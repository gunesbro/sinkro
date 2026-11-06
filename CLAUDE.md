# Sinkro

Sinkro is a free, open-source (MIT) browser extension that lets people on different computers watch any video on any website in sync — a watch party for the whole web. Chrome, Edge and Firefox from one Manifest V3 codebase. Desktop only; no mobile app, no separate desktop app.

One-sentence description (use verbatim in README, store listings, site):
> Sinkro is a free, open-source watch party extension for Chrome, Edge and Firefox that keeps any video on any website in sync with your friends.

Full background and reasoning: `docs/PLAN.md`. Visual design: `docs/DESIGN.md` and `docs/design-reference/`.

## Decisions already made (don't relitigate without asking)

- **Product**: browser extension + a static invite/landing page. No accounts, no analytics. Only room code, playback state (playing/paused, position, rate, timestamp) the page address and title of the room's video, the video's length and its player's site (sealed), and whether someone is on an ad, ever reach the server — never video content. The ad flag and a random per-connection id, used to spot reconnects, live only with the connection and are never stored. Those two are sent only on creating a room or bringing everyone to a video, sealed with a key from the room code, so joining by code can show the video's name and offer a button to it.
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
- Protocol messages: `join`, `state` (playing/paused, position, rate, sender timestamp), `ping`/`pong` (clock offset), `video/get`/`video/set`/`video` (the room's video, sealed), `ad`/`ads` (who's on an ad), `chat` (v1).
- **Mixed versions**: people in a room can run different extension versions, and the hosted server updates separately from all of them. New optional fields don't bump `PROTOCOL_VERSION`, because both sides ignore what they don't know. Bump it only for a change old clients can't work with, and keep `MIN_PROTOCOL_VERSION` as low as possible so existing installs keep working.
- **Echo loop prevention**: every remotely applied command sets a pending-event flag; flagged local events are not re-broadcast.
- **Drift**: ignore < 0.3 s; 0.3–2 s correct with `playbackRate` 0.95–1.05; > 2 s seek.
- **Another video**: nobody is moved by force. Whoever goes to another video goes on hold and gets "Bring everyone here" and "Back to the room"; when someone brings everyone, the others go on hold and get a button to follow. Browsing sends nothing: the page address only leaves the browser when one of those buttons is pressed.

## Video detection (core feature — make it excellent)

Six discovery layers: (1) DOM scan + `MutationObserver`; (2) open shadow roots, closed ones via `chrome.dom.openOrClosedShadowRoot` (`element.openOrClosedShadowRoot` on Firefox), because custom elements usually attach before they're in the document, so a page-context hook's event would be lost; (3) all frames (`all_frames`, `match_about_blank`, `match_origin_as_fallback`), candidates reported with `frameId`; (4) page-context hooks on `HTMLMediaElement.prototype.play` and `src`, added only to tabs in a room so other sites can't tell Sinkro is installed; (5) capture-phase `play`/`playing`/`loadedmetadata` on `document`; (6) site adapters.

Scoring picks one winner across all frames: + visible area, playing, unmuted, duration > 60 s, last clicked/hovered; − muted autoplay previews, hover thumbnails, tiny/hidden elements. Detect ads (duration jumps, source switches) and pause sync while one runs. Re-bind on SPA navigation (`pushState` hook, Navigation API) and element swaps (fingerprint: duration, source, title). Warn when participants are on different videos (duration differs > 2 s or normalised URLs differ). Fallback: a manual "pick the video" mode, remembered per site.

## MVP scope (phase 1)

Create/join room by code or link · play/pause/seek/rate sync · drift correction · detection engine (layers 1–5, scoring, manual picker) · ad detection · on-video badge the viewer can drag anywhere on the video · configurable server URL · invite page · EN + TR.
Later: big-screen mode that fills the window through temporary CSS, off by default and with no moving of the site's DOM (after real-site testing), same-source comparison for sites that serve one episode from several video hosts (to be evaluated), participants list with "who did what" (v1), chat + reactions (v1), host-only control (v1), site adapters (v1), "everyone ready" wait (v1), voice chat (v2), local-file mode (last).

Phase gate for MVP: 3 people, a 1-hour video, drift stays under 0.5 s.

## Working conventions

- Public repo. `main` is always releasable; never commit straight to it.
- Only the maintainer (@gunesbro) merges pull requests. AI agents open PRs and stop there: never run `gh pr merge`, with or without `--admin`, unless the maintainer asks for that specific PR in the current conversation.
- `docs/` is gitignored and exists only on the maintainer's machine for now; it gets edited and published near the end. Never commit it, and don't link to it from public files.
- One branch + one pull request per piece of work, in this order: repo skeleton → server → sync core → detection → popup UI → invite page → test suite.
- Small, focused commits with clear messages. PR description says what changed, how it was tested, and what's left.
- Accessibility is part of done: real `<button>`/`<label>`/`<input>`, 44 px touch targets, text contrast ≥ 4.5:1, `aria-label` on icon-only buttons.
- Privacy is a feature: never add telemetry, never send page titles or URLs to the server beyond the sealed address and title of the room's video. The room's socket opens from the page, so browsers send that site's `Origin` with it: never store or use it on the server, and keep the privacy page saying so.
