// A network drop: the viewer reconnects while the server still thinks the old socket is open.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath } = config;

const API = "http://localhost:8817";
const WEB = "http://localhost:8849";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log((ok ? "ok   " : "FAIL ") + name + (detail !== "" ? " -> " + detail : ""));
};
async function until(fn, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
    } catch {
      last = undefined;
    }
    if (last) return last;
    await wait(200);
  }
  return last;
}
const web = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><meta charset=utf-8><title>t</title><h1>page</h1>");
});
await new Promise((r) => web.listen(8849, r));
startServer("8817");
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
let context;
try {
  const { code } = await (
    await fetch(API + "/rooms", { method: "POST", headers: { "CF-Connecting-IP": "drop" } })
  ).json();
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sinkro-drop-")), {
    channel: config.channel,
    headless: false,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
    viewport: { width: 800, height: 500 },
    args: [
      "--headless=new",
      "--mute-audio",
      "--disable-extensions-except=" + extPath,
      "--load-extension=" + extPath,
    ],
  });
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const control = await context.newPage();
  await control.goto("chrome-extension://" + new URL(sw.url()).host + "/popup.html");
  await control.evaluate(
    (serverUrl) => chrome.storage.local.set({ serverUrl, language: "en" }),
    API,
  );
  const tab = await context.newPage();
  await tab.goto(WEB + "/one");
  await tab.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  const status = () =>
    control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "session/status" }), tabId);
  const badge = () => control.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId);
  const peersNow = () => status().then((s) => s?.peers);

  // Someone else who stays online throughout, and hears the real count.
  const ws = new WebSocket(API.replace("http", "ws") + "/rooms/" + code + "/ws");
  await new Promise((r) => ws.addEventListener("open", r));
  let heard = 0;
  ws.addEventListener("message", (e) => {
    if (e.data === "keepalive") return;
    const m = JSON.parse(e.data);
    if (m.type === "joined") heard = m.peers;
    if (m.type === "peers") heard = m.count;
  });
  ws.send(JSON.stringify({ type: "join", protocol: 1, viewer: "observer" }));

  await control.evaluate(
    ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
    [tabId, code],
  );
  await until(() => heard === 2 && peersNow().then((p) => p === 2));
  check(
    "two people before the drop",
    heard === 2 && (await peersNow()) === 2,
    heard + " / " + (await peersNow()),
  );

  // Make the connection die without a close reaching the server, as a real drop does: the
  // browser's own offline mode cuts its sockets while the server is told nothing in time.
  for (let round = 1; round <= 3; round += 1) {
    await context.setOffline(true);
    await until(async () => (await status())?.connection !== "connected", 45000);
    console.log(
      "round " +
        round +
        ": connection went " +
        (await status())?.connection +
        ", server counts " +
        heard,
    );
    await context.setOffline(false);
    await until(async () => (await status())?.connection === "connected", 45000);
    await wait(1500);
    check(
      "round " + round + ": back with the right count everywhere",
      heard === 2 && (await peersNow()) === 2,
      "others hear " + heard + ", viewer sees " + (await peersNow()) + ", icon " + (await badge()),
    );
  }
  check("and the icon says the same", (await badge()) === "2", await badge());
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error).slice(0, 400));
} finally {
  await Promise.race([context?.close().catch(() => {}), wait(5000)]);
  web.close();
  try {
    console.log("cleanup:", stopServers());
  } catch {}
  console.log(failures ? failures + " FAILED" : "all passed");
  process.exit(failures ? 1 : 0);
}
