import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackState, RoomState } from "../../server/src/protocol";
import type { HoldReason } from "../src/content/detection/ads";
import { SyncEngine, type EngineDeps, type PlaybackChange } from "../src/content/sync/engine";
import { FakeVideo } from "./fake-video";

const ME = "me";
const PEER = "peer";
const CLOCK_OFFSET_MS = 5000;

function setup(extra: Partial<EngineDeps> = {}) {
  const changes: PlaybackChange[] = [];
  const ownChanges: PlaybackChange[] = [];
  const rates: number[] = [];
  const jumps: boolean[] = [];
  const holdChanges: (HoldReason | "other_video" | null)[] = [];
  const sent: PlaybackState[] = [];
  const video = new FakeVideo();
  const hold: { reason: HoldReason | null; roomPosition: number | null } = {
    reason: null,
    roomPosition: null,
  };
  const serverNow = () => Date.now() + CLOCK_OFFSET_MS;
  let online = true;
  const engine = new SyncEngine({
    now: Date.now,
    serverNow,
    onRemoteChange: (change, { rate, jumped }) => {
      changes.push(change);
      rates.push(rate);
      jumps.push(jumped);
    },
    onOwnChange: (change, { rate, jumped }) => {
      ownChanges.push(change);
      rates.push(rate);
      jumps.push(jumped);
    },
    onHoldChange: (reason) => holdChanges.push(reason),
    holdFor: (roomPosition) => {
      hold.roomPosition = roomPosition;
      return hold.reason;
    },
    send: (state) => {
      if (online) sent.push(state);
      return online;
    },
    ...extra,
  });
  let seq = 0;
  const peerState = (state: Partial<RoomState>): RoomState => {
    seq += 1;
    return {
      playing: true,
      position: 0,
      rate: 1,
      sentAt: serverNow(),
      seq,
      from: PEER,
      ...state,
    };
  };
  const setOnline = (value: boolean) => {
    online = value;
  };
  return {
    engine,
    video,
    sent,
    peerState,
    serverNow,
    setOnline,
    hold,
    changes,
    ownChanges,
    rates,
    jumps,
    holdChanges,
  };
}

/** Joins a room others are in, and settles on a playing timeline at `position`. */
async function joinPlaying(context: ReturnType<typeof setup>, position = 100) {
  const { engine, video, peerState } = context;
  engine.bind(video.asVideo());
  video.position = position;
  engine.handleJoined({ clientId: ME, state: peerState({ position }), peers: 2 });
  await settle();
  context.sent.length = 0;
}

/** Lets queued media events run without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Moves time on with the video playing at its current rate, as a real one would. */
async function play(video: FakeVideo, ms: number, step = 250) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    if (!video.paused) video.position += (step / 1000) * video.playbackRate;
    await vi.advanceTimersByTimeAsync(step);
    video.dispatchEvent(new Event("timeupdate"));
  }
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("joining", () => {
  it("starts the timeline when nobody has one", async () => {
    const { engine, video, sent, serverNow } = setup();
    video.position = 42;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: null, peers: 1 });
    await settle();

    expect(sent).toEqual([{ playing: false, position: 42, rate: 1, sentAt: serverNow() }]);
  });

  it("starts the timeline once a video appears", async () => {
    const { engine, video, sent } = setup();
    engine.handleJoined({ clientId: ME, state: null, peers: 1 });
    expect(sent).toEqual([]);

    engine.bind(video.asVideo());
    await settle();
    expect(sent).toHaveLength(1);
  });

  it("follows a playing room, counting the time since its last state", async () => {
    const { engine, video, sent, peerState, serverNow } = setup();
    engine.bind(video.asVideo());
    const state = peerState({ position: 100, sentAt: serverNow() - 10_000 });
    engine.handleJoined({ clientId: ME, state, peers: 3 });
    await settle();

    expect(video.position).toBe(110);
    expect(video.paused).toBe(false);
    expect(sent).toEqual([]);
  });

  it("doesn't jump ahead on a timeline left behind in an empty room", async () => {
    const { engine, video, sent, peerState, serverNow } = setup();
    video.position = 5;
    engine.bind(video.asVideo());
    const state = peerState({ position: 100, sentAt: serverNow() - 3_600_000 });
    engine.handleJoined({ clientId: ME, state, peers: 1 });
    await settle();

    expect(video.position).toBe(5);
    expect(video.seekCalls).toBe(0);
    expect(sent.map((s) => s.position)).toEqual([5]);
  });

  it("applies the room's state to a video that appears later", async () => {
    const { engine, video, peerState } = setup();
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    engine.bind(video.asVideo());
    await settle();

    expect(video.position).toBe(100);
    expect(video.paused).toBe(false);
  });
});

describe("remote commands don't echo", () => {
  it.each([
    ["play", { playing: true, position: 50 }],
    ["pause", { playing: false, position: 50 }],
    ["seek", { playing: false, position: 900 }],
    ["rate", { playing: false, position: 50, rate: 1.5 }],
    ["seek while playing", { playing: true, position: 900 }],
  ])("%s", async (_, change) => {
    const context = setup();
    await joinPlaying(context, 50);
    const { engine, video, sent, peerState } = context;

    engine.handleState(peerState(change));
    await play(video, 3000);

    expect(sent).toEqual([]);
  });

  // Players can land a little off, on a keyframe say. The event is still ours.
  it("doesn't echo a remote pause when the player ends up slightly elsewhere", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState } = context;
    // Just after a tick, so the timeupdate ahead of pause can't put the position right first.
    await vi.advanceTimersByTimeAsync(1100);

    engine.handleState(peerState({ playing: false, position: 100 }));
    video.position = 101;
    await settle();

    expect(sent).toEqual([]);
  });

  it("doesn't echo a remote play when the player ends up slightly elsewhere", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState } = context;
    engine.handleState(peerState({ playing: false, position: 100 }));
    await settle();

    engine.handleState(peerState({ playing: true, position: 100 }));
    video.position = 101;
    await settle();

    expect(sent).toEqual([]);
  });

  it("doesn't echo when a newer state replaces a seek still in flight", async () => {
    const context = setup();
    await joinPlaying(context, 50);
    const { engine, video, sent, peerState } = context;

    engine.handleState(peerState({ position: 500 }));
    engine.handleState(peerState({ position: 900 }));
    await play(video, 3000);

    expect(sent).toEqual([]);
    expect(video.position).toBeGreaterThan(900);
  });
});

