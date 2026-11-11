// One person on a connection too slow for the video, whose player pauses itself to buffer, as
// some players do. The room must keep playing for everyone else: a slow connection is that
// person's, not something to stop the room for, again and again.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import {
  config,
  enableDeveloperMode,
  openExtensionPage,
  startServer,
  stopServers,
} from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath } = config;

const API = "http://localhost:8824";
const WEB = "http://localhost:8855";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? " -> " + detail : ""}`);
};
async function until(fn, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await wait(200);
  }
  return last;
}

// Ten minutes of silent 22 kHz 16-bit WAV: 44,100 bytes for each second of film. Chromium reads
// about 300 KB before it says how long a film is, which at this rate is a few seconds of it.
const rate = 22050,
  seconds = 600,
  bytesPerSecond = rate * 2;
const film = Buffer.alloc(44 + bytesPerSecond * seconds, 0);
film.write("RIFF", 0);
film.writeUInt32LE(36 + bytesPerSecond * seconds, 4);
film.write("WAVEfmt ", 8);
film.writeUInt32LE(16, 16);
film.writeUInt16LE(1, 20);
film.writeUInt16LE(1, 22);
film.writeUInt32LE(rate, 24);
film.writeUInt32LE(bytesPerSecond, 28);
film.writeUInt16LE(2, 32);
film.writeUInt16LE(16, 34);
film.write("data", 36);
film.writeUInt32LE(bytesPerSecond * seconds, 40);

/** The slow one's film arrives at half the speed it plays, so it keeps running dry. */
const SLOW_BYTES_PER_SECOND = bytesPerSecond / 2;
/** Enough at once for the player to read the film and start. */
const QUICK_BYTES = 320_000;
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
    if (url.searchParams.get("slow") === null) return res.end(film.subarray(start, end + 1));
    // The start comes at once, so the player can read the film and start; the rest a little at a
    // time, a tenth of a second's worth of what the slow connection carries.
    const quick = Math.min(end + 1, Math.max(start, QUICK_BYTES));
    if (quick > start) res.write(film.subarray(start, quick));
    let at = Math.max(start, quick);
    const chunk = SLOW_BYTES_PER_SECOND / 10;
    const timer = setInterval(() => {
      if (res.destroyed || at > end) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(film.subarray(at, Math.min(at + chunk, end + 1)));
      at += chunk;
    }, 100);
    res.on("close", () => clearInterval(timer));
    return;
  }
  const slow = url.searchParams.get("slow") !== null;
  res.writeHead(200, { "Content-Type": "text/html" });
  // The slow one's player pauses when it runs dry and plays again once it has data, as some
  // players do. It counts its own pauses, so the test knows the case really came up.
  res.end(
    `<!doctype html><meta charset=utf-8><title>Film</title><body style="margin:0;background:#333"><video src="/film.wav${slow ? "?slow" : ""}" width=800 height=450 preload=auto></video>` +
      (slow
        ? `<script>const v=document.querySelector("video");window.ownPauses=0;let held=false;v.addEventListener("waiting",()=>{if(!v.paused){held=true;window.ownPauses++;v.pause();}});v.addEventListener("canplay",()=>{if(held){held=false;v.play();}});</script>`
        : ""),
  );
});
await new Promise((r) => web.listen(8855, r));
startServer("8824");
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

async function viewer(name, path) {
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), `sinkro-buffering-${name}-`)),
    {
      channel: config.channel,
      headless: false,
      viewport: { width: 1000, height: 650 },
      locale: "en-US",
      args: [
        "--headless=new",
        "--mute-audio",
        "--autoplay-policy=no-user-gesture-required",
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ],
    },
  );
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup.html`;
  await enableDeveloperMode(context);
  const control = await context.newPage();
  await openExtensionPage(control, popupUrl);
  await control.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl }), API);
  const page = await context.newPage();
  await page.goto(`${WEB}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("video").duration > 0);
  await page.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  return {
    context,
    page,
    join: (code) =>
      control.evaluate(
        ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
        [tabId, code],
      ),
    status: () =>
      control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "session/status" }), tabId),
  };
}

const contexts = [];
try {
  const { code } = await (
    await fetch(`${API}/rooms`, { method: "POST", headers: { "CF-Connecting-IP": "buffering" } })
  ).json();
  const fast = await viewer("fast", "/film");
  contexts.push(fast.context);
  const slow = await viewer("slow", "/film?slow");
  contexts.push(slow.context);
  await fast.join(code);
  await until(async () => (await fast.status())?.connection === "connected");
  await slow.join(code);
  await until(async () => (await fast.status())?.peers === 2);

  // The fast one plays, as a person would.
  await fast.page.bringToFront();
  await fast.page.keyboard.press("Shift");
  await fast.page.evaluate(() => document.querySelector("video").play());
  check(
    "the room plays",
    await until(async () => (await fast.status())?.paused === false),
    JSON.stringify(await fast.status()),
  );

  // Half a minute of the slow one running dry and pausing itself, over and over.
  let roomPaused = 0;
  let fastPaused = 0;
  for (let second = 0; second < 30; second += 1) {
    await wait(1000);
    const status = await fast.status();
    if (status?.paused !== false) roomPaused += 1;
    if (await fast.page.evaluate(() => document.querySelector("video").paused)) fastPaused += 1;
  }
  const ownPauses = await slow.page.evaluate(() => window.ownPauses);
  check(
    "the slow one's player really did pause itself to buffer",
    ownPauses > 0,
    `${ownPauses} times`,
  );
  check("the room never paused", roomPaused === 0, `${roomPaused} of 30 seconds`);
  check("the fast one's video never stopped", fastPaused === 0, `${fastPaused} of 30 seconds`);
  // Pausing and playing as its data comes and goes, but never far from where the room is.
  const [fastAt, slowStatus] = [await fast.status(), await slow.status()];
  check(
    "the slow one is still in the room, a few seconds at most behind it",
    slowStatus?.connection === "connected" &&
      Math.abs((fastAt?.position ?? 0) - (slowStatus.position ?? 0)) < 5,
    JSON.stringify([fastAt?.position, slowStatus?.position, slowStatus?.connection]),
  );
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error).slice(0, 400));
} finally {
  for (const context of contexts) await Promise.race([context.close().catch(() => {}), wait(5000)]);
  web.close();
  try {
    stopServers();
  } catch {}
}
console.log(failures === 0 ? "all passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
