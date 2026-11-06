// Three people playing, pausing, seeking and changing speed, and the server going away.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath, soakSeconds } = config;

const API_PORT = 8802;
const WEB_PORT = 8811;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? " -> " + detail : ""}`);
}
async function until(fn, timeoutMs = 10000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await wait(stepMs);
  }
  return last;
}

// A real media file: one hour of silent 8 kHz WAV, served with range requests.
function wav(seconds) {
  const rate = 8000;
  const data = rate * seconds;
  const b = Buffer.alloc(44 + data, 128);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  return b;
}
// The soak starts about 20 minutes in, and the checks after it need the film still going.
const media = wav(Math.max(3600, 2400 + Number(soakSeconds)));
const pageFor = (
  src,
) => `<!doctype html><title>t</title><button id=play onclick="document.querySelector('video').play()">play</button>
<video src="${src}" width=640 height=360 preload=auto></video>`;
const web = createServer((req, res) => {
  if (req.url === "/media.wav") {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : media.length - 1;
    res.writeHead(m ? 206 : 200, {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(m ? { "Content-Range": `bytes ${start}-${end}/${media.length}` } : {}),
    });
    res.end(media.subarray(start, end + 1));
    return;
  }
  if (req.url === "/unseekable.wav") {
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": media.length });
    res.end(media);
    return;
  }
  const headers = { "Content-Type": "text/html" };
  if (req.url === "/csp")
    headers["Content-Security-Policy"] =
      "default-src 'self'; connect-src 'none'; script-src 'unsafe-inline'";
  res.writeHead(200, headers);
  res.end(pageFor(req.url === "/unseekable" ? "/unseekable.wav" : "/media.wav"));
});
await new Promise((r) => web.listen(WEB_PORT, r));

let wrangler;
function stopWrangler() {
  const out = stopServers();
  wrangler = undefined;
  return out;
}
async function startWrangler() {
  wrangler = startServer(String(API_PORT));
  const up = await until(
    () =>
      fetch(`${API}/health`).then(
        (r) => r.ok,
        () => false,
      ),
    40000,
    300,
  );
  if (!up) throw new Error("wrangler did not start");
}

async function launch(name, { autoplay = true, path = "/", untouched = false } = {}) {
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), `sinkro-${name}-`)),
    {
      channel: config.channel,
      headless: false,
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
      viewport: { width: 800, height: 500 },
      args: [
        "--headless=new",
        "--mute-audio",
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        ...(autoplay
          ? ["--autoplay-policy=no-user-gesture-required"]
          : ["--autoplay-policy=document-user-activation-required"]),
      ],
    },
  );
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const id = new URL(sw.url()).host;
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/popup.html`);
  await control.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl }), API);

  const video = await context.newPage();
  const errors = [];
  video.on("pageerror", (e) => errors.push(e.message));
  const sockets = [];
  const pongs = [];
  const drifts = [];
  video.on("websocket", (ws) => {
    sockets.push(ws.url());
    ws.on("framesent", (f) => {
      if (typeof f.payload === "string" && f.payload.includes('"drift"')) drifts.push(Date.now());
    });
    ws.on("framereceived", (f) => {
      if (typeof f.payload !== "string" || !f.payload.includes('"pong"')) return;
      const m = JSON.parse(f.payload);
      const at = Date.now();
      pongs.push({
        rtt: at - m.clientTime,
        offset: Math.round(m.serverTime - (m.clientTime + at) / 2),
        at,
      });
    });
  });
  await video.goto(`${WEB}${path}`);
  // Playwright's evaluate counts as a user gesture, which would lift the autoplay block.
  if (!untouched)
    await video.waitForFunction(
      () =>
        document.querySelector("video").readyState >= 3 ||
        document.querySelector("video").duration > 0,
    );
  else await wait(2500);

  // The popup will use the active tab too, which needs no extra permission.
  await video.bringToFront();
  const tabId = await control.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id;
  });
  if (tabId === undefined) throw new Error("no tab id");

  return {
    name,
    context,
    control,
    video,
    tabId,
    pongs,
    drifts,
    errors,
    sockets,
    send: (message) => control.evaluate((m) => chrome.runtime.sendMessage(m), message),
    join: (code) =>
      control.evaluate(
        ([tabId, code]) => chrome.runtime.sendMessage({ type: "session/join", tabId, code }),
        [tabId, code],
      ),
    leave: () =>
      control.evaluate(
        (tabId) => chrome.runtime.sendMessage({ type: "session/leave", tabId }),
        tabId,
      ),
    status: () =>
      control.evaluate(
        (tabId) => chrome.tabs.sendMessage(tabId, { type: "session/status" }),
        tabId,
      ),
    read: () =>
      video.evaluate(() => {
        const v = document.querySelector("video");
        return {
          t: v.currentTime,
          paused: v.paused,
          rate: v.playbackRate,
          at: Date.now(),
          seeking: v.seeking,
        };
      }),
    act: (fn, arg) => video.evaluate(fn, arg),
  };
}