describe("what the viewer does reaches the room", () => {
  it("pause", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.pause();
    await settle();

    expect(context.sent).toMatchObject([{ playing: false, position: 100 }]);
  });

  it("play", async () => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handleState(context.peerState({ playing: false, position: 100 }));
    await vi.advanceTimersByTimeAsync(3000);

    context.video.userPlay();
    await settle();

    expect(context.sent).toMatchObject([{ playing: true, position: 100 }]);
  });

  it("seek", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.userSeek(700);
    await settle();

    expect(context.sent).toMatchObject([{ playing: true, position: 700 }]);
  });

  it("speed", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.userSetRate(1.5);
    await settle();

    expect(context.sent).toMatchObject([{ playing: true, rate: 1.5 }]);
  });

  it("stamps states with server time, not the local clock", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.pause();
    await settle();

    expect(context.sent[0]?.sentAt).toBe(Date.now() + CLOCK_OFFSET_MS);
  });

  it("keeps a speed outside the protocol's range from getting the message refused", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.userSetRate(32);
    await settle();

    expect(context.sent[0]?.rate).toBe(16);
  });

  it("sends where a drag ended up, without flooding the room", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;

    for (const position of [200, 300, 400, 500, 600]) {
      video.userSeek(position);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(300);

    expect(sent.length).toBeLessThanOrEqual(3);
    expect(sent.at(-1)?.position).toBe(600);
  });

  it("ignores small jumps a player makes on its own", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.userSeek(100.2);
    await settle();

    expect(context.sent).toEqual([]);
  });

  it("reports a seek the viewer makes while a remote one is in flight", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState } = context;

    video.seekDelayMs = 100;
    engine.handleState(peerState({ position: 500 }));
    await vi.advanceTimersByTimeAsync(50);
    video.userSeek(800);
    await vi.advanceTimersByTimeAsync(100);

    expect(sent).toMatchObject([{ position: 800 }]);
  });
});

describe("a video still loading", () => {
  /** A player swapping the source: position 0, length unknown, nothing buffered. */
  function startLoading(video: FakeVideo) {
    video.position = 0;
    video.duration = Number.NaN;
    video.readyState = 0;
  }

  it("doesn't send a playing room back to zero when a player calls play on a new source", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    startLoading(video);
    video.paused = true;
    video.userPlay();
    await settle();

    expect(sent).toEqual([]);
  });

  it("doesn't send the room back to zero when a new source seeks or changes speed", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    startLoading(video);
    video.userSeek(0);
    await settle();
    video.userSetRate(1.5);
    await settle();

    expect(sent).toEqual([]);
  });

  it("doesn't pause the room when a player pauses while swapping sources", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    startLoading(video);
    video.pause();
    await settle();

    expect(sent).toEqual([]);
  });

  it("still lets the viewer start a paused room, from the room's own spot", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState } = context;
    engine.handleState(peerState({ playing: false, position: 700 }));
    await vi.advanceTimersByTimeAsync(1300);
    startLoading(video);
    video.userPlay();
    await settle();

    expect(sent).toMatchObject([{ playing: true, position: 700 }]);
  });

  it("doesn't start the room's timeline from a video with no length yet", async () => {
    const context = setup();
    const { engine, video, sent } = context;
    startLoading(video);
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: null, peers: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual([]);

    video.position = 42;
    video.duration = 3600;
    video.readyState = 4;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.map((s) => s.position)).toEqual([42]);
  });

  it("reports normally again once it has loaded", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    startLoading(video);
    await settle();
    video.duration = 3600;
    video.readyState = 4;
    video.position = 100;
    await vi.advanceTimersByTimeAsync(1300);

    video.pause();
    await settle();

    expect(sent).toMatchObject([{ playing: false }]);
  });
});

describe("seeks that don't go to plan", () => {
  it("doesn't drag the room along when this video can't seek", async () => {
    const context = setup();
    const { engine, video, peerState, sent } = context;
    video.seekable = false;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(sent).toEqual([]);
    expect(video.position).toBe(0);
  });

  it("doesn't take a very slow seek for the viewer's", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState, sent } = context;
    video.seekDelayMs = 20_000;
    engine.handleState(peerState({ position: 900 }));
    await vi.advanceTimersByTimeAsync(21_000);

    expect(sent).toEqual([]);
  });

  it("drops a seek the player's reload cancelled, so the next one is the viewer's", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState, sent } = context;
    video.seekDelayMs = 60_000;
    engine.handleState(peerState({ position: 900 }));
    await vi.advanceTimersByTimeAsync(100);
    video.reload();
    await settle();

    video.seekDelayMs = 0;
    video.userSeek(1500);
    await settle();

    expect(sent).toMatchObject([{ position: 1500 }]);
  });

  it("gets back on the timeline after the player reloads the element", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    await vi.advanceTimersByTimeAsync(1300);

    video.reload();
    await vi.advanceTimersByTimeAsync(1000);

    expect(video.paused).toBe(false);
    expect(sent).toEqual([]);
  });

  it("doesn't take a replaced seek for the viewer's, on a video that can't seek", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState, sent } = context;
    video.seekable = false;
    video.seekDelayMs = 100;
    engine.handleState(peerState({ position: 500 }));
    await vi.advanceTimersByTimeAsync(10);
    engine.handleState(peerState({ position: 900 }));
    await vi.advanceTimersByTimeAsync(500);

    expect(sent).toEqual([]);
  });
});

describe("a change whose event hasn't fired yet", () => {
  it("doesn't undo the viewer's pause", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    await vi.advanceTimersByTimeAsync(1300);

    video.pause();
    await settle();

    expect(video.paused).toBe(true);
    expect(video.playCalls).toBe(1);
    expect(sent).toMatchObject([{ playing: false }]);
  });

  it("doesn't undo the viewer's play", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState } = context;
    engine.handleState(peerState({ playing: false, position: 100 }));
    await vi.advanceTimersByTimeAsync(1300);

    video.paused = false;
    video.dispatchEvent(new Event("timeupdate"));
    await settle();
    expect(video.paused).toBe(false);

    video.dispatchEvent(new Event("play"));
    await settle();
    expect(sent).toMatchObject([{ playing: true }]);
  });

  it("doesn't undo the viewer's speed", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    await vi.advanceTimersByTimeAsync(1300);

    video.userSetRate(1.5);
    video.dispatchEvent(new Event("timeupdate"));
    await settle();

    expect(video.playbackRate).toBe(1.5);
    expect(sent).toMatchObject([{ rate: 1.5 }]);
  });

  it("stops waiting if the event never comes", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;

    // Reloading a media element pauses it without firing pause.
    video.paused = true;
    await vi.advanceTimersByTimeAsync(3000);

    expect(video.paused).toBe(false);
    expect(sent).toEqual([]);
  });

  it("doesn't mistake a blocked play for a pending change", async () => {
    const context = setup();
    const { engine, video, peerState } = context;
    video.autoplayAllowed = false;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    await settle();

    video.autoplayAllowed = true;
    await vi.advanceTimersByTimeAsync(6000);

    expect(video.paused).toBe(false);
  });
});

