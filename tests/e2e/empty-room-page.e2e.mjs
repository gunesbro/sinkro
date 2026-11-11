// A room started on a page without a video, like a series' listing, then the video opened on
// another page. The room's address is the listing's, so Sinkro asks to make this the room's
// video, and once it is, the invite link leads here.
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

const API = "http://localhost:8825";
const WEB = "http://localhost:8856";
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

// Ten minutes of silent WAV.
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
  if (url.pathname === "/series") {
    return res.end(
      `<!doctype html><meta charset=utf-8><title>The Series</title><h1>The Series</h1><a href="/episode/1">Episode 1</a>`,
    );
  }
  res.end(
    `<!doctype html><meta charset=utf-8><title>Episode 1</title><body style="margin:0;background:#333"><video src="/film.wav" width=800 height=450 preload=auto></video>`,
  );
});
await new Promise((r) => web.listen(8856, r));
startServer("8825");
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
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sinkro-empty-")), {
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
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup.html`;
  await enableDeveloperMode(context);
  const setup = await context.newPage();
  await openExtensionPage(setup, popupUrl);
  await setup.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl, language: "en" }), API);
  await setup.close();

  const page = await context.newPage();
  await page.goto(`${WEB}/series`);
  await wait(1200);
  const openPopup = async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(popupUrl);
    await page.bringToFront();
    await popup.reload();
    await popup.waitForSelector("main:not([hidden])");
    return popup;
  };
  const text = (popup, selector) =>
    popup
      .locator(selector)
      .first()
      .innerText()
      .catch(() => "");
  const inviteDestination = async (popup) => {
    await popup.bringToFront();
    await popup.click("#copy-link");
    const link = await popup.evaluate(() => navigator.clipboard.readText());
    await page.bringToFront();
    return new URLSearchParams(new URL(link).hash.slice(1)).get("url");
  };

  // A room started on the series' page, which has no video.
  let popup = await openPopup();
  await popup.click("#create");
  await until(async () => (await text(popup, "#room-status")) === "In sync");
  check(
    "the invite starts out leading to the series' page",
    (await inviteDestination(popup)) === `${WEB}/series`,
  );
  await popup.close();

  // The episode is opened and played, as a person would.
  await page.click("a");
  await page.waitForFunction(() => document.querySelector("video")?.duration > 0);
  await page.keyboard.press("Shift");
  await page.evaluate(() => document.querySelector("video").play());

  popup = await openPopup();
  const title = await until(async () => {
    const shown = await text(popup, "#alert-title");
    return shown === "Make this the room's video?" ? shown : null;
  });
  check(
    "Sinkro asks to make this the room's video",
    Boolean(title),
    await text(popup, "#alert-title"),
  );
  check(
    "with bringing everyone as the way, and no way back to a page without a video",
    (await popup.locator("#bring").getAttribute("class"))?.includes("primary") &&
      // One main action: sharing the room waits until this is done.
      !(await popup.locator("#copy-link").getAttribute("class"))?.includes("primary") &&
      (await popup.locator("#go-video").isHidden()),
  );
  if (shotDir) await popup.screenshot({ path: join(shotDir, "empty-room-page.png") });

  await popup.click("#bring");
  check(
    "once brought here, the notice is gone",
    await until(
      async () =>
        (await popup.locator("#alert").isHidden()) ||
        (await text(popup, "#alert-title")) !== "Make this the room's video?",
    ),
  );
  check(
    "and the invite leads to the episode",
    await until(async () => (await inviteDestination(popup)) === `${WEB}/episode/1`),
    String(await inviteDestination(popup)),
  );
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error).slice(0, 400));
} finally {
  await Promise.race([context?.close().catch(() => {}), wait(5000)]);
  web.close();
  try {
    stopServers();
  } catch {}
}
console.log(failures === 0 ? "all passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
