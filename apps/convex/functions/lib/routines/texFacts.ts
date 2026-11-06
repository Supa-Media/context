/**
 * A Tex routine's front matter, read where its text lives.
 *
 * The routine scan takes each schedule from the note's facts: the workspace object's first, else the control
 * plane's own copy (`sync.ts` `scanRoutines`). Neither has them for Tex's own notes once the workspace's notes live
 * in its object. Tex's notes keep their text in Tex's tables (`tex/<owner>/notes/<id>.md`,
 * `docs/decisions/texting-assistant/tex-durable-objects.md`), which the workspace object's facts never read, and
 * the control plane stopped keeping facts for such a workspace (#2714, `facts-in-objects.md`). From 2026-11-02 every
 * new or changed Tex routine waited forever: a reminder Tex had set never ran, and a changed one kept its old time.
 *
 * So a routine whose facts nobody holds, and whose row keys it in a Tex object, is read there, through the
 * gateway's door with a ticket for this workspace's own objects (`lib/texStore.ts`), and parsed with the same
 * `propsOf` the facts are. Only its props are kept, exactly what the facts would have held; the text is dropped.
 * A read that fails leaves the routine waiting, as before, for the next scan.
 */

import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { isTexKey } from "../../../../mcp/src/privacy/engine.js";
import { splitTexKey } from "../../../../mcp/src/store/texRouting.js";
import { propsOf } from "../../../../mcp/src/tree/props.js";
import { consoleTexBuckets } from "../texStore";

type Options = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

/** Props read from Tex's objects for the notes asked, by path: `sealed` when the text is encrypted, as the facts say it. */
export async function texPropsAt(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  notes: ReadonlyArray<{ path: string; key: string | null }>,
  options: Options = {},
): Promise<Map<string, { sealed: boolean; props: string | null }>> {
  const found = new Map<string, { sealed: boolean; props: string | null }>();
  const wanted: { path: string; owner: string; key: string }[] = [];
  for (const note of notes) {
    if (!isTexKey(note.key)) continue;
    const split = splitTexKey(note.key) as { owner: string; key: string } | null;
    if (split !== null) wanted.push({ path: note.path, ...split });
  }
  if (wanted.length === 0) return found;
  const owners = [...new Set(wanted.map((note) => note.owner))];
  const bucketFor = consoleTexBuckets(ctx, workspaceId, { ...options, ticketOwners: owners });
  if (bucketFor === null) return found;
  for (const note of wanted) {
    try {
      const object = await bucketFor(note.owner).get(note.key);
      if (object === null || object === undefined) continue;
      const props = propsOf(await object.text());
      found.set(note.path, { sealed: props === null, props: props === null ? null : JSON.stringify(props) });
    } catch {
      // Unreachable this time: the routine waits for the next scan, as one whose facts are behind does.
    }
  }
  return found;
}
