# Sinkro

Sinkro is a free, open-source (MIT) browser extension that lets people on different computers watch any video on any website in sync — a watch party for the whole web. Chrome, Edge and Firefox from one Manifest V3 codebase. Desktop only; no mobile app, no separate desktop app.

One-sentence description (use verbatim in README, store listings, site):
> Sinkro is a free, open-source watch party extension for Chrome, Edge and Firefox that keeps any video on any website in sync with your friends.

Full background and reasoning: `docs/PLAN.md`. Visual design: `docs/DESIGN.md` and `docs/design-reference/`.

## Decisions already made (don't relitigate without asking)

- **Product**: browser extension + a static invite/landing page. No accounts, no analytics. Only room code, playback state (playing/paused, position, rate, timestamp) the page address and title of the room's video, the video's length and its player's site (sealed), whether someone is on an ad, whether someone isn't on the room's video (a yes or no, never which page), and each person's name, drawn at random from a list and never typed (sealed), ever reach the server — never video content. Those two flags, the name and a random per-connection id, used to spot reconnects, live only with the connection and are never stored. The address and title are sent only on creating a room or bringing everyone to a video, sealed with a key from the room code, so joining by code can show the video's name and offer a button to it.
- **Languages**: English is the default, Turkish is the second language, both in the MVP. Use the WebExtension `_locales/en` and `_locales/tr` message files; the popup has an EN/TR switch that overrides the browser language. Every user-facing string goes through i18n from day one — no hard-coded copy.
- **Server**: Cloudflare Workers + Durable Objects (one Durable Object per room, WebSocket hibernation). Free tier. The server URL is configurable in extension settings so anyone can self-host.
- **Hosting for the invite page**: Cloudflare Pages at `sinkro.pages.dev` for now. A real domain comes later.
- **License**: MIT.
- **Name**: Sinkro (from "senkron"; reads the same in Turkish and English). Store title: "Sinkro — Watch Party: Sync Any Video With Friends".

## Differentiation (what we optimise for)

1. Flawless, self-explanatory UI/UX: zero setup, always-visible sync status, warnings that offer a one-click fix.
2. The best video detection on any site (see below).
3. Rooms of 10+ people (several competitors cap at 2).
4. Precise sync: clock-offset measurement, gentle playback-rate correction, seek only as a last resort.
5. Continuous maintenance: an automated test suite catches site breakage before users do.

## Architecture

```
extension/            MV3 extension (Chrome, Edge, Firefox)
  src/content/        content script: video detection, binding, sync engine, on-video badge + alerts
  src/adapters/       per-site adapters (Netflix etc.) — v1, community-contributed
  src/popup/          popup UI (create/join room, room view)
  src/background/     service worker: frame coordination, settings
  _locales/en, tr     i18n messages
server/               Cloudflare Worker + Durable Object (room)
site/                 static invite/landing page (Cloudflare Pages)
tests/                Playwright test pages + e2e
docs/                 PLAN.md, DESIGN.md, design-reference/
```

- Keep the WebSocket in the content script or an offscreen document — the MV3 service worker goes to sleep.
- Protocol messages: `join`, `state` (playing/paused, position, rate, sender timestamp, and what the viewer changed, so the server combines actions that cross), `ping`/`pong` (clock offset), `video/get`/`video/set`/`video` (the room's video, sealed), `ad`/`ads` (who's on an ad), `behind`/`left_behind` (how many aren't on the room's video), `drift`/`spread` (how far apart people are), `film`/`films` (each viewer's film length and sealed player site, to spot a different cut), `name`/`people` (each person's random name, sealed, so a change can say who made it), `chat` (v1).
- **Mixed versions**: people in a room can run different extension versions, and the hosted server updates separately from all of them. New optional fields don't bump `PROTOCOL_VERSION`, because both sides ignore what they don't know. Bump it only for a change old clients can't work with, and keep `MIN_PROTOCOL_VERSION` as low as possible so existing installs keep working.
- **Actions that cross**: a viewer's state names what their action changed and the room state they knew. The server applies only those parts, so a pause and a seek at the same moment both stick; on the same part the later one wins. A state without them replaces the room's whole.
- **Echo loop prevention**: every remotely applied command sets a pending-event flag; flagged local events are not re-broadcast.
- **Live streams**: nothing is synced. Each viewer's position counts from when they opened the stream, so positions can't be compared, and everyone is at the live edge anyway. A video whose length has no end, or keeps growing, is live; the badge and popup say "Live stream".
- **Drift**: ignore < 0.15 s; 0.15–2 s correct with `playbackRate` 0.95–1.05; > 2 s seek. Each viewer is measured against the room's timeline, so two people can be twice the dead band apart: that's why it's half of what's noticeable. Each viewer tells the room their drift, and the popup shows the spread between the furthest two.
- **Another video**: nobody is moved by force. Whoever goes to another video goes on hold and gets "Bring everyone here" and "Back to the room"; when someone brings everyone, the others go on hold and get a button to follow, and the rest of the room sees how many aren't on its video. Browsing sends no address: the others only learn, as a yes or no, that someone isn't on the room's video. The page address only leaves the browser when one of those buttons is pressed.

