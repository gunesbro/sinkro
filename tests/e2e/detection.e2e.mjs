// Does detection find the right video, across frames, shadow roots and decoys?
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath, shotDir } = config;

const API = "http://localhost:8805";
const WEB = "http://localhost:8821";
const OTHER = "http://127.0.0.1:8821"; // a different origin, for cross-origin frames
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? " -> " + detail : ""}`);
};
async function until(fn, timeoutMs = 8000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch {
      last = undefined;
    }
    if (last) return last;
    await wait(stepMs);
  }
  return last;
}

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
const films = { "/film.wav": wav(3600), "/other.wav": wav(1800), "/short.wav": wav(30) };

const V = (attrs = "") =>
  `<video src="/film.wav" width=800 height=450 preload=auto ${attrs}></video>`;
const shell = (body) =>
  `<!doctype html><meta charset=utf-8><title>t</title><body style="margin:0">${body}</body>`;
const pages = {
  "/plain": shell(`${V("id=film")}<script>window.v = document.getElementById("film")</script>`),
  "/late": shell(
    `<script>setTimeout(() => { document.body.innerHTML = '${V("id=film")}'; window.v = document.getElementById("film"); }, 2000)</script>`,
  ),
  "/open-shadow": shell(
    `<div id=h></div><script>const r = document.getElementById("h").attachShadow({mode:"open"}); r.innerHTML = '${V()}'; window.v = r.querySelector("video")</script>`,
  ),
  "/closed-shadow": shell(
    `<x-player></x-player><script>customElements.define("x-player", class extends HTMLElement { constructor(){ super(); const r = this.attachShadow({mode:"closed"}); r.innerHTML = '${V()}'; window.v = r.querySelector("video"); } })</script>`,
  ),
  "/closed-nested": shell(
    `<div id=h></div><script>const a = document.getElementById("h").attachShadow({mode:"closed"}); const d = document.createElement("div"); a.append(d); const b = d.attachShadow({mode:"open"}); const e = document.createElement("section"); b.append(e); const c = e.attachShadow({mode:"closed"}); c.innerHTML = '${V()}'; window.v = c.querySelector("video")</script>`,
  ),
  "/closed-late": shell(
    `<div id=h></div><script>const r = document.getElementById("h").attachShadow({mode:"closed"}); setTimeout(() => { r.innerHTML = '${V()}'; window.v = r.querySelector("video"); }, 2000)</script>`,
  ),
  "/iframe-same": shell(`<iframe src="/plain" width=900 height=500 style="border:0"></iframe>`),
  "/iframe-cross": shell(
    `<iframe src="${OTHER}/plain" width=900 height=500 style="border:0"></iframe>`,
  ),
  "/iframe-nested": shell(
    `<iframe src="${OTHER}/iframe-same" width=950 height=550 style="border:0"></iframe>`,
  ),
  "/iframe-blank": shell(
    `<iframe id=f width=900 height=500 style="border:0"></iframe><script>const d = document.getElementById("f").contentDocument; d.body.innerHTML = '${V()}'; window.v = d.querySelector("video")</script>`,
  ),
  "/iframe-srcdoc": shell(
    `<iframe srcdoc='<!doctype html><script>addEventListener("DOMContentLoaded",()=>{window.v=document.querySelector("video")})</script>${V()}' width=900 height=500 style="border:0"></iframe>`,
  ),
  "/scoring":
    shell(`<video id=trailer src="/short.wav" width=1000 height=500 muted loop autoplay preload=auto></video>
    <video id=thumb src="/short.wav" width=240 height=135 muted loop autoplay preload=auto></video>
    <video id=hidden src="/film.wav" width=1200 height=700 preload=auto style="display:none"></video>
    <video id=film src="/film.wav" width=800 height=450 preload=auto></video>
    <script>window.v = document.getElementById("film")</script>`),
  "/preview-top-film-frame": shell(
    `<video id=preview src="/short.wav" width=400 height=225 muted loop autoplay preload=auto></video><iframe src="${OTHER}/plain" width=900 height=500 style="border:0"></iframe>`,
  ),
  "/spa": shell(`<div id=app>${V("id=film")}</div><script>
    window.v = document.getElementById("film");
    window.next = () => { history.pushState({}, "", "/spa-2"); document.getElementById("app").innerHTML = '<video id=film2 src="/other.wav" width=800 height=450 preload=auto></video>'; window.v = document.getElementById("film2"); };
    window.swapSrc = () => { window.v.src = "/other.wav"; };
    window.removeIt = () => { window.v.remove(); };
    window.addBack = () => { document.getElementById("app").innerHTML = '${V("id=film3")}'; window.v = document.getElementById("film3"); };
  </script>`),
  "/two": shell(
    `<video id=big src="/film.wav" width=800 height=450 preload=auto></video><br><video id=small class="side-player" src="/other.wav" width=320 height=180 preload=auto></video><script>window.big = document.getElementById("big"); window.small = document.getElementById("small"); window.v = big;</script>`,
  ),
  "/two-frames": shell(
    `<video id=top src="/film.wav" width=700 height=300 preload=auto></video><iframe src="${OTHER}/plain" width=900 height=500 style="border:0"></iframe><script>window.v = document.getElementById("top")</script>`,
  ),
  "/big": shell(
    `<div id=b></div><script>let h=""; for(let i=0;i<4000;i++) h+="<div><span><i>x</i></span></div>"; document.getElementById("b").innerHTML=h; document.body.insertAdjacentHTML("beforeend", '${V("id=film")}'); window.v=document.getElementById("film");</script>`,
  ),
  "/storm": shell(`${V("id=film")}<div id=churn></div><script>
    window.v = document.getElementById("film");
    const churn = document.getElementById("churn");
    setInterval(() => { for (let i = 0; i < 20; i++) { const d = document.createElement("div"); churn.append(d); d.remove(); } }, 1);
    window.maxGap = 0; let last = performance.now();
    window.resetGap = () => { window.maxGap = 0; last = performance.now(); };
    setInterval(() => { const n = performance.now(); window.maxGap = Math.max(window.maxGap, n - last); last = n; }, 10);
  </script>`),
  "/ads": shell(`<div id=player>${V("id=film")}</div><script>
    window.v = document.getElementById("film");
    window.midroll = () => { window.v.src = "/short.wav"; return window.v.play(); };
    window.backToFilm = () => { window.v.src = "/film.wav"; };
    window.mark = (on) => document.getElementById("player").classList.toggle("ad-showing", on);
    window.skipButton = (text) => { document.getElementById("skip")?.remove(); if (text) document.getElementById("player").insertAdjacentHTML("beforeend", '<button id=skip>' + text + '</button>'); };
  </script>`),
  "/preroll":
    shell(`<div id=slot><video id=ad src="/short.wav" width=800 height=450 autoplay preload=auto></video></div><script>
    window.ad = document.getElementById("ad");
    window.showFilm = () => { document.getElementById("slot").innerHTML = '${V("id=film")}'; window.v = document.getElementById("film"); };
  </script>`),
  "/clip": shell(
    `<video id=clip src="/short.wav" width=800 height=450 preload=auto></video><script>window.v = document.getElementById("clip")</script>`,
  ),
  "/hook": shell(`${V("id=film")}<script>
    window.v = document.getElementById("film");
    window.probe = async () => {
      const out = {};
      out.srcGet = window.v.src.endsWith("/film.wav");
      window.v.src = "/other.wav"; out.srcSet = window.v.src.endsWith("/other.wav"); window.v.src = "/film.wav";
      const before = location.href; history.pushState({a:1}, "", "/hook?x=1"); out.push = location.search === "?x=1" && history.state.a === 1;
      history.replaceState({b:2}, "", "/hook?y=2"); out.replace = location.search === "?y=2" && history.state.b === 2;
      const p = window.v.play(); out.playPromise = p instanceof Promise; await p.catch(()=>{}); window.v.pause();
      const pd = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src"); out.descriptor = !!pd.get && !!pd.set;
      return out;
    };
  </script>`),
};

const web = createServer((req, res) => {
  const url = new URL(req.url, WEB);
  const film = films[url.pathname];
  if (film) {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : film.length - 1;
    res.writeHead(m ? 206 : 200, {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(m ? { "Content-Range": `bytes ${start}-${end}/${film.length}` } : {}),
    });
    res.end(film.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(pages[url.pathname] ?? pages["/plain"]);
});
await new Promise((r) => web.listen(8821, r));

startServer("8805");
for (let i = 0; i < 130; i += 1) {
  if (
    await fetch(`${API}/health`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await wait(300);
}

const context = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), "sinkro-detect-")),
  {
    channel: config.channel,
    headless: false,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    viewport: { width: 1280, height: 800 },
    args: [
      "--headless=new",
      "--mute-audio",
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
);
const sw =
  context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20000 }));
const extId = new URL(sw.url()).host;
const control = await context.newPage();
await control.goto(`chrome-extension://${extId}/popup.html`);
await control.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl }), API);

