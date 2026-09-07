/**
 * A LINK FOR PEOPLE WHO ALREADY HAVE ACCESS.
 *
 * Two ways to send somebody a note, and the difference is the whole design:
 *
 *  - **`/s/<token>`** is a *capability*. It carries 32 CSPRNG bytes, is
 *    addressed to one named person, grants them that note, and can be revoked.
 *    It exists for somebody who is **not** in your context.
 *  - **`/console/@slug?note=…`** is an *address*. It carries no token and
 *    grants nothing; whoever opens it sees the note only if their membership
 *    already lets them. It exists for the people you have already given access
 *    to, and for them a share would be machinery wrapped around a grant they
 *    have.
 *
 * The **link preview** is where the two used to differ and no longer do, and
 * the reasoning is worth keeping because it was reversed deliberately.
 *
 * A console URL is guessable, so a titled card there is an oracle — and that
 * argued for freezing it. What changed the answer is that the card is *opt-in*:
 * it exists only for notes the owner has explicitly team-linked, so the probe
 * reveals the set they already chose to publish and nothing else. Weighed
 * against a link nobody can read — a 64-character token says nothing about
 * what it points at — the owner took the readable one.
 *
 * The assertions for that live in the router's own suite; see
 * "a readable team link" in `preview.test.ts`.
 */

import { describe, expect, test } from "@jest/globals";
import {
  anchorFromQuery,
  browseHref,
  noteFromQuery,
  noteHref,
  resolveContextRoute,
  routeForPath,
  splitNoteAnchor,
} from "../features/console/nav";

const CONTEXTS = [{ id: "w1", slug: "seyi" }];

describe("the team link", () => {
  test("names the context and the note", () => {
    expect(noteHref("seyi", "1-projects/plan.md")).toBe(
      "/console/@seyi?note=1-projects%2Fplan.md",
    );
  });

  test("accepts a slug written either way", () => {
    expect(noteHref("@seyi", "a.md")).toBe(noteHref("seyi", "a.md"));
  });

  /**
   * It carries no token, and that is the point: there is nothing in this URL to
   * leak, because there is nothing in it that grants anything.
   */
  test("carries no capability", () => {
    const href = noteHref("seyi", "1-projects/plan.md");
    expect(href).not.toMatch(/[0-9a-f]{32}/);
    expect(href).not.toContain("token");
  });

  /**
   * The route grammar reads the segment after the context as a *view* name, so
   * a note in the path would collide with `settings`. In the query it does not,
   * and the existing parser already strips it — the URL still resolves to the
   * same Browse route it did before notes were addressable.
   */
  test("does not disturb the route it decorates", () => {
    expect(routeForPath(noteHref("seyi", "1-projects/plan.md"))).toEqual(
      routeForPath(browseHref("seyi")),
    );
  });
});

describe("reading the note out of a URL", () => {
  test("an ordinary path", () => {
    expect(noteFromQuery("1-projects/plan.md")).toBe("1-projects/plan.md");
  });

  test("a repeated parameter does not become a crash", () => {
    expect(noteFromQuery(["a.md", "b.md"])).toBe("a.md");
    expect(noteFromQuery(undefined)).toBeNull();
  });

  /**
   * This value becomes a path in a request against somebody's bucket. The same
   * refusals `safeNextRoute` makes, and for the same reason: a hand-edited URL
   * should open nothing rather than have its meaning guessed at.
   */
  test.each([
    ["/etc/passwd", "rooted"],
    ["../../privacy.md", "traversal"],
    ["1-projects/../../privacy.md", "traversal in the middle"],
    ["a\\\\b.md", "a backslash"],
    ["", "empty"],
    ["   ", "whitespace"],
  ])("%s opens nothing (%s)", (value) => {
    expect(noteFromQuery(value)).toBeNull();
  });

  test("a control character opens nothing", () => {
    expect(noteFromQuery("a\u0000b.md")).toBeNull();
  });
});

/**
 * A search result over a channel-day note's message deep-links as
 * `<notePath>#<anchor>` (`apps/mcp/src/search/CONTRACT.md`, "Channel-day
 * notes: one sub-document per message") — the same shape a wikilink into one
 * already uses. `noteHref` needs no change: `encodeURIComponent` already
 * turns the `#` into `%23`, so it never becomes a URL fragment. What has to
 * split it back apart is the read side.
 */