describe("drift", () => {
  it("leaves small drift alone", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video } = context;
    video.position += 0.1;
    await play(video, 2000);

    expect(video.playbackRate).toBe(1);
    expect(video.seekCalls).toBe(0);
  });

  it("slows down gently when ahead, and returns to normal speed once caught up", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent } = context;
    video.position += 1;
    await play(video, 500);

    expect(video.playbackRate).toBeCloseTo(0.95, 5);
    expect(engine.snapshot().correcting).toBe(true);

    await play(video, 40_000);
    expect(video.playbackRate).toBe(1);
    expect(Math.abs(engine.snapshot().drift ?? 9)).toBeLessThan(0.15);
    expect(engine.snapshot().correcting).toBe(false);
    expect(video.seekCalls).toBe(0);
    expect(sent).toEqual([]);
  });

  it("speeds up gently when behind", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video } = context;
    video.position -= 1;
    await play(video, 500);

    expect(video.playbackRate).toBeCloseTo(1.05, 5);
    expect(video.seekCalls).toBe(0);
  });

  it("scales the correction around the speed people chose", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState, sent } = context;
    engine.handleState(peerState({ position: 100, rate: 2 }));
    await settle();
    video.position -= 1;
    await play(video, 500);

    expect(video.playbackRate).toBeCloseTo(2.1, 5);
    expect(sent).toEqual([]);
  });

  it("seeks past 2 seconds", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    video.position += 5;
    await play(video, 1000);

    expect(video.seekCalls).toBe(1);
    expect(Math.abs(video.position - 101)).toBeLessThan(0.5);
    expect(sent).toEqual([]);
  });

  it("seeks rather than changing speed while paused", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState } = context;
    engine.handleState(peerState({ playing: false, position: 100 }));
    await settle();
    video.position = 100.5;
    await vi.advanceTimersByTimeAsync(1000);

    expect(video.position).toBe(100);
    expect(video.playbackRate).toBe(1);
  });

  it("doesn't publish its own speed changes as the viewer's", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    video.position += 1;
    await play(video, 2000);

    expect(video.playbackRate).not.toBe(1);
    expect(sent).toEqual([]);
  });

  it("publishes the chosen speed, not a corrected one", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    video.position += 1;
    await play(video, 500);
    expect(video.playbackRate).toBeCloseTo(0.95, 5);

    video.pause();
    await settle();

    expect(sent).toMatchObject([{ playing: false, rate: 1 }]);
    expect(video.playbackRate).toBe(1);
  });

  it("waits out buffering instead of seeking into it", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video } = context;
    video.readyState = 2;
    await vi.advanceTimersByTimeAsync(5000);
    expect(video.seekCalls).toBe(0);

    video.readyState = 4;
    await vi.advanceTimersByTimeAsync(1000);
    expect(video.seekCalls).toBe(1);
  });

  it("still applies a new state while buffering", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState } = context;
    video.readyState = 2;
    engine.handleState(peerState({ position: 900 }));
    await settle();

    expect(video.position).toBe(900);
  });

  it("doesn't get stuck seeking on a connection too slow to keep up", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video } = context;
    // The video never advances, so the timeline runs away from it.
    for (let second = 0; second < 30; second += 1) {
      video.position = Math.min(video.position, 100);
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(video.seekCalls).toBeLessThanOrEqual(7);
  });
});

describe("message order", () => {
  it("ignores its own echo", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState } = context;
    video.pause();
    await settle();
    const seeks = video.seekCalls;

    engine.handleState(peerState({ ...sent[0], from: ME }));
    await settle();

    expect(video.seekCalls).toBe(seeks);
    expect(video.paused).toBe(true);
  });

  it("drops a state already overtaken by what this viewer just sent", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState } = context;
    video.pause();
    await settle();

    engine.handleState(peerState({ playing: true, position: 900 }));
    await settle();

    expect(video.position).toBe(100);
    expect(video.paused).toBe(true);

    engine.handleState(peerState({ ...sent[0], from: ME }));
    engine.handleState(peerState({ playing: true, position: 900 }));
    await settle();

    expect(video.position).toBe(900);
  });

  it("drops a state while its own is waiting to be sent", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState } = context;
    video.userSeek(200);
    await settle();
    video.userSeek(300);
    await settle();
    engine.handleState(peerState({ ...sent[0], from: ME }));

    engine.handleState(peerState({ position: 900 }));
    await vi.advanceTimersByTimeAsync(300);

    expect(video.position).toBe(300);
    expect(sent.at(-1)?.position).toBe(300);
  });

  it("drops states older than one already seen", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState } = context;
    engine.handleState(peerState({ position: 500, seq: 50 }));
    await settle();

    engine.handleState(peerState({ position: 900, seq: 49 }));
    await settle();

    expect(video.position).toBe(500);
  });

  it("stops waiting for an echo when the room refuses a message", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState } = context;
    video.pause();
    await settle();
    engine.handleRejected();

    engine.handleState(peerState({ playing: true, position: 900 }));
    await settle();

    expect(video.position).toBe(900);
  });

  it("uses the room's copy of its own state", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState, serverNow } = context;
    video.pause();
    await settle();
    video.userPlay();
    await vi.advanceTimersByTimeAsync(300);
    engine.handleState(peerState({ ...sent[0], from: ME }));
    // The room overrode a badly wrong clock: the timeline is 20 s further on than sent.
    engine.handleState(peerState({ ...sent[1], from: ME, sentAt: serverNow() - 20_000 }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(video.position).toBeGreaterThan(115);
  });
});

