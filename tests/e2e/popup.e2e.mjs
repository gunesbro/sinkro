// The real popup, driven like a person would, with two browsers.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath, shotDir } = config;

const API = "http://localhost:8807";
const WEB = "http://localhost:8841";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? " -> " + detail : ""}`);
};
async function until(fn, timeoutMs = 8000, stepMs = 100) {
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
    res.end(film.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  if (url.pathname === "/empty")
    return res.end(`<!doctype html><meta charset=utf-8><title>Boş sayfa</title><h1>nothing</h1>`);
  res.end(
    `<!doctype html><meta charset=utf-8><title>Test Filmi: Uzun Gece</title><body style="margin:0"><video id=v src="/film.wav" width=800 height=450 preload=auto></video><script>window.v=document.getElementById("v")</script>`,
  );
});
await new Promise((r) => web.listen(8841, r));
startServer("8807");
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

const all = [];
async function viewer(name, path = "/watch?id=7") {
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), `sinkro-popup-${name}-`)),
    {
      channel: config.channel,
      headless: false,
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
      viewport: { width: 1000, height: 700 },
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
  all.push(context);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup.html`;
  const setup = await context.newPage();
  await setup.goto(popupUrl);
  await setup.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl, language: "en" }), API);
  await setup.close();

  const page = await context.newPage();
  await page.goto(`${WEB}${path}`);
  await wait(1200);

  /** Opens the popup against the page tab, as clicking the toolbar icon would. */
  const openPopup = async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(popupUrl);
    await page.bringToFront();
    await popup.reload();
    await popup.waitForSelector("main:not([hidden])");
    return popup;
  };
  return { name, context, page, openPopup, popupUrl };
}
const text = (popup, sel) =>
  popup
    .locator(sel)
    .first()
    .innerText()
    .catch(() => "");
const shot = (popup, name) =>
  shotDir
    ? popup.screenshot({ path: join(shotDir, `popup-${name}.png`), fullPage: true }).catch(() => {})
    : null;

