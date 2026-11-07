// Names in a room: each person gets a random one, the popup lists everyone, and the badge says
// who did what, in each person's own language.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import {
  config,
  enableDeveloperMode,
  openExtensionPage,
  startServer,
  stopServers,
} from "./lib.mjs";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { extPath, shotDir } = config;
const here = dirname(fileURLToPath(import.meta.url));

const API = "http://localhost:8823";
const WEB = "http://localhost:8854";
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

const words = (lang, key) =>
  JSON.parse(readFileSync(join(here, "../../extension/_locales", lang, "messages.json"), "utf8"))[
    key
  ].message.split("|");
const isName = (lang, text) => {
  const [adjective, ...rest] = text.split(" ");
  return (
    words(lang, "nameAdjectives").includes(adjective) &&
    words(lang, "nameAnimals").includes(rest.join(" "))
  );
};

// Ten minutes of silent WAV, so there's a film to sync.
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
  if (req.url === "/film.wav") {
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
    `<!doctype html><meta charset=utf-8><title>Film</title><body style="margin:0;background:#333"><video src="/film.wav" width=800 height=450 preload=auto></video>`,
  );
});
await new Promise((r) => web.listen(8854, r));
startServer("8823");
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

async function viewer(name, lang) {
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), `sinkro-names-${name}-`)),
    {
      channel: config.channel,
      headless: false,
      viewport: { width: 1000, height: 650 },
      locale: lang === "tr" ? "tr-TR" : "en-US",
      args: [
        "--headless=new",
        "--mute-audio",
        "--autoplay-policy=no-user-gesture-required",
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ],
    },
  );
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup.html`;
  await enableDeveloperMode(context);
  const control = await context.newPage();
  await openExtensionPage(control, popupUrl);
  await control.evaluate(
    ([serverUrl, language]) => chrome.storage.local.set({ serverUrl, language }),
    [API, lang],
  );
  const page = await context.newPage();
  await page.goto(`${WEB}/film`);
  await page.waitForFunction(() => document.querySelector("video").duration > 0);
  await page.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  const cdp = await context.newCDPSession(page);
  return {
    context,
    page,
    join: (code) =>
      control.evaluate(
        ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
        [tabId, code],
      ),
    status: () =>
      control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "session/status" }), tabId),
    /** The popup's list of people, as it shows it, opened against the page's tab. */
    popupPeople: async (shot) => {
      const popup = await context.newPage();
      await popup.setViewportSize({ width: 360, height: 640 });
      await popup.goto(popupUrl);
      await page.bringToFront();
      await popup.reload();
      await popup.waitForSelector("main:not([hidden])");
      const items = await until(async () => {
        const texts = await popup.locator("#people-list li").allInnerTexts();
        return texts.length >= 2 && texts.every((text) => text.trim() !== "") ? texts : null;
      });
      const newName = await popup.locator("#new-name").innerText();
      if (shotDir) await popup.screenshot({ path: join(shotDir, `names-${shot}.png`) });
      return { items: items ?? [], newName, popup };
    },
    /** Every bit of text on the page, the badge's closed shadow root included. */
    texts: async () => {
      const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const found = [];
      const walk = (node) => {
        if (node.nodeType === 3 && node.nodeValue.trim()) found.push(node.nodeValue.trim());
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
      };
      walk(root);
      return found;
    },
  };
}

const contexts = [];
try {
  const { code } = await (
    await fetch(`${API}/rooms`, { method: "POST", headers: { "CF-Connecting-IP": "names" } })
  ).json();
  const a = await viewer("a", "en");
  contexts.push(a.context);
  const b = await viewer("b", "tr");
  contexts.push(b.context);
  await a.join(code);
  await until(async () => (await a.status())?.connection === "connected");
  await b.join(code);
  await until(async () => (await a.status())?.peers === 2);

  const ready = await until(async () => {
    const people = (await a.status())?.people ?? [];
    return people.length === 2 && people.every((person) => person.pick !== null);
  });
  check("both names reach both people", ready, JSON.stringify((await a.status())?.people));

  const ofA = await a.popupPeople("a-en");
  const own = ofA.items.find((text) => text.endsWith(" (you)"));
  check("A's popup lists two people", ofA.items.length === 2, JSON.stringify(ofA.items));
  check(
    "A's own name comes first, marked, and is a random one",
    ofA.items[0] === own && own !== undefined && isName("en", own.replace(" (you)", "")),
    JSON.stringify(ofA.items),
  );
  check(
    "the other is a random name too",
    isName("en", ofA.items[1] ?? ""),
    JSON.stringify(ofA.items),
  );
  check("the button to draw another is there", ofA.newName === "Pick a new name", ofA.newName);

  const ofB = await b.popupPeople("b-tr");
  check(
    "B reads the names in Turkish, its own marked",
    ofB.items.length === 2 &&
      (ofB.items[0] ?? "").endsWith(" (sen)") &&
      isName("tr", (ofB.items[0] ?? "").replace(" (sen)", "")) &&
      isName("tr", ofB.items[1] ?? ""),
    JSON.stringify(ofB.items),
  );
  const aInTurkish = ofB.items[1] ?? "";
  await ofB.popup.close();

  // A plays and then pauses, as a person would: a key first each time, so it's taken as theirs.
  await a.page.bringToFront();
  await a.page.keyboard.press("Shift");
  await a.page.evaluate(() => document.querySelector("video").play());
  const playing = await until(async () => {
    const status = await b.status();
    return status?.paused === false && status.position > 1;
  });
  check("B plays along when A plays", playing, JSON.stringify(await b.status()));
  await wait(3500);
  await a.page.keyboard.press("Shift");
  await a.page.evaluate(() => document.querySelector("video").pause());
  const seen = new Set();
  const said = await until(async () => {
    const texts = await b.texts();
    for (const text of texts) if (/durdur|paus/i.test(text)) seen.add(text);
    return texts.find((text) => text.endsWith("videoyu durdurdu"));
  });
  if (!said) console.log("     B saw:", JSON.stringify([...seen]));
  check(
    "B's badge says who paused, by A's name in Turkish",
    said === `${aInTurkish} videoyu durdurdu`,
    String(said),
  );

  // A draws another name; B hears it.
  const before = ofA.items[0]?.replace(" (you)", "");
  await ofA.popup.locator("#new-name").click();
  const after = await until(async () => {
    const texts = await ofA.popup.locator("#people-list li").allInnerTexts();
    const mine = texts.find((text) => text.endsWith(" (you)"))?.replace(" (you)", "");
    return mine && mine !== before ? mine : null;
  });
  check("a new name shows in A's popup", Boolean(after), `${before} -> ${after}`);
  const ofBAgain = await b.popupPeople("b-tr-after");
  check(
    "and reaches B",
    ofBAgain.items[1] !== aInTurkish && isName("tr", ofBAgain.items[1] ?? ""),
    JSON.stringify([aInTurkish, ofBAgain.items[1]]),
  );
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", String(error).slice(0, 400));
} finally {
  for (const context of contexts) await Promise.race([context.close().catch(() => {}), wait(5000)]);
  web.close();
  stopServers();
}
console.log(failures === 0 ? "all passed" : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
