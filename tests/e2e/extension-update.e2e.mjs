// An open tab after the extension is updated: the popup should still find its video.
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

const { extPath, shotDir } = config;

const API = "http://localhost:8816";
const WEB = "http://localhost:8848";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? " -> " + detail : ""}`);
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
  seconds = 600;
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
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": film.length });
    return res.end(film);
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  if (url.pathname === "/frame")
    return res.end(
      '<!doctype html><meta charset=utf-8><title>f</title><body style="margin:0"><video id=v src="/film.wav" width=700 height=400 preload=auto></video>',
    );
  if (url.pathname === "/outer")
    return res.end(
      '<!doctype html><meta charset=utf-8><title>o</title><body style="margin:0"><iframe src="/frame" width=720 height=420></iframe>',
    );
  res.end(
    '<!doctype html><meta charset=utf-8><title>Film</title><body style="margin:0"><video id=v src="/film.wav" width=800 height=450 preload=auto></video><script>window.v=document.getElementById("v");window.count=()=>document.documentElement.children.length;window.hooks=()=>{let n=0;const p=HTMLMediaElement.prototype.play;return String(p).includes("announce")?1:0;};</script>',
  );
});
await new Promise((r) => web.listen(8848, r));
startServer("8816");
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
let context;
try {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sinkro-restore-")), {
    channel: config.channel,
    headless: false,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    viewport: { width: 1000, height: 650 },
    locale: "en-US",
    args: [
      "--headless=new",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
    ],
  });
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup.html`;
  await enableDeveloperMode(context);
  let control = await context.newPage();
  await openExtensionPage(control, popupUrl);
  await control.evaluate(
    (serverUrl) => chrome.storage.local.set({ serverUrl, language: "en" }),
    API,
  );
  const tab = await context.newPage();
  await tab.goto(`${WEB}/watch`);
  const framed = await context.newPage();
  await framed.goto(`${WEB}/outer`);
  await wait(1500);
  await tab.bringToFront();
  await tab.evaluate(() => window.v.play());
  await wait(500);

  const reload = async () => {
    await control.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await wait(2500);
    control = await context.newPage();
    await openExtensionPage(control, popupUrl);
  };
  const openPopup = async (page) => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await openExtensionPage(popup, popupUrl);
    await page.bringToFront();
    await popup.reload();
    await popup.waitForSelector("main:not([hidden])");
    return popup;
  };
  const text = (popup, sel) =>
    popup
      .locator(sel)
      .first()
      .innerText()
      .catch(() => "");

  await reload();
  const childrenBefore = await tab.evaluate(() => window.count());
  check(
    "the tab's video keeps playing through the update",
    (await tab.evaluate(() => window.v.paused)) === false,
  );

  const popup = await openPopup(tab);
  const found = await until(
    async () => (await text(popup, "#found-text")) === "Found a video on this tab",
  );
  check(
    "an open tab's video is found after an update, with no refresh",
    found === true,
    await text(popup, "#found-text"),
  );
  check("and a room can be created", await popup.locator("#create").isEnabled());
  await popup.screenshot({ path: join(shotDir, "restore-popup.png") });

  await popup.click("#create");
  await until(async () => /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(await text(popup, "#room-code")));
  const code = await text(popup, "#room-code");
  const ws = new WebSocket(`${API.replace("http", "ws")}/rooms/${code}/ws`);
  await new Promise((r) => ws.addEventListener("open", r));
  let peers = 0;
  const states = [];
  ws.addEventListener("message", (e) => {
    if (e.data === "keepalive") return;
    const m = JSON.parse(e.data);
    if (m.type === "joined") peers = m.peers;
    if (m.type === "peers") peers = m.count;
    if (m.type === "state") states.push(m);
  });
  ws.send(JSON.stringify({ type: "join", protocol: 1 }));
  await until(() => peers === 2);
  check("the room counts one viewer", peers === 2, String(peers));
  check(
    "with one badge on the page",
    (await tab.evaluate(() => window.count())) === childrenBefore + 1,
    String(await tab.evaluate(() => window.count())),
  );

  // A tab that answers slowly gets the script a second time: it mustn't run twice.
  await tab.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  for (let i = 0; i < 2; i += 1) {
    await control.evaluate(
      (t) => chrome.runtime.sendMessage({ type: "scripts/restore", tabId: t }),
      tabId,
    );
    await wait(800);
  }
  await wait(2500);
  check("adding it again doesn't add a person", peers === 2, String(peers));
  check(
    "or a badge",
    (await tab.evaluate(() => window.count())) === childrenBefore + 1,
    String(await tab.evaluate(() => window.count())),
  );
  await tab.bringToFront();
  await wait(1000);
  states.length = 0;
  await tab.evaluate(() => window.v.pause());
  await wait(1500);
  const senders = new Set(states.map((s) => s.from));
  check(
    "one pause reaches the room once",
    senders.size === 1 && states.length === 1,
    `${senders.size} senders, ${states.length} states`,
  );

  // A video inside a frame.
  await reload();
  const framedPopup = await openPopup(framed);
  const foundInFrame = await until(
    async () => (await text(framedPopup, "#found-text")) === "Found a video on this tab",
  );
  check(
    "a video in a frame is found too",
    foundInFrame === true,
    await text(framedPopup, "#found-text"),
  );
  await framedPopup.close();

  // A browser page can't take scripts, and must say so rather than fail.
  const blank = await context.newPage();
  await blank.goto("chrome://version");
  const blankPopup = await openPopup(blank);
  await wait(1500);
  check(
    "a browser page is told it can't be used",
    await blankPopup.locator("#create").isDisabled(),
    await text(blankPopup, "#found-text"),
  );
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error).slice(0, 400));
} finally {
  await Promise.race([context?.close().catch(() => {}), wait(5000)]);
  web.close();
  try {
    console.log("cleanup:", stopServers());
  } catch {}
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
}
