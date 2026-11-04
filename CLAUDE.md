# Sinkro

Sinkro is a free, open-source (MIT) browser extension that lets people on different computers watch any video on any website in sync — a watch party for the whole web. Chrome, Edge and Firefox from one Manifest V3 codebase. Desktop only; no mobile app, no separate desktop app.

One-sentence description (use verbatim in README, store listings, site):
> Sinkro is a free, open-source watch party extension for Chrome, Edge and Firefox that keeps any video on any website in sync with your friends.

Full background and reasoning: `docs/PLAN.md`. Visual design: `docs/DESIGN.md` and `docs/design-reference/`.

## Decisions already made (don't relitigate without asking)

- **Product**: browser extension + a static invite/landing page. No accounts, no analytics. Only room code and playback state (playing/paused, position, rate, timestamp) ever reach the server — never video content.
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
- Protocol messages: `join`, `state` (playing/paused, position, rate, sender timestamp), `ping`/`pong` (clock offset), `chat` (v1).
- **Echo loop prevention**: every remotely applied command sets a pending-event flag; flagged local events are not re-broadcast.
- **Drift**: ignore < 0.3 s; 0.3–2 s correct with `playbackRate` 0.95–1.05; > 2 s seek.

## Video detection (core feature — make it excellent)

Six discovery layers: (1) DOM scan + `MutationObserver`; (2) open shadow roots, closed ones via an `attachShadow` hook in page context; (3) all frames (`all_frames`, `match_about_blank`, `match_origin_as_fallback`), candidates reported with `frameId`; (4) page-context hooks on `HTMLMediaElement.prototype.play` and `src`; (5) capture-phase `play`/`playing`/`loadedmetadata` on `document`; (6) site adapters.

Scoring picks one winner across all frames: + visible area, playing, unmuted, duration > 60 s, last clicked/hovered; − muted autoplay previews, hover thumbnails, tiny/hidden elements. Detect ads (duration jumps, source switches) and pause sync while one runs. Re-bind on SPA navigation (`pushState` hook, Navigation API) and element swaps (fingerprint: duration, source, title). Warn when participants are on different videos (duration differs > 2 s or normalised URLs differ). Fallback: a manual "pick the video" mode, remembered per site.

## MVP scope (phase 1)

Create/join room by code or link · play/pause/seek/rate sync · drift correction · detection engine (layers 1–5, scoring, manual picker) · configurable server URL · invite page · EN + TR.
Later: participants list with "who did what" (v1), chat + reactions (v1), host-only control (v1), site adapters (v1), "everyone ready" wait (v1), voice chat (v2), local-file mode (last).

Phase gate for MVP: 3 people, a 1-hour video, drift stays under 0.5 s.

## Working conventions

- Public repo. `main` is always releasable; never commit straight to it.
- One branch + one pull request per piece of work, in this order: repo skeleton → server → sync core → detection → popup UI → invite page → test suite.
- Small, focused commits with clear messages. PR description says what changed, how it was tested, and what's left.
- Accessibility is part of done: real `<button>`/`<label>`/`<input>`, 44 px touch targets, text contrast ≥ 4.5:1, `aria-label` on icon-only buttons.
- Privacy is a feature: never add telemetry, never send page URLs or titles to the server beyond what the invite link needs.
