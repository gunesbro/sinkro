// Two people moving to another video in a room, with a site that changes video without
// loading a page.
// Real browsers, the built extension and a local server: see tests/README.md.
import { chromium } from "playwright-core";
import { config, startServer, stopServers } from "./lib.mjs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { extPath, shotDir } = config;

const API = "http://localhost:8809";
const WEB = "http://localhost:8843";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== "" ? " -> " + detail : ""}`);
};
async function until(fn, timeoutMs = 10000, stepMs = 100) {
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

function makeFilm(seconds) {
  const rate = 8000;
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
  return film;
}
const films = { 1: makeFilm(3600), 2: makeFilm(1800) };

const web = createServer((req, res) => {
  const url = new URL(req.url, WEB);
  const match = /^\/film(\d)\.wav$/.exec(url.pathname);
  if (match) {
    const film = films[match[1]];
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
  if (url.pathname === "/browse")
    return res.end(`<!doctype html><meta charset=utf-8><title>Ana sayfa</title><h1>nothing</h1>`);
  const id = url.searchParams.get("v") ?? "1";
  res.end(`<!doctype html><meta charset=utf-8><title>Film ${id}</title><body style="margin:0"><video id=v src="/film${id}.wav" width=800 height=450 preload=auto></video><script>
    window.v = document.getElementById("v");
    // The way a video site changes film: same page, same element, new address and source.
    // Some sites put a whole new element in.
    window.goToNewElement = (next) => {
      history.pushState({}, "", "/watch?v=" + next);
      const fresh = document.createElement("video");
      fresh.src = "/film" + next + ".wav"; fresh.width = 800; fresh.height = 450; fresh.preload = "auto";
      window.v.replaceWith(fresh);
      window.v = fresh;
      fresh.play();
    };
    // A miniplayer: the address goes elsewhere and the same film keeps playing.
    window.toMiniplayer = () => { history.pushState({}, "", "/"); document.title = "Home"; v.style.cssText = "position:fixed;right:10px;bottom:10px;width:280px;height:158px"; };
    window.fromMiniplayer = (back) => { history.pushState({}, "", back); document.title = "Film"; v.style.cssText = ""; };
    window.goTo = (next) => {
      history.pushState({}, "", "/watch?v=" + next);
      document.title = "Film " + next;
      v.src = "/film" + next + ".wav";
      v.play();
    };
  </script>`);
});
await new Promise((r) => web.listen(8843, r));
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

const all = [];
async function viewer(name, path) {
  const context = await chromium.launchPersistentContext(
    mkdtempSync(join(tmpdir(), `sinkro-change-${name}-`)),
    {
      channel: config.channel,
      headless: false,
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
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
  all.push(context);
  const sw =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const popupUrl = `chrome-extension://${new URL(sw.url()).host}/popup.html`;
  const control = await context.newPage();
  await control.goto(popupUrl);
  await control.evaluate(
    (serverUrl) => chrome.storage.local.set({ serverUrl, language: "en" }),
    API,
  );
  const tab = await context.newPage();
  await tab.goto(`${WEB}${path}`);
  await wait(1500);
  await tab.bringToFront();
  const tabId = await control.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
  );
  const openPopup = async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 640 });
    await popup.goto(popupUrl);
    await tab.bringToFront();
    await popup.reload();
    await popup.waitForSelector("main:not([hidden])");
    return popup;
  };
  return {
    context,
    control,
    tab,
    tabId,
    openPopup,
    status: () =>
      control.evaluate((t) => chrome.tabs.sendMessage(t, { type: "session/status" }), tabId),
    video: () =>
      tab.evaluate(() => ({
        time: window.v.currentTime,
        paused: window.v.paused,
        duration: window.v.duration,
        src: window.v.currentSrc,
      })),
  };
}
const text = (popup, sel) =>
  popup
    .locator(sel)
    .first()
    .innerText()
    .catch(() => "");
const shot = (p, name) => p.screenshot({ path: join(shotDir, `change-${name}.png`) });
/** Where the first big button on a badge card is: it's in a closed root, so go by the pixels of its label. */
const kindOf = async (v) => (await v.status())?.videoChange?.kind ?? null;

