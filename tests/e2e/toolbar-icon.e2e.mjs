// The toolbar icon and its number.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath } = config;

const API = "http://localhost:8815";
const WEB = "http://localhost:8847";
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
await new Promise((r) => web.listen(8847, r));
startServer("8815");
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
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sinkro-icon-")), {
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
  });
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

  const manifest = await control.evaluate(() => chrome.runtime.getManifest());
  const files = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  const present = await control.evaluate(
    async (paths) => Promise.all(paths.map(async (p) => (await fetch("/" + p)).ok)),
    files,
  );
  check(
    "every icon the manifest names is there",
    files.length === 8 && present.every(Boolean),
    files.length + " files",
  );
  check(
    "the toolbar starts on the grey one",
    Object.values(manifest.action.default_icon).every((p) => p.includes("-off-")),
  );
  check(
    "the store and extensions page get the coloured one",
    Object.values(manifest.icons).every((p) => p.includes("-on-")),
  );

  // Watch what the service worker asks for, and whether the browser accepts it.
  await sw.evaluate(() => {
    self.__icons = [];
    const original = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = async (details) => {
      try {
        await original(details);
        self.__icons.push({ path: details.path[16], ok: true });
      } catch (error) {
        self.__icons.push({ path: details.path[16], ok: false, error: String(error) });
      }
    };
  });
  const lastIcon = () => sw.evaluate(() => self.__icons.at(-1));

  const tab = await context.newPage();
  await tab.goto(`${WEB}/one`);
  await tab.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  const badge = () => control.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId);
  const isRed = await control.evaluate(
    (t) => chrome.action.getBadgeBackgroundColor({ tabId: t }),
    tabId,
  );
  check("no number outside a room", (await badge()) === "", JSON.stringify(isRed));

  await control.evaluate(
    ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
    [tabId, code],
  );
  await until(async () => (await lastIcon())?.path.includes("-on-"));
  const on = await lastIcon();
  check("joining turns the icon on", on?.path.includes("-on-") && on.ok, JSON.stringify(on));
  await until(async () => (await badge()) === "1");
  check("and shows how many are in the room", (await badge()) === "1", await badge());
  const colour = await control.evaluate(
    (t) => chrome.action.getBadgeBackgroundColor({ tabId: t }),
    tabId,
  );
  check(
    "in the accent colour",
    JSON.stringify(colour) === JSON.stringify([242, 176, 69, 255]),
    JSON.stringify(colour),
  );

  const ws = new WebSocket(`${API.replace("http", "ws")}/rooms/${code}/ws`);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "join", protocol: 1 }));
  await until(async () => (await badge()) === "2");
  check("someone arriving raises the number", (await badge()) === "2", await badge());
  ws.close();
  await until(async () => (await badge()) === "1");
  check("someone leaving lowers it", (await badge()) === "1", await badge());

  await tab.goto(`${WEB}/two`);
  await until(async () => (await badge()) === "1");
  const after = await lastIcon();
  check(
    "going to another page keeps the icon on",
    after?.path.includes("-on-") && after.ok,
    JSON.stringify(after),
  );
  check("and the number", (await badge()) === "1", await badge());

  await control.evaluate(
    (t) => chrome.runtime.sendMessage({ type: "session/leave", tabId: t }),
    tabId,
  );
  await until(async () => (await lastIcon())?.path.includes("-off-"));
  check("leaving turns it off", (await lastIcon())?.path.includes("-off-"));
  await until(async () => (await badge()) === "");
  check("and clears the number", (await badge()) === "");

  const other = await context.newPage();
  await other.goto(`${WEB}/three`);
  await other.bringToFront();
  const otherId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  await wait(500);
  check(
    "another tab isn't affected",
    (await control.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), otherId)) === "",
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
