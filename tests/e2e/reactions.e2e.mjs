// Reactions: one of six emoji sent from the badge on the video rises on everyone's screen
// with the sender's name, without touching playback, and can be hidden.
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

const API = "http://localhost:8831";
const WEB = "http://localhost:8864";
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
    `<!doctype html><meta charset=utf-8><title>Film</title><body style="margin:0;background:#333"><div id=wrap><video src="/film.wav" width=800 height=450 preload=auto></video></div><button id=fs onclick="document.getElementById('wrap').requestFullscreen()">Fullscreen</button>`,
  );
});
await new Promise((r) => web.listen(8864, r));
startServer("8831");
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

async function viewer(name) {
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), `sinkro-reactions-${name}-`)),
    {
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
    (serverUrl) => chrome.storage.local.set({ serverUrl, language: "en" }),
    API,
  );
  const page = await context.newPage();
  await page.goto(`${WEB}/film`);
  await page.waitForFunction(() => document.querySelector("video").duration > 0);
  await page.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  const cdp = await context.newCDPSession(page);

  /** Every element on the page, the badge's closed shadow root included, with its text. */
  const elements = async () => {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const found = [];
    const walk = (node, ancestors) => {
      if (node.nodeType === 3) return node.nodeValue;
      const attributes = {};
      for (let i = 0; i < (node.attributes ?? []).length; i += 2)
        attributes[node.attributes[i]] = node.attributes[i + 1];
      // The backend id stays the same from one look at the page to the next; the node id doesn't.
      const entry = {
        nodeId: node.nodeId,
        key: node.backendNodeId,
        tag: node.nodeName,
        attributes,
        ancestors,
        text: "",
      };
      if (node.nodeType === 1) found.push(entry);
      const inside =
        node.nodeType === 1 && attributes.id ? [...ancestors, attributes.id] : ancestors;
      let text = "";
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])])
        text += walk(child, inside) ?? "";
      entry.text = text;
      return text;
    };
    walk(root, []);
    return found;
  };
  const boxOf = async (nodeId) => {
    const { model } = await cdp.send("DOM.getBoxModel", { nodeId });
    const [x1, y1, x2, , , y3] = model.border;
    // As drawn, so a row shrunk out of sight measures as nothing.
    return { x: (x1 + x2) / 2, y: (y1 + y3) / 2, width: x2 - x1, height: y3 - y1 };
  };
  /** The reaction buttons that can be pressed now: none while the row is put away. */
  const buttons = async () => {
    const found = [];
    for (const element of await elements()) {
      if (element.attributes["data-reaction"] === undefined) continue;
      const box = await boxOf(element.nodeId).catch(() => null);
      if (box && box.width >= 40) found.push({ ...element, box });
    }
    return found;
  };
  const pill = async () =>
    (await elements()).find((element) => (element.attributes.style ?? "").includes("cursor: grab"));
  /** Opens the badge the way a pointer does. */
  const openBadge = async () => {
    await page.bringToFront();
    const found = await until(pill);
    const box = await boxOf(found.nodeId);
    await page.mouse.move(box.x + 3, box.y);
    await page.mouse.move(box.x, box.y);
    return box;
  };
  return {
    context,
    page,
    buttons,
    openBadge,
    join: (code) =>
      control.evaluate(
        ([t, c]) => chrome.runtime.sendMessage({ type: "session/join", tabId: t, code: c }),
        [tabId, code],
      ),
    status: () =>
      control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "session/status" }), tabId),
    /** The reactions on screen now: what each says, and the ids of the elements it's inside. */
    floaters: async () =>
      (await elements())
        .filter((element) => element.attributes["data-floater"] !== undefined)
        .map(({ key, text, ancestors }) => ({ key, text, ancestors })),
    /** Presses a reaction with the pointer, opening the badge first. */
    react: async (id) => {
      await openBadge();
      const button = await until(async () =>
        (await buttons()).find((element) => element.attributes["data-reaction"] === id),
      );
      await page.mouse.click(button.box.x, button.box.y);
    },
    showReactions: (show) =>
      control.evaluate(
        (on) =>
          on
            ? chrome.storage.local.remove("showReactions")
            : chrome.storage.local.set({ showReactions: false }),
        show,
      ),
  };
}

const nameOf = (pick) =>
  `${words("en", "nameAdjectives")[pick[0]]} ${words("en", "nameAnimals")[pick[1]]}`;
/** Collects the reactions seen over a while, since each is only up for two seconds. */
async function watch(person, ms) {
  const seen = new Map();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const { key, ...floater } of await person.floaters()) seen.set(key, floater);
    await wait(150);
  }
  return [...seen.values()];
}

