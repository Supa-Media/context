/**
 * "What changed", inside the credential barrier: what a sweep reads for it,
 * and what pressing Apply on a change card does.
 *
 * The engine (which arrivals, the workspace map, the checks on the model's
 * answer) is the gateway's `mcp/src/organizer/changes.js`. This file is the
 * reading and the writing, with the operations a person would use, each
 * recorded in Activity.
 */

import { recordActivity, type ActivityActor } from "../activity";
import type { Clearance } from "../clearance";
import type { FileStore } from "../fileOps";
import { FileOpError } from "../fileOps/errors";
import { archivePath } from "../fileOps/deleting";
import { readFile } from "../fileOps/reading";
import { writeFile } from "../fileOps/writing";
import { personNotes, planChangeSources, projectEntry } from "../../../../mcp/src/organizer/changes.js";
import { setNoteProperty } from "../../../../mcp/src/lists/setProperty.js";
import { noteProperties } from "../../../../mcp/src/lists/properties.js";

export type ChangeField = "owner" | "priority" | "status";

export interface ChangeStep {
  id: string;
  do: "archive" | "set";
  path: string;
  title: string;
  about?: "person" | "project";
  field?: ChangeField;
  value?: string;
  was?: string;
}

export interface ChangeSource {
  path: string;
  title: string;
  kind: "meeting" | "messages" | "chat" | "note";
  updatedAt: number;
}

/** What a sweep hands the orchestrator: the arrivals' text, and the map's facts. */
export interface ChangeWork {
  sources: { source: ChangeSource; body: string }[];
  people: { path: string; frontPath: string; title: string }[];
  projects: ReturnType<typeof projectEntry>[];
  statuses: string[];
}

/**
 * The arrivals since the last read and the facts the map is drawn from.
 * `entries` is the sweep's listing, `projectTexts` the front notes it already
 * read, so nothing is listed or read twice.
 */
export async function gatherChangeWork(
  read: (paths: string[]) => Promise<Map<string, { text: string; etag: string }>>,
  args: {
    entries: { path: string; updatedAt?: number; etag?: string }[];
    inboxRoot: string | null;
    readUpTo: number | null;
    projects: { path: string; frontPath: string; title: string }[];
    projectTexts: Map<string, { text: string; etag: string }>;
    statuses: string[];
    now: number;
  },
): Promise<ChangeWork> {
  const planned = planChangeSources(args.entries, args.inboxRoot, args.readUpTo, args.now) as ChangeSource[];
  const texts = await read(planned.map((source) => source.path));
  const sources: ChangeWork["sources"] = [];
  for (const source of planned) {
    const body = texts.get(source.path)?.text;
    // An unreadable or locked arrival is skipped, and the mark still moves
    // past it: it will not become readable by being asked again.
    if (body === undefined || noteProperties(body).organize === "off") continue;
    sources.push({ source, body });
  }
  const projects = args.projects.flatMap((project) => {
    const front = args.projectTexts.get(project.frontPath);
    return front ? [projectEntry(project, front.text)] : [];
  });
  return {
    sources,
    people: personNotes(args.entries) as ChangeWork["people"],
    projects,
    statuses: args.statuses,
  };
}

export type FieldUndo = { kind: "field"; path: string; field: ChangeField; value: string };
export type MoveUndo = { kind: "move"; from: string; to: string };

/** Set one frontmatter field, if it still holds what the card said it held. */
async function setField(
  store: FileStore,
  clearance: Clearance,
  step: ChangeStep & { field: ChangeField },
  value: string,
  now: number,
  actor: ActivityActor | null,
  summary: string | null,
): Promise<FieldUndo> {
  const note = await readFile(store, { path: step.path, clearance });
  if (note.encrypted || note.readOnly) throw new FileOpError("CONFLICT", "This note can't be changed here.");
  const current = noteProperties(note.text)[step.field];
  const was = typeof current === "string" ? current.trim() : "";
  if (step.was !== undefined && was.toLowerCase() !== step.was.toLowerCase()) {
    throw new FileOpError("CONFLICT", "Somebody changed it since.");
  }
  const changed = setNoteProperty(note.text, step.field, value === "" ? null : value) as { text?: string; error?: string };
  if (typeof changed.text !== "string") throw new FileOpError("PATH_INVALID", changed.error ?? "Couldn't change it.");
  const written = await writeFile(store, { path: note.path, text: changed.text, expectedEtag: note.etag, clearance, now });
  await recordActivity(store, { action: "file.write", paths: [written.path], details: summary === null ? { organizer: "undo" } : { organizer: "change", summary }, actor });
  return { kind: "field", path: note.path, field: step.field, value: was };
}

/**
 * Carry out the ticked steps of one change card. Field changes go first and
 * archives last, so a project is updated before it is filed away. A step whose
 * note moved or changed since the card was made is skipped, not forced; the
 * rest still happen. Returns what to undo, in reverse order.
 */
export async function applyChange(
  store: FileStore,
  clearance: Clearance,
  card: { title: string; steps: ChangeStep[] },
  only: readonly string[] | null,
  now: number,
  actor: ActivityActor | null,
): Promise<{ undos: (FieldUndo | MoveUndo)[]; skipped: number }> {
  const chosen = card.steps.filter((step) => only === null || only.includes(step.id));
  const ordered = [...chosen.filter((step) => step.do === "set"), ...chosen.filter((step) => step.do === "archive")];
  const undos: (FieldUndo | MoveUndo)[] = [];
  let skipped = 0;
  for (const step of ordered) {
    try {
      if (step.do === "set" && step.field && typeof step.value === "string") {
        undos.push(await setField(store, clearance, { ...step, field: step.field }, step.value, now, actor, card.title));
      } else if (step.do === "archive") {
        const moved = await archivePath(store, { path: step.path, clearance, now });
        await recordActivity(store, {
          action: "file.archive",
          paths: [moved.from, moved.to],
          details: { count: moved.paths.length, organizer: "change", summary: card.title },
          actor,
        });
        undos.push({ kind: "move", from: moved.to, to: moved.from });
      } else {
        skipped += 1;
      }
    } catch (thrown) {
      if (!(thrown instanceof FileOpError)) throw thrown;
      skipped += 1;
    }
  }
  return { undos: undos.reverse(), skipped };
}

/** Put one field back, for Undo. No check on the current value: the person asked. */
export async function restoreField(
  store: FileStore,
  clearance: Clearance,
  undo: FieldUndo,
  now: number,
  actor: ActivityActor | null,
): Promise<void> {
  await setField(store, clearance, { id: "undo", do: "set", path: undo.path, title: "", field: undo.field }, undo.value, now, actor, null);
}
