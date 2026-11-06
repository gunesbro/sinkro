// Two people on players of different lengths, or on different players, get told so.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath, shotDir } = config;

const API = "http://localhost:8821";
const WEB = "http://localhost:8852";
const OTHER = "http://127.0.0.1:8852";
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
const shortSeconds = 600;
const short = Buffer.alloc(44 + rate * shortSeconds, 128);
short.write("RIFF", 0);
short.writeUInt32LE(36 + rate * shortSeconds, 4);
short.write("WAVEfmt ", 8);
short.writeUInt32LE(16, 16);
short.writeUInt16LE(1, 20);
short.writeUInt16LE(1, 22);
short.writeUInt32LE(rate, 24);
short.writeUInt32LE(rate, 28);
short.writeUInt16LE(1, 32);
short.writeUInt16LE(8, 34);
short.write("data", 36);
short.writeUInt32LE(rate * shortSeconds, 40);
const web = createServer((req, res) => {
  const url = new URL(req.url, WEB);
  if (url.pathname === "/short.wav") {
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": short.length });
    return res.end(short);
  }
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
  if (url.pathname === "/short")
    return res.end(
      '<!doctype html><meta charset=utf-8><title>p</title><body style="margin:0;background:#000"><video id=v src="/short.wav" width=780 height=420 autoplay></video><script>window.v=document.getElementById("v");</script>',
    );
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
await new Promise((r) => web.listen(8852, r));
startServer("8821");
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
      .find((f) => f.url().includes("/player") || f.url().includes("/short"))
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
  // Each picks a player: the first from this site, the second from another, a different cut.
  const a = await viewer("a", "/episode?id=1");
  await a.tab.evaluate((src) => {
    document.getElementById("box").innerHTML =
      '<iframe src="' + src + '" width=800 height=440 allow="autoplay" style="border:0"></iframe>';
  }, WEB + "/player");
  await until(() => a.frameVideo()?.then((v) => v && !v.paused));
  const { code } = await (
    await fetch(API + "/rooms", { method: "POST", headers: { "CF-Connecting-IP": "source" } })
  ).json();
  await a.join(code);
  await until(
    async () => (await a.status())?.connection === "connected" && (await a.status())?.hasVideo,
  );
  await wait(2500);

  const b = await viewer("b", "/episode?id=1");
  await b.tab.evaluate((src) => {
    document.getElementById("box").innerHTML =
      '<iframe src="' + src + '" width=800 height=440 allow="autoplay" style="border:0"></iframe>';
  }, WEB + "/short");
  await b.join(code);
  await until(async () => (await b.status())?.peers === 2 && (await b.status())?.hasVideo);
  await a.tab.evaluate(() => {});
  const af = a.tab.frames().find((x) => x.url().includes("/player"));
  await af.evaluate(() => {
    window.v.pause();
  });
  await wait(300);
  await af.evaluate(() => window.v.play());
  const mismatch = await until(async () => (await b.status())?.sourceMismatch, 10000);
  check("a different cut in the room is noticed", !!mismatch, JSON.stringify(mismatch));
  check(
    "with both lengths",
    mismatch && Math.round(mismatch.mine) === 600 && Math.round(mismatch.room) === 1200,
    JSON.stringify(mismatch),
  );
  const named = await until(async () => (await b.status())?.sourceMismatch?.host, 5000);
  check(
    "and the room's player named, opened from its sealed form",
    named === "localhost",
    String(named),
  );
  await wait(600);
  await b.tab.screenshot({ path: join(shotDir, "source-card.png") });
  const popupB = await b.openPopup();
  await until(
    async () =>
      (await popupB.locator("#alert-title").innerText()) === "This may be a different source",
  );
  check(
    "the popup says the same",
    (await popupB.locator("#alert-body").innerText()).includes("localhost"),
    await popupB.locator("#alert-body").innerText(),
  );
  await popupB.close();
  const syncing = await b.status();
  check("and the sync carries on meanwhile", syncing.hold === null, String(syncing.hold));

  // The same cut as the room's: nothing to say. Checked before B does anything, because once
  // B pauses or plays, B's own state carries the other length and A is rightly told too.
  check(
    "the viewer with the room's cut isn't told anything",
    (await a.status())?.sourceMismatch === null,
    JSON.stringify((await a.status())?.sourceMismatch),
  );

  // Got it: the card goes for this pair of lengths. The card sits in a closed shadow root, so
  // its button is found by clicking down where it should be, and a miss can land on the video.
  await b.tab.bringToFront();
  let gone = false;
  for (let y = 160; y <= 230 && !gone; y += 8) {
    await b.tab.mouse.click(624, y);
    await wait(250);
    gone = (await b.status())?.sourceMismatch === null;
  }
  check("Got it puts it away", gone);
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
