/**
 * Auto-organize's file operations: everything a sweep or a press does inside
 * the one credential barrier (`runFileOperation`), and nothing else.
 *
 * A sweep is three trips, the same shape a cross-context move takes:
 *
 *   1. `organizerGather` reads the listing and the notes worth asking about,
 *      and hands back the questions for Jev with the note text inside them.
 *      Text passes through the control plane in flight, as every `readNote`
 *      does; nothing here stores it.
 *   2. The orchestrator (`functions/organizer.ts`) asks the inference worker,
 *      holding no credential.
 *   3. `organizerRecord` writes the resulting suggestions into the customer's
 *      own bucket, at `.context/organizer/state.json`.
 *
 * The engine these call is the gateway's (`mcp/src/organizer/`), so the rules
 * live in one place and are tested once.
 */

import { readActivity, recordActivity, type ActivityActor } from "../activity";
import type { Clearance } from "../clearance";
import type { FileStore } from "../fileOps";
import { FileOpError } from "../fileOps/errors";
import { archivePath } from "../fileOps/deleting";
import { movePath } from "../fileOps/moving";
import { readFiles, readFile } from "../fileOps/reading";
import { syncManifest } from "../fileOps/syncManifest";
import { writeFile } from "../fileOps/writing";
import { planSweep } from "../../../../mcp/src/organizer/plan.js";
import {
  inboxRequest,
  projectFacts,
  projectRequest,
} from "../../../../mcp/src/organizer/questions.js";
import { archiveSuggestion } from "../../../../mcp/src/organizer/suggest.js";
import {
  clearPending,
  mergeSweep,
  readOrganizerState,
  rememberRevert,
  resolveSuggestion,
  writeOrganizerState,
} from "../../../../mcp/src/organizer/state.js";
import { setNoteProperty } from "../../../../mcp/src/lists/setProperty.js";
import { noteProperties } from "../../../../mcp/src/lists/properties.js";
import { resolveStatusList } from "../../../../mcp/src/lists/statuses.js";

/** The name on what the organizer does by itself, in `activity.md`. */
export const ORGANIZER_ACTOR: ActivityActor = { name: "Context organizer", client: null };

/** A listing larger than this is swept on its newest part only. */
const MAX_MANIFEST_PAGES = 5;
const READ_BATCH = 50;
const STATE_WRITE_ATTEMPTS = 3;

export type OrganizerKind = "done" | "archive" | "file";

export interface OrganizerSuggestion {
  id: string;
  kind: OrganizerKind;
  path: string;
  title: string;
  reason: string;
  status?: string;
  /** Kind "done": the folder's Done word that accepting writes. */
  to?: string;
  target?: { path: string; title: string };
  etag?: string | null;
}

/** One question for Jev, and what the answer will be judged against. */
export type WorkItem =
  | {
      kind: "project";
      project: { kind: "note" | "folder"; path: string; frontPath: string; title: string; updatedAt: number | null; etag: string | null };
      facts: ReturnType<typeof projectFacts>;
      request: { state: string; questions: Record<string, unknown> };
    }
  | {
      kind: "inbox";
      note: { path: string; title: string; updatedAt: number | null; etag: string | null; meeting: boolean };
      title: string;
      request: { state: string; questions: Record<string, unknown> };
    };

export interface SweepWork {
  /** Notes the owner can see, for "212 of 450 notes". */
  total: number;
  items: WorkItem[];
  destinations: { path: string; title: string; group: string }[];
  /** Suggestions that need no question: closed projects gone quiet. */
  ready: OrganizerSuggestion[];
}

async function listEverything(store: FileStore, clearance: Clearance) {
  const entries: { path: string; updatedAt?: number; etag?: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MANIFEST_PAGES; page += 1) {
    const manifest = await syncManifest(store, { clearance, ...(cursor === undefined ? {} : { cursor }) });
    for (const entry of manifest.entries) {
      entries.push({ path: entry.path, updatedAt: entry.updatedAt, etag: entry.etag });
    }
    if (manifest.cursor === null) break;
    cursor = manifest.cursor;
  }
  return entries;
}

async function readTexts(store: FileStore, clearance: Clearance, paths: string[]) {
  const texts = new Map<string, { text: string; etag: string }>();
  for (let at = 0; at < paths.length; at += READ_BATCH) {
    const batch = await readFiles(store, { paths: paths.slice(at, at + READ_BATCH), clearance });
    for (const read of batch) {
      // An encrypted note is ciphertext here, and stays unread: the control
      // plane holds no key, and a locked note reaches no AI feature at all.
      if (read.outcome === "read" && !read.note.encrypted) {
        texts.set(read.path, { text: read.note.text, etag: read.note.etag });
      }
    }
  }
  return texts;
}

