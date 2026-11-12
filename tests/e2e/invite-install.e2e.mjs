// Someone opens an invite, installs Sinkro from the store in another tab, and should then be
// one click from the room: the invite's tab comes forward with its join button, no reload.
// The extension is added while the pages are already open, as an install does it.
// Real browsers and the built extension: see tests/README.md.
import { chromium } from "playwright-core";
import { config, enableDeveloperMode, openExtensionPage } from "./lib.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const { extPath, shotDir, siteDir } = config;

const INVITE = "https://sinkro.pages.dev";
// Nothing listens here: the room in this scenario is never reached, only joined.
const NO_SERVER = "http://localhost:8864";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
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
    last = await fn().catch(() => undefined);
    if (last) return last;
    await wait(100);
  }
  return last;
}

let context;
try {
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "sinkro-install-")), {
    channel: config.channel,
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    // Playwright turns extensions off unless one is named when the browser starts.
    ignoreDefaultArgs: ["--disable-extensions"],
    // Lets the test add the extension to a browser that's already running.
    args: ["--headless=new", "--mute-audio", "--enable-unsafe-extension-debugging"],
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== INVITE) return route.continue();
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
      return await route.fulfill({
        status: 200,
        contentType: TYPES[extname(path)] ?? "application/octet-stream",
        body: readFileSync(join(siteDir, path)),
      });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });
  await enableDeveloperMode(context);
  // A headless browser calls every tab visible, so the tab in front is asked of the extension.
  const tabInFront = async () => {
    const worker = await until(async () => context.serviceWorkers().at(-1));
    return worker.evaluate(
      async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url,
    );
  };
  const marked = (page) => page.evaluate(() => document.documentElement.dataset.sinkro ?? null);

  // Before Sinkro is there: an invite, the plain landing page, and the store in front.
  const invite = await context.newPage();
  await invite.goto(`${INVITE}/#room=K7M-2QX`);
  const landing = await context.newPage();
  await landing.goto(`${INVITE}/`);
  // Stands in for the store's tab: another page, in front, as it is while installing.
  const store = await context.newPage();
  await store.goto(`${INVITE}/privacy.html`);
  await store.bringToFront();
  check(
    "before installing, the invite offers the install and has no join button",
    (await invite.locator("#install").isVisible()) &&
      !(await invite.locator("#join-room").isVisible()),
  );

  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: extPath });

  check(
    "once installed, the invite has its join button without a reload",
    Boolean(await until(() => invite.locator("#join-room").isVisible())),
    String(await marked(invite)),
  );
  check(
    "and its tab has come forward",
    Boolean(await until(async () => (await tabInFront()) === invite.url())),
    String(await tabInFront()),
  );
  check(
    "the landing page knows Sinkro is there too",
    Boolean(await until(async () => (await marked(landing)) === "installed")),
  );
  if (shotDir) await invite.screenshot({ path: join(shotDir, "invite-install.png") });

  // Joining is still the viewer's own click.
  check("nobody was put in the room", (await marked(invite)) === "installed");
  const settings = await context.newPage();
  await openExtensionPage(settings, `chrome-extension://${id}/popup.html`);
  await settings.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl }), NO_SERVER);
  await invite.bringToFront();
  await invite.click("#join-room");
  check(
    "a click on it joins",
    Boolean(await until(async () => (await marked(invite)) === "joined")),
    String(await marked(invite)),
  );

  // An update isn't an install: it mustn't pull a tab forward.
  await store.bringToFront();
  await settings.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
  await wait(3000);
  check(
    "an update leaves the tabs as they are",
    (await tabInFront()) === store.url(),
    String(await tabInFront()),
  );
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error).slice(0, 400));
} finally {
  await Promise.race([context?.close().catch(() => {}), wait(5000)]);
}
console.log(failures === 0 ? "all passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
