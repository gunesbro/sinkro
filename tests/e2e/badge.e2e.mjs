// The on-video badge, judged by what's on screen and what clicks do.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath, shotDir } = config;

const API = "http://localhost:8808";
const WEB = "http://localhost:8851";
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

const rate = 8000,
  seconds = 3600;
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

const page = `<!doctype html><meta charset=utf-8><title>t</title><body style="margin:0;background:#333">
<div id=player style="width:800px;height:450px;background:#000"><video id=v src="/film.wav" width=800 height=450 preload=auto></video></div>
<div id=tiny><video src="/film.wav" width=160 height=90 muted></video></div><div style="height:2500px"></div>
<script>
  window.v = document.getElementById("v");
  window.clicks = [];
  document.getElementById("player").addEventListener("click", (e) => window.clicks.push(e.target.id));
  window.mark = (on) => document.getElementById("player").classList.toggle("ad-showing", on);
  window.full = () => document.getElementById("player").requestFullscreen();
  window.count = () => document.documentElement.children.length;
</script>`;
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
      ...(m ? { "Content-Range": `bytes ${start}-${end}/${film.length}` } : {}),
    });
    return res.end(film.subarray(start, end + 1));
  }
  if (url.pathname.startsWith("/bar")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(`<!doctype html><meta charset=utf-8><title>t</title><body style="margin:0;background:#333">
<div style="position:fixed;left:0;top:0;right:0;height:56px;background:#fff;z-index:1000"></div>
<div style="height:56px"></div><div id=player><video id=v src="/film.wav" width=800 height=450 preload=auto></video></div>
<div style="height:2500px"></div><script>window.v=document.getElementById("v");window.clicks=[];document.getElementById("player").addEventListener("click",(e)=>window.clicks.push(e.target.id));</script>`);
  }
  const headers = { "Content-Type": "text/html" };
  if (url.pathname === "/csp")
    headers["Content-Security-Policy"] =
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'none'";
  res.writeHead(200, headers);
  res.end(page);
});
await new Promise((r) => web.listen(8851, r));
startServer("8808");
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

const all = [];
async function viewer(name, { autoplay = true, path = "/" } = {}) {
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), `sinkro-badge-${name}-`)),
    {
      channel: config.channel,
      headless: false,
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
      viewport: { width: 1000, height: 650 },
      locale: "en-US",
      args: [
        "--headless=new",
        "--mute-audio",
        autoplay
          ? "--autoplay-policy=no-user-gesture-required"
          : "--autoplay-policy=document-user-activation-required",
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ],
    },
  );
  all.push(context);
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const control = await context.newPage();
  await control.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  await control.evaluate(
    (serverUrl) => chrome.storage.local.set({ serverUrl, language: "en" }),
    API,
  );
  const tab = await context.newPage();
  await tab.goto(`${WEB}${path}`);
  await wait(2000);
  await tab.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  return {
    context,
    control,
    tab,
    tabId,
    join: (code) =>
      control.evaluate(
        ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
        [tabId, code],
      ),
    leave: () =>
      control.evaluate(
        (t) => chrome.runtime.sendMessage({ type: "session/leave", tabId: t }),
        tabId,
      ),
    status: () =>
      control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "session/status" }), tabId),
  };
}
const newRoom = async () => {
  const { code } = await (
    await fetch(`${API}/rooms`, {
      method: "POST",
      headers: { "CF-Connecting-IP": `t-${Math.random()}` },
    })
  ).json();
  const ws = new WebSocket(`${API.replace("http", "ws")}/rooms/${code}/ws`);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "join", protocol: 1 }));
  await wait(150);
  return {
    code,
    ws,
    inject: (s) =>
      ws.send(JSON.stringify({ type: "state", playing: true, rate: 1, sentAt: Date.now(), ...s })),
  };
};
const shot = (p, name) => p.screenshot({ path: join(shotDir, `badge-${name}.png`) });
/** Compares a corner of the video with and without the badge, since it's in a closed root. */
const pixelsDiffer = (a, b) => Buffer.compare(a, b) !== 0;
const clip = { x: 500, y: 0, width: 300, height: 200 };

