/**
 * A granted note's address in @shared, and a grant's place in the list.
 *
 * A grant opens by its workspace and its note id (`?grant=<workspaceId>.<noteId>`),
 * not by a share token, so the two can never be taken for each other: a token is
 * never in `grant`, and a grant is never in `note`. These tests pin the address
 * as the router hands it back (decoded, one value per key), and the list rules
 * a grant item shares with a share item.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   parse accepts a grant with no dot                              1
 *   parse reads `by=path` as an id                                 1
 *   grantQuery leaves the path unencoded                           1
 *   sharedItemKey gives a grant its token-shaped key               1
 *   groupByPerson drops a grant with no recorded sharer            1
 */

import { describe, expect, test } from "@jest/globals";

const grant = require("../features/console/shared/sharedGrant") as typeof import("../features/console/shared/sharedGrant");
const inbox = require("../features/console/shared/sharedInbox") as typeof import("../features/console/shared/sharedInbox");
type SharedItem = import("../features/console/shared/sharedInbox").SharedItem;
type GrantItem = import("../features/console/shared/sharedInbox").GrantItem;

/** The query string as the router decodes it: one value per key, percent-escapes undone. */
function decoded(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.replace(/^\?/, "").split("&")) {
    const eq = part.indexOf("=");
    out[decodeURIComponent(eq < 0 ? part : part.slice(0, eq))] = decodeURIComponent(eq < 0 ? "" : part.slice(eq + 1));
  }
  return out;
}

const WS = "wsacme0001";
const NOTE = "0190f2c0-7a1b-7000-8000-00000000abcd";

describe("a granted note's address", () => {
  test("a granted note is addressed by workspace and note id, and round-trips", () => {
    const target = { workspaceId: WS, ref: { by: "id" as const, noteId: NOTE }, folder: false };
    const query = grant.grantQuery(target);
    expect(decoded(query)).toEqual({ grant: `${WS}.${NOTE}` });
    expect(grant.parseGrant(decoded(query))).toEqual(target);
  });

  test("a granted folder says it is a folder, and a note reached from a folder by path says so", () => {
    const folder = { workspaceId: WS, ref: { by: "id" as const, noteId: NOTE }, folder: true };
    expect(decoded(grant.grantQuery(folder))).toEqual({ grant: `${WS}.${NOTE}`, kind: "folder" });
    expect(grant.parseGrant(decoded(grant.grantQuery(folder)))).toEqual(folder);

    const child = { workspaceId: WS, ref: { by: "path" as const, path: "1-projects/plan.md" }, folder: false };
    expect(decoded(grant.grantQuery(child))).toEqual({ grant: `${WS}.1-projects/plan.md`, by: "path" });
    expect(grant.parseGrant(decoded(grant.grantQuery(child)))).toEqual(child);
  });

  test("a path with spaces, ampersands and question marks survives the address", () => {
    const awkward = "1-projects/plan & notes?.md";
    const target = { workspaceId: WS, ref: { by: "path" as const, path: awkward }, folder: false };
    const query = grant.grantQuery(target);
    // The raw address never carries a bare `&` or `?` inside the value.
    expect(query.split("&")).toHaveLength(2);
    expect(grant.parseGrant(decoded(query))).toEqual(target);
  });

  test("a token never parses as a grant, and a grant never reaches the share path", () => {
    expect(grant.parseGrant({ note: "tok-chaos" })).toBeNull();
    expect(grant.parseGrant({ grant: "tok-chaos" })).toBeNull();
  });

  test("malformed addresses are refused, not guessed at", () => {
    expect(grant.parseGrant({})).toBeNull();
    expect(grant.parseGrant({ grant: "" })).toBeNull();
    expect(grant.parseGrant({ grant: NOTE })).toBeNull(); // no workspace
    expect(grant.parseGrant({ grant: `.${NOTE}` })).toBeNull(); // empty workspace
    expect(grant.parseGrant({ grant: `${WS}.` })).toBeNull(); // empty reference
    expect(grant.parseGrant({ grant: `ws/evil.${NOTE}` })).toBeNull(); // not an id
    expect(grant.parseGrant({ grant: `${WS}.${NOTE}`, by: "name" })).toBeNull();
    expect(grant.parseGrant({ grant: `${WS}.${NOTE}`, kind: "file" })).toBeNull();
  });

  test("a repeated parameter is read as its first value", () => {
    expect(grant.firstOf(["a", "b"])).toBe("a");
    expect(grant.firstOf("a")).toBe("a");
    expect(grant.firstOf(undefined)).toBeUndefined();
  });

  test("the open key of a granted note is its grant key, and a path reached note has none", () => {
    expect(grant.grantItemKey(WS, NOTE)).toBe(`grant:${WS}.${NOTE}`);
    expect(
      grant.openKeyOf({ workspaceId: WS, ref: { by: "id", noteId: NOTE }, folder: false }),
    ).toBe(`grant:${WS}.${NOTE}`);
    expect(grant.openKeyOf({ workspaceId: WS, ref: { by: "path", path: "a.md" }, folder: false })).toBeNull();
  });
});

const share: SharedItem = {
  token: "tok-chaos",
  workspaceId: "ws-ana",
  slug: "ana",
  displayName: "Ana",
  workspaceKind: "personal",
  entryPath: "1-projects/beneath-the-chaos.md",
  sharedBy: "user-ana",
  sharedByHandle: "ana",
  sharedByName: null,
  title: null,
  createdAt: 1_000,
};

const granted: GrantItem = {
  kind: "grant",
  workspaceId: WS,
  slug: "acme",
  displayName: "Acme",
  workspaceKind: "shared",
  noteId: NOTE,
  entryPath: "1-projects/plan.md",
  itemKind: "file",
  sharedBy: null,
  sharedByHandle: null,
  sharedByName: null,
  title: "Plan",
  createdAt: 2_000,
};

describe("a grant item in Shared with me", () => {
  test("it is keyed and linked by its grant, and a share by its token", () => {
    expect(inbox.sharedItemKey(share)).toBe("tok-chaos");
    expect(inbox.sharedItemKey(granted)).toBe(`grant:${WS}.${NOTE}`);
    expect(inbox.sharedItemHref(share)).toBe("/console/shared?note=tok-chaos");
    expect(decoded(inbox.sharedItemHref(granted).split("?")[1]!)).toEqual({ grant: `${WS}.${NOTE}` });
  });

  test("a granted folder links as a folder", () => {
    const folder = { ...granted, itemKind: "folder" as const, entryPath: "1-projects" };
    expect(decoded(inbox.sharedItemHref(folder).split("?")[1]!)).toEqual({ grant: `${WS}.${NOTE}`, kind: "folder" });
  });

  test("a grant with no recorded sharer is grouped under no person, not dropped", () => {
    const groups = inbox.groupByPerson([share, granted]);
    expect(groups.map((group) => group.label).sort()).toEqual(["@ana", "Someone"]);
    const someone = groups.find((group) => group.label === "Someone")!;
    expect(someone.items.map((item) => inbox.sharedItemKey(item))).toEqual([`grant:${WS}.${NOTE}`]);
  });

  test("a grant the list titles itself with still says where it lives", () => {
    expect(inbox.itemTitle(granted)).toBe("Plan");
    expect(inbox.placeLabel(granted)).toBe("Acme");
    expect(inbox.matchesFilter(granted, "acme")).toBe(true);
  });
});