describe("autoplay", () => {
  it("reports when the browser refuses to play", async () => {
    const context = setup();
    const { engine, video, peerState, sent } = context;
    video.autoplayAllowed = false;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    await settle();

    expect(engine.snapshot().needsGesture).toBe(true);
    expect(video.paused).toBe(true);
    expect(sent).toEqual([]);
  });

  it("retries without hammering the browser", async () => {
    const context = setup();
    const { engine, video, peerState } = context;
    video.autoplayAllowed = false;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(video.playCalls).toBeLessThanOrEqual(5);
  });

  it("starts by itself once the browser allows it", async () => {
    const context = setup();
    const { engine, video, peerState } = context;
    video.autoplayAllowed = false;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    await settle();

    video.autoplayAllowed = true;
    await vi.advanceTimersByTimeAsync(6000);

    expect(video.paused).toBe(false);
    expect(engine.snapshot().needsGesture).toBe(false);
  });

  it("treats the viewer's click as joining in, not as a seek for everyone", async () => {
    const context = setup();
    const { engine, video, peerState, sent } = context;
    video.autoplayAllowed = false;
    video.position = 100;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    await settle();
    await vi.advanceTimersByTimeAsync(3000);

    video.userPlay();
    await settle();

    expect(sent).toEqual([]);
    expect(engine.snapshot().needsGesture).toBe(false);
    expect(video.position).toBeCloseTo(103, 0);
  });
});

describe("the autoplay notice", () => {
  it("goes away once the video is playing, even if play hasn't finished", async () => {
    const context = setup();
    const { engine, video, peerState } = context;
    video.autoplayAllowed = false;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    await settle();
    expect(engine.snapshot().needsGesture).toBe(true);

    video.paused = false;
    expect(engine.snapshot().needsGesture).toBe(false);
  });
});

describe("the join button when the browser still refuses", () => {
  it("brings the notice back", async () => {
    const context = setup();
    const { engine, video, peerState } = context;
    video.autoplayAllowed = false;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    await settle();

    engine.retryPlay();
    expect(engine.snapshot().needsGesture).toBe(false);
    await settle();

    expect(engine.snapshot().needsGesture).toBe(true);
  });
});

describe("the join button on the page", () => {
  it("plays straight away once the browser allows it, without telling the room", async () => {
    const context = setup();
    const { engine, video, peerState, sent } = context;
    video.autoplayAllowed = false;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: peerState({ position: 100 }), peers: 2 });
    await settle();
    expect(engine.snapshot().needsGesture).toBe(true);

    video.autoplayAllowed = true;
    engine.retryPlay();
    await settle();

    expect(video.paused).toBe(false);
    expect(engine.snapshot().needsGesture).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("end of the video", () => {
  it("tells the room, without restarting", async () => {
    const context = setup();
    await joinPlaying(context, 3599);
    const { video, sent } = context;
    video.reachEnd();
    await vi.advanceTimersByTimeAsync(3000);

    expect(sent).toMatchObject([{ playing: false, position: 3600 }]);
    expect(video.position).toBe(3600);
    expect(video.paused).toBe(true);
  });

  it("doesn't restart when the timeline also ran out", async () => {
    const context = setup();
    await joinPlaying(context, 3599);
    const { engine, video, peerState, serverNow } = context;
    video.position = 3600;
    video.ended = true;
    video.paused = true;
    const playCalls = video.playCalls;
    engine.handleState(peerState({ position: 3599, sentAt: serverNow() - 5000 }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(video.playCalls).toBe(playCalls);
    expect(video.position).toBe(3600);
  });

  it("plays again from the right place when someone seeks back", async () => {
    const context = setup();
    await joinPlaying(context, 3599);
    const { engine, video, peerState } = context;
    video.position = 3600;
    video.ended = true;
    video.paused = true;

    engine.handleState(peerState({ position: 60 }));
    await settle();

    expect(video.position).toBe(60);
    expect(video.paused).toBe(false);
  });
});

describe("connection loss", () => {
  it("leaves the viewer in charge while offline", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent } = context;
    engine.handleDisconnected();
    video.pause();
    await vi.advanceTimersByTimeAsync(5000);

    expect(video.paused).toBe(true);
    expect(video.playCalls).toBe(1);
    expect(sent).toEqual([]);
  });

  it("restores normal speed if it drops during a correction", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video } = context;
    video.position += 1;
    await play(video, 500);
    expect(video.playbackRate).not.toBe(1);

    engine.handleDisconnected();
    expect(video.playbackRate).toBe(1);
  });

  it("catches up to the room on reconnecting", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState, sent } = context;
    engine.handleDisconnected();
    video.pause();
    await vi.advanceTimersByTimeAsync(5000);

    engine.handleJoined({ clientId: "me-again", state: peerState({ position: 300 }), peers: 2 });
    await settle();

    expect(video.position).toBe(300);
    expect(video.paused).toBe(false);
    expect(sent).toEqual([]);
  });

  it("isn't counted as sent when the connection refuses a state", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState, setOnline } = context;
    setOnline(false);
    video.pause();
    await settle();
    setOnline(true);

    engine.handleState(peerState({ playing: true, position: 900 }));
    await settle();

    expect(video.position).toBe(900);
  });
});

describe("telling the viewer what someone else did", () => {
  it.each<[string, Partial<RoomState>, PlaybackChange]>([
    ["a pause", { playing: false, position: 100 }, "paused"],
    ["a seek forward", { position: 500 }, "seeked"],
    ["a seek back", { position: 10 }, "seeked"],
  ])("reports %s", async (_, state, expected) => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handleState(context.peerState(state));

    expect(context.changes).toEqual([expected]);
  });

  it("reports a new speed, and says what it is", async () => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handleState(context.peerState({ position: 100, rate: 1.5 }));

    expect(context.changes).toEqual(["rate"]);
    expect(context.rates).toEqual([1.5]);
  });

  it("calls a new speed that, not a seek, even after time has passed", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(10_000);
    context.engine.handleState(context.peerState({ position: 110, rate: 2 }));

    expect(context.changes).toEqual(["rate"]);
  });

  it("says whether a start also moved the position, as a seek bar's does", async () => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handleState(context.peerState({ playing: false, position: 100 }));
    context.engine.handleState(context.peerState({ playing: true, position: 500 }));

    expect(context.changes).toEqual(["paused", "played"]);
    expect(context.jumps).toEqual([false, true]);
  });

  it("says a start in place didn't move anything", async () => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handleState(context.peerState({ playing: false, position: 100 }));
    context.engine.handleState(context.peerState({ playing: true, position: 100 }));

    expect(context.jumps).toEqual([false, false]);
  });

  it("reports playback starting", async () => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handleState(context.peerState({ playing: false, position: 100 }));
    context.changes.length = 0;
    context.engine.handleState(context.peerState({ playing: true, position: 100 }));

    expect(context.changes).toEqual(["played"]);
  });

  it("says nothing about a state that changes nothing", async () => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handleState(context.peerState({ position: 100 }));

    expect(context.changes).toEqual([]);
  });

  it("accounts for the time passed since the last state", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(10_000);
    context.engine.handleState(context.peerState({ position: 110 }));

    expect(context.changes).toEqual([]);
  });

  it("says nothing about joining a room already playing", async () => {
    const context = setup();
    await joinPlaying(context);
    expect(context.changes).toEqual([]);
  });

  it("says nothing about the viewer's own actions", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent, peerState, changes } = context;
    video.pause();
    await settle();
    engine.handleState(peerState({ ...sent[0], from: ME }));

    expect(changes).toEqual([]);
  });
});

