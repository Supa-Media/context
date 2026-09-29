/**
 * A ```` ```join ```` FENCE IS WHERE THE HOMEPAGE'S WAITLIST FIELD GOES.
 *
 * The editor draws a closed one at the margin as a box (`JoinWidget`) the
 * homepage fills, and gives the source back when the caret reaches it. A
 * served site drops it, since only the homepage has a sign-in to offer
 * (`stripWebsiteJoin`). Anything else that looks like one is left alone.
 */

import { describe, expect, test } from "@jest/globals";
import { stripWebsiteJoin } from "@context/shared/src/websiteJoin";
import { JoinWidget, joinFences } from "../../features/console/files/livePreview/joinBlock";
import { decorationsFor, stateFor } from "./fixtures";

const PAGE = "# Welcome\n\nit's invite only.\n\n```join\n```\n\nalready in? sign in";

/** Join boxes drawn with the caret at `caret` (the end of the page by default). */
function boxes(doc: string, caret = doc.length): number {
  const state = stateFor(doc, caret);
  let found = 0;
  decorationsFor(state).between(0, state.doc.length, (_from, _to, value) => {
    if ((value.spec as { widget?: unknown }).widget instanceof JoinWidget) found += 1;
  });
  return found;
}

describe("the editor", () => {
  test("draws a closed join fence as one box", () => {
    expect(boxes(PAGE)).toBe(1);
    expect(joinFences(stateFor(PAGE, PAGE.length))).toHaveLength(1);
  });

  test("gives the source back when the caret is in it", () => {
    expect(boxes(PAGE, PAGE.indexOf("```join") + 2)).toBe(0);
  });

  test("leaves an unclosed fence and other code blocks alone", () => {
    expect(boxes("# Hi\n\n```join\nstill typing")).toBe(0);
    expect(boxes("# Hi\n\n```js\nconst join = 1;\n```")).toBe(0);
  });
});

describe("a served site", () => {
  test("drops the fence and the blank line it leaves", () => {
    expect(stripWebsiteJoin(PAGE)).toBe("# Welcome\n\nit's invite only.\n\nalready in? sign in");
  });

  test("keeps an unclosed fence and never looks inside another code block", () => {
    expect(stripWebsiteJoin("a\n\n```join\nb")).toBe("a\n\n```join\nb");
    const quoted = "````md\n```join\n```\n````";
    expect(stripWebsiteJoin(quoted)).toBe(quoted);
  });
});
