import { describe, expect, it } from "vitest";
import { floaterLabel } from "../src/content/reactions-layer";

describe("what a screen reader hears of a reaction", () => {
  it("says whose it is", () => {
    expect(floaterLabel("Blue Fox", "😂")).toBe("Blue Fox: 😂");
  });

  it("is just the reaction when the name isn't known yet", () => {
    expect(floaterLabel(null, "😂")).toBe("😂");
  });
});
