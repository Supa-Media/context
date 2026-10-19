/**
 * Parity between the two row renderers: `lib/nodes/rowAccess.ts` (the control
 * plane) and `apps/mcp/src/privacy/rowAccess.js` (the gateway port, which will
 * decide what an AI client sees). Both feed an engine, so a disagreement is a
 * visibility disagreement: the console shows a note the gateway hides, or the
 * reverse, and nothing throws.
 *
 * Each row set is rendered by both ports for each audience, and both engines
 * answer `canSee` over the same probe paths for four callers. Every answer must
 * match, and the granted names must match after the TS clearance layer
 * normalises them.
 *
 * Sabotage: make the JS `accessNamesFor` hand a folder grant to every
 * descendant's token (a list merging into its ancestor's) and the parity
 * tests on the folder-list and nested-list shapes fail here. Drop the
 * `accounts` case from the JS `accessNamesFor` and "the pinned workspace ...:
 * pin reader" fails; let the JS `canSee` answer `team` for the guest mark and
 * "the guest mark shuts team in both engines" fails.
 */

import { describe, expect, test } from "vitest";
import { READS_AS_GUEST, canSee as tsCanSee, type Scope } from "../../functions/lib/privacy";
import { clearanceOf } from "../../functions/lib/clearance";
import {
  accessNamesFor as tsAccessNamesFor,
  renderAccess as tsRenderAccess,
  type AccessRow,
  type Audience,
  type Caller,
} from "../../functions/lib/nodes/rowAccess";
import { canSee as jsCanSee } from "../../../mcp/src/privacy/engine.js";
import {
  accessNamesFor as jsAccessNamesFor,
  renderAccess as jsRenderAccess,
} from "../../../mcp/src/privacy/rowAccess.js";

const ID = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const FOLDER_HR = ID(1);
const NOTE_PAY = ID(2);
const NOTE_TEAM = ID(3);
const FOLDER_CLIENTS = ID(4);
const NOTE_BOB = ID(5);
const NOTE_ACME = ID(6);
const NOTE_TWIN = ID(7);
const FOLDER_ROOT_TEAM = ID(8);
const NOTE_DEAL = ID(9);
const FOLDER_DEEP = ID(10);
const NOTE_DEEP = ID(11);
const FOLDER_GUIDES = ID(12);
const NOTE_MEMBERS = ID(13);

const user = (id: string, role: "view" | "edit" = "view") => ({ kind: "user" as const, id, role });
const email = (id: string, role: "view" | "edit" = "view") => ({ kind: "email" as const, id, role });
const group = (id: string, role: "view" | "edit" = "view") => ({ kind: "group" as const, id, role });

