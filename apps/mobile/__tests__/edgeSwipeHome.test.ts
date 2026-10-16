import { describe, expect, test } from "@jest/globals";
import { EDGE_ZONE, HOME_AFTER, claimsEdgeSwipe, swipeReachesHome } from "../features/console/home/EdgeSwipeHome";

/**
 * A swipe in from the left edge goes Home (owner, 2026-10-16: "swipe to the
 * left and long press back ... let's add both"). Only from the edge, only
 * rightward, only more across than down, so a page's own sideways scrolling
 * and an ordinary vertical scroll stay the page's.
 *
 * SABOTAGE: dropping the `startX <= EDGE_ZONE` test fails the second; dropping
 * the `|dy| < dx` test fails the third.
 */
describe("the swipe Home", () => {
  test("from the edge, rightward, is claimed, and far enough goes Home", () => {
    expect(claimsEdgeSwipe(4, 20, 3)).toBe(true);
    expect(swipeReachesHome(HOME_AFTER, 10)).toBe(true);
  });

  test("a swipe that starts mid-page is the page's", () => {
    expect(claimsEdgeSwipe(EDGE_ZONE + 40, 60, 0)).toBe(false);
  });

  test("a scroll that drifts sideways is not a swipe", () => {
    expect(claimsEdgeSwipe(4, 20, 40)).toBe(false);
    expect(swipeReachesHome(HOME_AFTER + 10, HOME_AFTER + 40)).toBe(false);
  });

  test("leftward, or a short drag, goes nowhere", () => {
    expect(claimsEdgeSwipe(4, -30, 0)).toBe(false);
    expect(claimsEdgeSwipe(4, 6, 0)).toBe(false);
    expect(swipeReachesHome(HOME_AFTER - 1, 0)).toBe(false);
  });
});