const errors = [];

function observer(code) {
  const ws = new WebSocket(`${API.replace("http", "ws")}/rooms/${code}/ws`);
  const states = [];
  const ready = new Promise((r) =>
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "join", protocol: 1 }));
      r();
    }),
  );
  ws.addEventListener("message", (e) => {
    if (e.data === "keepalive") return;
    const m = JSON.parse(e.data);
    if (m.type === "state") states.push(m);
  });
  return {
    ws,
    states,
    ready,
    inject: (s) =>
      ws.send(JSON.stringify({ type: "state", playing: true, rate: 1, sentAt: Date.now(), ...s })),
  };
}

async function open(path) {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`${path}: ${e.message}`));
  await page.goto(`${WEB}${path}`);
  await page.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  const { code } = await (
    await fetch(`${API}/rooms`, {
      method: "POST",
      headers: { "CF-Connecting-IP": `test-${Math.random()}` },
    })
  ).json();
  const obs = observer(code);
  await obs.ready;
  await wait(100);
  const status = () =>
    control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "session/status" }), tabId);
  const join = () =>
    control.evaluate(
      ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
      [tabId, code],
    );
  const leave = () =>
    control.evaluate((t) => chrome.runtime.sendMessage({ type: "session/leave", tabId: t }), tabId);
  return {
    page,
    tabId,
    code,
    obs,
    status,
    join,
    leave,
    close: async () => {
      obs.ws.close();
      await leave().catch(() => {});
      await page.close();
    },
  };
}