try {
  const a = await viewer("a", "/watch?v=1");
  const b = await viewer("b", "/browse");

  // ---- creating shares the title
  const popupA = await a.openPopup();
  await popupA.click("#create");
  await until(async () => /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(await text(popupA, "#room-code")));
  const code = await text(popupA, "#room-code");
  await until(async () => (await a.status())?.connection === "connected");
  await a.tab.evaluate(() => {
    window.v.currentTime = 300;
    return window.v.play();
  });

  const popupB = await b.openPopup();
  await popupB.fill("#join-input", code);
  await popupB.click("#join-form button");
  await until(async () => (await text(popupB, "#alert-detail")) === "Film 1");
  check(
    "someone joining by code sees the video's title",
    (await text(popupB, "#alert-detail")) === "Film 1",
    await text(popupB, "#alert-detail"),
  );
  check(
    "and still has to press the button to go",
    b.tab.url().endsWith("/browse") && (await popupB.locator("#go-video").isVisible()),
  );
  await shot(popupB, "joined-by-code");

  await popupB.click("#go-video");
  await until(() => b.tab.url().includes("watch?v=1"));
  await until(async () => (await b.status())?.peers === 2);
  await until(
    async () =>
      Math.abs((await b.video()).time - (await a.video()).time) < 1 && !(await b.video()).paused,
  );
  check(
    "the button takes them there, in sync",
    Math.abs((await b.video()).time - (await a.video()).time) < 1,
    `${(await b.video()).time} / ${(await a.video()).time}`,
  );
  check("arriving by the button isn't called moving away", (await kindOf(b)) === null);
  check("and neither is the viewer who created the room", (await kindOf(a)) === null);

  // ---- a miniplayer: same film, another address
  const watchPath = await a.tab.evaluate(() => location.pathname + location.search);
  await a.tab.evaluate(() => window.toMiniplayer());
  await wait(2500);
  const miniStatus = await a.status();
  check(
    "a miniplayer isn't called moving away",
    miniStatus.videoChange === null && miniStatus.isFilmStillPlaying === true,
    JSON.stringify({
      c: miniStatus.videoChange,
      s: miniStatus.isFilmStillPlaying,
      h: miniStatus.hold,
    }),
  );
  check("and the sync doesn't go on hold", miniStatus.hold === null, String(miniStatus.hold));
  await wait(1500);
  check(
    "nor is B told A is elsewhere",
    (await b.status())?.othersBehind === 0,
    String((await b.status())?.othersBehind),
  );
  // A pause someone makes comes with a key or click, which is how it's told from a player's own.
  await a.tab.keyboard.press("Shift");
  await a.tab.evaluate(() => {
    window.v.pause();
  });
  await until(async () => (await b.video()).paused);
  check("A's pause from the miniplayer reaches B", (await b.video()).paused);
  await a.tab.evaluate(() => window.v.play());
  await until(async () => !(await b.video()).paused);
  check("and so does the play", !(await b.video()).paused);
  const popupMini = await a.openPopup();
  await wait(1000);
  check(
    "the popup offers no way to the video it's already playing",
    await popupMini.locator("#go-video").isHidden(),
  );
  check(
    "and doesn't offer sending this address to everyone",
    await popupMini.locator("#bring").isDisabled(),
  );
  await popupMini.close();
  await a.tab.evaluate((back) => window.fromMiniplayer(back), watchPath);
  await wait(1500);
  const backStatus = await a.status();
  check(
    "going back to the page is simply normal again",
    backStatus.videoChange === null && backStatus.isFilmStillPlaying === false,
    JSON.stringify(backStatus.videoChange),
  );
  // Then a different film from the miniplayer's page is still noticed.
  await a.tab.evaluate(() => window.toMiniplayer());
  await wait(1500);
  await a.tab.evaluate(() => {
    window.v.src = "/film2.wav";
    window.v.play();
  });
  await until(async () => (await kindOf(a)) === "you_moved");
  check("a new film after that is noticed", (await kindOf(a)) === "you_moved");

  // The maintainer's report: bringing everyone from here would send them to the home page.
  const miniMoved = await a.status();
  check("it's known to be a small player", miniMoved.isFloatingPlayer === true);
  const popupFloat = await a.openPopup();
  await until(async () => (await text(popupFloat, "#go-video")) === "Back to the room");
  check(
    "bringing everyone isn't offered, so the home page can't become the room's video",
    await popupFloat.locator("#bring").isDisabled(),
  );
  check(
    "and it says what to do instead",
    (await text(popupFloat, "#alert-body")).includes("own page"),
    await text(popupFloat, "#alert-body"),
  );
  await shot(popupFloat, "floating-popup");
  await popupFloat.close();
  await a.tab.bringToFront();
  await wait(500);
  await shot(a.tab, "floating-badge");
  check(
    "the room stays on its video",
    (await kindOf(b)) === null && b.tab.url().includes("watch"),
    b.tab.url(),
  );

  // Opening the new film's own page gives the button back.
  await a.tab.evaluate(() => window.fromMiniplayer("/watch?v=2"));
  await until(async () => (await a.status())?.isFloatingPlayer === false);
  await wait(800);
  const popupOpened = await a.openPopup();
  await until(async () => await popupOpened.locator("#bring").isEnabled());
  check(
    "on the film's own page, bringing everyone works again",
    await popupOpened.locator("#bring").isEnabled(),
  );
  await popupOpened.close();
  await a.tab.bringToFront();

  await a.tab.evaluate(() => {
    window.v.src = "/film1.wav";
    window.v.play();
  });
  await a.tab.evaluate((back) => window.fromMiniplayer(back), watchPath);
  await until(async () => (await kindOf(a)) === null);
  await until(async () => Math.abs((await a.video()).time - (await b.video()).time) < 1);

  // ---- A wanders off
  await a.tab.evaluate(() => window.goTo(2));
  await until(async () => (await kindOf(a)) === "you_moved");
  check("moving to another video is noticed", (await kindOf(a)) === "you_moved");
  await until(async () => (await a.video()).duration < 2000);
  await wait(2500);
  const aOff = await a.video();
  const bStill = await b.video();
  check(
    "B stays on the film, unmoved",
    bStill.src.endsWith("film1.wav") && !bStill.paused && bStill.time > 290,
    JSON.stringify(bStill),
  );
  check("B isn't moved or asked to follow", (await kindOf(b)) === null);
  await until(async () => (await b.status())?.othersBehind === 1);
  check(
    "but B hears one person is on another video, and nothing about which",
    (await b.status())?.othersBehind === 1,
    String((await b.status())?.othersBehind),
  );
  check("A's new video isn't dragged to the room's position", aOff.time < 30, String(aOff.time));
  await a.tab.bringToFront();
  await shot(a.tab, "you-moved-badge");

  // ---- nothing A does on the other video reaches the room
  await a.tab.evaluate(() => {
    window.v.currentTime = 500;
    window.v.pause();
  });
  await wait(1500);
  check(
    "A's seek and pause don't reach B",
    !(await b.video()).paused && (await b.video()).time < 400,
    JSON.stringify(await b.video()),
  );

  // ---- the popup says the same, and offers both
  const popupA2 = await a.openPopup();
  await until(async () => (await text(popupA2, "#alert-title")) === "You're on a different video");
  check(
    "the popup explains it",
    (await text(popupA2, "#alert-title")) === "You're on a different video",
  );
  check("and offers going back", (await text(popupA2, "#go-video")) === "Back to the room");
  check("and bringing everyone", await popupA2.locator("#bring").isEnabled());
  await shot(popupA2, "you-moved-popup");

  // ---- back to the room
  await popupA2.click("#go-video");
  await until(() => a.tab.url().includes("watch?v=1"));
  await until(async () => (await a.status())?.peers === 2 && (await kindOf(a)) === null);
  await until(
    async () =>
      Math.abs((await a.video()).time - (await b.video()).time) < 1 && !(await a.video()).paused,
  );
  check(
    "going back returns to the film, in sync",
    Math.abs((await a.video()).time - (await b.video()).time) < 1 && !(await a.video()).paused,
    `${(await a.video()).time} / ${(await b.video()).time}`,
  );
  await until(async () => (await b.status())?.othersBehind === 0);
  check(
    "and B hears everyone is back",
    (await b.status())?.othersBehind === 0,
    String((await b.status())?.othersBehind),
  );
  await popupA2.close();

  // ---- bringing everyone, from the badge
  await a.tab.bringToFront();
  await a.tab.evaluate(() => window.goTo(2));
  await until(async () => (await kindOf(a)) === "you_moved");
  await until(async () => (await a.video()).duration < 2000);
  await a.tab.evaluate(() => {
    window.v.currentTime = 90;
  });
  await wait(1200);
  // The card opens under the pill at the video's top right. Its first button is below the text.
  const before = await a.video();
  const box = await a.tab.evaluate(() => {
    const r = window.v.getBoundingClientRect();
    return { right: r.right, top: r.top };
  });
  await shot(a.tab, "before-bring");
  const popupA3 = await a.openPopup();
  await until(async () => await popupA3.locator("#bring").isEnabled());
  await popupA3.click("#bring");
  await popupA3.close();
  await until(async () => (await kindOf(a)) === null);
  check("bringing clears A's notice", (await kindOf(a)) === null);
  await a.tab.bringToFront();
  await until(async () => (await kindOf(b)) === "room_moved");
  check(
    "B hears the room moved",
    (await kindOf(b)) === "room_moved",
    JSON.stringify((await b.status())?.videoChange),
  );
  check("with the new video's title", (await b.status())?.videoChange?.title === "Film 2");
  await until(async () => (await a.status())?.othersBehind === 1);
  check(
    "A hears one person hasn't come yet",
    (await a.status())?.othersBehind === 1,
    JSON.stringify((await a.status())?.othersBehind),
  );
  await wait(1500);
  const bHeld = await b.video();
  check(
    "B isn't moved by force",
    b.tab.url().includes("watch?v=1") && bHeld.src.endsWith("film1.wav"),
    b.tab.url(),
  );
  check(
    "B's film isn't dragged to the new position",
    bHeld.time > 200 && !bHeld.paused,
    JSON.stringify(bHeld),
  );
  const aAfter = await a.video();
  check(
    "A kept their place, not the old room's",
    Math.abs(aAfter.time - before.time) < 10,
    `${before.time} -> ${aAfter.time}`,
  );
  const popupA4 = await a.openPopup();
  await until(
    async () => (await text(popupA4, "#alert-title")) === "1 of 2 people are on this video",
  );
  check(
    "and A's popup says how many are here, with no warning about the old film's length",
    (await text(popupA4, "#alert-title")) === "1 of 2 people are on this video",
    await text(popupA4, "#alert-title"),
  );
  await shot(popupA4, "behind-popup");
  await popupA4.close();
  await b.tab.bringToFront();
  await shot(b.tab, "room-moved-badge");

  const popupB2 = await b.openPopup();
  await until(
    async () => (await text(popupB2, "#alert-title")) === "The room moved to another video",
  );
  check(
    "the popup says so too",
    (await text(popupB2, "#alert-detail")) === "Film 2",
    await text(popupB2, "#alert-detail"),
  );
  await shot(popupB2, "room-moved-popup");
  await popupB2.click("#go-video");
  await until(() => b.tab.url().includes("watch?v=2"));
  await until(async () => (await b.status())?.peers === 2 && (await kindOf(b)) === null);
  await until(async () => Math.abs((await b.video()).time - (await a.video()).time) < 1);
  check(
    "following takes B to the new video, in sync",
    Math.abs((await b.video()).time - (await a.video()).time) < 1 &&
      (await b.video()).src.endsWith("film2.wav"),
    `${(await b.video()).time} / ${(await a.video()).time}`,
  );
  await until(async () => (await a.status())?.othersBehind === 0);
  check(
    "once B has come, A hears nobody is left behind",
    (await a.status())?.othersBehind === 0,
    JSON.stringify((await a.status())?.othersBehind),
  );

  // ---- sync still works in both directions afterwards
  await a.tab.bringToFront();
  await a.tab.keyboard.press("Shift");
  await a.tab.evaluate(() => window.v.pause());
  await until(async () => (await b.video()).paused);
  check("A's pause reaches B on the new video", (await b.video()).paused);
  await b.tab.evaluate(() => window.v.play());
  await until(async () => !(await a.video()).paused);
  check("and B's play reaches A", !(await a.video()).paused);

  // ---- click the real badge button: A moves again and brings everyone from the card
  await a.tab.bringToFront();
  await a.tab.evaluate(() => window.goTo(1));
  await until(async () => (await kindOf(a)) === "you_moved");
  await wait(600);
  await shot(a.tab, "you-moved-badge-2");
  // Pill sits 12 px in from the top right of the video; the card follows with two lines of text.
  let clicked = false;
  for (let y = 110; y <= 240 && !clicked; y += 12) {
    await a.tab.mouse.click(box.right - 240, box.top + y);
    await wait(250);
    clicked = (await kindOf(a)) === null;
  }
  check("the button on the badge itself brings everyone", clicked);
  await until(async () => (await kindOf(b)) === "room_moved");
  check("and B hears about it", (await kindOf(b)) === "room_moved");

  // ---- never dragged: a new element straight after the address changes, while the room is far along
  const popupB3 = await b.openPopup();
  await until(async () => (await text(popupB3, "#go-video")).startsWith("Go to the video"));
  await popupB3.click("#go-video");
  await until(async () => (await kindOf(b)) === null && (await b.status())?.peers === 2);
  await popupB3.close();
  await b.tab.bringToFront();
  await b.tab.evaluate(() => {
    window.v.currentTime = 700;
  });
  await until(async () => (await a.video()).time > 600);
  await a.tab.evaluate(() => window.goToNewElement(2));
  let worst = 0;
  for (let i = 0; i < 15; i += 1) {
    worst = Math.max(worst, (await a.video()).time);
    await wait(100);
  }
  check(
    "a site swapping in a new element straight away doesn't get it dragged",
    worst < 10,
    String(worst),
  );
  check("and it's noticed", (await kindOf(a)) === "you_moved");
  await b.tab.bringToFront();
  await wait(800);
  check(
    "the room stays where it was",
    (await b.video()).time > 600,
    String((await b.video()).time),
  );
  await a.tab.bringToFront();

  // ---- bringing everyone from an ad: the maintainer's report. The room is well along the old
  // film, the new one is on an ad, and when that ends it must not jump to the old film's spot.
  await a.tab.goto(WEB + "/watch?v=1");
  await until(async () => (await a.status())?.peers === 2 && (await kindOf(a)) === null);
  await until(
    async () =>
      Math.abs((await a.video()).time - (await b.video()).time) < 1 && !(await a.video()).paused,
  );
  const adAttempt = await b.video();
  check("the room is well along before the move", adAttempt.time > 390, String(adAttempt.time));
  await a.tab.bringToFront();
  await a.tab.evaluate(() => window.goTo(2));
  await until(async () => (await kindOf(a)) === "you_moved");
  await until(async () => (await a.video()).duration < 2000);
  await a.tab.evaluate(() => document.body.classList.add("ad-showing"));
  await wait(500);
  await a.control.evaluate(
    (t) => chrome.runtime.sendMessage({ type: "video/bring", tabId: t }),
    a.tabId,
  );
  await until(async () => (await kindOf(b)) === "room_moved");
  check("B hears the room moved during A's ad", (await kindOf(b)) === "room_moved");
  await wait(1200);
  check(
    "A is held by the ad, with no notice about moving",
    (await a.status()).hold === "ad" && (await kindOf(a)) === null,
    String((await a.status()).hold),
  );
  const bPopup = await b.openPopup();
  await until(async () => (await text(bPopup, "#go-video")).startsWith("Go to the video"));
  await bPopup.click("#go-video");
  await until(() => b.tab.url().includes("watch?v=2"));
  await until(async () => (await b.status())?.peers === 2 && (await kindOf(b)) === null);
  await bPopup.close();
  await wait(2000);
  const bOnNew = await b.video();
  check("B doesn't arrive at the old film's position", bOnNew.time < 100, String(bOnNew.time));
  await a.tab.bringToFront();
  await a.tab.evaluate(() => document.body.classList.remove("ad-showing"));
  await wait(3000);
  const aAfterAd = await a.video();
  const bAfterAd = await b.video();
  check(
    "when A's ad ends, A isn't sent to the old film's position",
    aAfterAd.time < 100,
    String(aAfterAd.time),
  );
  check("and neither is B", bAfterAd.time < 100, String(bAfterAd.time));
  check(
    "and they're together",
    Math.abs(aAfterAd.time - bAfterAd.time) < 1.5,
    aAfterAd.time.toFixed(1) + " / " + bAfterAd.time.toFixed(1),
  );

  // ---- a page with no video on it still gets the card, and can only go back
  await a.tab.goto(`${WEB}/browse`);
  await until(async () => (await kindOf(a)) === "you_moved");
  check("leaving for a page with no video is noticed", (await kindOf(a)) === "you_moved");
  await wait(800);
  await shot(a.tab, "you-moved-no-video");
  const notice = await a.status();
  check("with no video to bring anyone to", notice.hasVideo === false);

  // Leaving from the card, with no popup. The buttons sit along the card's last row.
  let left = false;
  for (let y = 205; y <= 240 && !left; y += 8) {
    await a.tab.mouse.click(945, y);
    await wait(200);
    left =
      (await a.control.evaluate(
        (t) => chrome.runtime.sendMessage({ type: "session/of", tabId: t }),
        a.tabId,
      )) === null;
  }
  check("the card's Leave button leaves the room", left);
  check("and takes the card away", !(await a.status().catch(() => null))?.videoChange);
  await wait(600);
  await shot(a.tab, "left-from-card");
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
