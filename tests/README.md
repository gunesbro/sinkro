# Browser tests

Unit tests run against a fake video. These run the built extension in a real browser, against real `<video>` elements on local test pages and a local copy of the server (`wrangler dev`), with several people in a room. Nothing goes to Cloudflare or to any outside site.

```sh
npx playwright-core install chromium   # once
npm run test:e2e                        # builds, then runs every scenario
npm run test:e2e -- sync popup          # just these
npm run test:e2e -- sync --repeat 3     # again and again, for timing bugs that only show sometimes
```

Each scenario prints a line per check, `ok` or `FAIL`, and the run ends with the ones that failed. CI runs every scenario on every pull request.

| Scenario           | What it checks                                                                |
| ------------------ | ----------------------------------------------------------------------------- |
| `sync`             | Three people play, pause, seek and change speed together; drift stays small   |
| `detection`        | The right video is found across frames, shadow roots, previews and decoys     |
| `popup`            | Creating, joining and leaving a room through the real popup                   |
| `badge`            | The on-video badge, its notices and dragging it                               |
| `other-video`      | Moving to another video, bringing everyone there, going back                  |
| `invite-page`      | The invite page, with the extension installed and without                     |
| `source-check`     | Two people on players of different lengths, or different players, are told so |
| `unstarted-player` | A player that's only a picture and a button until someone presses it          |
| `network-drop`     | Reconnecting after the network drops                                          |
| `people-count`     | The room counts each person once, back/forward cache included                 |
| `extension-reload` | What ran in a tab stops when the extension is reloaded                        |
| `extension-update` | An open tab keeps its video after the extension updates                       |
| `page-hook`        | The page hook goes only into tabs in a room                                   |
| `toolbar-icon`     | The toolbar icon and its people count                                         |
| `names`            | Random names: the popup's list, who did what on the badge, drawing a new name |
| `buffering`        | A slow connection whose player pauses itself to buffer never pauses the room  |
| `empty-room-page`  | A room started on a page with no video asks to make the first video its own   |
| `frame-swap`       | A player's frame replaced, or the page left, hands the room over at once      |

## Settings

| Variable           | Default                 | What for                                 |
| ------------------ | ----------------------- | ---------------------------------------- |
| `SINKRO_BROWSER`   | `chromium`              | `msedge` or `chrome` to use one you have |
| `SINKRO_EXTENSION` | `extension/dist/chrome` | Test another build                       |
| `SINKRO_SHOTS`     | a new temporary folder  | Where screenshots go                     |
| `SINKRO_SOAK`      | `30`                    | Seconds `sync` lets three people play    |

Browsers run headless and muted. Scenarios use fixed ports in the 8800s, so the runner runs them one at a time.

## Writing one

Copy the closest scenario. A few things learned the hard way:

- Playwright's `evaluate` counts as a user gesture, and it carries through `chrome.tabs.sendMessage` into the tab. A test of blocked autoplay mustn't touch the page before checking the block.
- Playwright turns off the back/forward cache by default, which hides real bugs. Launch with `ignoreDefaultArgs: ["--disable-back-forward-cache"]`, and use `history.back()` rather than `page.goBack()`.
- Reloading the extension leaves old content scripts running in open tabs, and the browser doesn't add new ones. Test both.
- `chrome.tabs.query` gives no `url` without the tabs permission. Find a test's tab by bringing it to the front and asking for the active one.
- Silent WAV audio, generated in the test, plays as a real video with no media files in the repo. Served with range requests it can seek; without them it stands in for a stream.
