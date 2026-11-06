// How can a room count more people than there are? Measures what the server counts in
// everyday situations, with the browser's back/forward cache on, as it is for real users.
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

const API = "http://localhost:8813";
const WEB = "http://localhost:8845";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? " -> " + detail : ""}`);
};

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
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<!doctype html><meta charset=utf-8><title>Film</title><body style="margin:0;background:#333"><video id=v src="/film.wav" width=800 height=450 preload=auto></video><a id=l href="/watch?v=${Math.random()}">next</a><script>window.v=document.getElementById("v");addEventListener("pageshow",(e)=>{window.restored=e.persisted;});</script>`,
  );
});
await new Promise((r) => web.listen(8845, r));
startServer("8813");
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
  const { code } = await (
    await fetch(`${API}/rooms`, { method: "POST", headers: { "CF-Connecting-IP": "ghost" } })
  ).json();
  const ws = new WebSocket(`${API.replace("http", "ws")}/rooms/${code}/ws`);
  await new Promise((r) => ws.addEventListener("open", r));
  let peers = 0;
  ws.addEventListener("message", (e) => {
    if (e.data === "keepalive") return;
    const m = JSON.parse(e.data);
    if (m.type === "joined") peers = m.peers;
    if (m.type === "peers") peers = m.count;
  });
  ws.send(JSON.stringify({ type: "join", protocol: 1 }));
  await wait(200);
  const say = (what) =>
    console.log(`${what}: server counts ${peers} (the observer is one of them)`);

  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sinkro-ghost-")), {
    channel: config.channel,
    headless: false,
    viewport: { width: 1000, height: 650 },
    locale: "en-US",
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
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
  await tab.goto(`${WEB}/watch?v=0`);
  await wait(1500);
  await tab.bringToFront();
  const idOf = () =>
    control.evaluate(
      async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
    );
  const joinTab = async () =>
    control.evaluate(
      ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
      [await idOf(), code],
    );

  await joinTab();
  await wait(3500);
  say("one tab in the room");

  // Following links and going back and forth, as anyone browsing does.
  for (let i = 1; i <= 4; i += 1) {
    await tab.click("#l");
    await wait(3500);
    check(`followed a link (${i}): still one viewer`, peers === 2, String(peers));
  }
  let wasRestored = false;
  const tabId = await idOf();
  for (let i = 1; i <= 2; i += 1) {
    await tab.evaluate(() => history.back());
    await wait(3500);
    const restored = await tab.evaluate(() => window.restored);
    if (restored) wasRestored = true;
    check(
      `went back (${i}), from the cache: ${restored}: still one viewer`,
      peers === 2,
      String(peers),
    );
    const status = await control.evaluate(
      async (t) => chrome.tabs.sendMessage(t, { type: "session/status" }),
      tabId,
    );
    check(
      "and the room is running again",
      status?.connection === "connected",
      JSON.stringify(status),
    );
  }
  check("the browser really did use its cache, so this tests something", wasRestored);
  await tab.evaluate(() => history.forward());
  await wait(3500);
  check("went forward: still one viewer", peers === 2, String(peers));

  // Duplicating the idea of a second tab in the same room.
  const second = await context.newPage();
  await second.goto(`${WEB}/watch?v=second`);
  await wait(1200);
  await second.bringToFront();
  await joinTab();
  await wait(3500);
  check("a second tab in the room counts as a second person", peers === 3, String(peers));

  // Reload the extension, leave the old tabs alone, join from a new tab.
  await control.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
  await wait(3000);
  check(
    "reloading the extension takes both old copies out of the room",
    peers === 1,
    String(peers),
  );
  control = await context.newPage();
  await openExtensionPage(control, popupUrl);
  const third = await context.newPage();
  await third.goto(`${WEB}/watch?v=third`);
  await wait(1500);
  await third.bringToFront();
  await joinTab();
  await wait(3500);
  check("joining again from a new tab counts once", peers === 2, String(peers));

  await second.reload();
  await wait(2500);
  check("a tab whose room the reload forgot doesn't come back", peers === 2, String(peers));
  await third.close();
  await wait(2500);
  check("closing the tab leaves just the observer", peers === 1, String(peers));
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