/** The window.v in whichever frame has one. */
async function videoFrame(page, name = "v") {
  return until(async () => {
    for (const frame of page.frames()) {
      const has = await frame.evaluate((n) => !!window[n], name).catch(() => false);
      if (has) return frame;
    }
    return null;
  });
}
const readIn = (frame, name = "v") =>
  frame.evaluate((n) => {
    const v = window[n];
    return { t: v.currentTime, paused: v.paused, ready: v.readyState };
  }, name);

/** Joins, sends a state, and checks that this frame's window.v followed it. */
async function finds(path, label = path) {
  const s = await open(path);
  try {
    await s.join();
    const frame = await videoFrame(s.page);
    const bound = await until(async () => (await s.status())?.hasVideo === true);
    // The first viewer starts the timeline once the video has loaded; let that settle.
    await until(() => s.obs.states.length > 0, 4000);
    s.obs.inject({ position: 300 });
    const ok = await until(async () => {
      const r = await readIn(await videoFrame(s.page));
      return !r.paused && Math.abs(r.t - 300) < 3;
    });
    const status = await s.status().catch(() => null);
    check(
      `finds the video: ${label}`,
      bound === true && ok === true,
      JSON.stringify({
        frame: frame?.url().slice(0, 40),
        read: await readIn(await videoFrame(s.page)),
        connection: status?.connection,
      }),
    );
  } finally {
    await s.close();
  }
}