describe("telling the viewer what they did themselves", () => {
  it("reports their pause", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.pause();
    await settle();

    expect(context.ownChanges).toEqual(["paused"]);
    expect(context.changes).toEqual([]);
  });

  it("reports them starting playback", async () => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handleState(context.peerState({ playing: false, position: 100 }));
    await settle();
    context.video.userPlay();
    await settle();

    expect(context.ownChanges).toEqual(["played"]);
  });

  it("reports their seek", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.userSeek(500);
    await settle();

    expect(context.ownChanges).toEqual(["seeked"]);
  });

  it("says whether their start moved the position too", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.pause();
    await settle();
    context.video.userSeek(500);
    context.video.userPlay();
    await vi.advanceTimersByTimeAsync(300);

    expect(context.ownChanges.at(-1)).toBe("played");
    expect(context.jumps.at(-1)).toBe(true);
  });

  it("reports their new speed, and says what it is", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.userSetRate(1.5);
    await settle();

    expect(context.ownChanges).toEqual(["rate"]);
    expect(context.rates).toEqual([1.5]);
  });

  it("says nothing about the speed a drift correction plays at", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.position += 1;
    await vi.advanceTimersByTimeAsync(3000);

    expect(context.ownChanges).toEqual([]);
    expect(context.changes).toEqual([]);
  });

  it("reports a seek that had to wait its turn to be sent", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.userSeek(500);
    await settle();
    context.video.userSeek(900);
    await vi.advanceTimersByTimeAsync(300);

    expect(context.ownChanges).toEqual(["seeked", "seeked"]);
  });

  it("says nothing when their action is just the room's own state", async () => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handleState(context.peerState({ playing: false, position: 100 }));
    await settle();

    expect(context.ownChanges).toEqual([]);
    expect(context.changes).toEqual(["paused"]);
  });

  it("says nothing about bringing everyone, which isn't a pause or a seek", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.position = 500;
    context.engine.bringEveryone();

    expect(context.ownChanges).toEqual([]);
  });

  it("says nothing when nobody else is there to be affected", async () => {
    const context = setup();
    const { engine, video } = context;
    video.position = 100;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: null, peers: 1 });
    await settle();
    video.userPlay();
    await vi.advanceTimersByTimeAsync(300);
    video.pause();
    await vi.advanceTimersByTimeAsync(300);

    expect(context.ownChanges).toEqual([]);
  });

  it("says nothing if the state couldn't be sent", async () => {
    const context = setup();
    await joinPlaying(context);
    context.setOnline(false);
    context.video.pause();
    await settle();

    expect(context.ownChanges).toEqual([]);
  });
});

describe("telling the viewer's actions from the player's own", () => {
  /** The viewer last touched the page long ago, so whatever happens now is the player. */
  const untouched = () => setup({ lastInputAt: () => Number.NEGATIVE_INFINITY });

  it("waits a moment before passing on a pause nobody pressed", async () => {
    const context = untouched();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    context.video.pause();
    await settle();
    expect(context.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);

    expect(context.sent.at(-1)?.playing).toBe(false);
  });

  it("doesn't undo the pause while it waits, which would leave nothing to pass on", async () => {
    const context = untouched();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    context.video.pause();
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    context.video.dispatchEvent(new Event("timeupdate"));
    await vi.advanceTimersByTimeAsync(400);

    expect(context.video.paused).toBe(true);
    expect(context.sent.at(-1)?.playing).toBe(false);
  });

  it("doesn't pass it on when an ad starts over the film meanwhile", async () => {
    const context = untouched();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    context.video.pause();
    await settle();
    context.hold.reason = "ad";
    await vi.advanceTimersByTimeAsync(2000);

    expect(context.sent).toEqual([]);
  });

  it("passes a pressed pause on at once", async () => {
    let inputAt = Number.NEGATIVE_INFINITY;
    const context = setup({ lastInputAt: () => inputAt });
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    inputAt = Date.now();
    context.video.pause();
    await settle();

    expect(context.sent.at(-1)?.playing).toBe(false);
  });

  it("doesn't let a player putting the film back after an ad pull the room back", async () => {
    const context = untouched();
    await joinPlaying(context, 900);
    context.hold.reason = "cant_follow";
    await vi.advanceTimersByTimeAsync(8000);
    context.hold.reason = null;
    await vi.advanceTimersByTimeAsync(1100);
    context.sent.length = 0;
    context.video.userSeek(900);
    await vi.advanceTimersByTimeAsync(1500);

    expect(context.sent).toEqual([]);
    expect(context.video.position).toBeGreaterThan(905);
  });

  it("still passes on the viewer's own seek right after a hold", async () => {
    let inputAt = Number.NEGATIVE_INFINITY;
    const context = setup({ lastInputAt: () => inputAt });
    await joinPlaying(context, 900);
    context.hold.reason = "ad";
    await vi.advanceTimersByTimeAsync(3000);
    context.hold.reason = null;
    await vi.advanceTimersByTimeAsync(1100);
    context.sent.length = 0;
    inputAt = Date.now();
    context.video.userSeek(2000);
    await vi.advanceTimersByTimeAsync(400);

    expect(context.sent.at(-1)?.position).toBeGreaterThan(1990);
  });
});

