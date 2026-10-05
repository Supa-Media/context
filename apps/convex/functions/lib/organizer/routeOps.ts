/**
 * "For your teams", inside the credential barrier: the three trips into a
 * TEAM's workspace that sending a note takes, each at the sender's own
 * clearance there.
 *
 *   - `outlineTeam` lists the folders a note could go in: only folders the
 *     whole team reads, so a note sent never lands somewhere private.
 *   - `deliverRoute` writes the new note, create-only, and records it in the
 *     team's Activity under the sender's name.
 *   - `withdrawRoute` is Undo: the note goes to the trash, recoverable.
 *
 * The card itself, and the arrival it came from, stay in the sender's
 * personal workspace (`sweepOps.ts`). The engine is the gateway's
 * `mcp/src/organizer/routes.js`.
 */

import { recordActivity, type ActivityActor } from "../activity";
import type { Clearance } from "../clearance";
import type { FileStore } from "../fileOps";
import { FileOpError } from "../fileOps/errors";
import { trashPath } from "../fileOps/deleting";
import { loadPrivacyState } from "../fileOps/privacyState";
import { writeFile } from "../fileOps/writing";
import { visibilityOf } from "../privacy";
import { planSweep } from "../../../../mcp/src/organizer/plan.js";
import { MAX_ROUTE_BODY, MAX_ROUTE_TITLE, MAX_TEAM_FOLDERS, plainBody, plainTitle, routeFileName, routeNoteText } from "../../../../mcp/src/organizer/routes.js";

/** Tries at a free file name before giving up: `name.md`, `name-2.md`, … */
const NAME_ATTEMPTS = 5;
const SOURCE_KINDS = new Set(["meeting", "messages", "chat", "note"]);

type Entries = { path: string; updatedAt?: number; etag?: string }[];

/** Would a new note in `folder` be read by the whole team? */
function teamReads(folder: string, rules: Parameters<typeof visibilityOf>[1]): boolean {
  return visibilityOf(folder === "" ? "note.md" : `${folder}/note.md`, rules) === "team";
}

/**
 * The folders a note for this team may go in: its projects, areas and
 * resources folders that the whole team reads, then its inbox when it has one.
 */
export async function outlineTeam(store: FileStore, entries: Entries, now: number) {
  const plan = planSweep(entries, now);
  const privacy = await loadPrivacyState(store);
  const folders: { path: string; title: string }[] = [];
  for (const destination of plan.destinations as { path: string; title: string }[]) {
    if (teamReads(destination.path, privacy.rules)) folders.push({ path: destination.path, title: destination.title });
  }
  const inbox = (plan.roots as { inbox?: string | null }).inbox ?? null;
  if (inbox && teamReads(inbox, privacy.rules)) folders.push({ path: inbox, title: "Inbox" });
  return { folders: folders.slice(0, MAX_TEAM_FOLDERS) };
}

function bounded(value: unknown, max: number, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new FileOpError("PATH_INVALID", `That note had no ${what}.`);
  }
  return value;
}

/**
 * Write the team's new note. The folder is checked again here, against the
 * team's own rules as they are now: a card names the folder it was written
 * for, and a folder made private since must not receive it.
 */
export async function deliverRoute(
  store: FileStore,
  clearance: Clearance,
  input: Record<string, unknown>,
  now: number,
  actor: ActivityActor | null,
): Promise<{ path: string }> {
  const title = plainTitle(bounded(input.title, MAX_ROUTE_TITLE * 2, "title"));
  const body = plainBody(bounded(input.body, MAX_ROUTE_BODY * 2, "text"));
  if (title.length < 3 || body.length === 0 || body.length > MAX_ROUTE_BODY) throw new FileOpError("PATH_INVALID", "That note is empty or too long.");
  const folder = typeof input.folder === "string" ? input.folder.replace(/\/+$/, "") : "";
  if (folder.split("/").some((part) => part === ".." || part === "." || part.startsWith(".")) || folder.startsWith("/")) {
    throw new FileOpError("PATH_INVALID", "That folder isn't one a note can go in.");
  }
  const privacy = await loadPrivacyState(store);
  if (!teamReads(folder, privacy.rules)) throw new FileOpError("CONFLICT", "That folder isn't shared with the whole team any more.");
  const kind = typeof input.kind === "string" && SOURCE_KINDS.has(input.kind) ? input.kind : "note";
  const text = routeNoteText({ title, body, kind, owner: actor?.name ?? "" });
  const leaf = routeFileName(title).replace(/\.md$/, "");
  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt += 1) {
    const path = `${folder === "" ? "" : `${folder}/`}${leaf}${attempt === 1 ? "" : `-${attempt}`}.md`;
    try {
      const written = await writeFile(store, { path, text, clearance, now });
      await recordActivity(store, { action: "file.create", paths: [written.path], details: { organizer: "route" }, actor });
      return { path: written.path };
    } catch (thrown) {
      // A note already there: take the next name. Anything else is the answer.
      if (!(thrown instanceof FileOpError) || thrown.code !== "CONFLICT") throw thrown;
    }
  }
  throw new FileOpError("CONFLICT", "There are already notes with that name there.");
}

/** Undo a sent note: into the team's trash, where it can still be restored. */
export async function withdrawRoute(
  store: FileStore,
  clearance: Clearance,
  input: Record<string, unknown>,
  now: number,
  actor: ActivityActor | null,
): Promise<{ applied: boolean }> {
  const path = bounded(input.path, 2048, "path");
  const moved = await trashPath(store, { path, clearance, now });
  await recordActivity(store, { action: "file.delete", paths: [moved.from], details: { organizer: "undo" }, actor });
  return { applied: true };
}
