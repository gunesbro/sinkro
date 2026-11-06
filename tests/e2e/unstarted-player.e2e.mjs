// A player that's only a picture and a button until someone presses it, with the video
// arriving inside a frame from another address, and the room already playing.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath, shotDir } = config;

const API = "http://localhost:8818";
const WEB = "http://localhost:8850";
const OTHER = "http://127.0.0.1:8850";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log((ok ? "ok   " : "FAIL ") + name + (detail !== "" ? " -> " + detail : ""));
};
async function until(fn, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch {
      last = undefined;
    }
    if (last) return last;
    await wait(100);
  }
  return last;
}
const rate = 8000,
  seconds = 1200;
const film = Buffer.alloc(44 + rate * seconds, 128);
film.write("RIFF", 0);
film.writeUInt32LE(36 + rate * seconds, 4);
film.write("WAVEfmt ", 8);
film.writeUInt32LE(16, 16);
film.writeUInt16LE(1, 20);
film.writeUInt16LE(1, 22);
film.writeUInt32LE(rate, 24);
film.writeUInt32LE(rate, 28);
film.writeUInt16LE(1, 32);
film.writeUInt16LE(8, 34);
film.write("data", 36);
film.writeUInt32LE(rate * seconds, 40);
const web = createServer((req, res) => {
  const url = new URL(req.url, WEB);
  if (url.pathname === "/film.wav") {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : film.length - 1;
    res.writeHead(m ? 206 : 200, {
      "Content-Type": "audio/wav",
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(m ? { "Content-Range": "bytes " + start + "-" + end + "/" + film.length } : {}),
    });
    return res.end(film.subarray(start, end + 1));
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  if (url.pathname === "/player")
    return res.end(
      '<!doctype html><meta charset=utf-8><title>p</title><body style="margin:0;background:#000"><video id=v src="/film.wav" width=780 height=420 autoplay></video><script>window.v=document.getElementById("v");</script>',
    );
  if (url.pathname === "/mutedfilm")
    return res.end(
      '<!doctype html><meta charset=utf-8><title>Muted</title><body style="margin:0;background:#333"><video id=v src="/film.wav" width=560 height=315 muted autoplay></video><script>window.v=document.getElementById("v");</script>',
    );
  if (url.pathname === "/feed")
    return res.end(
      '<!doctype html><meta charset=utf-8><title>Feed</title><body style="margin:0;background:#333"><h1>feed</h1><video id=p width=320 height=180 muted style="margin:60px"></video><script>const p=document.getElementById("p");window.v=p;p.addEventListener("mouseenter",()=>{if(!p.src)p.src="/film.wav";p.play();});p.addEventListener("mouseleave",()=>{p.pause();});</script>',
    );
  if (url.pathname === "/elsewhere")
    return res.end(
      '<!doctype html><meta charset=utf-8><title>Home</title><body style="margin:0;background:#333"><h1>home</h1>',
    );
  res.end(
    '<!doctype html><meta charset=utf-8><title>Episode One</title><body style="margin:0;background:#222"><div id=box style="width:800px;height:440px;background:#555"><button id=start style="margin:180px 340px;width:120px;height:60px">play</button></div><script>document.getElementById("start").addEventListener("click",()=>{document.getElementById("box").innerHTML=\'<iframe id=f src="' +
      OTHER +
      '/player" width=800 height=440 allow="autoplay" style="border:0"></iframe>\';});</script>',
  );
});
await new Promise((r) => web.listen(8850, r));
startServer("8818");
for (let i = 0; i < 130; i += 1) {
  if (
    await fetch(API + "/health").then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await wait(300);
}
const all = [];
async function viewer(name, path) {
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), "sinkro-facade-" + name + "-")),
    {
      channel: config.channel,
      headless: false,
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
      viewport: { width: 1000, height: 650 },
      locale: "en-US",
      args: [
        "--headless=new",
        "--mute-audio",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-extensions-except=" + extPath,
        "--load-extension=" + extPath,
      ],
    },
  );
  all.push(context);
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const popupUrl = "chrome-extension://" + new URL(sw.url()).host + "/popup.html";
  const control = await context.newPage();
  await control.goto(popupUrl);
  await control.evaluate(
    (serverUrl) => chrome.storage.local.set({ serverUrl, language: "en" }),
    API,
  );
  const tab = await context.newPage();
  await tab.goto(WEB + path);
  await wait(1000);
  await tab.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  const frameVideo = () =>
    tab
      .frames()
      .find((f) => f.url().includes("/player"))
      ?.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused }));
  return {
    context,
    control,
    tab,
    tabId,
    popupUrl,
    frameVideo,
    status: () =>
      control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "session/status" }), tabId),
    join: (code) =>
      control.evaluate(
        ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
        [tabId, code],
      ),
    openPopup: async () => {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 360, height: 640 });
      await popup.goto(popupUrl);
      await tab.bringToFront();
      await popup.reload();
      await popup.waitForSelector("main:not([hidden])");
      return popup;
    },
  };
}
const clip = { x: 640, y: 0, width: 360, height: 300 };
try {
  // The first viewer presses play, and creates the room with the video going.
  const a = await viewer("a", "/episode?id=1");
  await a.tab.click("#start");
  await until(() => a.frameVideo()?.then((v) => v && !v.paused));
  const popupA = await a.openPopup();
  await until(
    async () => (await popupA.locator("#found-text").innerText()) === "Found a video on this tab",
  );
  await popupA.click("#create");
  await until(async () =>
    /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(await popupA.locator("#room-code").innerText()),
  );
  const code = await popupA.locator("#room-code").innerText();
  // The address goes to the room from the popup, so it needs a moment before this closes it.
  await wait(1500);
  await popupA.close();
  await until(
    async () => (await a.status())?.connection === "connected" && (await a.status())?.hasVideo,
  );
  await a.frameVideo();
  await wait(1500);

  // The second is on the same page, picture and button only.
  const b = await viewer("b", "/episode?id=1");
  const before = await b.tab.screenshot({ clip });
  await b.join(code);
  await until(
    async () => (await b.status())?.peers === 2 && (await b.status())?.isOnRoomPage === true,
  );
  const waiting = await b.status();
  check(
    "a second viewer on the room's page knows no video has started",
    waiting.isOnRoomPage === true && waiting.hasVideo === false,
    JSON.stringify({ r: waiting.isOnRoomPage, v: waiting.hasVideo }),
  );
  await wait(600);
  await b.tab.screenshot({ path: join(shotDir, "facade-card.png") });
  check("and is told what to do", Buffer.compare(before, await b.tab.screenshot({ clip })) !== 0);

  const popupB = await b.openPopup();
  await until(
    async () =>
      (await popupB.locator("#alert-title").innerText()) === "The video hasn't started here",
  );
  check(
    "the popup says the same",
    (await popupB.locator("#alert-title").innerText()) === "The video hasn't started here",
    await popupB.locator("#alert-title").innerText(),
  );
  await popupB.close();

  // Pressing it: the video turns up in a frame, and joins the room.
  await b.tab.bringToFront();
  await b.tab.click("#start");
  await until(async () => (await b.status())?.hasVideo === true);
  check("pressing play gets the video found", (await b.status())?.hasVideo === true);
  const close = await until(async () => {
    const [x, y] = [await a.frameVideo(), await b.frameVideo()];
    return x && y && !y.paused && Math.abs(x.t - y.t) < 1 ? { a: x.t, b: y.t } : null;
  }, 15000);
  check(
    "and it catches up with the room",
    !!close,
    JSON.stringify(close ?? [await a.frameVideo(), await b.frameVideo()]),
  );
  await wait(600);
  await b.tab.screenshot({ path: join(shotDir, "facade-joined.png") });

  // A new episode opened in a room well along: it must start from its own beginning.
  await a.frameVideo();
  const f = a.tab.frames().find((x) => x.url().includes("/player"));
  await f.evaluate(() => {
    window.v.currentTime = 600;
  });
  await until(async () => (await b.frameVideo())?.t > 590, 15000);
  check(
    "the room is well along",
    (await b.frameVideo())?.t > 590,
    JSON.stringify(await b.frameVideo()),
  );
  await a.tab.goto(WEB + "/episode?id=2");
  await wait(1200);
  await a.tab.click("#start");
  await until(() => a.frameVideo()?.then((v) => v && !v.paused));
  let furthest = 0;
  for (let i = 0; i < 20; i += 1) {
    furthest = Math.max(furthest, (await a.frameVideo())?.t ?? 0);
    await wait(200);
  }
  check(
    "a new episode starts from its beginning, not the room's position",
    furthest < 15,
    String(furthest),
  );
  check(
    "and it says this is a different video",
    (await a.status())?.videoChange?.kind === "you_moved",
    JSON.stringify((await a.status())?.videoChange),
  );
  await a.tab.screenshot({ path: join(shotDir, "facade-new-episode.png") });
  const roomKeptOn = await b.frameVideo();
  check("while the room stays where it was", roomKeptOn?.t > 590, JSON.stringify(roomKeptOn));

  // Browsing on another page in the room isn't nagged.
  const c = await viewer("c", "/elsewhere");
  const cBefore = await c.tab.screenshot({ clip });
  await c.join(code);
  await until(async () => (await c.status())?.peers === 3);
  await wait(3000);
  const cStatus = await c.status();
  check(
    "someone on another page isn't asked to press anything",
    cStatus.isOnRoomPage === false,
    String(cStatus.isOnRoomPage),
  );
  check(
    "so nothing appears on it",
    Buffer.compare(cBefore, await c.tab.screenshot({ clip })) === 0,
  );

  // A feed's preview under the pointer, for someone in the room with the room playing.
  const d = await viewer("d", "/feed");
  const heard = [];
  const ws = new WebSocket(API.replace("http", "ws") + "/rooms/" + code + "/ws");
  await new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => {
    if (e.data === "keepalive") return;
    const m = JSON.parse(e.data);
    if (m.type === "state") heard.push(m);
  });
  ws.send(JSON.stringify({ type: "join", protocol: 1, viewer: "listener" }));
  await d.join(code);
  await until(async () => (await d.status())?.connection === "connected");
  await wait(1500);
  heard.length = 0;
  await d.tab.bringToFront();
  await d.tab.mouse.move(200, 200);
  await until(() => d.tab.evaluate(() => !window.v.paused));
  await wait(2000);
  const hovered = await d.status();
  const previewAt = await d.tab.evaluate(() => window.v.currentTime);
  check(
    "a preview under the pointer doesn't count as a video",
    hovered.hasVideo === false,
    JSON.stringify({ v: hovered.hasVideo, h: hovered.hold }),
  );
  check("and isn't sent to the room's position", previewAt < 10, String(previewAt));
  await d.tab.mouse.move(800, 600);
  await wait(2000);
  check(
    "the pointer leaving, which stops it, doesn't pause the room",
    heard.filter((m) => !m.playing).length === 0,
    JSON.stringify(heard.map((m) => m.playing)),
  );
  check("and the room is still playing", !(await b.frameVideo()).paused);

  // Clicking it says it's what they came for.
  await d.tab.mouse.move(200, 200);
  await until(() => d.tab.evaluate(() => !window.v.paused));
  await d.tab.mouse.down();
  await d.tab.mouse.up();
  await wait(1500);
  check("clicking a preview makes it a video", (await d.status()).hasVideo === true);

  // A muted film opened by clicking: the pointer rests where the player then appears.
  const e = await viewer("e", "/elsewhere");
  await e.tab.bringToFront();
  await e.tab.mouse.move(200, 150);
  await e.join(code);
  await until(async () => (await e.status())?.connection === "connected");
  await e.tab.goto(WEB + "/mutedfilm");
  await e.tab.mouse.move(201, 151);
  await wait(3000);
  const mutedFilm = await e.status();
  check(
    "a muted film under the resting pointer is a video, not a preview",
    mutedFilm?.hasVideo === true,
    JSON.stringify({ v: mutedFilm?.hasVideo, h: mutedFilm?.hold }),
  );
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error).slice(0, 500));
} finally {
  await Promise.all(all.map((c) => Promise.race([c.close().catch(() => {}), wait(5000)])));
  web.close();
  try {
    console.log("cleanup:", stopServers());
  } catch {}
  console.log(failures ? failures + " FAILED" : "all passed");
  process.exit(failures ? 1 : 0);
}