export async function gatherOrganizerWork(
  store: FileStore,
  clearance: Clearance,
  now: number,
): Promise<SweepWork> {
  const entries = await listEverything(store, clearance);
  const plan = planSweep(entries, now);
  const texts = await readTexts(store, clearance, [
    ...plan.statusNotes,
    ...plan.projects.map((project) => project.frontPath),
    ...plan.inbox.map((note) => note.path),
  ]);
  // What "done" is called in the projects folder: its own list, or the defaults.
  const statusList = resolveStatusList(
    (plan.roots as { projects?: string | null }).projects ?? "",
    plan.statusNotes.flatMap((path) => {
      const read = texts.get(path);
      return read ? [{ path, properties: noteProperties(read.text) }] : [];
    }),
  ).list;

  const items: WorkItem[] = [];
  const ready: OrganizerSuggestion[] = [];
  for (const project of plan.projects) {
    const read = texts.get(project.frontPath);
    if (!read) continue;
    const withEtag = { ...project, etag: read.etag };
    const facts = projectFacts(withEtag, read.text, now, statusList);
    if (!facts.status || facts.optedOut) continue;
    if (facts.closed) {
      const archive = archiveSuggestion(withEtag, facts);
      if (archive) ready.push(archive as OrganizerSuggestion);
      continue;
    }
    items.push({ kind: "project", project: withEtag as Extract<WorkItem, { kind: "project" }>["project"], facts, request: projectRequest(withEtag, read.text, facts) });
  }
  if (plan.destinations.length > 0) {
    for (const note of plan.inbox) {
      const read = texts.get(note.path);
      if (!read) continue;
      const request = inboxRequest(note, read.text, plan.destinations);
      items.push({ kind: "inbox", note: { ...note, etag: read.etag }, title: note.title, request });
    }
  }
  return { total: entries.length, items, destinations: plan.destinations, ready };
}

/** Read, change, write back on the etag; a lost race re-reads and retries. */
async function updateState(
  store: FileStore,
  change: (state: ReturnType<typeof mergeSweep>) => ReturnType<typeof mergeSweep>,
) {
  for (let attempt = 0; attempt < STATE_WRITE_ATTEMPTS; attempt += 1) {
    const { state, etag } = await readOrganizerState(store);
    const next = change(state);
    if ((await writeOrganizerState(store, next, etag)) !== null) return next;
  }
  throw new FileOpError("CONFLICT", "Suggestions changed while saving. Try again.");
}

export async function recordOrganizerSweep(
  store: FileStore,
  suggestions: OrganizerSuggestion[],
  now: number,
): Promise<{ pending: number; suggestions: OrganizerSuggestion[] }> {
  const next = await updateState(store, (state) => mergeSweep(state, suggestions, now));
  return { pending: next.pending.length, suggestions: next.pending as OrganizerSuggestion[] };
}

export async function readOrganizerPending(store: FileStore) {
  const { state } = await readOrganizerState(store);
  return { suggestions: state.pending as OrganizerSuggestion[], sweptAt: state.sweptAt as number | null };
}

export async function clearOrganizerPending(store: FileStore): Promise<{ pending: number }> {
  await updateState(store, clearPending);
  return { pending: 0 };
}

export type OrganizerUndo =
  | { kind: "move"; from: string; to: string }
  | { kind: "status"; path: string; value: string };

/** Carry out one accepted suggestion with the operations a person would use. */
async function apply(
  store: FileStore,
  clearance: Clearance,
  suggestion: OrganizerSuggestion,
  now: number,
  actor: ActivityActor | null,
): Promise<OrganizerUndo> {
  if (suggestion.kind === "done") {
    const note = await readFile(store, { path: suggestion.path, clearance });
    if (note.encrypted || note.readOnly) throw new FileOpError("CONFLICT", "This note can't be changed here.");
    const changed = setNoteProperty(note.text, "status", suggestion.to ?? "done") as { text?: string; error?: string };
    if (typeof changed.text !== "string") throw new FileOpError("PATH_INVALID", changed.error ?? "Couldn't set the status.");
    const written = await writeFile(store, { path: note.path, text: changed.text, expectedEtag: note.etag, clearance, now });
    await recordActivity(store, { action: "file.write", paths: [written.path], details: { organizer: "done", summary: suggestion.reason }, actor });
    return { kind: "status", path: note.path, value: suggestion.status ?? "" };
  }
  if (suggestion.kind === "archive") {
    const moved = await archivePath(store, { path: suggestion.path, clearance, now });
    await recordActivity(store, { action: "file.archive", paths: [moved.from, moved.to], details: { count: moved.paths.length, organizer: "archive", summary: suggestion.reason }, actor });
    return { kind: "move", from: moved.to, to: moved.from };
  }
  const target = suggestion.target;
  if (!target) throw new FileOpError("PATH_INVALID", "This suggestion has nowhere to file to.");
  const leaf = suggestion.path.split("/").pop() ?? suggestion.path;
  const moved = await movePath(store, { from: suggestion.path, to: `${target.path}/${leaf}`, clearance, now });
  await recordActivity(store, { action: "file.move", paths: [moved.from, moved.to], details: { count: moved.paths.length, organizer: "file", summary: `Filed in ${target.title}` }, actor });
  return { kind: "move", from: moved.to, to: moved.from };
}

