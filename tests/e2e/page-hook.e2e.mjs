// The page hook goes only into tabs in a room, and leaves with the room.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath } = config;

const API = "http://localhost:8822";
const WEB = "http://localhost:8853";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? " -> " + detail : ""}`);
};
async function until(fn, timeoutMs = 8000) {
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
const web = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><meta charset=utf-8><title>t</title><h1>page</h1>");
});
await new Promise((r) => web.listen(8853, r));
startServer("8822");
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
    await fetch(`${API}/rooms`, { method: "POST", headers: { "CF-Connecting-IP": "icon" } })
  ).json();
  context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), "sinkro-hookcheck-")),
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
      ],
    },
  );
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const host = new URL(sw.url()).host;
  const control = await context.newPage();
  await control.goto(`chrome-extension://${host}/popup.html`);
  await control.evaluate(
    (serverUrl) => chrome.storage.local.set({ serverUrl, language: "en" }),
    API,
  );

  const tab = await context.newPage();
  await tab.goto(WEB + "/one");
  await tab.bringToFront();
  await wait(1500);
  const traces = () =>
    tab.evaluate(() => ({
      marker: HTMLMediaElement.prototype[Symbol.for("sinkro.page-hook")] === true,
      nativePlay: String(HTMLMediaElement.prototype.play).includes("[native code]"),
    }));
  const outside = await traces();
  check(
    "a site outside a room sees no trace of the hook",
    !outside.marker && outside.nativePlay,
    JSON.stringify(outside),
  );
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  await control.evaluate(
    ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
    [tabId, code],
  );
  const inside = await until(async () => (await traces()).marker && (await traces()), 8000);
  check(
    "a tab in a room gets it",
    !!inside && inside.marker && !inside.nativePlay,
    JSON.stringify(inside),
  );
  await tab.reload();
  const reloaded = await until(async () => (await traces()).marker && (await traces()), 8000);
  check("and gets it again after reloading", !!reloaded, JSON.stringify(await traces()));
  await control.evaluate(
    (t) => chrome.runtime.sendMessage({ type: "session/leave", tabId: t }),
    tabId,
  );
  await tab.reload();
  await wait(2000);
  const after = await traces();
  check(
    "after leaving, the next page has none",
    !after.marker && after.nativePlay,
    JSON.stringify(after),
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