describe("a state of ours the room never echoes", () => {
  it("doesn't leave this viewer deaf to the room", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    context.video.pause();
    await settle();
    expect(context.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3500);
    context.engine.handleState(context.peerState({ playing: true, position: 900 }));
    await settle();

    expect(context.video.paused).toBe(false);
    expect(context.video.position).toBeGreaterThan(890);
  });

  it("still ignores what was sent before its own state, while the echo can still come", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    context.video.pause();
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    context.engine.handleState(context.peerState({ playing: true, position: 900 }));
    await settle();

    expect(context.video.paused).toBe(true);
  });
});

describe("sending what the film is", () => {
  it("adds the film's details to what it sends", async () => {
    const sent: PlaybackState[] = [];
    const video = new FakeVideo();
    const engine = new SyncEngine({
      now: Date.now,
      serverNow: Date.now,
      send: (state) => {
        sent.push(state);
        return true;
      },
      filmDetails: () => ({ duration: 1471, source: "sealed" }),
    });
    video.position = 10;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: null, peers: 1 });
    await settle();

    expect(sent[0]).toMatchObject({ duration: 1471, source: "sealed" });
    engine.stop();
  });
});

describe("saying when a hold starts and ends", () => {
  it("reports each change once", async () => {
    const context = setup();
    await joinPlaying(context);
    context.hold.reason = "ad";
    await vi.advanceTimersByTimeAsync(3000);
    context.hold.reason = null;
    await vi.advanceTimersByTimeAsync(3000);

    expect(context.holdChanges).toEqual(["ad", null]);
  });

  it("says nothing with no hold", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(3000);

    expect(context.holdChanges).toEqual([]);
  });
});

describe("bringing everyone to a different film", () => {
  /** Well along the old film, then on a new one from its start, as a real move goes. */
  async function onNewFilm(context: ReturnType<typeof setup>) {
    await joinPlaying(context, 1800);
    context.video.position = 5;
    context.hold.reason = "ad";
    await vi.advanceTimersByTimeAsync(1100);
    context.sent.length = 0;
  }

  it("doesn't send the new film to where the old one had got to, after an ad", async () => {
    const context = setup();
    await onNewFilm(context);
    context.engine.bringEveryone(true);
    context.hold.reason = null;
    await vi.advanceTimersByTimeAsync(3000);

    expect(context.video.position).toBeLessThan(100);
  });

  it("gives the room the new film's position once the ad ends", async () => {
    const context = setup();
    await onNewFilm(context);
    context.engine.bringEveryone(true);
    expect(context.sent).toEqual([]);
    context.hold.reason = null;
    await vi.advanceTimersByTimeAsync(1100);

    expect(context.sent).toHaveLength(1);
    expect(context.sent[0]?.position).toBeLessThan(100);
    expect(context.sent[0]?.playing).toBe(true);
  });

  it("gives it straight away with no ad", async () => {
    const context = setup();
    await joinPlaying(context, 1800);
    context.video.position = 5;
    context.engine.bringEveryone(true);

    expect(context.sent).toHaveLength(1);
    expect(context.sent[0]?.position).toBe(5);
  });

  it("keeps the timeline for bringing everyone within the same film", async () => {
    const context = setup();
    await joinPlaying(context, 1800);
    context.hold.reason = "ad";
    await vi.advanceTimersByTimeAsync(1100);
    context.engine.bringEveryone();
    context.video.position = 5;
    context.hold.reason = null;
    await vi.advanceTimersByTimeAsync(1100);

    expect(context.video.position).toBeGreaterThan(1700);
  });

  it("follows someone else's position in the new film, for whoever hears of the move", async () => {
    const context = setup();
    await joinPlaying(context, 1800);
    context.engine.forgetTimeline();
    context.video.position = 3;
    context.engine.handleState(context.peerState({ position: 40 }));
    await settle();

    expect(context.video.position).toBeCloseTo(40, 0);
    expect(context.changes).toEqual([]);
  });

  it("drops what it was about to say about the old film", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    context.video.pause();
    await settle();
    context.video.userPlay();
    await settle();
    context.engine.forgetTimeline();
    const sentBefore = context.sent.length;
    await vi.advanceTimersByTimeAsync(300);

    expect(context.sent.filter((s, i) => i >= sentBefore && s.position > 50 && !s.playing)).toEqual(
      [],
    );
  });
});

describe("joining others who have nothing going yet", () => {
  async function joinEmptyRoom(context: ReturnType<typeof setup>) {
    context.engine.bind(context.video.asVideo());
    context.engine.handleJoined({ clientId: ME, state: null, peers: 2 });
    await settle();
  }

  it("starts the video, rather than telling the room it's paused", async () => {
    const context = setup();
    await joinEmptyRoom(context);

    expect(context.video.paused).toBe(false);
    expect(context.sent.filter((state) => !state.playing)).toEqual([]);
  });

  it("then starts the room's timeline, with the video playing", async () => {
    const context = setup();
    await joinEmptyRoom(context);
    await vi.advanceTimersByTimeAsync(1100);

    expect(context.sent).toHaveLength(1);
    expect(context.sent[0]?.playing).toBe(true);
  });

  it("asks for a click when the browser blocks it, and doesn't pause the room", async () => {
    const context = setup();
    context.video.autoplayAllowed = false;
    await joinEmptyRoom(context);

    expect(context.engine.snapshot().needsGesture).toBe(true);
    expect(context.sent).toEqual([]);
  });

  it("starts when the viewer clicks", async () => {
    const context = setup();
    context.video.autoplayAllowed = false;
    await joinEmptyRoom(context);
    context.video.autoplayAllowed = true;
    context.engine.retryPlay();
    await settle();

    expect(context.video.paused).toBe(false);
    expect(context.engine.snapshot().needsGesture).toBe(false);
  });

  it("doesn't retry on every tick while the browser is refusing", async () => {
    const context = setup();
    context.video.autoplayAllowed = false;
    await joinEmptyRoom(context);
    const play = vi.spyOn(context.video, "play");
    await vi.advanceTimersByTimeAsync(3000);

    expect(play).not.toHaveBeenCalled();
  });

  it("leaves alone a viewer with nobody else there", async () => {
    const context = setup();
    context.engine.bind(context.video.asVideo());
    context.engine.handleJoined({ clientId: ME, state: null, peers: 1 });
    await settle();

    expect(context.video.paused).toBe(true);
    expect(context.sent[0]?.playing).toBe(false);
  });

  it("respects a viewer who pauses it themselves afterwards", async () => {
    const context = setup();
    await joinEmptyRoom(context);
    await vi.advanceTimersByTimeAsync(1100);
    context.video.pause();
    await vi.advanceTimersByTimeAsync(3000);

    expect(context.video.paused).toBe(true);
    expect(context.sent.at(-1)?.playing).toBe(false);
  });

  it("waits while this viewer is on an ad of their own", async () => {
    const context = setup();
    context.hold.reason = "ad";
    await joinEmptyRoom(context);

    expect(context.video.paused).toBe(true);
    expect(context.sent).toEqual([]);
  });
});