try {
  const a = await viewer("a");
  let popup = await a.openPopup();

  // ---- home
  await until(async () => (await text(popup, "#found-text")) === "Found a video on this tab");
  check(
    "home: finds the tab's video",
    (await text(popup, "#found-text")) === "Found a video on this tab",
  );
  check(
    "home: shows the title and length",
    (await text(popup, "#video-title")) === "Test Filmi: Uzun Gece" &&
      (await text(popup, "#video-meta")) === "1:00:00",
    `${await text(popup, "#video-title")} | ${await text(popup, "#video-meta")}`,
  );
  await shot(popup, "home-en");

  await popup.click('[data-lang="tr"]');
  await until(async () => (await text(popup, "#create")) === "Oda oluştur");
  check(
    "TR switch changes the copy",
    (await text(popup, "#create")) === "Oda oluştur" &&
      (await text(popup, "footer span")).startsWith("Hesap yok"),
  );
  check(
    "wordmark stays undotted in Turkish",
    (await popup.locator(".wordmark").getAttribute("lang")) === "en",
  );
  await shot(popup, "home-tr");
  await popup.click('[data-lang="en"]');
  await until(async () => (await text(popup, "#create")) === "Create a room");

  // ---- bad input
  await popup.fill("#join-input", "nope");
  await popup.click("#join-form button");
  await until(async () => (await text(popup, "#home-error")).length > 0);
  check(
    "a bad code explains itself",
    (await text(popup, "#home-error")).includes("room code"),
    await text(popup, "#home-error"),
  );
  await shot(popup, "home-error");

  // ---- create
  await popup.click("#create");
  await until(
    async () =>
      (await popup.locator("#room").isVisible()) &&
      /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(await text(popup, "#room-code")),
  );
  const code = await text(popup, "#room-code");
  check("create: shows the room code", /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code), code);
  await until(async () => (await text(popup, "#room-status")) === "In sync");
  check(
    "create: connects and reports in sync",
    (await text(popup, "#room-status")) === "In sync",
    await text(popup, "#room-status"),
  );
  check(
    "create: shows people and time",
    (await text(popup, "#people")) === "1 in this room" &&
      /^\d+:\d\d/.test(await text(popup, "#timecode")),
    `${await text(popup, "#people")} | ${await text(popup, "#timecode")}`,
  );
  await shot(popup, "room-en");

  // ---- picking another video is possible from inside a room
  check(
    "the room view offers to pick a video, with nothing wrong",
    (await popup.locator("#pick-any").isVisible()) && (await popup.locator("#alert").isHidden()),
  );
  await shot(popup, "room-with-pick");

  // ---- reopening finds the room
  await popup.close();
  popup = await a.openPopup();
  check(
    "reopening the popup goes straight to the room",
    (await popup.locator("#room").isVisible()) && (await text(popup, "#room-code")) === code,
  );

  // ---- invite link
  await popup.bringToFront();
  await popup.click("#copy-link");
  const link = await popup.evaluate(() => navigator.clipboard.readText());
  await a.page.bringToFront();
  const parsed = new URL(link);
  const params = new URLSearchParams(parsed.hash.slice(1));
  check(
    "invite link carries the room and page in its fragment",
    parsed.origin === "https://sinkro.pages.dev" &&
      parsed.search === "" &&
      params.get("room") === code &&
      params.get("url") === `${WEB}/watch?id=7`,
    link,
  );
  await until(async () => (await text(popup, "#copy-link")) === "Copy invite link", 4000);
  check(
    "copy button goes back to its label",
    (await text(popup, "#copy-link")) === "Copy invite link",
  );

  // ---- a second person pastes the link
  const b = await viewer("b");
  const popupB = await b.openPopup();
  await until(async () => (await text(popupB, "#found-text")) === "Found a video on this tab");
  await popupB.fill("#join-input", link);
  await popupB.click("#join-form button");
  await until(async () => (await text(popupB, "#room-code")) === code);
  check("pasting the invite link joins the room", (await text(popupB, "#room-code")) === code);
  await until(
    async () =>
      (await text(popup, "#people")) === "2 in this room" &&
      (await text(popupB, "#people")) === "2 in this room",
  );
  check(
    "both see two people",
    (await text(popup, "#people")) === "2 in this room" &&
      (await text(popupB, "#people")) === "2 in this room",
    `${await text(popup, "#people")} | ${await text(popupB, "#people")}`,
  );

  // ---- they stay together
  await a.page.evaluate(() => {
    window.v.currentTime = 600;
    return window.v.play();
  });
  const together = await until(async () => {
    const r = await b.page.evaluate(() => ({ t: window.v.currentTime, paused: window.v.paused }));
    return !r.paused && Math.abs(r.t - 600) < 3;
  });
  check("the room works through the popup's join", together === true);
  await until(async () => /^10:0\d$/.test(await text(popupB, "#timecode")));
  check(
    "the time readout follows the video",
    /^10:0\d$/.test(await text(popupB, "#timecode")),
    await text(popupB, "#timecode"),
  );

  // ---- bring everyone: B is told to be somewhere else, then brings A along
  await wait(1000);
  await b.page.evaluate(() => {
    window.v.pause();
  });
  await until(async () => a.page.evaluate(() => window.v.paused));
  const atPause = await b.page.evaluate(() => window.v.currentTime);
  await a.page.evaluate(() => {
    window.v.currentTime = 1500;
  });
  await until(async () => Math.abs((await b.page.evaluate(() => window.v.currentTime)) - 1500) < 1);
  await popupB.bringToFront();
  await b.page.bringToFront();
  await popupB.click("#bring");
  await wait(300);
  check(
    "bring everyone answers",
    (await text(popupB, "#bring")) === "Sent",
    await text(popupB, "#bring"),
  );
  await wait(800);
  const stillTogether = await Promise.all(
    [a.page, b.page].map((p) => p.evaluate(() => window.v.currentTime)),
  );
  check(
    "bring everyone keeps both on the same spot",
    Math.abs(stillTogether[0] - stillTogether[1]) < 0.5,
    JSON.stringify(stillTogether) + ` paused at ${atPause.toFixed(1)}`,
  );

  // ---- leave
  await popupB.click("#leave");
  await until(async () => popupB.locator("#home").isVisible());
  check("leave returns to the home view", await popupB.locator("#home").isVisible());
  await until(async () => (await text(popup, "#people")) === "1 in this room");
  check(
    "the other person sees them go",
    (await text(popup, "#people")) === "1 in this room",
    await text(popup, "#people"),
  );

  // ---- joining by code from a new-tab-like page offers the room's video
  await popupB.bringToFront();
  await b.page.goto("chrome://version").catch(() => {});
  await b.page.bringToFront();
  await popupB.reload();
  await popupB.waitForSelector("main:not([hidden])");
  await popupB.fill("#join-input", code);
  await popupB.click("#join-form button");
  const offered = await until(async () => popupB.locator("#go-video").isVisible(), 8000);
  check(
    "joining by code offers the room's video",
    offered === true && (await text(popupB, "#go-video")).includes("localhost"),
    await text(popupB, "#go-video").catch(() => ""),
  );
  check(
    "it says the video won't open by itself",
    (await text(popupB, "#alert-body")).includes("won't open by itself"),
    await text(popupB, "#alert-body"),
  );
  await popupB.bringToFront();
  await popupB.click("#copy-link");
  const passedOn = await popupB.evaluate(() => navigator.clipboard.readText());
  await b.page.bringToFront();
  check(
    "a joiner's invite link still leads to the video",
    new URLSearchParams(new URL(passedOn).hash.slice(1)).get("url") === WEB + "/watch?id=7",
    passedOn,
  );
  check(
    "it doesn't go there by itself",
    /^(chrome|edge):\/\//.test(await b.page.url()),
    b.page.url(),
  );
  await shot(popupB, "go-to-video");
  await popupB.click("#go-video");
  const went = await until(async () => b.page.url() === WEB + "/watch?id=7", 8000);
  check("the button goes to the video", went === true, b.page.url());
  const joinedThere = await until(
    async () =>
      (await text(popupB, "#room-status")) !== "" &&
      (await text(popupB, "#people")) === "2 in this room",
    15000,
  );
  check("and the viewer is in the room there", joinedThere === true, await text(popupB, "#people"));
  await until(async () => popupB.locator("#go-video").isHidden(), 3000);
  check("the button goes away once there", await popupB.locator("#go-video").isHidden());
  await popupB.click("#leave");
  await until(async () => popupB.locator("#home").isVisible());

  // ---- a mistyped code shows up at once, even with no page to connect from
  await b.page.goto("chrome://version").catch(() => {});
  await b.page.bringToFront();
  await popupB.reload();
  await popupB.waitForSelector("main:not([hidden])");
  await popupB.fill("#join-input", "ZZZ-223");
  await popupB.click("#join-form button");
  const goneFast = await until(
    async () => (await text(popupB, "#alert-title")) === "This room no longer exists",
    6000,
  );
  check(
    "a dead code is caught without leaving the page",
    goneFast === true,
    await text(popupB, "#alert-title"),
  );
  await popupB.click("#leave");
  await until(async () => popupB.locator("#home").isVisible());
  await b.page.goto(WEB + "/watch?id=7");
  await b.page.bringToFront();
  await popupB.reload();
  await popupB.waitForSelector("main:not([hidden])");

  // ---- a room that doesn't exist
  await popupB.fill("#join-input", "ZZZ-222");
  await popupB.click("#join-form button");
  await until(async () => (await text(popupB, "#alert-title")) === "This room no longer exists");
  check(
    "a dead room says so",
    (await text(popupB, "#alert-title")) === "This room no longer exists",
    await text(popupB, "#alert-title"),
  );
  await shot(popupB, "room-gone");
  await popupB.click("#leave");
  await until(async () => popupB.locator("#home").isVisible());

  // ---- settings
  await popupB.click("#open-settings");
  check(
    "settings shows the current server",
    (await popupB.inputValue("#server-input")) === API,
    await popupB.inputValue("#server-input"),
  );
  await popupB.fill("#server-input", "not a url");
  await popupB.click("#settings-form button[type=submit]");
  await until(async () => (await text(popupB, "#server-error")).length > 0);
  check(
    "settings refuses a bad address",
    (await text(popupB, "#server-error")).includes("http"),
    await text(popupB, "#server-error"),
  );
  await shot(popupB, "settings");
  await popupB.fill("#server-input", "http://localhost:9/");
  await popupB.click("#settings-form button[type=submit]");
  await until(async () => popupB.locator("#home").isVisible());
  check("settings saves and goes back", await popupB.locator("#home").isVisible());
  await popupB.click("#create");
  await until(async () => (await text(popupB, "#home-error")).includes("server"), 10000);
  check(
    "an unreachable server says so",
    (await text(popupB, "#home-error")).includes("server"),
    await text(popupB, "#home-error"),
  );

  // ---- connection loss
  console.log("stopping the server:", stopServers());
  await until(async () => (await text(popup, "#alert-title")) === "Connection lost", 60000, 500);
  check(
    "a lost connection shows up",
    (await text(popup, "#alert-title")) === "Connection lost",
    await text(popup, "#alert-title"),
  );
  await shot(popup, "conn-lost");
  startServer("8807");
  await until(
    async () =>
      fetch(`${API}/health`).then(
        (r) => r.ok,
        () => false,
      ),
    40000,
    300,
  );
  await until(
    async () =>
      (await popup.locator("#alert").isHidden()) &&
      (await text(popup, "#room-status")) === "In sync",
    45000,
    500,
  );
  check(
    "and clears when it's back",
    await popup.locator("#alert").isHidden(),
    await text(popup, "#room-status"),
  );
  await popup.close();

  // ---- pages with nothing to sync
  const c = await viewer("c", "/empty");
  const popupC = await c.openPopup();
  await until(async () => (await text(popupC, "#found-text")) === "No video on this page yet");
  check(
    "a page with no video says so",
    (await text(popupC, "#found-text")) === "No video on this page yet" &&
      (await text(popupC, "#video-title")) === "",
    await text(popupC, "#found-text"),
  );
  await shot(popupC, "no-video");
  await popupC.close();
  await c.page.goto("chrome://version").catch(() => {});
  await wait(500);
  const popupD = await c.openPopup();
  await wait(1800);
  check(
    "a browser page says what's possible there",
    (await text(popupD, "#found-text")).includes("join with a code"),
    await text(popupD, "#found-text"),
  );
  check("creating a room waits for a video", await popupD.locator("#create").isDisabled());
  check("joining is open", !(await popupD.locator("#join-form button").isDisabled()));
  await shot(popupD, "browser-page");

  // Join by code from a page the extension can't run on, then go to the video.
  const { code: laterCode } = await (
    await fetch(`${API}/rooms`, {
      method: "POST",
      headers: { "CF-Connecting-IP": `test-${Math.random()}` },
    })
  ).json();
  await popupD.fill("#join-input", laterCode);
  await popupD.click("#join-form button");
  await until(async () => (await text(popupD, "#room-code")) === laterCode);
  await until(
    async () => (await text(popupD, "#alert-title")) === "Open the video in this tab",
    6000,
  );
  check(
    "joining from there asks for the video",
    (await text(popupD, "#alert-title")) === "Open the video in this tab",
    await text(popupD, "#alert-title"),
  );
  await shot(popupD, "waiting-for-video");
  await c.page.goto(`${WEB}/watch`);
  const started = await until(
    async () =>
      (await text(popupD, "#people")) === "1 in this room" &&
      (await popupD.locator("#alert").isHidden()),
    15000,
  );
  check(
    "and connects once the tab gets there",
    started === true,
    `${await text(popupD, "#people")} | ${await text(popupD, "#room-status")}`,
  );
  await popupD.click("#leave");
  await until(async () => popupD.locator("#home").isVisible());

  // A pasted invite link opens its video by itself, from a page with nothing on it.
  await c.page.goto("chrome://version").catch(() => {});
  await wait(500);
  await popupD.reload();
  await popupD.waitForSelector("main:not([hidden])");
  await popupD.fill(
    "#join-input",
    `https://sinkro.pages.dev/#room=${laterCode}&url=${encodeURIComponent(`${WEB}/watch?from=link`)}`,
  );
  await popupD.click("#join-form button");
  const navigated = await until(async () => c.page.url() === `${WEB}/watch?from=link`, 8000);
  check("a pasted link takes the tab to its video", navigated === true, c.page.url());
  const inRoom = await until(
    async () =>
      (await text(popupD, "#room-status")).length > 0 &&
      (await text(popupD, "#people")) === "1 in this room",
    15000,
  );
  check("and is in the room there", inRoom === true, await text(popupD, "#people"));
  await popupD.click("#leave");
  await until(async () => popupD.locator("#home").isVisible());

  // Already on the link's video: no reload.
  await c.page.evaluate(() => {
    window.stayed = true;
  });
  await popupD.reload();
  await popupD.waitForSelector("main:not([hidden])");
  await until(async () => (await text(popupD, "#found-text")).startsWith("Found"));
  await popupD.fill(
    "#join-input",
    `https://sinkro.pages.dev/#room=${laterCode}&url=${encodeURIComponent(`${WEB}/watch?from=link`)}`,
  );
  await popupD.click("#join-form button");
  await until(async () => (await text(popupD, "#people")) === "1 in this room", 10000);
  check(
    "a tab already on the video doesn't reload",
    (await c.page.evaluate(() => window.stayed)) === true,
  );
  await popupD.click("#leave");
  await popupD.close();

  // ---- the picker opens from the popup
  await c.page.goto(`${WEB}/watch`);
  await wait(1200);
  const popupE = await c.openPopup();
  await until(async () => (await text(popupE, "#found-text")).startsWith("Found"));
  await popupE.bringToFront();
  await c.page.bringToFront();
  const closed = popupE.waitForEvent("close", { timeout: 5000 }).then(
    () => true,
    () => false,
  );
  await popupE.click("#pick-home");
  check("the picker button closes the popup", (await closed) === true);
  await wait(500);
  await c.page.bringToFront();
  await c.page.keyboard.press("Escape");

  // ---- accessibility basics, on every view
  const popupF = await a.openPopup();
  await popupF.bringToFront();
  const audit = await popupF.evaluate(() => {
    const small = [];
    const unnamed = [];
    for (const el of document.querySelectorAll("button, a, input")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.height < 44 || (r.width < 44 && el.tagName !== "A"))
        small.push(`${el.id || el.textContent} ${Math.round(r.width)}x${Math.round(r.height)}`);
      const name =
        el.getAttribute("aria-label") ||
        el.textContent.trim() ||
        document.querySelector(`label[for="${el.id}"]`)?.textContent;
      if (!name) unnamed.push(el.id || el.tagName);
    }
    return {
      small,
      unnamed,
      fonts: [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => f.family + " " + f.weight),
    };
  });
  check("touch targets are at least 44 px", audit.small.length === 0, audit.small.join(", "));
  check("every control has a name", audit.unnamed.length === 0, audit.unnamed.join(", "));
  check(
    "bundled fonts load",
    audit.fonts.some((f) => f.includes("DM Sans")) &&
      audit.fonts.some((f) => f.includes("Big Shoulders")),
    audit.fonts.join(", "),
  );
  const overflow = await popupF.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  check("nothing overflows sideways", overflow === false);
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", error);
} finally {
  await Promise.all(all.map((c) => Promise.race([c.close().catch(() => {}), wait(5000)])));
  web.close();
  try {
    console.log("cleanup:", stopServers());
  } catch {}
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
}
