<img src="extension/icons/icon-on-128.png" width="96" height="96" alt="">

# Sinkro

Sinkro is a free, open-source watch party extension for Chrome, Edge and Firefox that keeps any video on any website in sync with your friends.

**Status:** early development. Nothing is in the stores yet.

No accounts and no analytics. Only the room code, playback state (playing or paused, position, rate, timestamp), whether someone is on an ad and, when someone creates a room or brings everyone to their video, that page's address and title encrypted with the room code reach the server. The video itself never does.

## Install

Sinkro isn't in the extension stores yet. To try it now:

1. Install [Node.js](https://nodejs.org/) 24, then run `npm ci` and `npm run build` in this repository.
2. Open `chrome://extensions` or `edge://extensions` and turn on developer mode.
3. Choose **Load unpacked** and select `extension/dist/chrome`.

##

| Path         | What it is                                      |
| ------------ | ----------------------------------------------- |
| `extension/` | Manifest V3 extension for Chrome, Edge, Firefox |
| `server/`    | Cloudflare Worker that hosts rooms              |
| `site/`      | Static invite and landing page                  |
| `tests/`     | Playwright test pages and end-to-end tests      |

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