describe("a click on a seek bar, which pauses, moves and plays in a moment", () => {
  /** The room hears the pause at once, and the rest a moment later. */
  async function clickSeekBar(context: ReturnType<typeof setup>, to = 500) {
    const { video } = context;
    // As measured on YouTube: separate moments, a few milliseconds apart.
    video.pause();
    await vi.advanceTimersByTimeAsync(8);
    video.userSeek(to);
    await vi.advanceTimersByTimeAsync(6);
    video.userPlay();
    await settle();
  }

  /** Playing video keeps firing timeupdate, which is what runs the engine in between. */
  async function timeUpdates(video: FakeVideo, count: number) {
    for (let i = 0; i < count; i += 1) {
      await vi.advanceTimersByTimeAsync(210);
      video.dispatchEvent(new Event("timeupdate"));
      await settle();
    }
  }

  it("lands where the viewer clicked, on the first click", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    context.video.seekDelayMs = 100;
    await clickSeekBar(context);
    await timeUpdates(context.video, 6);

    expect(context.video.position).toBeGreaterThan(490);
    expect(context.video.paused).toBe(false);
  });

  it("tells the room where it ended up", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    await clickSeekBar(context);
    await timeUpdates(context.video, 3);

    expect(context.sent.at(-1)).toMatchObject({ playing: true });
    expect(context.sent.at(-1)?.position).toBeGreaterThan(490);
  });

  it("isn't pulled back by the room echoing the pause", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    await clickSeekBar(context);
    const pause = context.sent[0];
    if (pause) context.engine.handleState(context.peerState({ ...pause, from: ME }));
    await timeUpdates(context.video, 6);

    expect(context.video.position).toBeGreaterThan(490);
    expect(context.video.paused).toBe(false);
  });

  it("still follows the room once that's been sent", async () => {
    const context = setup();
    await joinPlaying(context);
    await vi.advanceTimersByTimeAsync(1000);
    await clickSeekBar(context);
    await timeUpdates(context.video, 3);
    for (const state of context.sent) {
      context.engine.handleState(context.peerState({ ...state, from: ME }));
    }
    context.engine.handleState(context.peerState({ position: 900 }));
    await settle();

    expect(context.video.position).toBeGreaterThan(890);
  });
});

describe("a seek of its own that the player never reports", () => {
  async function afterLostSeek(context: ReturnType<typeof setup>) {
    await joinPlaying(context);
    context.video.losesNextSeek = true;
    context.engine.handleState(context.peerState({ position: 300 }));
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    context.sent.length = 0;
  }

  it("doesn't swallow the viewer's next seek", async () => {
    const context = setup();
    await afterLostSeek(context);
    context.video.userSeek(900);
    await vi.advanceTimersByTimeAsync(400);

    expect(context.video.position).toBeGreaterThan(890);
    expect(context.sent.at(-1)?.position).toBeGreaterThan(890);
  });

  it("still knows its own seek when the report is only slow", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.seekDelayMs = 3000;
    context.engine.handleState(context.peerState({ position: 300 }));
    await settle();
    await vi.advanceTimersByTimeAsync(3500);

    expect(context.sent).toEqual([]);
  });

  it("notices the viewer seeking during its own slow seek", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.seekDelayMs = 3000;
    context.engine.handleState(context.peerState({ position: 300 }));
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    context.video.seekDelayMs = 0;
    context.video.userSeek(900);
    await vi.advanceTimersByTimeAsync(400);

    expect(context.sent.at(-1)?.position).toBeGreaterThan(890);
  });
});

describe("alone in a room", () => {
  /** Alone, with a timeline this viewer started. */
  async function alone() {
    const context = setup();
    const { engine, video } = context;
    video.position = 100;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: null, peers: 1 });
    await settle();
    video.userPlay();
    // Past the limit on how often states go out, so the play has been sent.
    await vi.advanceTimersByTimeAsync(300);
    // The room echoes each state back, as it would for real.
    for (const state of context.sent) {
      engine.handleState(context.peerState({ ...state, from: ME }));
    }
    context.sent.length = 0;
    return context;
  }

  it("never corrects the video, since there's nobody to be in sync with", async () => {
    const { video } = await alone();
    video.position = 5000;
    const seeks = video.seekCalls;
    await vi.advanceTimersByTimeAsync(5000);

    expect(video.seekCalls).toBe(seeks);
    expect(video.playbackRate).toBe(1);
  });

  it("isn't dragged to the end of a short video by a timeline that ran past it", async () => {
    const { video } = await alone();
    video.duration = 15;
    video.position = 5;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(video.position).toBe(5);
    expect(video.paused).toBe(false);
  });

  it("reports no drift", async () => {
    const { engine, video } = await alone();
    video.position = 5000;
    expect(engine.snapshot().drift).toBeNull();
  });

  it("keeps the room's state up to date for whoever joins", async () => {
    const { video, sent } = await alone();
    await vi.advanceTimersByTimeAsync(300);
    video.pause();
    await settle();

    expect(sent).toMatchObject([{ playing: false }]);
  });

  it("sends where it is when someone arrives", async () => {
    const { engine, video, sent } = await alone();
    video.position = 777;
    engine.handlePeers(2);

    expect(sent.map((s) => s.position)).toEqual([777]);
  });

  it("starts correcting once there's someone to follow", async () => {
    const { engine, video, sent, peerState } = await alone();
    engine.handlePeers(2);
    engine.handleState(peerState({ ...sent.at(-1), from: ME }));
    engine.handleState(peerState({ position: 900 }));
    await settle();

    expect(video.position).toBe(900);
  });

  it("sends nothing new when the count changes among others", async () => {
    const context = setup();
    await joinPlaying(context);
    context.engine.handlePeers(3);
    context.engine.handlePeers(2);

    expect(context.sent).toEqual([]);
  });

  it("stops correcting when everyone else leaves", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video } = context;
    engine.handlePeers(1);
    video.position += 1;
    await play(video, 2000);

    expect(video.playbackRate).toBe(1);
  });

  it("doesn't send an ad's position to someone arriving", async () => {
    const { engine, video, sent, hold } = await alone();
    hold.reason = "ad";
    video.position = 7;
    engine.handlePeers(2);

    expect(sent).toEqual([]);
  });
});

