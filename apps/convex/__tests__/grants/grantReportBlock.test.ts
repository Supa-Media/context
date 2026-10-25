/**
 * Report and block on a note shared with you by name (a grant), from @shared.
 *
 *  1. **A grant is reported by its workspace and note id**, resolved through
 *     `outsiderGrantsFor`, the same re-derivation @shared lists it with. The
 *     report carries ids only: never the path, the title or the body.
 *  2. **A report is never an oracle.** A grant the caller does not hold, a
 *     note id from another workspace and a made-up id all get the same receipt;
 *     only the team learns whether it resolved.
 *  3. **Blocking the person who granted it takes their grant away from the
 *     blocker**: the row leaves @shared and refuses to open, with the one
 *     refusal every other closed grant gets. A grant someone else also wrote
 *     keeps the note open. Unblocking restores it. Nothing is deleted.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop `blockedGrantNames` from `guestViewOf`: "report and block takes the
 *    granter's note out of @shared" and "and it no longer opens" fail;
 *  - keep a row if any grant on it is blocked (`&&` for `||` in the per-row
 *    fold): "a note someone else also granted stays open" fails;
 *  - resolve a grant target without `outsiderGrantsFor` (any note id in the
 *    workspace): "a note id the caller holds no grant on" fails.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { asUser, captureError, errorCode } from "../fixtures.helpers";
import { noteIdOf, PLAN, PLAN_MARKER, readByNoteId, refusalOf, SALARIES, setListFor, world, type World } from "./outsider.helpers";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

vi.setConfig({ testTimeout: 30_000 });

const DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.example.invalid/42";

let sent: string[] = [];
let clientIds = 0;
function clientId(): string {
  clientIds += 1;
  return clientIds.toString(16).padStart(24, "0");
}

beforeEach(() => {
  sent = [];
  process.env.FEEDBACK_SENTRY_DSN = DSN;
  delete process.env.FEEDBACK_INTAKE;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FEEDBACK_SENTRY_DSN;
});

/** The world's bucket stub answers storage; the report's post is caught here. */
async function reportingWorld(): Promise<World> {
  const w = await world();
  const storage = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit & { body: Uint8Array }) => {
    if (!String(url).includes("ingest.example.invalid")) return storage(url, init);
    sent.push(new TextDecoder().decode(new Uint8Array(init.body)));
    return new Response("{}", { status: 200 });
  });
  return w;
}

function reportGrant(w: World, who: Id<"users">, workspaceId: string, noteId: string, alsoBlock = false) {
  return asUser(w.t, who).action(api.functions.reports.submitReport, {
    clientReportId: clientId(),
    target: { kind: "grant", workspaceId, noteId },
    reason: "harassment",
    alsoBlock,
  });
}

async function grantRows(w: World, who: Id<"users">) {
  const rows = (await asUser(w.t, who).query(api.functions.shares.listSharedWithMe, {})) as unknown as {
    kind: string;
    entryPath: string;
  }[];
  return rows.filter((row) => row.kind === "grant");
}

describe("a grant is reported by its note id", () => {
  test("the report resolves, names the granter, and carries no path, title or body", async () => {
    const w = await reportingWorld();
    await setListFor(w, PLAN, [{ kind: "user", userId: w.kola, role: "view" }]);
    const noteId = await noteIdOf(w, PLAN);

    await reportGrant(w, w.kola, w.ws, noteId);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"resolved":"yes"');
    expect(sent[0]).toContain(noteId);
    expect(sent[0]).toContain(w.owner);
    expect(sent[0]).not.toContain(PLAN);
    expect(sent[0]).not.toContain("plan.md");
    expect(sent[0]).not.toContain(PLAN_MARKER);
    const rows = await w.t.run((ctx) => ctx.db.query("contentReports").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "grant", resolved: true, ids: { workspaceId: w.ws, noteId, personId: w.owner } });
  });

  test("a note id the caller holds no grant on, one from another workspace and a made-up one get the same receipt", async () => {
    const w = await reportingWorld();
    await setListFor(w, PLAN, [{ kind: "user", userId: w.kola, role: "view" }]);
    const ungranted = await noteIdOf(w, SALARIES);
    const elsewhere = await noteIdOf(w, PLAN, w.beta);

    const receipts = [
      await reportGrant(w, w.kola, w.ws, ungranted),
      await reportGrant(w, w.kola, w.beta, elsewhere),
      await reportGrant(w, w.kola, w.ws, "not-a-note-id"),
      await reportGrant(w, w.kola, "not-a-workspace-id", "not-a-note-id"),
    ];
    for (const receipt of receipts) expect(Object.keys(receipt)).toEqual(["eventId"]);
    expect(sent).toHaveLength(4);
    for (const body of sent) expect(body).toContain('"resolved":"no"');
    // A member reporting a note the members can read is not an outsider's grant either.
    await reportGrant(w, w.bob, w.ws, await noteIdOf(w, PLAN));
    expect(sent[4]).toContain('"resolved":"no"');
  });
});