export interface ResolveOutcome {
  applied: boolean;
  offer: OrganizerKind | null;
  pending: number;
  undo: OrganizerUndo | null;
  error: string | null;
}

/**
 * Accept or dismiss one suggestion. An accept that cannot be carried out (the
 * note moved, somebody edited it) is taken off the list and reported, never
 * retried against a note that is no longer the one it was about.
 */
export async function resolveOrganizerSuggestion(
  store: FileStore,
  clearance: Clearance,
  args: { id: string; decision: "accept" | "dismiss" },
  now: number,
  actor: ActivityActor | null,
): Promise<ResolveOutcome> {
  const { state } = await readOrganizerState(store);
  const suggestion = (state.pending as OrganizerSuggestion[]).find((item) => item.id === args.id);
  if (!suggestion) return { applied: false, offer: null, pending: state.pending.length, undo: null, error: "That suggestion is no longer waiting." };

  let undo: OrganizerUndo | null = null;
  let error: string | null = null;
  if (args.decision === "accept") {
    try {
      undo = await apply(store, clearance, suggestion, now, actor);
    } catch (thrown) {
      error = thrown instanceof FileOpError ? thrown.message : "That couldn't be done. The note may have changed.";
    }
  }
  let offer = false;
  const unasked = actor === ORGANIZER_ACTOR;
  const next = await updateState(store, (current) => {
    const resolved = resolveSuggestion(current, args.id, error ? "dismiss" : args.decision, now);
    offer = resolved.offer && !unasked;
    // Activity's Undo on a change nobody pressed for has only the row to go
    // on, and the row does not say what the status was.
    return unasked && undo?.kind === "status" ? rememberRevert(resolved.state, undo.path, undo.value) : resolved.state;
  });
  return {
    applied: undo !== null,
    offer: offer ? suggestion.kind : null,
    pending: next.pending.length,
    undo,
    error,
  };
}

/** Put a status back the way it was, for Undo on "Mark done". */
export async function restoreOrganizerStatus(
  store: FileStore,
  clearance: Clearance,
  args: { path: string; value: string },
  now: number,
  actor: ActivityActor | null,
): Promise<void> {
  const note = await readFile(store, { path: args.path, clearance });
  const changed = setNoteProperty(note.text, "status", args.value === "" ? null : args.value) as { text?: string; error?: string };
  if (typeof changed.text !== "string") throw new FileOpError("PATH_INVALID", changed.error ?? "Couldn't restore the status.");
  const written = await writeFile(store, { path: note.path, text: changed.text, expectedEtag: note.etag, clearance, now });
  await recordActivity(store, { action: "file.write", paths: [written.path], details: { organizer: "undo" }, actor });
}

export type OrganizerAction = "gather" | "record" | "read" | "resolve" | "clear" | "autopilot" | "undo";

function parseInput(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new FileOpError("PATH_INVALID", "That organizer request was malformed.");
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new FileOpError("PATH_INVALID", `That organizer request had no ${what}.`);
  }
  return value;
}

/**
 * The one `organizer` file operation, dispatched here so the barrier's own
 * dispatch stays one line. Input and output are JSON strings: suggestions are
 * the engine's shape, checked by the engine when it reads them back, and none
 * of them is a credential.
 */
