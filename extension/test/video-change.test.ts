import { describe, expect, it } from "vitest";
import { videoPageKey } from "../src/invite";
import {
  broughtHere,
  describeChange,
  destination,
  isOnRoomPage,
  NEW_TAB_VIDEO,
  pageVisited,
  roomVideoLearned,
  videoFound,
  type TabVideo,
} from "../src/video-change";

const FILM = "https://videos.example/watch?v=1";
const OTHER = "https://videos.example/watch?v=2";
const MIRROR = "https://mirror.example/film-1";
const HOME = "https://videos.example/";

const visit = (state: TabVideo, url: string, title = "") => pageVisited(state, { url, title });
const room = (state: TabVideo, url: string, announced = true, title = "The Film") =>
  roomVideoLearned(state, { url, title }, announced);

/** On the room's video with the video found, the usual place to start from. */
const watching = (url = FILM) => videoFound(room(visit(NEW_TAB_VIDEO, url), url));

describe("moving away from the room's video", () => {
  it("notices the viewer going to another video", () => {
    expect(visit(watching(), OTHER).change).toBe("you_moved");
  });

  it("clears when they come back by themselves", () => {
    expect(visit(visit(watching(), OTHER), FILM).change).toBeNull();
  });

  it("stays while they keep wandering", () => {
    expect(visit(visit(watching(), OTHER), "https://videos.example/watch?v=3").change).toBe(
      "you_moved",
    );
  });

  it("leads back to where they were", () => {
    expect(destination(visit(watching(), OTHER))).toBe(FILM);
  });

  it("leads a viewer on a mirror back to the mirror, not the room's own site", () => {
    const onMirror = videoFound(room(visit(NEW_TAB_VIDEO, MIRROR), FILM, false));
    expect(onMirror.change).toBeNull();
    expect(destination(visit(onMirror, OTHER))).toBe(MIRROR);
  });

  it("isn't set off by a reload", () => {
    expect(visit(watching(), FILM).change).toBeNull();
  });

  it.each([
    ["a time", `${FILM}&t=120`],
    ["tracking", `${FILM}&utm_source=x&si=abc`],
    ["a fragment", `${FILM}#comments`],
  ])("isn't set off by %s in the address", (_, address) => {
    expect(visit(watching(), address).change).toBeNull();
  });

  it("isn't set off by leaving a page that had no video", () => {
    const browsing = visit(NEW_TAB_VIDEO, HOME);
    const arrived = visit(browsing, FILM);
    expect(arrived.change).toBeNull();
    expect(arrived.followingUrl).toBe(FILM);
  });

  it("counts leaving any page that had a video", () => {
    expect(visit(videoFound(visit(NEW_TAB_VIDEO, HOME)), FILM).change).toBe("you_moved");
  });

  it("only counts a video found while on the page being followed", () => {
    const moved = visit(watching(), OTHER);
    expect(videoFound(moved)).toBe(moved);
  });
});

describe("the room moving", () => {
  it("tells whoever is still on the old video", () => {
    const moved = room(watching(), OTHER);
    expect(moved.change).toBe("room_moved");
    expect(describeChange(moved)).toEqual({
      kind: "room_moved",
      title: "The Film",
      host: "videos.example",
    });
  });

  it("offers the new video", () => {
    expect(destination(room(watching(), OTHER))).toBe(OTHER);
  });

  it("clears when they get there", () => {
    expect(visit(room(watching(), OTHER), OTHER).change).toBeNull();
  });

  it("says nothing to whoever is already there", () => {
    const already = room(visit(watching(), OTHER), OTHER);
    expect(already.change).toBeNull();
    expect(already.followingUrl).toBe(OTHER);
  });

  it("isn't undone by going back to the old video", () => {
    const moved = room(watching(), OTHER);
    expect(visit(visit(moved, HOME), FILM).change).toBe("room_moved");
  });

  it("is noticed when someone moves a room that had no video yet", () => {
    const noVideoYet = videoFound(visit(NEW_TAB_VIDEO, FILM));
    expect(room(noVideoYet, OTHER).change).toBe("room_moved");
  });

  it("is noticed after a reconnect that missed the announcement", () => {
    expect(room(watching(), OTHER, false).change).toBe("room_moved");
  });

  it("changes nothing when the room says what it already said", () => {
    expect(room(visit(watching(), OTHER), FILM, false).change).toBe("you_moved");
  });
});