try {
  // ---- discovery layers
  for (const path of [
    "/plain",
    "/late",
    "/open-shadow",
    "/closed-shadow",
    "/closed-nested",
    "/closed-late",
    "/iframe-same",
    "/iframe-cross",
    "/iframe-nested",
    "/iframe-blank",
    "/iframe-srcdoc",
  ]) {
    await finds(path);
  }

  // ---- scoring: a page full of decoys
  {
    const s = await open("/scoring");
    await s.join();
    await wait(2500);
    const before = await s.page.evaluate(() => ({
      t: document.getElementById("trailer").currentTime,
      h: document.getElementById("hidden").currentTime,
    }));
    s.obs.inject({ position: 500, playing: false });
    await wait(1500);
    const after = await s.page.evaluate(() => {
      const g = (id) => document.getElementById(id);
      return {
        film: g("film").currentTime,
        trailerPaused: g("trailer").paused,
        thumbPaused: g("thumb").paused,
        hidden: g("hidden").currentTime,
      };
    });
    check(
      "picks the film over a muted trailer, a thumbnail and a hidden video",
      Math.abs(after.film - 500) < 0.5 &&
        !after.trailerPaused &&
        !after.thumbPaused &&
        after.hidden === before.h,
      JSON.stringify(after),
    );
    await s.close();
  }
  {
    const s = await open("/preview-top-film-frame");
    await s.join();
    const frame = await until(() => s.page.frames().find((f) => f.url().startsWith(OTHER)));
    await wait(2500);
    s.obs.inject({ position: 500, playing: false });
    const moved = await until(async () => Math.abs((await readIn(frame)).t - 500) < 0.5);
    const previewPaused = await s.page.evaluate(() => document.getElementById("preview").paused);
    const status = await s.status();
    check(
      "across frames: film in a cross-origin frame beats a muted preview on top",
      moved === true && !previewPaused,
      JSON.stringify({ previewPaused, connection: status?.connection, peers: status?.peers }),
    );
    await s.close();
  }

  // ---- changes after joining
  {
    const s = await open("/spa");
    await s.join();
    await until(async () => (await s.status())?.hasVideo === true);
    s.obs.inject({ position: 200 });
    await until(
      async () => Math.abs((await s.page.evaluate(() => window.v.currentTime)) - 200) < 2,
    );
    const sentBefore = s.obs.states.length;

    await s.page.evaluate(() => window.next());
    await until(async () => (await s.status())?.videoChange?.kind === "you_moved");
    await until(async () => (await s.page.evaluate(() => window.v.readyState)) >= 1);
    await wait(1500);
    const onOther = await s.page.evaluate(() => ({
      t: window.v.currentTime,
      paused: window.v.paused,
    }));
    check(
      "SPA navigation to another address: says so and leaves the new film alone",
      (await s.status())?.videoChange?.kind === "you_moved" && onOther.t < 5,
      JSON.stringify(onOther),
    );
    check(
      "and nothing about it reaches the room",
      s.obs.states.length === sentBefore,
      `${s.obs.states.length - sentBefore} states`,
    );

    // Back on the address the room is on, whatever element the site uses now.
    await s.page.evaluate(() => history.pushState({}, "", "/spa"));
    const followed = await until(async () => {
      const r = await s.page.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused }));
      return !r.paused && Math.abs(r.t - 200) < 15;
    });
    check(
      "coming back: a new element rebinds and follows the room",
      followed === true,
      JSON.stringify(
        await s.page.evaluate(() => ({
          t: window.v.currentTime,
          paused: window.v.paused,
          url: location.pathname,
        })),
      ),
    );
    check(
      "the swap isn't reported to the room",
      s.obs.states.length === sentBefore,
      `${s.obs.states.length - sentBefore} states`,
    );

    // A real player sets a new source and calls play straight away, before it has any length.
    const beforeSwapPlay = s.obs.states.length;
    await s.page.evaluate(() => {
      window.v.src = "/other.wav";
      return window.v.play();
    });
    await wait(2500);
    check(
      "source swap with play: the room isn't sent back to zero",
      s.obs.states.length === beforeSwapPlay,
      `${s.obs.states.length - beforeSwapPlay} states, at ${await s.page.evaluate(() => window.v.currentTime)}`,
    );

    await s.page.evaluate(() => window.swapSrc());
    const afterSrc = await until(async () => {
      const r = await s.page.evaluate(() => ({
        t: window.v.currentTime,
        paused: window.v.paused,
        ready: window.v.readyState,
      }));
      return r.ready >= 2 && !r.paused && Math.abs(r.t - 200) < 25;
    }, 10000);
    check(
      "new source in the same element: rejoins the timeline",
      afterSrc === true,
      JSON.stringify(
        await s.page.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused })),
      ),
    );

    const beforeRemoval = s.obs.states.length;
    await s.page.evaluate(() => window.removeIt());
    const gone = await until(async () => (await s.status())?.hasVideo === false);
    const whileGone = await s.status();
    await wait(500);
    check(
      "removing a video doesn't pause the room",
      s.obs.states.length === beforeRemoval,
      `${s.obs.states.length - beforeRemoval} states`,
    );
    check(
      "video removed: the room stays connected",
      gone === true && whileGone.connection === "connected",
      JSON.stringify(whileGone),
    );

    await s.page.evaluate(() => window.addBack());
    const back = await until(async () => {
      const r = await s.page.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused }));
      return !r.paused && r.t > 100;
    });
    check("a new video appearing rebinds", back === true);
    await s.close();
  }

  // ---- the picker
  {
    const s = await open("/two");
    await s.join();
    await until(async () => (await s.status())?.hasVideo === true);
    await wait(1500);
    s.obs.inject({ position: 100, playing: false });
    await until(async () => Math.abs((await s.page.evaluate(() => big.currentTime)) - 100) < 0.5);
    check(
      "scoring starts on the larger video",
      Math.abs((await s.page.evaluate(() => big.currentTime)) - 100) < 0.5,
    );

    await control.evaluate(
      (t) => chrome.runtime.sendMessage({ type: "picker/start", tabId: t }),
      s.tabId,
    );
    await wait(800);
    if (shotDir) await s.page.screenshot({ path: join(shotDir, "picker.png") });
    await s.page.keyboard.press("Escape");
    await wait(500);
    s.obs.inject({ position: 150, playing: false });
    await wait(1000);
    const afterCancel = await s.page.evaluate(() => [big.currentTime, small.currentTime]);
    check(
      "Esc cancels: nothing changes",
      Math.abs(afterCancel[0] - 150) < 0.5 && afterCancel[1] === 0,
      JSON.stringify(afterCancel),
    );

    await control.evaluate(
      (t) => chrome.runtime.sendMessage({ type: "picker/start", tabId: t }),
      s.tabId,
    );
    await wait(800);
    const box = await s.page.locator("#small").boundingBox();
    await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await wait(1800);
    const playedByClick = await s.page.evaluate(() => small.paused);
    s.obs.inject({ position: 222, playing: false });
    await wait(1200);
    let reads = await s.page.evaluate(() => [big.currentTime, small.currentTime]);
    check(
      "clicking the small video makes it the one in sync",
      Math.abs(reads[1] - 222) < 0.5 && Math.abs(reads[0] - 150) < 1,
      JSON.stringify({ reads, playedByClick }),
    );

    await s.page.reload();
    await wait(2500);
    s.obs.inject({ position: 333, playing: false });
    const remembered = await until(
      async () => Math.abs((await s.page.evaluate(() => small.currentTime)) - 333) < 0.5,
      6000,
    );
    reads = await s.page.evaluate(() => [big.currentTime, small.currentTime]);
    check(
      "the choice is remembered after a reload",
      remembered === true && reads[0] < 1,
      JSON.stringify(reads),
    );

    await s.close();
    await control.evaluate(() => chrome.storage.local.remove("picked:localhost"));
  }
  {
    // Keyboard: the buttons are real, so Enter works.
    const s = await open("/two");
    await s.join();
    await until(async () => (await s.status())?.hasVideo === true);
    await control.evaluate(
      (t) => chrome.runtime.sendMessage({ type: "picker/start", tabId: t }),
      s.tabId,
    );
    await wait(800);
    await s.page.keyboard.press("Enter");
    await wait(1500);
    s.obs.inject({ position: 77, playing: false });
    await wait(1200);
    const reads = await s.page.evaluate(() => [big.currentTime, small.currentTime]);
    check(
      "the picker works from the keyboard",
      Math.abs(reads[0] - 77) < 0.5 || Math.abs(reads[1] - 77) < 0.5,
      JSON.stringify(reads),
    );
    await s.close();
    await control.evaluate(() => chrome.storage.local.clear()).catch(() => {});
    await control.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl }), API);
  }
  {
    // A pick in a cross-origin frame, then a pick on top: the second replaces the first.
    const s = await open("/two-frames");
    await s.join();
    await until(async () => (await s.status())?.hasVideo === true);
    const frame = await until(() => s.page.frames().find((f) => f.url().startsWith(OTHER)));
    await wait(1500);
    await control.evaluate(
      (t) => chrome.runtime.sendMessage({ type: "picker/start", tabId: t }),
      s.tabId,
    );
    await wait(800);
    const iframeBox = await s.page.locator("iframe").boundingBox();
    await s.page.mouse.click(iframeBox.x + 400, iframeBox.y + 200);
    await wait(2500);
    s.obs.inject({ position: 444, playing: false });
    const pickedFrame = await until(
      async () => Math.abs((await readIn(frame)).t - 444) < 0.5,
      6000,
    );
    check(
      "picking a video in a cross-origin frame moves sync there",
      pickedFrame === true,
      JSON.stringify(await readIn(frame)),
    );

    await control.evaluate(
      (t) => chrome.runtime.sendMessage({ type: "picker/start", tabId: t }),
      s.tabId,
    );
    await wait(800);
    const topBox = await s.page.locator("#top").boundingBox();
    await s.page.mouse.click(topBox.x + 300, topBox.y + 150);
    await wait(2500);
    s.obs.inject({ position: 555, playing: false });
    const pickedTop = await until(
      async () => Math.abs((await s.page.evaluate(() => window.v.currentTime)) - 555) < 0.5,
      6000,
    );
    const frameAfter = await readIn(frame);
    check(
      "a later pick replaces it",
      pickedTop === true && Math.abs(frameAfter.t - 555) > 1,
      JSON.stringify({
        top: await s.page.evaluate(() => window.v.currentTime),
        frame: frameAfter.t,
      }),
    );
    await s.close();
    await control.evaluate(() => chrome.storage.local.clear()).catch(() => {});
    await control.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl }), API);
  }

  // ---- two real viewers, one with its video in a cross-origin frame
  {
    const s = await open("/iframe-cross");
    const other = await context.newPage();
    await other.goto(`${WEB}/plain`);
    await other.bringToFront();
    const otherTab = await control.evaluate(
      async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
    );
    await s.join();
    await control.evaluate(
      ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
      [otherTab, s.code],
    );
    const frame = await until(() => s.page.frames().find((f) => f.url().startsWith(OTHER)));
    await wait(2500);
    // A person acts with a key or a click, inside the frame where the video is. Headless
    // Chromium doesn't deliver input to a frame from another address, so the key is sent there.
    await frame.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })),
    );
    await frame.evaluate(() => {
      window.v.currentTime = 900;
      return window.v.play();
    });
    const a = await until(async () => {
      const r = await other.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused }));
      return !r.paused && Math.abs(r.t - 900) < 3;
    });
    check(
      "a viewer whose video is in a frame leads another viewer",
      a === true,
      JSON.stringify(await other.evaluate(() => window.v.currentTime)),
    );
    await other.keyboard.press("Shift");
    await other.evaluate(() => {
      window.v.currentTime = 1500;
    });
    const b = await until(async () => Math.abs((await readIn(frame)).t - 1500) < 3);
    check("and follows them", b === true, JSON.stringify(await readIn(frame)));
    await control.evaluate(
      (t) => chrome.runtime.sendMessage({ type: "session/leave", tabId: t }),
      otherTab,
    );
    await other.close();
    await s.close();
  }

  // ---- the page hook leaves pages working, in a room or not
  {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`/hook: ${e.message}`));
    await page.goto(`${WEB}/hook`);
    const out = await page.evaluate(() => window.probe());
    check(
      "page's own play, src and history still behave",
      Object.values(out).every(Boolean),
      JSON.stringify(out),
    );
    await page.close();
  }

  // ---- ads
  {
    const s = await open("/ads");
    await s.join();
    await until(async () => (await s.status())?.hasVideo === true);
    s.obs.inject({ position: 300 });
    await until(
      async () => Math.abs((await s.page.evaluate(() => window.v.currentTime)) - 300) < 2,
    );
    await wait(1500);
    const before = s.obs.states.length;

    // A mid-roll: the same element plays something short, then goes back.
    await s.page.evaluate(() => window.midroll());
    await wait(3000);
    let read = await s.page.evaluate(() => ({
      t: window.v.currentTime,
      dur: window.v.duration,
      paused: window.v.paused,
    }));
    let status = await s.status();
    check(
      "mid-roll: leaves the ad alone and says so",
      read.dur === 30 && read.t < 10 && !read.paused && status.hold === "cant_follow",
      JSON.stringify({ read, hold: status.hold }),
    );
    await s.page.evaluate(() => {
      window.v.pause();
    });
    await wait(600);
    await s.page.evaluate(() => {
      window.v.currentTime = 29.5;
      return window.v.play();
    });
    await wait(2000);
    const ended = await s.page.evaluate(() => window.v.ended);
    check(
      "mid-roll: pausing, seeking and ending it don't reach the room",
      s.obs.states.length === before,
      JSON.stringify({ ended, states: s.obs.states.length - before }),
    );

    await s.page.evaluate(() => window.backToFilm());
    const back = await until(async () => {
      const r = await s.page.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused }));
      return !r.paused && r.t > 300 && r.t < 330;
    }, 10000);
    status = await s.status();
    check(
      "mid-roll: back on the room's spot afterwards",
      back === true && status.hold === null,
      JSON.stringify(
        await s.page.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused })),
      ),
    );

    // A player's own marker, with the same video underneath.
    await wait(1000);
    const beforeMark = s.obs.states.length;
    await s.page.evaluate(() => window.mark(true));
    await wait(1500);
    s.obs.inject({ position: 1000 });
    await wait(1500);
    const marked = await s.page.evaluate(() => window.v.currentTime);
    status = await s.status();
    check(
      "ad marker: holds, and doesn't follow the room",
      marked < 400 && status.hold === "ad",
      JSON.stringify({ marked, hold: status.hold }),
    );
    await s.page.evaluate(() => window.mark(false));
    const released = await until(
      async () => Math.abs((await s.page.evaluate(() => window.v.currentTime)) - 1000) < 10,
    );
    check(
      "ad marker: catches up when it's gone",
      released === true,
      String(await s.page.evaluate(() => window.v.currentTime)),
    );
    check(
      "ad marker: nothing reached the room",
      s.obs.states.length === beforeMark + 1,
      `${s.obs.states.length - beforeMark} states (1 is the injected one)`,
    );
    await s.close();
  }
  {
    // A pre-roll with the room already at 500: nothing tells it apart except being too short.
    const s = await open("/preroll");
    s.obs.inject({ position: 500 });
    await wait(300);
    await s.join();
    await until(async () => (await s.status())?.connection === "connected");
    await wait(3000);
    const ad = await s.page.evaluate(() => ({
      t: window.ad.currentTime,
      paused: window.ad.paused,
    }));
    const status = await s.status();
    check(
      "pre-roll: plays out, untouched",
      ad.t < 10 && !ad.paused && status.hold === "cant_follow",
      JSON.stringify({ ad, hold: status.hold }),
    );
    await s.page.evaluate(() => window.showFilm());
    const joined = await until(async () => {
      const r = await s.page.evaluate(() => ({
        t: window.v?.currentTime ?? 0,
        paused: window.v?.paused,
      }));
      return r.paused === false && Math.abs(r.t - 505) < 15;
    }, 10000);
    check(
      "pre-roll: the film joins the room when it appears",
      joined === true,
      JSON.stringify(await s.page.evaluate(() => window.v.currentTime)),
    );
    check(
      "pre-roll: nothing reached the room",
      s.obs.states.length === 1,
      `${s.obs.states.length} states (1 is the injected one)`,
    );
    await s.close();
  }
  {
    // A short video that's the actual thing being watched mustn't be taken for an ad.
    const s = await open("/clip");
    await s.join();
    await until(async () => (await s.status())?.hasVideo === true);
    s.obs.inject({ position: 10 });
    const followed = await until(async () => {
      const r = await s.page.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused }));
      return !r.paused && Math.abs(r.t - 10) < 3;
    });
    const status = await s.status();
    check(
      "a short clip with nothing longer around isn't an ad",
      followed === true && status.hold === null,
      JSON.stringify(status.hold),
    );
    await s.close();
  }

  // ---- what the viewer reported: alone, on a short video, on a feed
  {
    const s = await open("/ads");
    s.obs.ws.close();
    await wait(300);
    await s.join();
    await until(async () => (await s.status())?.hasVideo === true);
    await wait(1200);
    await s.page.evaluate(() => {
      window.v.currentTime = 2000;
      return window.v.play();
    });
    await wait(1500);
    await s.page.evaluate(() => {
      window.v.src = "/short.wav";
      return window.v.play();
    });
    await wait(3000);
    let status = await s.status();
    let read = await s.page.evaluate(() => ({
      t: window.v.currentTime,
      dur: window.v.duration,
      paused: window.v.paused,
    }));
    check(
      "alone: a short video after a long one isn't called an ad",
      status.hold === null,
      JSON.stringify({ hold: status.hold, peers: status.peers }),
    );
    check(
      "alone: and it isn't touched",
      read.dur === 30 && read.t < 10 && !read.paused,
      JSON.stringify(read),
    );

    // Looping past its end, with no way for a timeline to keep up.
    await s.page.evaluate(() => {
      window.v.loop = true;
      window.v.currentTime = 29;
    });
    await wait(4000);
    status = await s.status();
    read = await s.page.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused }));
    check(
      "alone: a looping short video keeps looping",
      status.hold === null && !read.paused && read.t < 10,
      JSON.stringify({ hold: status.hold, read }),
    );
    check("alone: and reads as in sync", status.drift === null, JSON.stringify(status.drift));

    // Someone arrives and is told where this viewer really is.
    const late = observer(s.code);
    await late.ready;
    const told = await until(() => late.states.length > 0, 4000);
    const here = await s.page.evaluate(() => window.v.currentTime);
    check(
      "someone arriving gets where this viewer really is",
      told === true && Math.abs(late.states.at(-1).position - here) < 3,
      JSON.stringify({ told: late.states.at(-1)?.position, here }),
    );
    late.ws.close();

    // Evidence still counts, alone or not: a skip button in either language.
    await wait(500);
    for (const label of ["Skip Ad", "Reklamı Atla"]) {
      await s.page.evaluate((text) => window.skipButton(text), label);
      const held = await until(async () => (await s.status())?.hold === "ad", 3000);
      check(`a "${label}" button means an ad`, held === true);
      await s.page.evaluate(() => window.skipButton(null));
      await until(async () => (await s.status())?.hold === null, 3000);
    }
    await s.page.evaluate(() => window.skipButton("Skip intro"));
    await wait(1500);
    check("a button that skips something else doesn't", (await s.status()).hold === null);
    await s.close();
  }

  // ---- a page changing its DOM constantly, with the picker open on top
  {
    const s = await open("/storm");
    await s.join();
    await until(async () => (await s.status())?.hasVideo === true);
    await s.page.evaluate(() => window.resetGap());
    await wait(3000);
    const roomGap = await s.page.evaluate(() => window.maxGap);
    await control.evaluate(
      (t) => chrome.runtime.sendMessage({ type: "picker/start", tabId: t }),
      s.tabId,
    );
    await wait(500);
    await s.page.evaluate(() => window.resetGap());
    await wait(3000);
    const pickerGap = await s.page.evaluate(() => window.maxGap);
    check(
      "a page churning its DOM stays responsive in a room",
      roomGap < 150,
      `longest stall ${roomGap.toFixed(0)} ms`,
    );
    check("and with the picker open", pickerGap < 150, `longest stall ${pickerGap.toFixed(0)} ms`);
    await s.page.keyboard.press("Escape");
    await s.close();
  }

  // ---- cost on a big page
  {
    const s = await open("/big");
    const t0 = Date.now();
    await s.join();
    const bound = await until(async () => (await s.status())?.hasVideo === true, 8000, 20);
    check(
      "a 12,000-element page still binds promptly",
      bound === true,
      `${Date.now() - t0} ms to join and bind`,
    );
    await s.close();
  }

  check("no page errors", errors.length === 0, errors.join("; "));
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", error);
} finally {
  await context.close().catch(() => {});
  web.close();
  try {
    console.log("cleanup:", stopServers());
  } catch {}
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
}
