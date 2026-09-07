import { describe, expect, test } from "@jest/globals";
import { anchorFromQuery, noteFromQuery, noteHref } from "../features/console/nav";

/**
 * `noteHref`'s third argument, reconciled with the sibling search work's own
 * `<notePath>#<anchor>` deep link (`apps/mcp/src/search/CONTRACT.md`) — see
 * `noteHref`'s own comment for the two independent designs this used to be.
 * `teamLink.test.ts` already holds `splitNoteAnchor`/`noteFromQuery`/
 * `anchorFromQuery` to that contract in full; this file only pins the
 * convenience argument itself, so a contact's activity link and a
 * channel-day's own message list — the two callers that pass path and anchor
 * as separate values rather than a value already carrying a `#` — produce
 * exactly what that contract expects to read back.
 */
describe("noteHref with an anchor", () => {
  test("no anchor is the plain note link, unchanged", () => {
    expect(noteHref("seyi", "1-projects/a.md")).toBe("/console/@seyi?note=1-projects%2Fa.md");
  });

  test("an anchor is embedded as path#anchor, then the whole value is encoded", () => {
    expect(noteHref("seyi", "0-inbox/email/name-at-example-com/2026-09-07", "msg-0123456789abcdef")).toBe(
      "/console/@seyi?note=0-inbox%2Femail%2Fname-at-example-com%2F2026-09-07%23msg-0123456789abcdef",
    );
  });

  test("an empty anchor is the same as none", () => {
    expect(noteHref("seyi", "1-projects/a.md", "")).toBe("/console/@seyi?note=1-projects%2Fa.md");
  });

  test("round-trips through noteFromQuery and anchorFromQuery", () => {
    const href = noteHref("seyi", "0-inbox/email/name-at-example-com/2026-09-07", "msg-0123456789abcdef");
    const query = decodeURIComponent(href.split("?note=")[1]!);
    expect(noteFromQuery(query)).toBe("0-inbox/email/name-at-example-com/2026-09-07");
    expect(anchorFromQuery(query)).toBe("msg-0123456789abcdef");
  });
});
