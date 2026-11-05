# Sinkro server

A Cloudflare Worker with one Durable Object per room. It relays playback state between the people in a room and never sees video. It stores the address and title of the room's video only in a form sealed by the extension. It works on Cloudflare's free plan.

## Self-hosting

```sh
npm install
npx wrangler login
npm run deploy -w server
```

Then enter the `workers.dev` URL as the server URL in the extension's settings.

## HTTP

| Request                | Result                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| `GET /health`          | `200 {"ok":true}`                                                          |
| `POST /rooms`          | `201 {"code":"K7M-2QX"}`, or `429` past 10 rooms a minute from one address |
| `GET /rooms/{code}/ws` | WebSocket upgrade; the code is case-insensitive and the dash is optional   |

The creation limit keeps a hash of the address for at most a minute, then deletes it. Addresses themselves aren't stored. A room is deleted 24 hours after its last person leaves, or 24 hours after it's created if nobody joins. A room with people in it closes with code `4408` and is deleted after 12 hours with no one joining and no change of playback or video. It's checked once an hour, so this can run an hour late.

## Reconnecting

A client may send `viewer` in `join`, any string of up to 64 characters that stays the same across its reconnects. A new join with the same value closes the older socket and replaces it, so it isn't counted twice. It's kept with the connection, not in storage.

## Someone on an ad

A client that has joined can send `{"type":"ad","watching":true}`. Everyone who has joined gets `{"type":"ads","count":n}`, counting the others on an ad, and someone joining gets it in `joined` as `ads`, when any are. It's kept with the connection, not in storage.

## The room's video

Without joining, a client can send `{"type":"video/get"}` or `{"type":"video/set","sealed":"..."}`, and the room answers `{"type":"video","sealed":...}`. Setting it also sends that answer to everyone who has joined, and whoever joins later gets it in `joined` as `video`. The value is opaque to the server and deleted with the room.

## WebSocket messages

All messages are JSON text of at most 4096 characters. The types are in [`src/protocol.ts`](src/protocol.ts).

| Direction | Message                                                | Notes                                                 |
| --------- | ------------------------------------------------------ | ----------------------------------------------------- |
| →         | `{type:"join",protocol:1}`                             | Send first                                            |
| ←         | `{type:"joined",clientId,state,peers}`                 | `state` is null until someone sends one               |
| →         | `{type:"state",playing,position,rate,sentAt}`          | `position` in seconds, `sentAt` in server time (ms)   |
| ←         | `{type:"state",playing,position,rate,sentAt,seq,from}` | Goes to everyone, sender included; ignore lower `seq` |
| →         | `{type:"ping",clientTime}`                             | Measures the clock offset; also works before joining  |
| ←         | `{type:"pong",clientTime,serverTime}`                  |                                                       |
| ←         | `{type:"peers",count}`                                 | Someone joined or left                                |
| ←         | `{type:"error",code}`                                  | `invalid_message`, `not_joined` or `rate_limited`     |
| →         | `keepalive`                                            | Plain text; answered with `keepalive`                 |

The room keeps one shared timeline, the latest `state`. While it's playing, the target position is `position + rate * (serverNow - sentAt) / 1000`.

If `sentAt` is more than 30 seconds from server time, the server replaces it with the server time. Each connection can send 50 messages per 10 seconds, and a room holds 50 connections.

## Close codes

| Code | Meaning                                        |
| ---- | ---------------------------------------------- |
| 4400 | The extension and server protocols don't match |
| 4404 | The room doesn't exist                         |
| 4409 | The room is full                               |

## Tests

```sh
npm test -w server
```