/** Row sets, each named for the shape it pins. */
const ROW_SETS: Record<string, AccessRow[]> = {
  "empty (everything inherits the root private default)": [],
  "team folder with a private note and a team note": [
    { path: "1-projects", noteId: FOLDER_ROOT_TEAM, kind: "folder", base: "team", grantees: [] },
    { path: "1-projects/salary.md", noteId: NOTE_PAY, kind: "file", base: "private", grantees: [] },
    { path: "1-projects/roadmap.md", noteId: NOTE_TEAM, kind: "file", base: "team", grantees: [] },
  ],
  "private folder with a team note inside": [
    { path: "2-areas/hr", noteId: FOLDER_HR, kind: "folder", base: "private", grantees: [] },
    { path: "2-areas/hr/policy.md", noteId: NOTE_TEAM, kind: "file", base: "team", grantees: [] },
  ],
  "folder list, and a note list that replaces it": [
    {
      path: "2-areas/clients",
      noteId: FOLDER_CLIENTS,
      kind: "folder",
      base: "private",
      grantees: [user("user-kola")],
    },
    { path: "2-areas/clients/acme.md", noteId: NOTE_ACME, kind: "file", base: "private", grantees: [user("user-ana")] },
    { path: "2-areas/clients/bob.md", noteId: NOTE_BOB, kind: "file", base: "team", grantees: [] },
  ],
  "nested lists: a deep folder list under a listed folder": [
    {
      path: "2-areas/clients",
      noteId: FOLDER_CLIENTS,
      kind: "folder",
      base: "private",
      grantees: [user("user-kola")],
    },
    {
      path: "2-areas/clients/acme/deep",
      noteId: FOLDER_DEEP,
      kind: "folder",
      base: "private",
      grantees: [user("user-ana")],
    },
    { path: "2-areas/clients/acme/deep/plan.md", noteId: NOTE_DEEP, kind: "file", base: "private", grantees: [] },
  ],
  "a private subfolder inside a listed folder": [
    {
      path: "2-areas/clients",
      noteId: FOLDER_CLIENTS,
      kind: "folder",
      base: "private",
      grantees: [user("user-kola")],
    },
    { path: "2-areas/clients/internal", noteId: FOLDER_DEEP, kind: "folder", base: "private", grantees: [] },
  ],
  "case-fold twins: a listed note whose casing differs from a probe": [
    { path: "2-areas/clients", noteId: FOLDER_CLIENTS, kind: "folder", base: "team", grantees: [] },
    { path: "2-areas/clients/Acme.md", noteId: NOTE_TWIN, kind: "file", base: "private", grantees: [user("user-ana")] },
  ],
  "email and group grants, with an edit grant": [
    {
      path: "2-areas/deal.md",
      noteId: NOTE_DEAL,
      kind: "file",
      base: "private",
      grantees: [email("Partner@Example.test", "edit"), group("supa-leads")],
    },
    { path: "2-areas/hr", noteId: FOLDER_HR, kind: "folder", base: "team", grantees: [] },
  ],
  "a note open to every member, in a private folder": [
    { path: "2-areas/hr", noteId: FOLDER_HR, kind: "folder", base: "private", grantees: [] },
    { path: "2-areas/hr/bug.md", noteId: NOTE_DEAL, kind: "file", base: "private", grantees: [{ kind: "members", id: "members", role: "view" }] },
  ],
  "the pinned workspace: a folder open to every account, and a team note inside it that is not": [
    { path: "guides", noteId: FOLDER_GUIDES, kind: "folder", base: "team", grantees: [{ kind: "accounts", id: "accounts", role: "view" }] },
    { path: "guides/members.md", noteId: NOTE_MEMBERS, kind: "file", base: "team", grantees: [] },
  ],
};

interface Who {
  name: string;
  audience: Audience;
  scope: Scope;
  caller: Caller;
}

const CALLERS: Who[] = [
  { name: "owner", audience: "member", scope: "private", caller: { userId: "user-owner" } },
  { name: "member", audience: "member", scope: "team", caller: { userId: "user-member", member: true } },
  {
    name: "listed member",
    audience: "member",
    scope: "team",
    caller: { userId: "user-ana", emails: ["ANA@example.test"], groupIds: ["supa-leads"] },
  },
  {
    name: "guest",
    audience: "guest",
    scope: "team",
    caller: { userId: "user-kola", emails: ["Partner@Example.test"] },
  },
  // Somebody reaching the pinned workspace through the pin alone (`lib/pinnedReaders.ts`).
  { name: "pin reader", audience: "guest", scope: "team", caller: { userId: "user-sayo", account: true } },
];

const PROBES = [
  "index.md",
  "privacy.md",
  ".history/x.md",
  "1-projects/salary.md",
  "1-projects/roadmap.md",
  "1-projects/new.md",
  "2-areas/hr/policy.md",
  "2-areas/hr/other.md",
  "2-areas/clients",
  "2-areas/clients/acme.md",
  "2-areas/clients/Acme.md",
  "2-areas/clients/bob.md",
  "2-areas/clients/notes/x.md",
  "2-areas/clients/acme/deep/plan.md",
  "2-areas/clients/acme/other.md",
  "2-areas/clients/internal/secret.md",
  "2-areas/clients-old/x.md",
  "2-areas/deal.md",
  "2-areas/other/x.md",
  "guides/start.md",
  "guides/members.md",
];

