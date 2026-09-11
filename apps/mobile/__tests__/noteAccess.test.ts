/**
 * The share dialog's people list, as a pure join.
 *
 * `accessRows` answers "who reaches this note" from two things somebody else
 * decided: the visibility the server computed, and the membership the control
 * plane returned. The properties worth pinning are the ones a list like this
 * gets wrong in the direction that matters — showing somebody as having access
 * when they do not.
 */

import { describe, expect, test } from "@jest/globals";
import {
  accessRows,
  accessSummary,
  removalHandler,
  type AccessMember,
} from "../features/console/files/access";

const MEMBERS: AccessMember[] = [
  { userId: "u1", role: "owner", name: "seyi", isMe: true },
  { userId: "u2", role: "editor", name: "kola", isMe: false },
  { userId: "u3", role: "member", name: "rae", isMe: false },
];

describe("who reaches a note", () => {
  test("a team note reaches everybody, and says the folder is why", () => {
    const rows = accessRows("team", false, MEMBERS);
    expect(rows.map((row) => row.label)).toEqual(["seyi (you)", "kola", "rae"]);
    expect(rows[1].reason).toMatch(/folder/i);
  });

  test("...and says the note is why when the note itself carries the rule", () => {
    expect(accessRows("team", true, MEMBERS)[1].reason).toMatch(/this note/i);
  });

  /**
   * The direction that matters. A private note reaches owners; a list that
   * showed the editor greyed out would read as "shared with three people" at
   * the glance this screen exists for.
   */
  test("a private note lists owners only, and the others are absent rather than dimmed", () => {
    const rows = accessRows("private", true, MEMBERS);
    expect(rows.map((row) => row.label)).toEqual(["seyi (you)"]);
  });

  test("a group rule is named rather than resolved to people it cannot see", () => {
    const rows = accessRows("@supa-leads", true, MEMBERS);
    expect(rows.map((row) => row.label)).toEqual(["seyi (you)", "@supa-leads"]);
    // Not "kola" — this console does not know who is in the group, and
    // guessing is the overstatement the whole privacy vocabulary forbids.
    expect(rows.map((row) => row.label)).not.toContain("kola");
    expect(rows[1].role).toBe("group");
  });

  test("every row is keyed uniquely, including the group row", () => {
    const rows = accessRows("@supa-leads", true, MEMBERS);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});

describe("the summary line", () => {
  test("names the group instead of calling it private", () => {
    expect(accessSummary("@supa-leads", true)).toContain("@supa-leads");
    expect(accessSummary("@supa-leads", true)).not.toMatch(/\bprivate\b/i);
  });

  test("says where the rule came from, which is the half a list cannot show", () => {
    expect(accessSummary("team", false)).toMatch(/inherited from its folder/);
    expect(accessSummary("team", true)).toMatch(/set on this note/);
  });

  test("the two tiers read as themselves", () => {
    expect(accessSummary("team", false)).toMatch(/Everyone in this workspace/);
    expect(accessSummary("private", false)).toMatch(/Only owners/);
  });
});

describe("not loaded is not empty", () => {
  /**
   * The rule `privacy/map.ts` states for its own rows. An empty list under
   * "PEOPLE WITH ACCESS" is a claim — "nobody can read this" — and it is the
   * wrong one to make about a team-readable note whose membership has not
   * landed yet. No rows, and the summary line carries the truth meanwhile.
   */
  test("a membership still in flight draws no rows rather than an empty context", () => {
    expect(accessRows("team", false, undefined)).toEqual([]);
    expect(accessRows("private", false, undefined)).toEqual([]);
    // The summary is unaffected, because it does not depend on the list.
    expect(accessSummary("team", false)).toMatch(/Everyone in this workspace/);
  });

  test("an actually-empty membership is still empty, so the two are not conflated", () => {
    expect(accessRows("team", false, [])).toEqual([]);
  });
});

/**
 * ## What a row can actually DO, which is the part the dialog was missing
 *
 * Every row under "PEOPLE WITH ACCESS" was a label, a role and a reason —
 * three strings, rendered as three pieces of text, with no control anywhere on
 * them. So the sheet diagnosed ("the folder it is in is shared with the
 * workspace") and left the owner to work out that the sentence meant the cure
 * was a folder rule, in Settings, under Privacy.
 *
 * ## The constraint that decides the whole design
 *
 * **`team` means every member, so one person cannot be peeled off a
 * team-visible note.** There is no per-note role and no per-person exception —
 * `privacy.md` holds folder defaults and exact-note overrides, and an override
 * is still one of the two tiers or a group. Taking access away from one person
 * therefore has exactly two honest routes, and they are very different sizes:
 *
 *  - **Narrow the note.** An exact-note `private` rule takes it back from
 *    everyone but owners. Per-note, reversible, and the one most people mean.
 *  - **Remove them from the workspace.** `removeMember`, which closes every
 *    note and every folder at once. Real, owner-only, and emphatically not a
 *    per-note action.
 *
 * A sheet that offered a bare "Remove" next to one person's name and then did
 * either of those would be lying about its blast radius. So the row carries
 * *routes*, each saying what it actually reaches, and the dialog makes the
 * person choose.
 */
describe("what can be done about a row", () => {
  test("an owner row offers nothing — the server refuses it anyway", () => {
    const rows = accessRows("team", false, MEMBERS);
    expect(rows[0].role).toBe("owner");
    expect(rows[0].removal).toEqual([]);
  });

  test("a member on a team note gets both routes, narrowest first", () => {
    const rows = accessRows("team", false, MEMBERS);
    const kola = rows[1];
    expect(kola.removal.map((route) => route.id)).toEqual([
      "note-private",
      "workspace-remove",
    ]);
  });

  /**
   * The blast radius is the reason these are two routes rather than one
   * button, so it has to be in the words, not only in the handler.
   */
  test("each route says how far it reaches", () => {
    const [narrow, wide] = accessRows("team", false, MEMBERS)[1].removal;
    expect(narrow.label).toMatch(/this note/i);
    expect(narrow.detail).toMatch(/everyone except|owners/i);
    expect(wide.detail).toMatch(/every note|whole|entire|all/i);
    expect(wide.danger).toBe(true);
    expect(narrow.danger).toBe(false);
  });

  /**
   * Nothing changes when the note already carries its own rule — an exact-note
   * exception is still narrowed to `private` the same way. What changes is the
   * reason above it, which `accessRows` already got right.
   */
  test("an exact-note rule offers the same routes as an inherited one", () => {
    const inherited = accessRows("team", false, MEMBERS)[1].removal;
    const exact = accessRows("team", true, MEMBERS)[1].removal;
    expect(exact.map((r) => r.id)).toEqual(inherited.map((r) => r.id));
  });

  /**
   * A group rule is the one case where the console genuinely cannot act: it
   * does not know who is in the group — `access.ts` opens by refusing to guess
   * — so the only honest verb points at where that is decided.
   */
  test("a group row sends you where its membership actually lives", () => {
    const rows = accessRows("@supa-leads", true, MEMBERS);
    const group = rows.find((row) => row.role === "group")!;
    expect(group.removal.map((route) => route.id)).toEqual(["manage-group"]);
  });

  test("owners on a private note have nothing to remove either", () => {
    const rows = accessRows("private", false, MEMBERS);
    expect(rows.every((row) => row.removal.length === 0)).toBe(true);
  });
});

/**
 * ## Dispatching a route
 *
 * Two call sites render this dialog — the pane and the frame's share button —
 * and both have to turn a chosen route into the right mutation. Doing that
 * twice is how the narrow route and the wide one end up swapped on one of
 * them, so the mapping lives here and both read it.
 *
 * The handler is **absent as a whole object** when the caller can do none of
 * it, which is the rule the dialog then relies on to draw no control at all.
 */
describe("turning a chosen route into an action", () => {
  const row = { key: "u2", label: "kola", role: "editor", reason: "", isMe: false, removal: [] };

  test("narrowing the note is a visibility change on that path, nothing else", () => {
    const calls: string[] = [];
    const handle = removalHandler({
      path: "1-projects/foo.md",
      setPrivate: (path) => calls.push(`private:${path}`),
      removeMember: (userId) => calls.push(`remove:${userId}`),
    })!;
    handle({ id: "note-private", label: "", detail: "", danger: false }, row);
    expect(calls).toEqual(["private:1-projects/foo.md"]);
  });

  test("removing from the context names the person, not the path", () => {
    const calls: string[] = [];
    const handle = removalHandler({
      path: "1-projects/foo.md",
      setPrivate: (path) => calls.push(`private:${path}`),
      removeMember: (userId) => calls.push(`remove:${userId}`),
    })!;
    handle({ id: "workspace-remove", label: "", detail: "", danger: true }, row);
    expect(calls).toEqual(["remove:u2"]);
  });

  /**
   * The group row's key is the visibility string (`@supa-leads`), never a user
   * id — so a dispatcher that fed it to `removeMember` would be handing the
   * control plane a group name where a person belongs.
   */
  test("a group route never reaches removeMember", () => {
    const calls: string[] = [];
    const handle = removalHandler({
      path: "p.md",
      setPrivate: () => calls.push("private"),
      removeMember: (userId) => calls.push(`remove:${userId}`),
      openGroups: () => calls.push("groups"),
    })!;
    handle({ id: "manage-group", label: "", detail: "", danger: false }, {
      ...row,
      key: "@supa-leads",
      role: "group",
    });
    expect(calls).toEqual(["groups"]);
  });

  test("no handler at all when the caller can do none of it", () => {
    expect(removalHandler({ path: "p.md" })).toBeUndefined();
  });

  /**
   * A route the caller cannot perform does nothing rather than throwing — the
   * dialog only offers routes it was given handlers for, but a row built from
   * a future rule must not be able to crash the sheet.
   */
  test("a route with no handler behind it is inert", () => {
    const handle = removalHandler({ path: "p.md", setPrivate: () => {} })!;
    expect(() =>
      handle({ id: "workspace-remove", label: "", detail: "", danger: true }, row),
    ).not.toThrow();
  });
});
