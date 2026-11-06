<img src="extension/icons/icon-on-128.png" width="96" height="96" alt="">

# Sinkro

Sinkro is a free, open-source watch party extension for Chrome, Edge and Firefox that keeps any video on any website in sync with your friends.

**Status:** early development. Nothing is in the extension stores yet; see [Install](#install).

- **Any video, any site.** No list of supported sites: Sinkro finds the video on the page, inside frames and players that hide it, and tells it apart from previews and ads.
- **No account.** Open a video, create a room, send the link. Whoever opens it lands on the same video, at the same second.
- **Tight sync.** Everyone is measured against the room's shared timeline, with each computer's clock corrected. Small drift is evened out by playing a touch faster or slower, so nobody sees a jump; the popup shows how far apart the room is, usually a few hundredths of a second.
- **Rooms for up to 50 people.**
- **Says what's going on.** A small badge on the video shows whether you're in sync, who paused or skipped, and offers a one-click fix when something's off: someone on an ad, someone on a different video, a browser that wants a click first.
- **English and Turkish.**

## Install

Sinkro isn't in the extension stores yet. To try it now, take the latest package from [Releases](https://github.com/gunesbro/sinkro/releases):

- **Chrome or Edge:** download `sinkro-chrome-….zip` and unzip it. Open `chrome://extensions` or `edge://extensions`, turn on developer mode, choose **Load unpacked** and select the unzipped folder.
- **Firefox:** if the release has an `.xpi` file, open it in Firefox to install. Otherwise download `sinkro-firefox-….zip`, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on** and pick the zip; it goes away when Firefox closes.

Everyone in a room installs it the same way. To build it yourself instead, see [Development](#development).

## How to use it

1. Open a video on any site and click the Sinkro icon.
2. Choose **Create a room** and send the invite link, or read out the room code.
3. Your friends open the link, or paste the code into Sinkro, and press **Join**. They're taken to the same video, at the same second.

From then on, play, pause, seeking and speed reach everyone. If someone goes to another video, nobody is moved by force: they can **Bring everyone here** or go **Back to the room**, and the others see how many people are away.

## How it works

Each person's browser holds a connection to a small room server. When someone plays, pauses, seeks or changes speed, their browser sends the new playback state, and the others apply it. Everyone keeps to one shared timeline, using server time measured against each computer's own clock. When two people act at the same moment, the room keeps both: a pause and a seek sent together end up paused at the seek.

Some things Sinkro deliberately doesn't do:

- **Live streams aren't synced.** On a live stream each viewer's position counts from when they opened it, so positions can't be compared, and everyone is watching live anyway. The badge says "Live stream".
- **Some large streaming services don't let a page move their player.** Those need a small site-specific adapter, which is planned.
- **Ads aren't skipped.** When someone is on an ad, Sinkro leaves their ad alone, tells the others, and brings them back to the room's spot when it ends.

## Privacy

No accounts and no analytics. Only these reach the server:

- the room code;
- playback state: playing or paused, position, speed and a timestamp, with the video's length and player site encrypted;
- whether someone is on an ad, how far their video is from the room's, and whether they're on the room's video at all, as a yes or no, never which page;
- the address and title of the room's video, encrypted with the room code, and only when someone creates a room or brings everyone to a video.

The video itself never does. See the [privacy page](https://sinkro.pages.dev/privacy.html) for the details.

## FAQ

**Does everyone need the extension?** Yes. The invite page offers to install it.

**Does everyone need an account on the video site?** Only if the site asks for one. Each person watches with their own browser and their own login; Sinkro only keeps the players together.

**Does it share my screen or my video?** No. Only the playback state above leaves your browser.

**Can I use it on my phone?** No. Mobile browsers mostly don't support extensions.

**Can I run my own server?** Yes, for free. See below.

## Run your own server

The server is a Cloudflare Worker with one Durable Object per room, and it fits Cloudflare's free plan. You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and Node.js 24.

1. Clone this repository and run `npm ci`.
2. Sign in to Cloudflare: `npx wrangler login`.
3. Deploy: `npm run deploy -w server`. Wrangler prints the address, ending in `workers.dev`.
4. Optional: so that the connection limits can't link back to anyone's address, set a secret key from `server/`: `npx wrangler secret put IP_HASH_KEY`, then deploy again.
5. In Sinkro, open **Settings** (the sliders icon in the popup) and paste that address into **Server address**. Everyone in a room needs the same server.

The [server README](server/README.md) describes the protocol and its limits.

## Development

| Path         | What it is                                      |
| ------------ | ----------------------------------------------- |
| `extension/` | Manifest V3 extension for Chrome, Edge, Firefox |
| `server/`    | Cloudflare Worker that hosts rooms              |
| `site/`      | Static invite and landing page                  |
| `tests/`     | Real-browser tests of the built extension       |

You need Node.js 24 or newer.

```sh
npm install
npm run build   # writes extension/dist/chrome and extension/dist/firefox
npm run check   # formatting, types, locale files, builds, Firefox lint, unit tests
```

**Load the extension**

- Chrome or Edge: open `chrome://extensions` or `edge://extensions`, turn on developer mode, choose "Load unpacked" and select `extension/dist/chrome`.
- Firefox: open `about:debugging#/runtime/this-firefox`, choose "Load Temporary Add-on" and select `extension/dist/firefox/manifest.json`.

**Run the server locally**

```sh
npm run dev -w server
```

Then set the server address in the extension's settings to the one Wrangler prints. Newer Chrome and Edge versions ask before a public site may connect to `localhost`, so a local server is easiest to use with local test pages.

**Run the browser tests**

```sh
npx playwright-core install chromium   # once
npm run test:e2e                        # every scenario, or name some: npm run test:e2e -- sync popup
```

See [tests/README.md](tests/README.md) for what they cover.

**Contributing.** Every change goes through a pull request; CI runs the checks and every browser scenario. Please report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
