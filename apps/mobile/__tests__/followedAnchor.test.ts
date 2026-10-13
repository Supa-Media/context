import { describe, expect, test } from "@jest/globals";
import { anchorOnScreen } from "../features/console/followedAnchor";

/**
 * Which anchor the open note scrolls to: the address's (`?note=path#anchor`)
 * first, else the one a followed link carried — but only while the note it
 * was followed to is the one on screen.
 */
describe("anchorOnScreen", () => {
  const followed = { path: "0-inbox/email/a/2026/09/2026-09-07.md", anchor: "msg-1" };

  test("a followed link's anchor, on the note it was followed to", () => {
    expect(anchorOnScreen(followed.path, null, followed)).toBe("msg-1");
  });

  test("nothing once another note is on screen", () => {
    expect(anchorOnScreen("1-projects/plan.md", null, followed)).toBeNull();
    expect(anchorOnScreen(null, null, followed)).toBeNull();
  });

  test("the address wins over a followed link", () => {
    expect(anchorOnScreen(followed.path, "msg-2", followed)).toBe("msg-2");
  });

  test("no followed link, no anchor beyond the address", () => {
    expect(anchorOnScreen(followed.path, null, null)).toBeNull();
  });
});