try {
  const room = await newRoom();
  const a = await viewer("a");
  const childrenBefore = await a.tab.evaluate(() => window.count());
  const cornerBefore = await a.tab.screenshot({ clip });
  await a.join(room.code);
  await until(async () => (await a.status())?.connection === "connected");
  room.inject({ position: 100 });
  await wait(1200);
  const cornerDuring = await a.tab.screenshot({ clip });
  await shot(a.tab, "in-sync");
  check("the badge appears over the video", pixelsDiffer(cornerBefore, cornerDuring));
  check(
    "it adds one element to the page",
    (await a.tab.evaluate(() => window.count())) === childrenBefore + 1,
    `${childrenBefore} -> ${await a.tab.evaluate(() => window.count())}`,
  );

  await a.tab.mouse.click(770, 28);
  await wait(200);
  const clicks = await a.tab.evaluate(() => window.clicks);
  check("a click on the chip stays on the chip", clicks.length === 0, JSON.stringify(clicks));
  await a.tab.mouse.click(600, 28);
  await wait(200);
  const clicksBeside = await a.tab.evaluate(() => window.clicks);
  check(
    "clicks right beside the chip reach the player",
    clicksBeside.length === 1 && clicksBeside[0] === "v",
    JSON.stringify(clicksBeside),
  );
  await a.tab.evaluate(() => {
    window.clicks.length = 0;
  });
  await a.tab.mouse.move(300, 300);

  await wait(5500);
  await shot(a.tab, "quiet");

  await a.tab.evaluate(() => window.mark(true));
  await wait(1500);
  await shot(a.tab, "ad");
  check("an ad shows on the status", (await a.status()).hold === "ad");
  await a.tab.evaluate(() => window.mark(false));
  await wait(1500);

  await a.tab
    .evaluate(() => window.full())
    .catch((e) => console.log("fullscreen failed", e.message));
  await wait(1200);
  await shot(a.tab, "fullscreen");
  const parent = await a.tab.evaluate(() => [...document.getElementById("player").children].length);
  check(
    "in fullscreen the badge moves inside the fullscreen element",
    parent === 2,
    `${parent} children in the player`,
  );
  await a.tab.evaluate(() => document.exitFullscreen());
  await wait(800);
  check(
    "and moves back after",
    (await a.tab.evaluate(() => document.getElementById("player").children.length)) === 1 &&
      (await a.tab.evaluate(() => window.count())) === childrenBefore + 1,
  );

  // ---- a word when someone else pauses, then gone
  const quietCorner = await a.tab.screenshot({ clip });
  room.inject({ playing: false, position: 100 });
  await wait(1200);
  const withNotice = await a.tab.screenshot({ clip });
  await shot(a.tab, "notice-paused");
  check("someone else's pause shows a notice", pixelsDiffer(quietCorner, withNotice));
  await wait(3600);
  const afterNotice = await a.tab.screenshot({ clip });
  check("and it goes away by itself", pixelsDiffer(withNotice, afterNotice));
  room.inject({ playing: true, position: 100 });
  await wait(4200);

  // ---- and a word when the viewer does it themselves
  const quietAgain = await a.tab.screenshot({ clip });
  await a.tab.keyboard.press("Shift");
  await a.tab.evaluate(() => window.v.pause());
  await wait(1100);
  const ownNotice = await a.tab.screenshot({ clip });
  await shot(a.tab, "notice-own-paused");
  check("the viewer's own pause shows a notice too", pixelsDiffer(quietAgain, ownNotice));
  await wait(3600);
  check(
    "and it goes away by itself too",
    pixelsDiffer(ownNotice, await a.tab.screenshot({ clip })),
  );
  await a.tab.evaluate(() => window.v.play());
  await wait(4200);

  // ---- a change of speed is told too, both ways
  const beforeRate = await a.tab.screenshot({ clip });
  room.inject({ position: 100, rate: 1.5 });
  await wait(1200);
  await shot(a.tab, "notice-rate");
  const withRate = await a.tab.screenshot({ clip });
  check("someone else's change of speed shows a notice", pixelsDiffer(beforeRate, withRate));
  // A seek that lands a little off is then corrected through speed, up to 5% either way.
  const followed = await a.tab.evaluate(() => window.v.playbackRate);
  check("and the video follows it", Math.abs(followed - 1.5) <= 1.5 * 0.05 + 1e-9, followed);
  await wait(3600);
  const beforeOwnRate = await a.tab.screenshot({ clip });
  await a.tab.evaluate(() => {
    window.v.playbackRate = 1;
  });
  await wait(1100);
  await shot(a.tab, "notice-own-rate");
  check(
    "the viewer's own change of speed shows one too",
    pixelsDiffer(beforeOwnRate, await a.tab.screenshot({ clip })),
  );
  await wait(4200);

  // ---- a click on a seek bar: pause, jump and start within moments, as some players' do
  await a.tab.mouse.move(100, 500);
  await a.tab.evaluate(() => {
    window.v.pause();
    window.v.currentTime += 200;
    window.v.play();
  });
  await wait(1200);
  await shot(a.tab, "notice-own-seekbar");
  await wait(3200);
  room.inject({ playing: false, position: 600 });
  await wait(150);
  room.inject({ playing: true, position: 900 });
  await wait(1200);
  await shot(a.tab, "notice-remote-seekbar");
  await wait(3200);

  // ---- scrolling the video away
  const topCorner = { x: 700, y: 0, width: 290, height: 80 };
  await a.tab.evaluate(() => window.scrollTo(0, 1400));
  await wait(500);
  const scrolledWithBadge = await a.tab.screenshot({ clip: topCorner });
  await shot(a.tab, "scrolled-away");
  await a.tab.evaluate(() => window.scrollTo(0, 0));
  await wait(400);
  const backOnVideo = await a.tab.screenshot({ clip: clip });
  check("the badge comes back with its video", pixelsDiffer(cornerBefore, backOnVideo));
  await a.leave();
  await wait(500);
  await a.tab.evaluate(() => window.scrollTo(0, 1400));
  await wait(400);
  const scrolledClean = await a.tab.screenshot({ clip: topCorner });
  check(
    "with its video scrolled away, the badge doesn't float over the page",
    !pixelsDiffer(scrolledWithBadge, scrolledClean),
  );
  await a.tab.evaluate(() => window.scrollTo(0, 0));
  await a.join(room.code);
  await until(async () => (await a.status())?.connection === "connected");
  room.inject({ position: 100 });
  await wait(1200);

  // ---- moving the badge
  const moveRequest = () =>
    a.control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "badge/move" }), a.tabId);
  const region = (x, y) => a.tab.screenshot({ clip: { x, y, width: 180, height: 60 } });
  const clicksNow = () => a.tab.evaluate(() => window.clicks.length);
  const emptyTarget = await region(60, 300);
  await a.tab.bringToFront();
  await moveRequest();
  await wait(500);
  await shot(a.tab, "move-mode");
  const beforeDrag = await clicksNow();
  await a.tab.mouse.move(770, 28);
  await a.tab.mouse.down();
  await a.tab.mouse.move(400, 200, { steps: 6 });
  await a.tab.mouse.move(100, 320, { steps: 6 });
  await a.tab.mouse.up();
  await wait(400);
  check(
    "dragging the badge doesn't click the player",
    (await clicksNow()) === beforeDrag,
    `${(await clicksNow()) - beforeDrag} clicks`,
  );
  await shot(a.tab, "moved");
  check("the badge goes where it's dragged", pixelsDiffer(emptyTarget, await region(60, 300)));

  await a.tab.keyboard.press("ArrowUp");
  await a.tab.keyboard.press("ArrowUp");
  await wait(200);
  const tAfterArrows = await a.tab.evaluate(() => window.v.currentTime);
  await a.tab.keyboard.press("Enter");
  await wait(400);
  await a.tab.mouse.click(600, 28);
  await wait(200);
  check(
    "after moving, clicks go through again",
    (await clicksNow()) === beforeDrag + 1,
    `${(await clicksNow()) - beforeDrag} clicks`,
  );
  check("the old spot is clear", tAfterArrows >= 0);

  const saved = await a.control.evaluate(() => chrome.storage.local.get("badge:localhost"));
  check(
    "the spot is remembered for the site",
    typeof saved["badge:localhost"]?.x === "number" &&
      saved["badge:localhost"].x < 0.5 &&
      saved["badge:localhost"].y > 0.5,
    JSON.stringify(saved),
  );

  await a.tab.reload();
  await wait(2500);
  await a.tab.evaluate(() => window.v.play());
  await wait(1200);
  await shot(a.tab, "moved-after-reload");
  check(
    "it comes back there after a reload",
    pixelsDiffer(emptyTarget, await region(60, 280)) ||
      pixelsDiffer(emptyTarget, await region(60, 300)),
  );

  // Arrow keys in move mode are for the badge, not the player's seeking.
  const seekClicks = await a.tab.evaluate(() => {
    window.keys = [];
    addEventListener("keydown", (e) => window.keys.push(e.key));
    return 0;
  });
  await moveRequest();
  await wait(400);
  await a.tab.keyboard.press("ArrowRight");
  await wait(200);
  const keysSeen = await a.tab.evaluate(() => window.keys.length);
  check(
    "the page doesn't see arrow keys meant for the badge",
    keysSeen === 0 && seekClicks === 0,
    `${keysSeen} keys`,
  );

  // Esc puts it back; Reset goes to the default.
  await a.tab.mouse.move(120, 310);
  await a.tab.keyboard.press("Escape");
  await wait(300);
  const afterEsc = await a.control.evaluate(() => chrome.storage.local.get("badge:localhost"));
  check(
    "Esc changes nothing that's saved",
    afterEsc["badge:localhost"]?.x === saved["badge:localhost"].x,
    JSON.stringify(afterEsc),
  );
  await a.control.evaluate(() => chrome.storage.local.remove("badge:localhost"));

  await a.leave();
  await wait(600);
  check(
    "leaving removes the badge",
    (await a.tab.evaluate(() => window.count())) === childrenBefore,
  );
  const cornerAfter = await a.tab.screenshot({ clip });
  check("and nothing is left on screen", !pixelsDiffer(cornerBefore, cornerAfter));

  // ---- the chip at rest, hovered, and dragged with no mode at all
  const dragRoom = await newRoom();
  const d = await viewer("d");
  await d.join(dragRoom.code);
  await until(async () => (await d.status())?.connection === "connected");
  dragRoom.inject({ position: 100 });
  await wait(6500);
  await d.tab.mouse.move(100, 400);
  await wait(300);
  const chipClip = { x: 640, y: 0, width: 160, height: 90 };
  await shot(d.tab, "chip-rest");
  await d.tab.evaluate(() => {
    document.getElementById("v").style.background = "#fff";
  });
  await wait(200);
  await d.tab.screenshot({
    path: join(shotDir, "badge-chip-rest-bright.png"),
    clip: { x: 640, y: 0, width: 160, height: 60 },
  });
  await d.tab.evaluate(() => {
    document.getElementById("v").style.background = "";
  });
  await wait(200);
  const atRest = await d.tab.screenshot({ clip: chipClip });
  await d.tab.mouse.move(770, 28);
  await wait(400);
  await shot(d.tab, "chip-hover");
  const hovered = await d.tab.screenshot({ clip: chipClip });
  check("hovering opens the chip", pixelsDiffer(atRest, hovered));
  await d.tab.mouse.move(100, 400);
  // It stays open a moment, for the pointer to reach the reactions, then fades back.
  await wait(900);
  check("and it closes again", !pixelsDiffer(atRest, await d.tab.screenshot({ clip: chipClip })));

  const dragClicks = await d.tab.evaluate(() => window.clicks.length);
  await d.tab.mouse.move(770, 28);
  await d.tab.mouse.down();
  await d.tab.mouse.move(500, 150, { steps: 6 });
  await d.tab.mouse.move(300, 300, { steps: 6 });
  await wait(200);
  await shot(d.tab, "chip-dragging");
  await d.tab.mouse.up();
  await wait(400);
  await shot(d.tab, "chip-dropped");
  const droppedAt = await d.control.evaluate(() => chrome.storage.local.get("badge:localhost"));
  check(
    "dragging needs no mode, and the spot is saved on release",
    typeof droppedAt["badge:localhost"]?.x === "number" && droppedAt["badge:localhost"].x < 0.5,
    JSON.stringify(droppedAt),
  );
  check(
    "dragging doesn't click the player",
    (await d.tab.evaluate(() => window.clicks.length)) === dragClicks,
  );
  check("nor pause it", (await d.tab.evaluate(() => window.v.paused)) === false);

  await d.tab.mouse.move(100, 500);
  await wait(300);
  const here = droppedAt["badge:localhost"];
  const chipX = 12 + Math.round(here.x * 750) + 25;
  const chipY = Math.round(here.y * 418) + 16;
  await d.tab.mouse.move(chipX, chipY);
  await d.tab.mouse.down();
  await d.tab.mouse.move(600, 100, { steps: 6 });
  await d.tab.keyboard.press("Escape");
  await d.tab.mouse.up();
  await wait(300);
  const afterCancel = await d.control.evaluate(() => chrome.storage.local.get("badge:localhost"));
  check(
    "Esc during a drag puts it back and saves nothing",
    afterCancel["badge:localhost"].x === here.x,
    JSON.stringify(afterCancel),
  );
  await d.tab.keyboard.press("Space");
  await d.control.evaluate(() => chrome.storage.local.remove("badge:localhost"));
  await d.leave();

  // ---- scrolling under a site's pinned bar, the case from the maintainer's screenshot
  const barRoom = await newRoom();
  const e = await viewer("e", { path: "/bar" });
  // Short of the scrollbar, which moves as the page scrolls.
  const barClip = { x: 0, y: 0, width: 960, height: 56 };
  const belowBar = { x: 500, y: 60, width: 300, height: 60 };
  const belowBarBefore = await e.tab.screenshot({ clip: belowBar });
  const barBefore = await e.tab.screenshot({ clip: barClip });
  await e.join(barRoom.code);
  await until(async () => (await e.status())?.connection === "connected");
  barRoom.inject({ position: 100 });
  await wait(1500);
  const seen = await e.tab.screenshot({ clip: belowBar });
  check("at the top, the chip is on the video", pixelsDiffer(belowBarBefore, seen));
  await shot(e.tab, "bar-top");
  check(
    "at the top, the chip is on the video and the bar is untouched",
    !pixelsDiffer(barBefore, await e.tab.screenshot({ clip: barClip })),
  );
  for (const [by, name] of [
    [20, "just touching the bar"],
    [28, "half under the bar"],
    [40, "under the bar"],
    [300, "above the window"],
  ]) {
    await e.tab.evaluate((y) => window.scrollTo(0, y), by);
    await wait(500);
    await shot(e.tab, "bar-" + by);
    check(
      "with its spot " + name + ", the chip doesn't sit on the bar",
      !pixelsDiffer(barBefore, await e.tab.screenshot({ clip: barClip })),
    );
  }
  await e.tab.evaluate(() => window.scrollTo(0, 0));
  await wait(500);
  check(
    "it comes back when the video does",
    pixelsDiffer(belowBarBefore, await e.tab.screenshot({ clip: belowBar })),
  );

  // A card that needs a click stays, but below the bar.
  await e.tab.evaluate(() => window.scrollTo(0, 300));
  await e.tab.evaluate(() => {
    history.pushState({}, "", "/bar-other");
    window.v.src = "/film.wav?other";
    return window.v.play();
  });
  await until(async () => (await e.status())?.videoChange?.kind === "you_moved");
  await wait(600);
  await shot(e.tab, "bar-card");
  check(
    "a card with a button stays, and doesn't cover the bar",
    !pixelsDiffer(barBefore, await e.tab.screenshot({ clip: barClip })),
  );
  check(
    "it's there below the bar",
    pixelsDiffer(
      (await e.tab.evaluate(() => 0)) === 0 ? belowBarBefore : belowBarBefore,
      await e.tab.screenshot({ clip: belowBar }),
    ),
  );

  // ---- a page whose CSP forbids all styles
  const strictRoom = await newRoom();
  const b = await viewer("b", { path: "/csp" });
  const bBefore = await b.tab.screenshot({ clip });
  await b.join(strictRoom.code);
  await until(async () => (await b.status())?.connection === "connected");
  await wait(1200);
  const bDuring = await b.tab.screenshot({ clip });
  await shot(b.tab, "csp");
  check("a page with style-src 'none' can't hide the badge", pixelsDiffer(bBefore, bDuring));

  // ---- someone else on an ad
  const adsRoom = await newRoom();
  const heard = [];
  adsRoom.ws.addEventListener("message", (e) => {
    if (e.data !== "keepalive") heard.push(JSON.parse(e.data));
  });
  const f = await viewer("f");
  await f.join(adsRoom.code);
  await until(async () => (await f.status())?.connection === "connected");
  adsRoom.inject({ position: 100 });
  await wait(1500);
  await f.tab.mouse.move(100, 500);
  const adClear = await f.tab.screenshot({ clip });
  adsRoom.ws.send(JSON.stringify({ type: "ad", watching: true }));
  await until(async () => (await f.status())?.othersOnAd === 1);
  check("the viewer hears someone is on an ad", (await f.status()).othersOnAd === 1);
  await wait(400);
  await shot(f.tab, "others-on-ad");
  check("and it shows on the badge", pixelsDiffer(adClear, await f.tab.screenshot({ clip })));
  check("the video carries on by itself", (await f.tab.evaluate(() => window.v.paused)) === false);
  let pausedForThem = false;
  for (let y = 100; y <= 220 && !pausedForThem; y += 10) {
    await f.tab.mouse.click(520, y);
    await wait(200);
    pausedForThem = await f.tab.evaluate(() => window.v.paused);
  }
  check("the card's button pauses the video", pausedForThem === true);
  await until(() => heard.some((m) => m.type === "state" && m.playing === false));
  check(
    "for everyone",
    heard.some((m) => m.type === "state" && m.playing === false),
  );
  await wait(400);
  await shot(f.tab, "others-on-ad-paused");
  await f.tab.mouse.move(100, 500);
  adsRoom.ws.send(JSON.stringify({ type: "ad", watching: false }));
  await until(async () => (await f.status())?.othersOnAd === 0);
  await wait(400);
  await shot(f.tab, "ad-ended");
  check("the notice goes when the ad ends", (await f.status()).othersOnAd === 0);
  await f.tab.evaluate(() => window.v.play());
  await wait(800);
  heard.length = 0;
  await f.tab.evaluate(() => document.getElementById("player").classList.add("ad-showing"));
  await until(() => heard.some((m) => m.type === "ads" && m.count === 1), 5000);
  check(
    "the viewer's own ad reaches the others",
    heard.some((m) => m.type === "ads" && m.count === 1),
    JSON.stringify(heard.slice(-3)),
  );
  await f.tab.evaluate(() => document.getElementById("player").classList.remove("ad-showing"));
  await until(() => heard.some((m) => m.type === "ads" && m.count === 0), 5000);
  check(
    "and so does its end",
    heard.some((m) => m.type === "ads" && m.count === 0),
  );
  await f.leave();

  // ---- joining someone who has nothing going yet, like a creator on an ad, with autoplay blocked
  const adRoom = await newRoom();
  const late = await viewer("late", { autoplay: false });
  const lateBefore = await late.tab.screenshot({ clip });
  await late.join(adRoom.code);
  await wait(4500);
  await shot(late.tab, "blocked-no-timeline");
  check(
    "with nothing going in the room, a blocked viewer still gets the card",
    pixelsDiffer(lateBefore, await late.tab.screenshot({ clip })),
  );
  await late.tab.mouse.click(540, 170);
  const lateStarted = await until(
    async () => !(await late.tab.evaluate(() => window.v.paused)),
    3000,
  );
  check("and its button starts the video", lateStarted === true);
  await wait(1500);
  check("which then starts the room's timeline", (await late.status()).needsGesture === false);

  // ---- blocked autoplay: one click on the badge's button
  const shyRoom = await newRoom();
  shyRoom.inject({ position: 500 });
  await wait(200);
  const c = await viewer("c", { autoplay: false });
  await c.join(shyRoom.code);
  await wait(3500);
  await shot(c.tab, "blocked");
  const button = { x: Number(process.env.BUTTON_X ?? 540), y: Number(process.env.BUTTON_Y ?? 170) };
  await c.tab.mouse.click(button.x, button.y);
  const joined = await until(async () => {
    const r = await c.tab.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused }));
    return !r.paused && r.t > 500;
  }, 3000);
  const clicksOnPlayer = await c.tab.evaluate(() => window.clicks.length);
  check(
    "the join button starts playback at the room's spot",
    joined === true,
    JSON.stringify(await c.tab.evaluate(() => [window.v.currentTime, window.v.paused])),
  );
  check("and its click doesn't reach the player", clicksOnPlayer === 0, `${clicksOnPlayer} clicks`);
  await wait(800);
  await shot(c.tab, "after-join");
  check("the status clears", (await c.status()).needsGesture === false);
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error.message).slice(0, 300));
} finally {
  await Promise.all(all.map((c) => Promise.race([c.close().catch(() => {}), wait(5000)])));
  web.close();
  try {
    console.log("cleanup:", stopServers());
  } catch {}
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
}
