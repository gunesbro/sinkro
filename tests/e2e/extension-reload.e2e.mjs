// Reloading the extension with a tab in a room: does what was running in the tab go away?
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

const API = "http://localhost:8812";
const WEB = "http://localhost:8844";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? " -> " + detail : ""}`);
};
async function until(fn, timeoutMs = 10000, stepMs = 100) {
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
    `<!doctype html><meta charset=utf-8><title>Film</title><body style="margin:0;background:#333"><video id=v src="/film.wav" width=800 height=450 preload=auto></video><script>window.v=document.getElementById("v");window.count=()=>document.documentElement.children.length;</script>`,
  );
});
await new Promise((r) => web.listen(8844, r));
startServer("8812");
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
    await fetch(`${API}/rooms`, { method: "POST", headers: { "CF-Connecting-IP": "orphan" } })
  ).json();
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
  await wait(200);

  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sinkro-orphan-")), {
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
  await wait(1500);
  await tab.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  const join2 = () =>
    control.evaluate(
      ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
      [tabId, code],
    );

  await join2();
  await until(() => peers === 2);
  check("one viewer plus the observer is two people", peers === 2, String(peers));
  const childrenInRoom = await tab.evaluate(() => window.count());

  for (let round = 1; round <= 3; round += 1) {
    // What the extensions page's reload button does.
    await control.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await wait(3000);
    const peersAfterReload = peers;
    console.log(`reload ${round}: right after, server counts ${peersAfterReload}`);
    if (round === 1)
      check(
        "reloading the extension takes the old copy out of the room",
        peersAfterReload === 1,
        String(peersAfterReload),
      );
    if (round === 1)
      check(
        "and takes its badge off the page",
        (await tab.evaluate(() => window.count())) === childrenInRoom - 1,
        String(await tab.evaluate(() => window.count())),
      );

    control = await context.newPage();
    await openExtensionPage(control, popupUrl);
    await tab.bringToFront();
    await wait(300);
    await tab.reload();
    await wait(1500);
    await join2();
    await wait(4000);
    console.log(
      `reload ${round}: after joining again, server counts ${peers}, badges: ${(await tab.evaluate(() => window.count())) - (childrenInRoom - 1)}`,
    );
  }
  check("three reloads later it's still two people", peers === 2, String(peers));

  // Only one copy may be speaking for the video.
  await tab.bringToFront();
  await tab.evaluate(() => window.v.play());
  await wait(1500);
  states.length = 0;
  await tab.evaluate(() => window.v.pause());
  await wait(1500);
  const senders = new Set(states.map((s) => s.from));
  check(
    "one pause reaches the room from one copy",
    senders.size === 1,
    `${senders.size} senders, ${states.length} states`,
  );
  await tab.screenshot({ path: join(shotDir, "orphan-after.png") });
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
