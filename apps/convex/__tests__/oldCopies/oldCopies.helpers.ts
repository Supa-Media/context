/**
 * A keyed personal workspace holding what the mail, calendar, chat and
 * iMessage passes used to copy into it, beside notes of the person's own, for
 * the old-copies checks (`functions/oldCopies.ts`).
 */

import { internal } from "../../_generated/api";
import { runNodesOperation } from "../../functions/lib/nodes/run";
import { hideOldCopiesPass } from "../../functions/lib/oldCopies/hiding";
import { fixture, type Fixture } from "../nodes/moveFixture.helpers";
import { rowOf } from "../nodes/keyedFixture.helpers";

const day = (origin: string, date: string) =>
  `---\ntype: "channel-day"\nchannel: "email"\ndate: "${date}"\norigin: "${origin}"\n---\n\n# ${date}\n\nA stranger's words.\n`;

const contact = (notes: string) =>
  `---\ntype: "contact"\nname: "Ana"\n---\n\n# Ana\n\n## Identifiers\n\n- email: ana@example.test\n\n## Activity\n\n### 2026-09\n\n- 2026-09-07 · email — hello\n\n## Notes\n\n${notes}\n`;

/** Every object the fixture adds, by path. */
export const SEEDED: Record<string, string> = {
  "0-inbox/email/me/2026/09/2026-09-07.md": day("gmail-sync", "2026-09-07"),
  "0-inbox/email/me/2026/10/2026-10-20.md": day("gmail-sync", "2026-10-20"),
  "0-inbox/email/me/attachments/2026/09/07/abc-invoice.pdf": "pdf bytes",
  "0-inbox/email/me/my-own-filing.md": "# Things I filed by hand\n",
  "0-inbox/calendar/me/2026/09/2026-09-08.md": day("calendar-sync", "2026-09-08"),
  "0-inbox/imessage/2026/09/2026-09-01.md": day("desktop-imessage-sync", "2026-09-01"),
  "0-inbox/contacts/a/ana.md": contact(""),
  "0-inbox/contacts/b/bo.md": contact("Met at the conference; likes jazz."),
  "1-projects/2026-09-07.md": "# A note of mine named for a day\n",
  "1-projects/report.pdf": "pdf of mine",
};

/** The copies among them, and what the page counts each as. */
export const COPIES = {
  days: ["0-inbox/email/me/2026/09/2026-09-07.md", "0-inbox/email/me/2026/10/2026-10-20.md", "0-inbox/calendar/me/2026/09/2026-09-08.md", "0-inbox/imessage/2026/09/2026-09-01.md"],
  contacts: ["0-inbox/contacts/a/ana.md"],
  files: ["0-inbox/email/me/attachments/2026/09/07/abc-invoice.pdf"],
};

export const OWN = ["0-inbox/email/me/my-own-filing.md", "0-inbox/contacts/b/bo.md", "1-projects/2026-09-07.md", "1-projects/report.pdf"];

export async function copiesFixture(): Promise<Fixture> {
  const f = await fixture();
  for (const [path, text] of Object.entries(SEEDED)) f.store.seed(path, text);
  await runNodesOperation(f.ctx, { workspaceId: f.ws, scope: "private", operation: { kind: "nodesSweep" } }, f.store);
  await f.t.run(async (ctx) => {
    await ctx.db.patch(f.ws, { kind: "personal" });
    await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1 });
    await ctx.db.insert("noteIdCopies", { workspaceId: f.ws, status: "done", runId: 1, files: 0, copied: 0, failed: 0, failures: [], updatedAt: 1, keyedAt: 1 });
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect();
    for (const row of rows) {
      if (row.kind !== "file" || row.noteId === undefined) continue;
      await ctx.db.patch(row._id, { storageKey: `notes/${row.noteId}.md` });
    }
  });
  for (const [path, text] of Object.entries(SEEDED)) f.store.seed((await rowOf(f, path)).storageKey as string, text);
  // One day the facts fill read: its front matter decides it without opening the note.
  const read = await rowOf(f, COPIES.days[0]);
  await f.t.run(async (ctx) => {
    await ctx.db.patch(read._id, { parsed: read.etag, props: JSON.stringify({ properties: { origin: "gmail-sync" } }) });
  });
  return f;
}

/** Every pass, as `hideWorkspace` makes them, until the end; answers the summed pass. */
export async function hideAll(f: Fixture) {
  let cursor: string | null = null;
  const total = { days: 0, contacts: 0, files: 0 };
  for (let pass = 0; pass < 50; pass += 1) {
    const begun = await f.t.mutation(internal.functions.oldCopies.beginPass, { workspaceId: f.ws, now: Date.now() });
    if (begun === false) return total;
    cursor = begun;
    const made = await hideOldCopiesPass(f.ctx, f.ws, f.store, null, cursor);
    total.days += made.days;
    total.contacts += made.contacts;
    total.files += made.files;
    await f.t.mutation(internal.functions.oldCopies.recordPass, {
      workspaceId: f.ws,
      cursor: made.cursor,
      stopped: made.stopped !== undefined,
      days: made.days,
      contacts: made.contacts,
      files: made.files,
      ...(made.firstDay === undefined ? {} : { firstDay: made.firstDay }),
      ...(made.lastDay === undefined ? {} : { lastDay: made.lastDay }),
      now: Date.now(),
    });
    if (made.stopped !== undefined) return total;
  }
  throw new Error("the passes did not finish");
}
