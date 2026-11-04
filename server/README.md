# Sinkro server

A Cloudflare Worker with one Durable Object per room. It relays playback state between the people in a room and never sees video, page URLs or titles. It works on Cloudflare's free plan.

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

The creation limit is counted by Cloudflare's rate limiter, which works per location and is approximate. Sinkro stores no addresses. A room is deleted 24 hours after its last person leaves, or 24 hours after it's created if nobody joins.

## WebSocket messages

All messages are JSON text of at most 512 characters. The types are in [`src/protocol.ts`](src/protocol.ts).

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
