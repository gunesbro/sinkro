import { describe, expect, it } from "vitest";
import { mergeState, type FieldVersions } from "../src/merge";
import type { RoomState } from "../src/protocol";

const NOW = 100_000;
/** Playing from 10 s, ten seconds ago, so at 20 s now. */
const playing: RoomState = {
  playing: true,
  position: 10,
  rate: 1,
  sentAt: NOW - 10_000,
  seq: 5,
  from: "a",
};
const versions: FieldVersions = { playing: 5, position: 5, rate: 5, positionBy: "a" };

function merge(incoming: Parameters<typeof mergeState>[0]["incoming"], from = "b", seq = 6) {
  return mergeState({ current: playing, versions, incoming, seq, from, now: NOW });
}

describe("combining what people do", () => {
  it("replaces the whole state when nothing says what changed", () => {
    const { state, versions: next } = merge({ playing: false, position: 3, rate: 2, sentAt: NOW });
    expect(state).toMatchObject({
      playing: false,
      position: 3,
      rate: 2,
      sentAt: NOW,
      seq: 6,
      from: "b",
    });
    expect(next).toEqual({ playing: 6, position: 6, rate: 6, positionBy: "b" });
  });

  it("pauses where the viewer paused, when the timeline hasn't moved since they heard", () => {
    const { state } = merge({
      playing: false,
      position: 19.8,
      rate: 1,
      sentAt: NOW - 50,
      changed: ["playing"],
      basis: 5,
    });
    expect(state).toMatchObject({ playing: false, position: 19.8, sentAt: NOW });
  });

  it("keeps a seek that crossed a pause: paused where the seek went", () => {
    // B seeks to 600, then A's pause arrives, sent before A heard about the seek.
    const seek = merge({
      playing: true,
      position: 600,
      rate: 1,
      sentAt: NOW,
      changed: ["position"],
      basis: 5,
    });
    expect(seek.state).toMatchObject({ playing: true, position: 600 });

    const pause = mergeState({
      current: seek.state,
      versions: seek.versions,
      incoming: {
        playing: false,
        position: 20,
        rate: 1,
        sentAt: NOW,
        changed: ["playing"],
        basis: 5,
      },
      seq: 7,
      from: "a",
      now: NOW + 1000,
    });
    expect(pause.state).toMatchObject({ playing: false, rate: 1 });
    expect(pause.state.position).toBeCloseTo(601);
  });

  it("keeps a pause that crossed a seek: paused, at the seek", () => {
    const pause = merge(
      { playing: false, position: 20, rate: 1, sentAt: NOW, changed: ["playing"], basis: 5 },
      "a",
    );
    const seek = mergeState({
      current: pause.state,
      versions: pause.versions,
      incoming: {
        playing: true,
        position: 600,
        rate: 1,
        sentAt: NOW,
        changed: ["position"],
        basis: 5,
      },
      seq: 7,
      from: "b",
      now: NOW + 500,
    });
    expect(seek.state).toMatchObject({ playing: false, position: 600 });
  });

  it("lets the later of two seeks win", () => {
    const first = merge({
      playing: true,
      position: 600,
      rate: 1,
      sentAt: NOW,
      changed: ["position"],
      basis: 5,
    });
    const second = mergeState({
      current: first.state,
      versions: first.versions,
      incoming: {
        playing: true,
        position: 900,
        rate: 1,
        sentAt: NOW,
        changed: ["position"],
        basis: 5,
      },
      seq: 7,
      from: "c",
      now: NOW,
    });
    expect(second.state.position).toBe(900);
  });

  it("keeps a change of speed that crossed a pause", () => {
    const rate = merge({
      playing: true,
      position: 20,
      rate: 1.5,
      sentAt: NOW,
      changed: ["rate"],
      basis: 5,
    });
    const pause = mergeState({
      current: rate.state,
      versions: rate.versions,
      incoming: {
        playing: false,
        position: 20,
        rate: 1,
        sentAt: NOW,
        changed: ["playing"],
        basis: 5,
      },
      seq: 7,
      from: "a",
      now: NOW,
    });
    expect(pause.state).toMatchObject({ playing: false, rate: 1.5 });
  });

  it("knows a viewer's own seek, even from before its echo", () => {
    const seek = merge({
      playing: true,
      position: 600,
      rate: 1,
      sentAt: NOW,
      changed: ["position"],
      basis: 5,
    });
    // B pauses at 600.2 before hearing its own seek back.
    const pause = mergeState({
      current: seek.state,
      versions: seek.versions,
      incoming: {
        playing: false,
        position: 600.2,
        rate: 1,
        sentAt: NOW,
        changed: ["playing"],
        basis: 5,
      },
      seq: 7,
      from: "b",
      now: NOW + 300,
    });
    expect(pause.state.position).toBe(600.2);
  });

  it("starts from where the room is when a play crossed a seek", () => {
    const seek = merge({
      playing: false,
      position: 600,
      rate: 1,
      sentAt: NOW,
      changed: ["position"],
      basis: 5,
    });
    const play = mergeState({
      current: { ...seek.state, playing: false },
      versions: seek.versions,
      incoming: {
        playing: true,
        position: 20,
        rate: 1,
        sentAt: NOW,
        changed: ["playing"],
        basis: 5,
      },
      seq: 7,
      from: "a",
      now: NOW + 100,
    });
    expect(play.state).toMatchObject({ playing: true });
    expect(play.state.position).toBeCloseTo(600, 0);
  });

  it("works on a room saved before it kept versions", () => {
    const { state } = mergeState({
      current: playing,
      versions: undefined,
      incoming: {
        playing: false,
        position: 19.9,
        rate: 1,
        sentAt: NOW,
        changed: ["playing"],
        basis: 5,
      },
      seq: 6,
      from: "b",
      now: NOW,
    });
    expect(state).toMatchObject({ playing: false, position: 19.9 });
  });

  it("replaces the whole state in a room with none", () => {
    const { state } = mergeState({
      current: null,
      versions: undefined,
      incoming: {
        playing: true,
        position: 5,
        rate: 1,
        sentAt: NOW,
        changed: ["playing"],
        basis: 0,
      },
      seq: 1,
      from: "a",
      now: NOW,
    });
    expect(state).toMatchObject({ playing: true, position: 5, sentAt: NOW, seq: 1 });
  });
});