## Video detection (core feature — make it excellent)

Six discovery layers: (1) DOM scan + `MutationObserver`; (2) open shadow roots, closed ones via `chrome.dom.openOrClosedShadowRoot` (`element.openOrClosedShadowRoot` on Firefox), because custom elements usually attach before they're in the document, so a page-context hook's event would be lost; (3) all frames (`all_frames`, `match_about_blank`, `match_origin_as_fallback`), candidates reported with `frameId`; (4) page-context hooks on `HTMLMediaElement.prototype.play` and `src`, added only to tabs in a room so other sites can't tell Sinkro is installed; (5) capture-phase `play`/`playing`/`loadedmetadata` on `document`; (6) site adapters.

Scoring picks one winner across all frames: + visible area, playing, unmuted, duration > 60 s, last clicked/hovered; − muted autoplay previews, hover thumbnails, tiny/hidden elements. Detect ads (duration jumps, source switches) and pause sync while one runs. Re-bind on SPA navigation (`pushState` hook, Navigation API) and element swaps (fingerprint: duration, source, title). Warn when participants are on different videos (duration differs > 1 s or normalised URLs differ). Fallback: a manual "pick the video" mode, remembered per site.

## MVP scope (phase 1)

Create/join room by code or link · play/pause/seek/rate sync · drift correction · detection engine (layers 1–5, scoring, manual picker) · ad detection · on-video badge the viewer can drag anywhere on the video · configurable server URL · invite page · EN + TR.
Later: big-screen mode that fills the window through temporary CSS, off by default and with no moving of the site's DOM (after real-site testing), participants list with "who did what" (v1; random names, the popup's list and named badge notices are done, per-person status needs a privacy decision first), chat + reactions (v1; typed chat counts as personal communications in both stores, fixed-list reactions don't), host-only control (v1), site adapters (v1), "everyone ready" wait (v1), voice chat (v2), local-file mode (last). Same-source comparison is done as length plus sealed player site (`film`/`films`).

Phase gate for MVP: 3 people, a 1-hour video, drift stays under 0.5 s. **Passed and released:** the MVP is in the Chrome Web Store and Firefox Add-ons (November 2026).

## Releases and stores

- Stores: [Chrome Web Store](https://chromewebstore.google.com/detail/sinkro-%E2%80%94-watch-party-sync/gndjbfbcaaffalmlcjlhofbboopbcgdc), which Edge installs from too, and [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/sinkro/), listed. There's no separate Edge store listing for now.
- The version lives in `extension/package.json` (and the lockfile). Pushing a tag `vX.Y.Z` on `main` runs `.github/workflows/release.yml`: checks, the Chrome and Firefox zips, a GitHub pre-release, and the Firefox package sent to Firefox Add-ons as a listed version. Firefox Add-ons takes each version number once, listed or unlisted, so every release needs a new number; the workflow skips sending one AMO already has. The Chrome zip is uploaded by hand in the Chrome Web Store dashboard.
- Store data declarations: Chrome declares web history and website content; Firefox declares `browsingActivity` and `websiteContent` in the manifest (`extension/scripts/build.mjs`). Anything new that leaves the browser means updating both, and anything a person types counts as personal data in both stores.
- The hosted server and the site are deployed by the maintainer, from `main`: `npm run deploy -w server`, then `npx wrangler pages deploy site --project-name sinkro --branch main --commit-dirty=true --force`. After merging a change to `server/` or `site/`, say which of them needs deploying.

## Working conventions

- Public repo. `main` is always releasable; never commit straight to it.
- Only the maintainer (@gunesbro) merges pull requests. AI agents open PRs and stop there: never run `gh pr merge`, with or without `--admin`, unless the maintainer asks for that specific PR in the current conversation.
- `docs/` is gitignored and exists only on the maintainer's machine for now; it gets edited and published near the end. Never commit it, and don't link to it from public files.
- One branch + one pull request per piece of work. Agents don't push release tags, deploy, or submit to stores without the maintainer's go for that release.
- Small, focused commits with clear messages. PR description says what changed, how it was tested, and what's left.
- Accessibility is part of done: real `<button>`/`<label>`/`<input>`, 44 px touch targets, text contrast ≥ 4.5:1, `aria-label` on icon-only buttons.
- Public text (README, store listings, site) makes no claims about other watch party projects, and names no real streaming sites; screenshots use a made-up demo site.
- Bugs from real sites: reproduce them from the maintainer's steps with a real browser and the real extension, and add a browser scenario under `tests/e2e` for what was found. Respect sites' blocks; never get around them.
- Privacy is a feature: never add telemetry, never send page titles or URLs to the server beyond the sealed address and title of the room's video. The room's socket opens from the page, so browsers send that site's `Origin` with it: never store or use it on the server, and keep the privacy page saying so.