describe("while an ad plays", () => {
  /** In a playing room at 100, with an ad now on screen and the engine aware of it. */
  async function duringAd() {
    const context = setup();
    await joinPlaying(context);
    context.hold.reason = "ad";
    await vi.advanceTimersByTimeAsync(1300);
    context.sent.length = 0;
    return context;
  }

  it("reports the hold, and no drift to worry about", async () => {
    const { engine } = await duringAd();
    expect(engine.snapshot().hold).toBe("ad");
    expect(engine.snapshot().drift).toBeNull();
  });

  it("tells the check where the room really is, past the end of a short video", async () => {
    const context = setup();
    await joinPlaying(context);
    context.video.duration = 30;
    await vi.advanceTimersByTimeAsync(1300);
    expect(context.hold.roomPosition).toBeGreaterThan(100);
  });

  it("leaves the video alone", async () => {
    const { video } = await duringAd();
    video.position = 5;
    const seeks = video.seekCalls;
    await play(video, 10_000);

    expect(video.seekCalls).toBe(seeks);
    expect(video.playbackRate).toBe(1);
  });

  it("doesn't follow new states into it", async () => {
    const { engine, video, peerState } = await duringAd();
    video.position = 5;
    engine.handleState(peerState({ playing: false, position: 900 }));
    await vi.advanceTimersByTimeAsync(2000);

    expect(video.position).toBe(5);
    expect(video.paused).toBe(false);
  });

  it("keeps the room out of what happens to it", async () => {
    const { video, sent } = await duringAd();
    video.pause();
    await settle();
    video.userPlay();
    await settle();
    video.userSeek(10);
    await settle();
    video.userSetRate(2);
    await settle();

    expect(sent).toEqual([]);
  });

  it("doesn't pause the room when the ad ends", async () => {
    const { video, sent } = await duringAd();
    video.duration = 30;
    video.reachEnd();
    await vi.advanceTimersByTimeAsync(3000);

    expect(sent).toEqual([]);
  });

  it("doesn't bring everyone to the ad", async () => {
    const { engine, sent } = await duringAd();
    engine.bringEveryone();

    expect(sent).toEqual([]);
  });

  it("goes back to the room's spot as soon as it's over", async () => {
    const { engine, video, peerState, hold } = await duringAd();
    video.position = 5;
    engine.handleState(peerState({ playing: true, position: 900 }));
    await vi.advanceTimersByTimeAsync(1300);
    expect(video.position).toBeLessThan(10);

    hold.reason = null;
    await vi.advanceTimersByTimeAsync(1000);

    expect(video.position).toBeGreaterThan(900);
    expect(engine.snapshot().hold).toBeNull();
  });

  it("goes back even within the usual cooldown on seeks", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState, hold } = context;
    engine.handleState(peerState({ position: 900 }));
    await settle();

    hold.reason = "ad";
    await vi.advanceTimersByTimeAsync(1300);
    video.position = 5;
    hold.reason = null;
    await vi.advanceTimersByTimeAsync(1000);

    expect(video.position).toBeGreaterThan(900);
  });

  it("doesn't start the room's timeline from an ad", async () => {
    const context = setup();
    const { engine, video, sent, hold } = context;
    hold.reason = "ad";
    video.position = 7;
    engine.bind(video.asVideo());
    engine.handleJoined({ clientId: ME, state: null, peers: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toEqual([]);

    hold.reason = null;
    video.position = 42;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.map((s) => s.position)).toEqual([42]);
  });
});

describe("bringing everyone along", () => {
  it("sends this viewer's position even when nothing changed", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, sent } = context;
    engine.bringEveryone();

    expect(sent).toMatchObject([{ playing: true, position: 100 }]);
  });

  it("does nothing without a room or a video", () => {
    const context = setup();
    context.engine.bringEveryone();
    context.engine.bind(context.video.asVideo());
    context.engine.bringEveryone();

    expect(context.sent).toEqual([]);
  });
});

describe("binding", () => {
  it("stops listening to a video it has let go of", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent } = context;
    engine.bind(null);
    video.pause();
    video.userSeek(500);
    await vi.advanceTimersByTimeAsync(2000);

    expect(sent).toEqual([]);
    expect(video.position).toBe(500);
  });

  it("restores normal speed on a video it lets go of", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video } = context;
    video.position += 1;
    await play(video, 500);
    engine.bind(null);

    expect(video.playbackRate).toBe(1);
  });

  it("isn't moved by events from the video it replaced", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, sent } = context;
    const next = new FakeVideo();
    engine.bind(next.asVideo());
    await settle();

    next.position = 500;
    video.pause();
    await settle();

    expect(sent).toEqual([]);
  });

  it("doesn't take a video being removed for the viewer pausing", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video, sent } = context;
    video.removeFromPage();
    await vi.advanceTimersByTimeAsync(3000);

    expect(sent).toEqual([]);
  });

  it("doesn't restart a video that's no longer in the page", async () => {
    const context = setup();
    await joinPlaying(context);
    const { video } = context;
    const playCalls = video.playCalls;
    video.removeFromPage();
    await vi.advanceTimersByTimeAsync(3000);

    expect(video.playCalls).toBe(playCalls);
    expect(video.paused).toBe(true);
  });

  it("brings a swapped-in video onto the timeline", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, sent } = context;
    const next = new FakeVideo();
    engine.bind(next.asVideo());
    await settle();

    expect(next.position).toBe(100);
    expect(next.paused).toBe(false);
    expect(sent).toEqual([]);
  });

  it("stops everything when the session ends", async () => {
    const context = setup();
    await joinPlaying(context);
    const { engine, video, peerState, sent } = context;
    engine.stop();
    engine.handleState(peerState({ position: 900 }));
    video.pause();
    await vi.advanceTimersByTimeAsync(5000);

    expect(video.position).toBe(100);
    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