describe("blocking the granter takes their grant away from the blocker", () => {
  test("report and block takes the granter's note out of @shared, and it no longer opens", async () => {
    const w = await reportingWorld();
    await setListFor(w, PLAN, [{ kind: "user", userId: w.kola, role: "view" }]);
    const noteId = await noteIdOf(w, PLAN);
    expect(await grantRows(w, w.kola)).toHaveLength(1);
    expect(JSON.stringify(await readByNoteId(w, w.kola, noteId))).toContain(PLAN_MARKER);

    await reportGrant(w, w.kola, w.ws, noteId, true);

    expect(await grantRows(w, w.kola)).toHaveLength(0);
    const blocked = await captureError(() => readByNoteId(w, w.kola, noteId));
    const ungranted = await noteIdOf(w, SALARIES);
    const never = await captureError(() => readByNoteId(w, w.kola, ungranted));
    expect(errorCode(blocked)).toBe("SHARE_UNAVAILABLE");
    // The same refusal a note that was never granted gets.
    expect(refusalOf(blocked)).toBe(refusalOf(never));
    // Nothing is deleted: the grant row is still the owner's.
    const grants = await w.t.run((ctx) => ctx.db.query("nodeAccess").collect());
    expect(grants.some((grant) => grant.granteeUserId === w.kola)).toBe(true);
  });

  test("unblocking restores it", async () => {
    const w = await reportingWorld();
    await setListFor(w, PLAN, [{ kind: "user", userId: w.kola, role: "view" }]);
    const noteId = await noteIdOf(w, PLAN);
    await reportGrant(w, w.kola, w.ws, noteId, true);
    expect(await grantRows(w, w.kola)).toHaveLength(0);

    await asUser(w.t, w.kola).mutation(api.functions.blocks.unblockPerson, { userId: w.owner });

    expect(await grantRows(w, w.kola)).toHaveLength(1);
    expect(JSON.stringify(await readByNoteId(w, w.kola, noteId))).toContain(PLAN_MARKER);
  });

  test("a note someone else also granted stays open", async () => {
    const w = await reportingWorld();
    await setListFor(w, PLAN, [{ kind: "user", userId: w.kola, role: "view" }]);
    const noteId = await noteIdOf(w, PLAN);
    // A second grant on the same row, written by a person Kola has not blocked.
    const node = await w.t.run(async (ctx) => treeNodeAt(ctx.db, w.ws, PLAN));
    await w.t.run((ctx) =>
      ctx.db.insert("nodeAccess", {
        workspaceId: w.ws,
        nodeId: node!._id,
        granteeKind: "user",
        granteeUserId: w.kola,
        role: "view",
        grantedBy: w.bob,
        at: Date.now(),
        source: "owner",
      }),
    );

    await reportGrant(w, w.kola, w.ws, noteId, true);

    expect(JSON.stringify(await readByNoteId(w, w.kola, noteId))).toContain(PLAN_MARKER);
  });

  test("a block by someone else changes nothing for the outsider", async () => {
    const w = await reportingWorld();
    await setListFor(w, PLAN, [
      { kind: "user", userId: w.kola, role: "view" },
      { kind: "user", userId: w.carol, role: "view" },
    ]);
    const noteId = await noteIdOf(w, PLAN);
    await reportGrant(w, w.carol, w.ws, noteId, true);

    expect(await grantRows(w, w.carol)).toHaveLength(0);
    expect(await grantRows(w, w.kola)).toHaveLength(1);
  });
});