describe("a message deep link inside a note path", () => {
  const dayPath = "0-inbox/email/name-at-example-com/2026-09-07.md";
  const anchor = "msg-6f3a91c04b7d5e28";

  test("splitNoteAnchor separates the two", () => {
    expect(splitNoteAnchor(`${dayPath}#${anchor}`)).toEqual({ path: dayPath, anchor });
  });

  test("an ordinary path has no anchor to split off", () => {
    expect(splitNoteAnchor("1-projects/plan.md")).toEqual({ path: "1-projects/plan.md", anchor: null });
    expect(splitNoteAnchor(dayPath)).toEqual({ path: dayPath, anchor: null });
  });

  test("something that merely contains a # is not an anchor", () => {
    // Only a trailing `#msg-<16 hex>` counts — a stray `#` anywhere else in a
    // path is just a character in a path, not a link target.
    expect(splitNoteAnchor("a#b.md")).toEqual({ path: "a#b.md", anchor: null });
    expect(splitNoteAnchor(`${dayPath}#msg-notenoughhex`)).toEqual({
      path: `${dayPath}#msg-notenoughhex`,
      anchor: null,
    });
  });

  /**
   * The property that matters: `noteFromQuery` — what feeds `useNoteAddress`'s
   * two-way sync with the open selection — never carries the anchor through.
   * If it did, `note` would disagree with `FileBrowser`'s own `selectedPath`
   * (a real bucket path, never one with a `#anchor` tail) by exactly that
   * suffix on every note a search result opened, which is the oscillation
   * `useNoteAddress`'s own module comment warns never converges.
   */
  test("noteFromQuery opens the containing note, not a literal #anchor path", () => {
    expect(noteFromQuery(`${dayPath}#${anchor}`)).toBe(dayPath);
  });

  test("anchorFromQuery reads the other half of the same value", () => {
    expect(anchorFromQuery(`${dayPath}#${anchor}`)).toBe(anchor);
    expect(anchorFromQuery(dayPath)).toBeNull();
    expect(anchorFromQuery(undefined)).toBeNull();
  });

  test("a repeated parameter reads consistently across both halves", () => {
    expect(noteFromQuery([`${dayPath}#${anchor}`, "other.md"])).toBe(dayPath);
    expect(anchorFromQuery([`${dayPath}#${anchor}`, "other.md"])).toBe(anchor);
  });

  test("a value safeNotePath refuses has no path and no anchor", () => {
    expect(noteFromQuery(`../../secret.md#${anchor}`)).toBeNull();
    expect(anchorFromQuery(`../../secret.md#${anchor}`)).toBeNull();
  });
});

describe("somebody who was invited and has not accepted", () => {
  /**
   * The case this exists for. They follow a note link into a context they have
   * a live invitation to; without this they land on the **map**, which is the
   * least useful answer available — they were sent a link, they do have a way
   * in, and nothing on that screen says so.
   */
  test("is sent to their invitation, not to the map", () => {
    const resolution = resolveContextRoute({
      route: routeForPath(noteHref("seyi", "a.md")),
      contexts: [{ id: "w2", slug: "somewhere-else" }],
      selectedContextId: "w2",
      loading: false,
      invitations: [{ slug: "seyi", token: "tok" }],
    });
    expect(resolution).toEqual({ action: "redirect", href: "/invite/tok" });
  });

  test("an invitation to a different context does not answer this one", () => {
    const resolution = resolveContextRoute({
      route: routeForPath(noteHref("seyi", "a.md")),
      contexts: [{ id: "w2", slug: "somewhere-else" }],
      selectedContextId: "w2",
      loading: false,
      invitations: [{ slug: "elsewhere", token: "tok" }],
    });
    expect(resolution).toEqual({ action: "redirect", href: "/console" });
  });

  /**
   * A member needs no invitation and must never be sent to one — they already
   * have the note.
   */
  test("a member goes straight to the context", () => {
    expect(
      resolveContextRoute({
        route: routeForPath(noteHref("seyi", "a.md")),
        contexts: CONTEXTS,
        selectedContextId: null,
        loading: false,
        invitations: [{ slug: "seyi", token: "tok" }],
      }),
    ).toEqual({ action: "select", contextId: "w1" });
  });

  /**
   * `undefined` is "nobody told me", not "there are none". A caller without the
   * list behaves exactly as it did before invitations were consulted — which is
   * also what happens while the query is still in flight, so a slow list never
   * bounces an invited person to the map.
   */
  test("an absent list changes nothing", () => {
    expect(
      resolveContextRoute({
        route: routeForPath(noteHref("nobody", "a.md")),
        contexts: CONTEXTS,
        selectedContextId: "w1",
        loading: false,
      }),
    ).toEqual({ action: "redirect", href: "/console" });
  });

  test("and a stranger still gets the map", () => {
    expect(
      resolveContextRoute({
        route: routeForPath(noteHref("nobody", "a.md")),
        contexts: CONTEXTS,
        selectedContextId: "w1",
        loading: false,
        invitations: [],
      }),
    ).toEqual({ action: "redirect", href: "/console" });
  });
});

/*
  The preview assertions live in the router's own suite — `infra/router` is a
  separate package and Jest cannot import across it here. See "a readable team
  link" in `preview.test.ts`, beside the nine-variant byte-identity set that
  still governs every console URL without a linked note.
*/
