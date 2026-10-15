import { describe, expect, test } from "@jest/globals";
import { leftBehindLine, leftBehindMore, leftBehindTitle } from "../features/console/storage/handoff/leftBehind";

const one = { bucket: "my-old-bucket", keys: ["meetings/kickoff.m4a"], count: 1, at: 0 };
const many = { bucket: "my-old-bucket", keys: ["a.mov", "b.mov"], count: 52, at: 0 };

describe("files a move left behind", () => {
  test("say how many, where they are, and that nothing was deleted", () => {
    expect(leftBehindTitle(one)).toBe("1 file stayed behind");
    expect(leftBehindLine(one)).toBe(
      "It is over the 20 MB file limit, so the move left it in my-old-bucket. Nothing was deleted.",
    );
    expect(leftBehindTitle(many)).toBe("52 files stayed behind");
    expect(leftBehindLine(many)).toContain("They are over the 20 MB file limit, so the move left them in my-old-bucket.");
  });

  test("count the ones past the names shown", () => {
    expect(leftBehindMore(one)).toBeNull();
    expect(leftBehindMore(many)).toBe("and 50 more");
  });
});