describe("learning where the room is", () => {
  it("leaves a viewer on another page alone, in case it's a mirror", () => {
    const learned = room(visit(NEW_TAB_VIDEO, MIRROR), FILM, false);
    expect(learned.change).toBeNull();
    expect(learned.followingUrl).toBe(MIRROR);
  });

  it("waits for the page to be known", () => {
    expect(room(NEW_TAB_VIDEO, FILM).change).toBeNull();
  });
});

describe("bringing everyone", () => {
  it("makes this page the room's video", () => {
    const brought = broughtHere(visit(watching(), OTHER));
    expect(brought.change).toBeNull();
    expect(brought.roomUrl).toBe(OTHER);
    expect(brought.followingUrl).toBe(OTHER);
  });

  it("takes the title with it", () => {
    const moved = pageVisited(watching(), { url: OTHER, title: "Next Film" });
    expect(broughtHere(moved).roomTitle).toBe("Next Film");
  });

  it("isn't treated as moving when its own announcement comes back", () => {
    const brought = broughtHere(visit(watching(), OTHER));
    expect(room(brought, OTHER).change).toBeNull();
  });

  it("works from a viewer the room moved away from", () => {
    const brought = broughtHere(room(watching(), OTHER));
    expect(brought.change).toBeNull();
    expect(brought.roomUrl).toBe(FILM);
  });

  it("then moving away again is noticed", () => {
    expect(visit(broughtHere(visit(watching(), OTHER)), FILM).change).toBe("you_moved");
  });
});

describe("isOnRoomPage", () => {
  it("is true on the room's video's page", () => {
    expect(isOnRoomPage(room(visit(NEW_TAB_VIDEO, FILM), FILM, false))).toBe(true);
  });

  it("is true with only time or tracking different", () => {
    expect(isOnRoomPage(room(visit(NEW_TAB_VIDEO, `${FILM}&t=9`), FILM, false))).toBe(true);
  });

  it("is false anywhere else, so browsing isn't nagged", () => {
    expect(isOnRoomPage(room(visit(NEW_TAB_VIDEO, HOME), FILM, false))).toBe(false);
  });

  it("is false with no room video known", () => {
    expect(isOnRoomPage(visit(NEW_TAB_VIDEO, FILM))).toBe(false);
  });
});

describe("telling the viewer", () => {
  it("says nothing with nothing changed", () => {
    expect(describeChange(watching())).toBeNull();
    expect(destination(watching())).toBeNull();
  });

  it("names where going back leads, and doesn't repeat the room's title", () => {
    expect(describeChange(visit(watching(), "https://other.example/x"))).toEqual({
      kind: "you_moved",
      title: "",
      host: "videos.example",
    });
  });
});

describe("videoPageKey", () => {
  it.each([
    ["https://a.com/x?v=1", "https://www.a.com/x/?v=1"],
    ["https://a.com/x?v=1&list=2", "https://a.com/x?list=2&v=1"],
    ["https://a.com/x?v=1", "https://a.com/x?v=1&t=30&utm_medium=y&fbclid=z"],
    ["https://a.com/x", "https://a.com/x#part2"],
  ])("treats %s and %s as the same video", (a, b) => {
    expect(videoPageKey(a)).toBe(videoPageKey(b));
  });

  it.each([
    ["https://a.com/x?v=1", "https://a.com/x?v=2"],
    ["https://a.com/x", "https://a.com/y"],
    ["https://a.com/x", "https://b.com/x"],
    ["https://a.com:8080/x", "https://a.com:9090/x"],
  ])("treats %s and %s as different videos", (a, b) => {
    expect(videoPageKey(a)).not.toBe(videoPageKey(b));
  });

  it("has no answer for something that isn't an address", () => {
    expect(videoPageKey("not a url")).toBeNull();
  });
});