const contexts = [];
try {
  const { code } = await (
    await fetch(`${API}/rooms`, { method: "POST", headers: { "CF-Connecting-IP": "reactions" } })
  ).json();
  const a = await viewer("a");
  contexts.push(a.context);
  const b = await viewer("b");
  contexts.push(b.context);
  await a.join(code);
  await until(async () => (await a.status())?.connection === "connected");
  await b.join(code);
  await until(async () => (await a.status())?.peers === 2);
  await until(async () => {
    const people = (await b.status())?.people ?? [];
    return people.length === 2 && people.every((person) => person.pick !== null);
  });
  const aName = nameOf((await b.status()).people.find((person) => !person.isYou).pick);

  await a.page.bringToFront();
  await a.page.keyboard.press("Shift");
  await a.page.evaluate(() => document.querySelector("video").play());
  const playing = await until(async () => {
    const status = await b.status();
    return status?.paused === false && status.position > 1;
  });
  check("both are playing together", playing === true, JSON.stringify(await b.status()));

  // ---- the row
  await a.openBadge();
  const row = await until(async () => {
    const found = await a.buttons();
    return found.length === 6 ? found : null;
  });
  check("the open badge offers six reactions", row?.length === 6, String(row?.length));
  check(
    "each is a button with a name, at least 44 px",
    (row ?? []).every(
      ({ tag, attributes, box }) =>
        tag === "BUTTON" &&
        (attributes["aria-label"] ?? "") !== "" &&
        box.width >= 44 &&
        box.height >= 44,
    ),
    JSON.stringify((row ?? []).map(({ box }) => [box.width, box.height])),
  );

  // ---- one reaction, seen by both
  const before = { a: await a.status(), b: await b.status(), at: Date.now() };
  const watching = [watch(a, 2200), watch(b, 2200)];
  await a.react("fire");
  const pressed = await a.buttons();
  const [onA, onB] = await Promise.all(watching);
  check(
    "the sender sees it at once, as their own",
    onA.some(({ text }) => text.includes("🔥") && text.includes("You")),
    JSON.stringify(onA),
  );
  check(
    "the other sees it with the sender's name",
    onB.some(({ text }) => text.includes("🔥") && text.includes(aName)),
    `${aName} | ${JSON.stringify(onB)}`,
  );
  check(
    "the row waits before the next one",
    pressed.length === 6 &&
      pressed.every((button) => button.attributes["aria-disabled"] === "true"),
    JSON.stringify(pressed.map((button) => button.attributes["aria-disabled"])),
  );
  const after = { a: await a.status(), b: await b.status(), at: Date.now() };
  const elapsed = (after.at - before.at) / 1000;
  check(
    "nobody's film paused or jumped",
    after.a.paused === false &&
      after.b.paused === false &&
      Math.abs(after.a.position - before.a.position - elapsed) < 1 &&
      Math.abs(after.b.position - before.b.position - elapsed) < 1,
    JSON.stringify([before.a.position, after.a.position, before.b.position, after.b.position]),
  );
  await wait(500);
  const rested = await a.buttons();
  check(
    "and takes one again after two seconds",
    rested.length === 6 && rested.every((button) => button.attributes["aria-disabled"] !== "true"),
    JSON.stringify(rested.map((button) => button.attributes["aria-disabled"])),
  );
  check(
    "nothing is left on either screen once they've gone",
    (await a.floaters()).length === 0 && (await b.floaters()).length === 0,
  );

  // ---- a press with the pointer doesn't keep the row
  await a.page.mouse.move(5, 600);
  const putAway = await until(async () => (await a.buttons()).length === 0, 3000);
  check("the row closes once the pointer has left, after a press too", putAway === true);
  await a.page.keyboard.press("ArrowRight");
  await a.page.keyboard.press("Enter");
  check(
    "and keys pressed afterwards aren't taken for reactions",
    (await watch(b, 1200)).length === 0,
  );

  // ---- a key held down is one reaction
  await a.page.bringToFront();
  await a.page.focus("#fs");
  await a.page.keyboard.press("Tab");
  const held = watch(b, 2600);
  for (let repeat = 0; repeat < 10; repeat += 1) {
    await a.page.keyboard.down("Enter");
    await wait(100);
  }
  await a.page.keyboard.up("Enter");
  const fromHeld = await held;
  check(
    "the row is reached with the keyboard, and a held key sends one",
    fromHeld.length === 1,
    JSON.stringify(fromHeld),
  );
  await wait(2200);

  // ---- fullscreen, and the badge dragged, with one in flight
  await b.page.bringToFront();
  await b.page.click("#fs");
  await until(() => b.page.evaluate(() => document.fullscreenElement?.id === "wrap"));
  const inFullscreen = watch(b, 1800);
  await a.react("clap");
  const grip = await a.openBadge();
  await a.page.mouse.down();
  await a.page.mouse.move(grip.x - 200, grip.y + 150, { steps: 5 });
  await a.page.mouse.up();
  const shown = await inFullscreen;
  check(
    "a reaction shows inside a fullscreen player",
    shown.some(({ text, ancestors }) => text.includes("👏") && ancestors.includes("wrap")),
    JSON.stringify(shown),
  );
  await wait(2500);
  check(
    "none is left behind after a drag or in fullscreen",
    (await a.floaters()).length === 0 && (await b.floaters()).length === 0,
  );
  await b.page.evaluate(() => document.exitFullscreen());

  // ---- hidden by the switch
  await b.showReactions(false);
  await b.openBadge();
  const gone = await until(async () => (await b.buttons()).length === 0);
  check("with reactions hidden, the row goes", gone === true);
  const whileHidden = watch(b, 1800);
  await a.react("wow");
  check("and nobody's reaction shows", (await whileHidden).length === 0);
  await wait(2200);
  await b.showReactions(true);
  await b.openBadge();
  const back = await until(async () => (await b.buttons()).length === 6);
  check("shown again, the row is back", back === true);
  const again = watch(b, 1800);
  await a.react("laugh");
  const seenAgain = await again;
  check(
    "and so are reactions",
    seenAgain.some(({ text }) => text.includes("😂")),
    JSON.stringify(seenAgain),
  );
  if (shotDir) {
    await wait(2200);
    await b.react("heart");
    await wait(500);
    await b.page.screenshot({ path: join(shotDir, "reactions-b.png") });
  }
} catch (error) {
  failures += 1;
  console.log("FAIL threw:", error);
} finally {
  await Promise.all(contexts.map((c) => Promise.race([c.close().catch(() => {}), wait(5000)])));
  web.close();
  stopServers();
}
console.log(failures === 0 ? "all passed" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
