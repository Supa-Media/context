/**
 * Old copies where the notes live in their workspace object (`lib/oldCopies/hiding.ts`, `decidedByObject`): the
 * object says what each note's front matter is, read at its current text, and the control plane's copy of the
 * facts is not consulted (`docs/decisions/storage-and-credentials/facts-in-objects.md`).
 *
 * Sabotage (temporary local edits, reverted): passing `everyNote` never leaves the person's day-named note decided
 * by the control plane's stale copy, so it is hidden; dropping the object's props reads the mail day with an
 * ordinary name as the person's, so it stays.
 */

import { describe, expect, test, vi } from "vitest";
import { propsOf } from "../../../mcp/src/tree/props.js";
import { liveAt, rowOf } from "../nodes/keyedFixture.helpers";
import { COPIES, OWN, SEEDED, copiesFixture, hideAll } from "./oldCopies.helpers";
import { decidedByObject } from "../../functions/lib/oldCopies/hiding";
import type { FactRows } from "../../functions/lib/nodes/objectFacts";

/** The object, as `ws.facts.rows` answers a props ask: each note's props read from its text now. */
const texts: Record<string, string> = { ...SEEDED };
const objectRows: FactRows = async (request) => ({
  served: true,
  props: (request.paths ?? []).filter((path) => path in texts).map((path) => {
    const props = propsOf(texts[path]);
    return { path, version: "o", sealed: props === null, props: props === null ? null : JSON.stringify(props) };
  }),
});

vi.mock("../../functions/lib/nodes/objectFacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../functions/lib/nodes/objectFacts")>()),
  objectFactRows: async () => objectRows,
}));

describe("hiding old copies from the workspace object's facts", () => {
  test("the object's front matter decides, and the control plane's copy is not read", async () => {
    // A mail day under an ordinary name: only its front matter says it is a copy.
    const renamed = "0-inbox/email/me/kept-thread.md";
    texts[renamed] = SEEDED[COPIES.days[0]];
    const f = await copiesFixture();
    f.store.seed(renamed, texts[renamed]);
    const { seedTreeFromStore } = await import("../fixtures.helpers");
    await seedTreeFromStore(f.t, f.ws, f.store);
    // The control plane's copy says the person's own note is a copied day: stale, and never asked.
    const own = await rowOf(f, OWN[0]);
    await f.t.run(async (ctx) => {
      await ctx.db.patch(own._id, { parsed: own.etag, props: JSON.stringify({ properties: { origin: "gmail-sync" } }) });
    });

    const counted = await hideAll(f);

    expect(counted.days).toBe(COPIES.days.length + 1);
    expect(await liveAt(f, renamed)).toBe(false);
    for (const path of OWN) expect(await liveAt(f, path)).toBe(true);
  });

  test("a note the object does not answer for is decided by its name, as a row with no facts is", async () => {
    const silent: FactRows = async () => ({ served: false });
    const rows = await decidedByObject(silent, [
      { path: "0-inbox/email/me/2026/09/2026-09-07.md", verdict: "facts" },
      { path: "0-inbox/contacts/a/ana.md", verdict: "facts" },
      { path: "1-projects/plan.md", verdict: "facts" },
      { path: "0-inbox/email/me/attachments/x.pdf", verdict: "attachment" },
    ]);
    expect(rows.map((row) => [row.path, row.verdict])).toEqual([
      ["0-inbox/email/me/2026/09/2026-09-07.md", "read"],
      ["0-inbox/contacts/a/ana.md", "read"],
      ["0-inbox/email/me/attachments/x.pdf", "attachment"],
    ]);
  });
});