describe("the gateway's row renderer agrees with the control plane's", () => {
  for (const [shape, rows] of Object.entries(ROW_SETS)) {
    for (const who of CALLERS) {
      test(`${shape}: ${who.name}`, () => {
        const tsRender = tsRenderAccess(rows, who.audience);
        const jsRender = jsRenderAccess(rows, who.audience);

        const tsNames = tsAccessNamesFor(who.caller, rows);
        const jsNames = jsAccessNamesFor(who.caller, rows);
        const clearance = clearanceOf(who.scope, tsNames);
        expect(jsNames).toEqual([...clearance.names].sort());
        const granted = new Set(jsNames);

        for (const probe of PROBES) {
          const ts = tsCanSee(probe, who.scope, tsRender.rules, tsRender.overrides, clearance.names);
          const js = jsCanSee(probe, who.scope, jsRender.rules, jsRender.overrides, granted);
          expect(js, `${probe} for ${who.name}`).toBe(ts);
        }
      });
    }
  }
});

describe("the guest mark (`READS_AS_GUEST`)", () => {
  test("shuts team in both engines, even under a member's rules", () => {
    const rows = ROW_SETS["the pinned workspace: a folder open to every account, and a team note inside it that is not"];
    const ts = tsRenderAccess(rows, "member");
    const js = jsRenderAccess(rows, "member");
    for (const probe of ["guides/start.md", "guides/members.md"]) {
      expect(tsCanSee(probe, "team", ts.rules, ts.overrides, new Set([READS_AS_GUEST]))).toBe(false);
      expect(jsCanSee(probe, "team", js.rules, js.overrides, new Set([READS_AS_GUEST]))).toBe(false);
      // Without it, a member's rules open both: the mark is what closes them.
      expect(tsCanSee(probe, "team", ts.rules, ts.overrides, new Set())).toBe(true);
      expect(jsCanSee(probe, "team", js.rules, js.overrides, new Set())).toBe(true);
    }
  });

  test("a pin reader holds the folder open to every account, and not the team note inside it", () => {
    const rows = ROW_SETS["the pinned workspace: a folder open to every account, and a team note inside it that is not"];
    const guest = jsRenderAccess(rows, "guest");
    const names = new Set([READS_AS_GUEST, ...jsAccessNamesFor({ account: true }, rows)]);
    expect(jsCanSee("guides/start.md", "team", guest.rules, guest.overrides, names)).toBe(true);
    expect(jsCanSee("guides/members.md", "team", guest.rules, guest.overrides, names)).toBe(false);
    // A real member reads both.
    const member = jsRenderAccess(rows, "member");
    expect(jsCanSee("guides/members.md", "team", member.rules, member.overrides, new Set())).toBe(true);
  });
});

describe("the parity table is not vacuous", () => {
  test("every shape shows something to someone and hides something from someone", () => {
    for (const [shape, rows] of Object.entries(ROW_SETS)) {
      const answers: boolean[] = [];
      for (const who of CALLERS) {
        const render = jsRenderAccess(rows, who.audience);
        const granted = new Set(jsAccessNamesFor(who.caller, rows));
        for (const probe of PROBES) {
          answers.push(jsCanSee(probe, who.scope, render.rules, render.overrides, granted));
        }
      }
      if (rows.length === 0) continue;
      expect(answers.includes(true), `${shape}: nothing visible`).toBe(true);
      expect(answers.includes(false), `${shape}: nothing hidden`).toBe(true);
    }
  });

  test("the case-fold twin is held by its lister and not by a member", () => {
    const rows = ROW_SETS["case-fold twins: a listed note whose casing differs from a probe"];
    const member = jsRenderAccess(rows, "member");
    const names = new Set(jsAccessNamesFor({ userId: "user-ana" }, rows));
    expect(jsCanSee("2-areas/clients/acme.md", "team", member.rules, member.overrides, new Set())).toBe(false);
    expect(jsCanSee("2-areas/clients/Acme.md", "team", member.rules, member.overrides, names)).toBe(true);
  });
});
