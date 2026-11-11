// A site that swaps the frame holding its player, or goes to another page, while in a room.
// The frame that ran the room is gone, and another has to take over without a long gap.
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

const API = "http://localhost:8830";
const WEB = "http://localhost:8862";
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
const OTHER = "http://127.0.0.1:8863"; // a different origin, for the player's frame
const html = (body) =>
  `<!doctype html><meta charset=utf-8><title>Film</title><body style="margin:0;background:#333">${body}`;
const web = createServer((req, res) => {
  const url = new URL(req.url, WEB);
  if (url.pathname === "/film.wav") {
    const m = /bytes=(d+)-(d*)/.exec(req.headers.range ?? "");
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
  if (url.pathname === "/player") {
    return res.end(html(`<video src="/film.wav" width=800 height=450 preload=auto></video>`));
  }
  if (url.pathname === "/watch") {
    return res.end(html(`<video src="/film.wav" width=800 height=450 preload=auto></video>`));
  }
  res.end(html(`<iframe src="${OTHER}/player?1" width=820 height=470 style="border:0"></iframe>`));
});
await new Promise((r) => web.listen(8862, r));
const other = createServer((req, res) => web.emit("request", req, res));
await new Promise((r) => other.listen(8863, r));
startServer("8830");
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
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sinkro-frames-")), {
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
  await page.goto(`${WEB}/embed`);
  const playerFrame = () => page.frames().find((frame) => frame.url().startsWith(OTHER));
  await until(async () =>
    playerFrame()?.evaluate(() => document.querySelector("video")?.duration > 0),
  );
  const openPopup = async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(popupUrl);
    await page.bringToFront();
    await popup.reload();
    await popup.waitForSelector("main:not([hidden])");
    return popup;
  };
  /** Which frame of the tab runs the room, as the background has it. */
  const winner = () =>
    sw.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      const key = Object.keys(all).find((name) => name.startsWith("frames:"));
      return key ? all[key].winner : null;
    });
  const popup = await openPopup();
  await popup.click("#create");
  await until(
    async () =>
      (
        await popup
          .locator("#room-code")
          .first()
          .innerText()
          .catch(() => "")
      ).length > 3,
  );
  await popup.close();
  await page.bringToFront();
  await playerFrame().evaluate(() => document.querySelector("video").play());
  const first = await until(async () => {
    const id = await winner();
    return id ? id : null;
  });
  check("the room runs in the frame with the player", Boolean(first), String(await winner()));

  // The site puts another frame in place of the player's, as one switching players does.
  let at = Date.now();
  await page.evaluate((src) => {
    document.querySelector("iframe").remove();
    const frame = document.createElement("iframe");
    frame.src = src;
    frame.width = "820";
    frame.height = "470";
    document.body.append(frame);
  }, `${OTHER}/player?2`);
  const second = await until(async () => {
    const id = await winner();
    return id && id !== first ? id : null;
  }, 25000);
  let took = Date.now() - at;
  check(
    "a frame put in its place takes the room over within a few seconds",
    Boolean(second) && took < 5000,
    `${took} ms, winner ${await winner()}`,
  );

  // The viewer goes to a page with the video on the page itself.
  await until(async () =>
    playerFrame()?.evaluate(() => document.querySelector("video")?.duration > 0),
  );
  await playerFrame().evaluate(() => document.querySelector("video").play());
  await wait(6000);
  at = Date.now();
  await page.goto(`${WEB}/watch`);
  const third = await until(async () => ((await winner()) === 0 ? "top" : null), 25000);
  took = Date.now() - at;
  check(
    "after going to another page, the room runs there within a few seconds",
    Boolean(third) && took < 5000,
    `${took} ms, winner ${await winner()}`,
  );
  const popupAfter = await openPopup();
  const status = await until(async () => {
    const shown = await popupAfter
      .locator("#room-status")
      .first()
      .innerText()
      .catch(() => "");
    // On hold, since this page isn't the room's video: connected, which is what's asked here.
    return shown === "In sync" || shown === "On hold" ? shown : null;
  });
  check(
    "and the popup shows the room connected",
    Boolean(status),
    await popupAfter
      .locator("#room-status")
      .first()
      .innerText()
      .catch(() => "?"),
  );
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error).slice(0, 400));
} finally {
  await Promise.race([context?.close().catch(() => {}), wait(5000)]);
  web.close();
  other.close();
  try {
    stopServers();
  } catch {}
}
console.log(failures === 0 ? "all passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
