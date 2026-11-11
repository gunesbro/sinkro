// The real invite page, served at its real address through a route.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const { extPath, shotDir, siteDir } = config;

const API = "http://localhost:8809";
const WEB = "http://localhost:8861";
const INVITE = "https://sinkro.pages.dev";
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
    return res.end(film.subarray(start, end + 1));
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(
    `<!doctype html><meta charset=utf-8><title>film</title><body style="margin:0"><video id=v src="/film.wav" width=800 height=450 preload=auto></video><script>window.v=document.getElementById("v")</script>`,
  );
});
await new Promise((r) => web.listen(8861, r));
startServer("8809");
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

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
};
// The headers in site/_headers, as Cloudflare Pages would send them.
const headersFile = readFileSync(join(siteDir, "_headers"), "utf8");
const siteHeaders = Object.fromEntries(
  headersFile
    .split("\n")
    .filter((l) => l.startsWith("  "))
    .map((l) => {
      const at = l.indexOf(":");
      return [l.slice(0, at).trim(), l.slice(at + 1).trim()];
    }),
);

const all = [];
async function browser(name, { extension = true, locale = "en-US" } = {}) {
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), `sinkro-invite-${name}-`)),
    {
      channel: config.channel,
      headless: false,
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
      viewport: { width: 1280, height: 900 },
      locale,
      args: [
        "--headless=new",
        "--mute-audio",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
        ...(extension
          ? [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`]
          : []),
      ],
    },
  );
  all.push(context);
  const outside = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === INVITE) {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      try {
        return await route.fulfill({
          status: 200,
          contentType: TYPES[extname(path)] ?? "application/octet-stream",
          headers: siteHeaders,
          body: readFileSync(join(siteDir, path)),
        });
      } catch {
        return route.fulfill({ status: 404, body: "" });
      }
    }
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) &&
      !["chrome-extension:", "data:"].includes(url.protocol)
    )
      outside.push(url.hostname);
    return route.continue();
  });
  let control = null;
  if (extension) {
    const sw =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 20000 }));
    control = await context.newPage();
    await control.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    await control.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl }), API);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 160));
  });
  return {
    context,
    control,
    page,
    errors,
    outside,
    status: async () => {
      await page.bringToFront();
      const tabId = await control.evaluate(
        async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
      );
      return control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "session/status" }), tabId);
    },
  };
}
const visible = (page, sel) => page.locator(sel).isVisible();
const text = (page, sel) => page.locator(sel).innerText();

try {
  const { code } = await (
    await fetch(`${API}/rooms`, { method: "POST", headers: { "CF-Connecting-IP": "t-1" } })
  ).json();
  const ws = new WebSocket(`${API.replace("http", "ws")}/rooms/${code}/ws`);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "join", protocol: 1 }));
  await wait(200);
  ws.send(
    JSON.stringify({ type: "state", playing: true, position: 700, rate: 1, sentAt: Date.now() }),
  );
  const filmUrl = `${WEB}/watch?id=9`;
  const link = `${INVITE}/#room=${code}&url=${encodeURIComponent(filmUrl)}`;

  // ---- no extension
  const bare = await browser("bare", { extension: false });
  await bare.page.goto(`${INVITE}/`);
  await wait(500);
  check(
    "landing: states what Sinkro is, in the agreed words",
    (await text(bare.page, "#lede")).startsWith(
      "Sinkro is a free, open-source watch party extension for Chrome, Edge and Firefox",
    ),
    await text(bare.page, "#title"),
  );
  check(
    "landing: no room card or join button",
    !(await visible(bare.page, "#room-card")) && !(await visible(bare.page, "#join-room")),
  );
  if (shotDir)
    await bare.page.screenshot({ path: join(shotDir, "invite-landing.png"), fullPage: true });

  await bare.page.goto(link);
  await bare.page.reload();
  await wait(500);
  check(
    "invite without the extension: offers the install",
    (await visible(bare.page, "#install")) && !(await visible(bare.page, "#join-room")),
  );
  check(
    "the install button goes to this browser's store, in a new tab",
    (await bare.page.getAttribute("#install", "href")).startsWith(
      "https://chromewebstore.google.com/detail/",
    ) && (await bare.page.getAttribute("#install", "target")) === "_blank",
    await bare.page.getAttribute("#install", "href"),
  );
  check(
    "invite: shows the room and where it leads",
    (await text(bare.page, "#room-code")) === code &&
      (await text(bare.page, "#destination")) === "localhost",
    `${await text(bare.page, "#room-code")} | ${await text(bare.page, "#destination")}`,
  );
  if (shotDir)
    await bare.page.screenshot({ path: join(shotDir, "invite-not-installed.png"), fullPage: true });

  // ---- what a hostile link can do
  await bare.page.goto(
    `${INVITE}/#room=${code}&url=${encodeURIComponent("javascript:alert(document.domain)")}`,
  );
  await bare.page.reload();
  await wait(300);
  check(
    "a javascript: address never becomes a link",
    !(await visible(bare.page, "#destination-row")) &&
      (await visible(bare.page, "#no-destination")),
  );
  await bare.page.goto(`${INVITE}/#room=${encodeURIComponent("<img src=x onerror=alert(1)>")}`);
  await bare.page.reload();
  await wait(300);
  check("a bad room code is just the landing page", !(await visible(bare.page, "#room-card")));
  await bare.page.goto(
    `${INVITE}/#room=${code}&url=${encodeURIComponent("https://evil.example/<img src=x onerror=alert(1)>")}`,
  );
  await bare.page.reload();
  await wait(300);
  check(
    "markup in an address stays text",
    (await bare.page.locator("#destination img").count()) === 0 &&
      (await text(bare.page, "#destination")) === "evil.example",
    await text(bare.page, "#destination"),
  );
  await bare.page.goto(`${INVITE}/privacy.html`);
  check("privacy page loads", (await text(bare.page, "h1")).length > 0);
  check("nothing loads from anywhere else", bare.outside.length === 0, bare.outside.join(", "));
  check(
    "no errors, CSP included, without the extension",
    bare.errors.length === 0,
    bare.errors.join("; "),
  );

  // ---- Turkish
  const tr = await browser("tr", { extension: false, locale: "tr-TR" });
  await tr.page.goto(link);
  await wait(500);
  check(
    "Turkish browser gets Turkish",
    (await text(tr.page, "#install")).includes("edin"),
    await text(tr.page, "h1"),
  );
  if (shotDir) await tr.page.screenshot({ path: join(shotDir, "invite-tr.png"), fullPage: true });
  await tr.page.click('[data-lang="en"]');
  await wait(200);
  check("the switch changes it", (await text(tr.page, "#install")).includes("Get Sinkro"));
  const narrow = await tr.context.newPage();
  await narrow.setViewportSize({ width: 360, height: 700 });
  await narrow.goto(link);
  await wait(400);
  check(
    "fits a narrow window",
    !(await narrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)),
  );

  // ---- with the extension
  const a = await browser("a");
  await a.page.goto(link);
  await until(() => visible(a.page, "#join-room"));
  check(
    "installed: offers to join instead of installing",
    (await visible(a.page, "#join-room")) && !(await visible(a.page, "#install")),
  );
  if (shotDir)
    await a.page.screenshot({ path: join(shotDir, "invite-installed.png"), fullPage: true });

  // A script on the page can't join for the viewer: only a real click counts.
  await a.page.evaluate(() =>
    document.getElementById("join-room").dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  await wait(1500);
  check("a scripted click doesn't join", new URL(a.page.url()).origin === INVITE, a.page.url());
  await a.page.reload();
  await until(() => visible(a.page, "#join-room"));

  await a.page.click("#join-room");
  await until(async () => a.page.url() === filmUrl);
  check("a real click goes to the video", a.page.url() === filmUrl, a.page.url());
  const followed = await until(async () => {
    const r = await a.page.evaluate(() => ({
      t: window.v?.currentTime ?? 0,
      paused: window.v?.paused,
    }));
    return r.paused === false && Math.abs(r.t - 700) < 60;
  }, 12000);
  check(
    "and lands in the room, at its spot",
    followed === true,
    JSON.stringify(await a.page.evaluate(() => [window.v.currentTime, window.v.paused])),
  );
  const status = await a.status();
  check(
    "connected, two people",
    status.connection === "connected" && status.peers === 2,
    JSON.stringify({ c: status.connection, p: status.peers }),
  );

  // ---- a room with no video to go to
  const b = await browser("b");
  await b.page.goto(`${INVITE}/#room=${code}`);
  await until(() => visible(b.page, "#join-room"));
  check("no address: says so", await visible(b.page, "#no-destination"));
  await b.page.click("#join-room");
  await until(async () => (await b.status())?.connection === "connected");
  check(
    "joins from the page, and stays on it",
    new URL(b.page.url()).origin === INVITE && (await b.status()).peers === 3,
    b.page.url(),
  );
  await wait(6000);
  check(
    "and the page says it worked, even later",
    (await text(b.page, "#join-room")) === "You're in the room",
    await text(b.page, "#join-room"),
  );
  if (shotDir)
    await b.page.screenshot({ path: join(shotDir, "invite-joined.png"), fullPage: true });

  // ---- a lookalike page gets nowhere
  const c = await browser("c");
  await c.page.goto(`${WEB}/watch#room=${code}&url=${encodeURIComponent(filmUrl)}`);
  await wait(800);
  const marked = await c.page.evaluate(() => document.documentElement.dataset.sinkro ?? null);
  const fake = await c.page.evaluate(async () => {
    const b = document.createElement("button");
    b.id = "join-room";
    b.textContent = "join";
    b.style.cssText = "position:fixed;left:900px;top:20px;width:200px;height:80px";
    document.body.append(b);
    return true;
  });
  await c.page.mouse.click(1000, 60);
  await wait(1200);
  check("another site's page isn't told the extension is here", marked === null && fake);
  check(
    "and its join button does nothing",
    (await c.status()) === null,
    JSON.stringify(await c.status()),
  );

  ws.close();
  for (const v of [a, b, c]) check("no page errors", v.errors.length === 0, v.errors.join("; "));
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error.message).slice(0, 400));
} finally {
  await Promise.all(all.map((c) => Promise.race([c.close().catch(() => {}), wait(5000)])));
  web.close();
  try {
    console.log("cleanup:", stopServers());
  } catch {}
  console.log(failures ? `${failures} FAILED` : "all passed");
  process.exit(failures ? 1 : 0);
}