export async function runOrganizerOperation(
  store: FileStore,
  clearance: Clearance,
  operation: { action: OrganizerAction; input: string; autopilot?: boolean },
  now: number,
  actor: ActivityActor | null,
): Promise<string> {
  const input = parseInput(operation.input);
  const acting = operation.autopilot === true ? ORGANIZER_ACTOR : actor;
  switch (operation.action) {
    case "gather":
      return JSON.stringify(await gatherOrganizerWork(store, clearance, now));
    case "record": {
      const suggestions = Array.isArray(input.suggestions) ? (input.suggestions as OrganizerSuggestion[]) : [];
      return JSON.stringify(await recordOrganizerSweep(store, suggestions, now));
    }
    case "read":
      return JSON.stringify(await readOrganizerPending(store));
    case "clear":
      return JSON.stringify(await clearOrganizerPending(store));
    case "resolve": {
      const decision = input.decision === "accept" ? "accept" : input.decision === "dismiss" ? "dismiss" : null;
      if (!decision) throw new FileOpError("PATH_INVALID", "Accept or dismiss, nothing else.");
      return JSON.stringify(await resolveOrganizerSuggestion(store, clearance, { id: text(input.id, "suggestion"), decision }, now, acting));
    }
    case "autopilot": {
      const kinds = new Set(Array.isArray(input.kinds) ? input.kinds.filter((kind): kind is OrganizerKind => kind === "done" || kind === "archive" || kind === "file") : []);
      return JSON.stringify(await runAutopilot(store, clearance, kinds, now));
    }
    case "undo":
      return JSON.stringify(await undoOrganizerChange(store, clearance, input, now, acting));
  }
}

/** Carry out, by itself, every waiting suggestion of the kinds switched to "without asking". */
async function runAutopilot(store: FileStore, clearance: Clearance, kinds: Set<OrganizerKind>, now: number) {
  let applied = 0;
  if (kinds.size === 0) return { applied };
  const { state } = await readOrganizerState(store);
  for (const suggestion of state.pending as OrganizerSuggestion[]) {
    if (!kinds.has(suggestion.kind)) continue;
    const outcome = await resolveOrganizerSuggestion(store, clearance, { id: suggestion.id, decision: "accept" }, now, ORGANIZER_ACTOR);
    if (outcome.applied) applied += 1;
  }
  return { applied };
}

function sameList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((item, at) => item === b[at]);
}

/**
 * Take one change back: from the token an accept handed out, or from an
 * Activity row the organizer wrote by itself. A row is only honoured if it is
 * really there and really the organizer's, so this cannot become a way to
 * move anything else.
 */
async function undoOrganizerChange(
  store: FileStore,
  clearance: Clearance,
  input: Record<string, unknown>,
  now: number,
  actor: ActivityActor | null,
): Promise<{ applied: boolean; error?: string }> {
  let undo: OrganizerUndo | null = null;
  const token = input.token as Record<string, unknown> | undefined;
  const entry = input.entry as Record<string, unknown> | undefined;
  if (token && typeof token === "object") {
    if (token.kind === "move") undo = { kind: "move", from: text(token.from, "path"), to: text(token.to, "path") };
    else if (token.kind === "status") undo = { kind: "status", path: text(token.path, "path"), value: typeof token.value === "string" ? token.value : "" };
  } else if (entry && typeof entry === "object" && Array.isArray(entry.paths)) {
    const paths = entry.paths.filter((path): path is string => typeof path === "string");
    const rows = await readActivity(store, { scope: clearance.scope, names: [...clearance.names] });
    const row = rows.find((candidate) => candidate.by === ORGANIZER_ACTOR.name && candidate.kind === entry.kind && sameList(candidate.paths, paths) && (entry.at === undefined || candidate.at === entry.at));
    if (!row) return { applied: false, error: "That change can't be undone from here." };
    if ((row.kind === "file.move" || row.kind === "file.archive") && row.paths.length === 2) {
      undo = { kind: "move", from: row.paths[1] as string, to: row.paths[0] as string };
    } else if (row.kind === "file.write" && row.paths.length === 1) {
      const { state } = await readOrganizerState(store);
      const was = (state.reverts as Record<string, string> | undefined)?.[row.paths[0] as string];
      if (was !== undefined) undo = { kind: "status", path: row.paths[0] as string, value: was };
    }
  }
  if (!undo) return { applied: false, error: "That change can't be undone from here." };
  try {
    if (undo.kind === "status") {
      await restoreOrganizerStatus(store, clearance, { path: undo.path, value: undo.value }, now, actor);
      const path = undo.path;
      await updateState(store, (state) => rememberRevert(state, path, undefined));
    } else {
      const moved = await movePath(store, { from: undo.from, to: undo.to, clearance, now });
      await recordActivity(store, { action: "file.move", paths: [moved.from, moved.to], details: { count: moved.paths.length, organizer: "undo" }, actor });
    }
    return { applied: true };
  } catch (thrown) {
    return { applied: false, error: thrown instanceof FileOpError ? thrown.message : "That couldn't be undone. The note may have changed." };
  }
}
