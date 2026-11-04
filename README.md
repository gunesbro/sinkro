# Sinkro

Sinkro is a free, open-source watch party extension for Chrome, Edge and Firefox that keeps any video on any website in sync with your friends.

**Status:** early development. Nothing is in the stores yet and syncing doesn't work yet.

No accounts and no analytics. Only the room code and playback state (playing or paused, position, rate, timestamp) reach the server, never the video itself.

## Repository layout

| Path         | What it is                                      |
| ------------ | ----------------------------------------------- |
| `extension/` | Manifest V3 extension for Chrome, Edge, Firefox |
| `server/`    | Cloudflare Worker that hosts rooms              |
| `site/`      | Static invite and landing page                  |
| `tests/`     | Playwright test pages and end-to-end tests      |
| `docs/`      | Plan, design rules and mockups                  |

## Development

You need Node.js 24 or newer.

```sh
npm install
npm run build   # writes extension/dist/chrome and extension/dist/firefox
npm run check   # formatting, types, locale files, builds, Firefox lint
```

**Load the extension**

- Chrome or Edge: open `chrome://extensions` or `edge://extensions`, turn on developer mode, choose "Load unpacked" and select `extension/dist/chrome`.
- Firefox: open `about:debugging#/runtime/this-firefox`, choose "Load Temporary Add-on" and select `extension/dist/firefox/manifest.json`.

**Run the server locally**

```sh
npm run dev -w server
```

## License

[MIT](LICENSE)
