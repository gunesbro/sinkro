import { describe, expect, it, vi } from "vitest";
import { Arrivals } from "../src/content/sync/arrivals";

function setup({ isHere = true } = {}) {
  let now = 0;
  const onEveryoneHere = vi.fn();
  const here = { value: isHere };
  const arrivals = new Arrivals({ onEveryoneHere, isHere: () => here.value, now: () => now });
  arrivals.setPeers(2);
  return {
    arrivals,
    onEveryoneHere,
    here,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("everyone's here", () => {
  it("is said when the one away comes back on the same page", () => {
    const { arrivals, onEveryoneHere } = setup();
    arrivals.setOthersAway(1);
    arrivals.setOthersAway(0);
    expect(onEveryoneHere).toHaveBeenCalledOnce();
  });

  it("is said when the one away follows through a new page", () => {
    const { arrivals, onEveryoneHere, advance } = setup();
    arrivals.setOthersAway(1);
    // The old page goes first, then the new one joins.
    arrivals.setPeers(1);
    arrivals.setOthersAway(0);
    expect(onEveryoneHere).not.toHaveBeenCalled();
    advance(3000);
    arrivals.setPeers(2);
    expect(onEveryoneHere).toHaveBeenCalledOnce();
  });

  it("isn't said when the one away leaves the room", () => {
    const { arrivals, onEveryoneHere, advance } = setup();
    arrivals.setOthersAway(1);
    arrivals.setPeers(1);
    arrivals.setOthersAway(0);
    advance(20_000);
    arrivals.setPeers(2);
    expect(onEveryoneHere).not.toHaveBeenCalled();
  });

  it("isn't said when the one away brings everyone to their video instead", () => {
    const { arrivals, onEveryoneHere, here } = setup();
    arrivals.setOthersAway(1);
    arrivals.roomMoved();
    here.value = false;
    arrivals.setOthersAway(0);
    expect(onEveryoneHere).not.toHaveBeenCalled();
  });

  it("isn't said to someone who isn't on the room's video themselves", () => {
    const { arrivals, onEveryoneHere } = setup({ isHere: false });
    arrivals.setOthersAway(1);
    arrivals.setOthersAway(0);
    expect(onEveryoneHere).not.toHaveBeenCalled();
  });

  it("isn't said when nobody was away", () => {
    const { arrivals, onEveryoneHere } = setup();
    arrivals.setOthersAway(0);
    arrivals.setPeers(3);
    expect(onEveryoneHere).not.toHaveBeenCalled();
  });
});