function observer(code) {
  const ws = new WebSocket(`${API.replace("http", "ws")}/rooms/${code}/ws`);
  const states = [];
  let latest = null;
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "join", protocol: 1 })));
  ws.addEventListener("message", (e) => {
    if (e.data === "keepalive") return;
    const m = JSON.parse(e.data);
    if (m.type === "state") {
      states.push(m);
      latest = m;
    }
    if (m.type === "joined" && m.state) latest = m.state;
  });
  return {
    ws,
    states,
    latest: () => latest,
    inject: (s) =>
      ws.send(JSON.stringify({ type: "state", rate: 1, playing: true, sentAt: Date.now(), ...s })),
  };
}

/** Largest gap between viewers' positions, normalised to one instant. */
async function spread(viewers) {
  const reads = await Promise.all(viewers.map((v) => v.read()));
  const now = Math.max(...reads.map((r) => r.at));
  const times = reads.map((r) => r.t + (r.paused ? 0 : ((now - r.at) / 1000) * r.rate));
  return { gap: Math.max(...times) - Math.min(...times), times, reads };
}
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance;

const everyone = [];
try {
  await startWrangler();
  const a = await launch("a");
  everyone.push(a);
  const b = await launch("b");
  everyone.push(b);
  const c = await launch("c");
  everyone.push(c);
  const viewers = [a, b, c];

  // ---- no room, no connection
  await wait(1500);
  check("a tab in no room reports no session", (await a.status()) === null);
  check(
    "a tab in no room opens no socket",
    a.sockets.length === 0,
    `${a.sockets.length} sockets seen`,
  );

  // ---- create and join
  const created = await a.send({ type: "room/create" });
  check(
    "create a room",
    /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(created.code ?? ""),
    JSON.stringify(created),
  );
  const { code } = created;

  const bad = await a.join("not a code");
  check("an invalid code is refused", bad?.error === "invalid_code");

  await a.act(() => (document.querySelector("video").currentTime = 30));
  await a.join(code);
  await until(async () => (await a.status())?.connection === "connected");
  check(
    "first viewer connects",
    (await a.status())?.connection === "connected",
    JSON.stringify(await a.status()),
  );
  const spreadCheck = async (viewers) => {
    const spreads = await until(async () => {
      const all = await Promise.all(viewers.map((v) => v.status()));
      return all.every((s) => typeof s?.spread === "number") && all.map((s) => s.spread);
    }, 20000);
    check(
      "everyone hears how far apart the room is",
      Array.isArray(spreads),
      JSON.stringify(spreads),
    );
    check(
      "and it's small",
      Array.isArray(spreads) && spreads.every((s) => s < 0.3),
      JSON.stringify(spreads),
    );
  };
  check(
    "the socket check above can see content script sockets",
    a.sockets.length > 0,
    a.sockets.join(" "),
  );
  const obs = observer(code);
  await until(() => obs.latest());
  check(
    "first viewer starts the timeline",
    near(obs.latest()?.position, 30),
    `position ${obs.latest()?.position}`,
  );

  await b.join(code.toLowerCase().replace("-", ""));
  await c.join(code);
  await until(async () =>
    (await Promise.all([b, c].map((v) => v.status()))).every((s) => s?.connection === "connected"),
  );
  await until(async () => near((await b.read()).t, 30) && near((await c.read()).t, 30));
  check(
    "later viewers land on the room's position",
    near((await b.read()).t, 30) && near((await c.read()).t, 30),
    JSON.stringify((await spread(viewers)).times),
  );
  check(
    "peer count is shared",
    (await a.status()).peers === 4 || (await c.status()).peers === 4,
    `c sees ${(await c.status()).peers}`,
  );

  // ---- each action reaches everyone, exactly once
  async function action(name, doIt, expected) {
    await wait(800);
    const before = obs.states.length;
    await doIt();
    const reached = await until(async () => {
      const reads = await Promise.all(viewers.map((v) => v.read()));
      return reads.every(expected);
    }, 5000);
    check(
      `${name}: reaches all three`,
      reached === true,
      JSON.stringify(
        (await Promise.all(viewers.map((v) => v.read()))).map((r) => [
          +r.t.toFixed(2),
          r.paused,
          r.rate,
        ]),
      ),
    );
    await wait(2500);
    const sent = obs.states.length - before;
    check(`${name}: exactly one message, no echo`, sent === 1, `${sent} states`);
  }
  await action(
    "A plays",
    () => a.act(() => document.querySelector("video").play()),
    (r) => !r.paused,
  );
  await spreadCheck([a, b, c]);
  await action(
    "A seeks to 600",
    () => a.act(() => (document.querySelector("video").currentTime = 600)),
    (r) => r.t >= 599 && r.t < 610,
  );
  await action(
    "B pauses",
    () => b.act(() => document.querySelector("video").pause()),
    (r) => r.paused,
  );
  const pausedAt = await spread(viewers);
  check("paused viewers agree", pausedAt.gap < 0.3, `gap ${pausedAt.gap.toFixed(3)} s`);
  await action(
    "C seeks while paused",
    () => c.act(() => (document.querySelector("video").currentTime = 1200)),
    (r) => near(r.t, 1200, 0.1) && r.paused,
  );
  await action(
    "C plays",
    () => c.act(() => document.querySelector("video").play()),
    (r) => !r.paused,
  );
  await action(
    "B sets 1.5x",
    () => b.act(() => (document.querySelector("video").playbackRate = 1.5)),
    (r) => near(r.rate, 1.5, 0.08),
  );
  await action(
    "A sets 1x",
    () => a.act(() => (document.querySelector("video").playbackRate = 1)),
    (r) => near(r.rate, 1, 0.06),
  );

  // ---- drift correction on real playback: the room's timeline moves, viewers must follow
  await until(async () => (await spread(viewers)).gap < 0.3, 20000);
  let before = obs.states.length;
  const r0 = await a.read();
  obs.inject({ position: r0.t + 1 + (Date.now() - r0.at) / 1000 });
  await wait(1500);
  let reads = await Promise.all(viewers.map((v) => v.read()));
  check(
    "1 s behind the timeline: speeds up, no seek needed",
    reads.every((r) => r.rate > 1 && r.rate <= 1.0501),
    JSON.stringify(reads.map((r) => r.rate)),
  );
  const settled = await until(
    async () => {
      const statuses = await Promise.all(viewers.map((v) => v.status()));
      return statuses.every((s) => !s.correcting && Math.abs(s.drift) < 0.3);
    },
    60000,
    500,
  );
  const afterCorrection = await Promise.all(viewers.map((v) => v.status()));
  check(
    "catches up and returns to normal speed",
    settled === true,
    JSON.stringify(afterCorrection.map((s) => +s.drift.toFixed(3))),
  );
  reads = await Promise.all(viewers.map((v) => v.read()));
  check(
    "normal speed restored",
    reads.every((r) => r.rate === 1),
    JSON.stringify(reads.map((r) => r.rate)),
  );
  check(
    "corrections send nothing to the room",
    obs.states.length - before === 1,
    `${obs.states.length - before} states (1 is the injected one)`,
  );

  before = obs.states.length;
  const r1 = await a.read();
  const jumpTo = r1.t + 30;
  obs.inject({ position: jumpTo });
  await wait(1500);
  reads = await Promise.all(viewers.map((v) => v.read()));
  check(
    "30 s off: seeks",
    reads.every((r) => r.t > jumpTo - 0.5 && r.t < jumpTo + 3),
    JSON.stringify(reads.map((r) => +r.t.toFixed(2))),
  );
  check(
    "seeks send nothing to the room",
    obs.states.length - before === 1,
    `${obs.states.length - before} states`,
  );

  // ---- reload rejoins on its own
  await b.video.reload();
  await b.video.waitForFunction(() => document.querySelector("video").duration > 0);
  const rejoined = await until(async () => {
    const [ra, rb] = await Promise.all([a.read(), b.read()]);
    return !rb.paused && near(ra.t, rb.t, 2);
  }, 15000);
  check(
    "a reloaded page rejoins and catches up",
    rejoined === true,
    JSON.stringify((await spread(viewers)).times),
  );

  // ---- soak
  console.log(`soak: ${soakSeconds} s with three viewers...`);
  await wait(3000);
  let worst = 0;
  const samples = [];
  const soakStart = Date.now();
  const soakEnd = soakStart + Number(soakSeconds) * 1000;
  while (Date.now() < soakEnd) {
    const { gap } = await spread(viewers);
    samples.push(gap);
    worst = Math.max(worst, gap);
    await wait(1000);
  }
  if (worst >= 0.5) {
    const statuses = await Promise.all(viewers.map((v) => v.status()));
    const reads = await Promise.all(viewers.map((v) => v.read()));
    console.log("DIAG statuses", JSON.stringify(statuses));
    console.log("DIAG reads", JSON.stringify(reads));
    for (const v of viewers) console.log("DIAG pongs", v.name, JSON.stringify(v.pongs.slice(-12)));
  }
  samples.sort((x, y) => x - y);
  check(
    `drift over ${soakSeconds} s stays under 0.5 s`,
    worst < 0.5,
    `worst ${worst.toFixed(3)} s, median ${samples[samples.length >> 1].toFixed(3)} s, ${samples.length} samples`,
  );
  // Each message counts against the server's daily quota, and steady play has nothing new.
  const driftsDuringSoak = viewers.map((v) => v.drifts.filter((at) => at >= soakStart).length);
  check(
    "steady play tells the room its drift rarely",
    driftsDuringSoak.every((count) => count <= Math.max(2, Number(soakSeconds) / 30)),
    `${JSON.stringify(driftsDuringSoak)} drift messages in ${soakSeconds} s`,
  );
  check(
    "and everyone still knows how far apart the room is",
    (await Promise.all(viewers.map((v) => v.status()))).every((s) => typeof s.spread === "number"),
  );

  // ---- privacy
  // A viewer's own state also carries the film's length and its player's site, sealed.
  const latest = obs.latest();
  const allowed = [
    "duration",
    "from",
    "playing",
    "position",
    "rate",
    "sentAt",
    "seq",
    "source",
    "type",
  ];
  const keys = Object.keys(latest).sort();
  check(
    "only playback state crosses the wire",
    keys.every((key) => allowed.includes(key)) &&
      !/https?:|\/\/|localhost/.test(String(latest.source ?? "")),
    keys.join(","),
  );

  // ---- page CSP
  const strict = await launch("strict", { path: "/csp" });
  everyone.push(strict);
  await strict.join(code);
  const strictUp = await until(
    async () => (await strict.status())?.connection === "connected",
    10000,
  );
  check(
    "a page with connect-src 'none' can't block the socket",
    strictUp === true,
    JSON.stringify(await strict.status()),
  );
  await until(async () => !(await strict.read()).paused, 5000);
  check(
    "and that page follows the room",
    near((await strict.read()).t, (await a.read()).t, 2),
    JSON.stringify([(await strict.read()).t, (await a.read()).t]),
  );

  // ---- a video that can't seek
  const stuck = await launch("stuck", { path: "/unseekable" });
  everyone.push(stuck);
  const statesBeforeStuck = obs.states.length;
  const positionBeforeStuck = (await a.read()).t;
  await stuck.join(code);
  await until(async () => (await stuck.status())?.connection === "connected", 10000);
  await wait(7000);
  check(
    "a viewer whose video can't seek doesn't drag the room",
    obs.states.length === statesBeforeStuck,
    `${obs.states.length - statesBeforeStuck} states`,
  );
  const aAfterStuck = await a.read();
  check(
    "the room keeps playing where it was",
    !aAfterStuck.paused && aAfterStuck.t > positionBeforeStuck,
    JSON.stringify([positionBeforeStuck, aAfterStuck.t]),
  );
  await stuck.leave();

  // ---- autoplay policy
  const shy = await launch("shy", { autoplay: false, untouched: true });
  everyone.push(shy);
  await shy.join(code);
  // Messages from Playwright's evaluate carry a user gesture into the tab, so don't ask yet.
  await wait(3000);
  const blocked = await until(async () => (await shy.status())?.needsGesture === true, 5000);
  const statesBeforeClick = obs.states.length;
  check(
    "a blocked browser is reported, and doesn't drag the room",
    blocked === true,
    JSON.stringify(await shy.status()),
  );
  await shy.video.click("#play");
  const unblocked = await until(async () => {
    const [rs, ra] = await Promise.all([shy.read(), a.read()]);
    return !rs.paused && near(rs.t, ra.t, 1);
  }, 8000);
  check(
    "a click joins in at the room's position",
    unblocked === true,
    JSON.stringify([(await shy.read()).t, (await a.read()).t]),
  );
  await wait(1000);
  check(
    "that click isn't sent to everyone",
    obs.states.length === statesBeforeClick,
    `${obs.states.length - statesBeforeClick} states`,
  );
  await shy.leave();
  await strict.leave();

  // ---- leaving
  await wait(500);
  await c.leave();
  await wait(500);
  check("leaving ends the session", (await c.status()) === null);
  await c.act(() => document.querySelector("video").pause());
  const leftAt = obs.states.length;
  await wait(2000);
  check(
    "someone who left doesn't affect the room",
    obs.states.length === leftAt && !(await a.read()).paused,
  );
  check("someone who left isn't controlled by the room", (await c.read()).paused);
  obs.ws.close();

  // ---- server outage
  console.log("stopping the server:", stopWrangler());
  const noticed = await until(
    async () => (await a.status())?.connection === "reconnecting",
    60000,
    500,
  );
  check(
    "an outage is noticed",
    noticed === "reconnecting" || noticed === true,
    JSON.stringify(await a.status()),
  );
  await a.act(() => document.querySelector("video").pause());
  await wait(2500);
  check("offline, the viewer stays in charge", (await a.read()).paused);
  await startWrangler();
  const back = await until(
    async () =>
      (await Promise.all([a, b].map((v) => v.status()))).every(
        (s) => s?.connection === "connected",
      ),
    45000,
    500,
  );
  check(
    "both reconnect by themselves",
    back === true,
    JSON.stringify(await Promise.all([a, b].map((v) => v.status()))),
  );
  const agree = await until(async () => (await spread([a, b])).gap < 0.5, 15000);
  check(
    "and end up together",
    agree === true,
    JSON.stringify((await spread([a, b])).reads.map((r) => [+r.t.toFixed(2), r.paused])),
  );

  for (const v of everyone)
    check(`no page errors in ${v.name}`, v.errors.length === 0, v.errors.join("; "));
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", error);
} finally {
  await Promise.allSettled(everyone.map((v) => v.context.close()));
  web.close();
  try {
    console.log("cleanup:", stopWrangler());
  } catch {}
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
}
