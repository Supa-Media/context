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
import { archiveSuggestion, doneSuggestion, fileSuggestion } from "../../../../mcp/src/organizer/suggest.js";
import {
  CARD_KINDS,
  clearPending,
  mergeSweep,
  readOrganizerState,
  rememberRevert,
  resolveSuggestion,
  setRouting,
  writeOrganizerState,
} from "../../../../mcp/src/organizer/state.js";
import { setNoteProperty } from "../../../../mcp/src/lists/setProperty.js";
import { type ChangeStep, type ChangeWork, type FieldUndo, applyChange, gatherChangeWork, restoreField } from "./changeOps";
import { noteProperties } from "../../../../mcp/src/lists/properties.js";
import { deliverRoute, outlineTeam, withdrawRoute } from "./routeOps";
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
  /**
   * "change" is a What changed card (`./changeOps.ts`), "route" a note for one
   * of the owner's teams (`./routeOps.ts`): never done without asking.
   */
  kind: OrganizerKind | "change" | "route";
  path: string;
  title: string;
  reason: string;
  status?: string;
  /** Kind "done": the folder's Done word that accepting writes. */
  to?: string;
  target?: { path: string; title: string };
  etag?: string | null;
  /** Kind "change": what it is about, where it was read, and its steps. */
  topic?: "people" | "focus" | "project";
  source?: { path: string; title: string; kind: string };
  steps?: ChangeStep[];
  at?: number;
  /** Kind "route": the team, the folder there, the note, and what it held back. */
  route?: RouteCard;
}

export interface RouteCard {
  team: string;
  folder: string;
  folderTitle: string;
  body: string;
  leftOut: { what: string; why: "people" | "personal" | "meeting" | "owner" }[];
}

/** Which teams the owner switched off, and what they keep to themselves. */
export interface Routing {
  off: string[];
  keep: string;
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
  /** What changed: arrivals to read, when the sweep asked for them. */
  changes: ChangeWork | null;
  /** The owner's team switches and rule, read with the arrivals. */
  routing: Routing | null;
}

export async function listEverything(store: FileStore, clearance: Clearance) {
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
  let queue = paths;
  while (queue.length > 0) {
    const batch = await readFiles(store, { paths: queue.slice(0, READ_BATCH), clearance });
    // Past a batch's byte budget the rest come back `deferred`, unread: ask
    // again. The first path of a batch is always read, so this ends.
    const deferred = batch.filter((read) => read.outcome === "deferred").map((read) => read.path);
    queue = [...deferred, ...queue.slice(READ_BATCH)];
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
  options: { changes?: boolean } = {},
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
  let changes: ChangeWork | null = null;
  let routing: Routing | null = null;
  if (options.changes === true) {
    const { state } = await readOrganizerState(store);
    routing = state.routing as Routing;
    changes = await gatherChangeWork((paths) => readTexts(store, clearance, paths), {
      entries,
      inboxRoot: (plan.roots as { inbox?: string | null }).inbox ?? null,
      readUpTo: (state as { changesReadUpTo?: number | null }).changesReadUpTo ?? null,
      projects: plan.projects,
      projectTexts: texts,
      statuses: Object.values(statusList as Record<string, string[]>).flat(),
      now,
    });
  }
  return { total: entries.length, items, destinations: plan.destinations, ready, changes, routing };
}

/**
 * What one answered question suggests, or null. The sweep and the
 * organization-score suite both call this, so the suite judges the rules the
 * sweep actually applies.
 */
export function suggestionFor(
  item: WorkItem,
  destinations: SweepWork["destinations"],
  answers: Record<string, unknown>,
): OrganizerSuggestion | null {
  const suggestion =
    item.kind === "project"
      ? doneSuggestion(item.project, item.facts, answers)
      : fileSuggestion(item.note, item.title, destinations, answers);
  return (suggestion as OrganizerSuggestion | null) ?? null;
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
  changesReadUpTo?: number,
): Promise<{ pending: number; changes: number; suggestions: OrganizerSuggestion[] }> {
  const next = await updateState(store, (state) => mergeSweep(state, suggestions, now, changesReadUpTo));
  const all = next.pending as OrganizerSuggestion[];
  return { pending: all.length, changes: countChanges(all), suggestions: all };
}

/** Cards on the What changed page (changes, and notes for teams), for its count. */
export function countChanges(pending: readonly unknown[]): number {
  return (pending as OrganizerSuggestion[]).filter((item) => (CARD_KINDS as readonly string[]).includes(item.kind)).length;
}

export async function readOrganizerPending(store: FileStore) {
  const { state } = await readOrganizerState(store);
  return { suggestions: state.pending as OrganizerSuggestion[], sweptAt: state.sweptAt as number | null, routing: state.routing as Routing };
}

export async function clearOrganizerPending(store: FileStore): Promise<{ pending: number }> {
  await updateState(store, clearPending);
  return { pending: 0 };
}

export type OrganizerUndo =
  | { kind: "move"; from: string; to: string }
  | { kind: "status"; path: string; value: string }
  | FieldUndo
  | { kind: "batch"; undos: ({ kind: "move"; from: string; to: string } | FieldUndo)[] }
  /** A note sent to a team: Undo trashes it there (`organizer.unsendRoute`). */
  | { kind: "sent"; team: string; path: string };

/** Carry out one accepted suggestion with the operations a person would use. */
async function apply(
  store: FileStore,
  clearance: Clearance,
  suggestion: OrganizerSuggestion,
  now: number,
  actor: ActivityActor | null,
  steps: readonly string[] | null,
  sent: { team: string; path: string } | null,
): Promise<OrganizerUndo> {
  if (suggestion.kind === "route") {
    // The note was written in the team's own workspace before this; here the
    // card is only taken off the list. Without proof of that, nothing is done.
    if (!sent || sent.team !== suggestion.route?.team) throw new FileOpError("CONFLICT", "That note wasn't sent.");
    return { kind: "sent", team: sent.team, path: sent.path };
  }
  if (suggestion.kind === "change") {
    const done = await applyChange(store, clearance, { title: suggestion.title, steps: suggestion.steps ?? [] }, steps, now, actor);
    if (done.undos.length === 0) throw new FileOpError("CONFLICT", "Those notes changed since. Nothing was done.");
    return { kind: "batch", undos: done.undos };
  }
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
  /** Everything waiting for the owner, change cards included. */
  pending: number;
  /** The What changed cards among them. */
  changes: number;
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
  args: { id: string; decision: "accept" | "dismiss"; steps?: readonly string[] | null; sent?: { team: string; path: string } | null },
  now: number,
  actor: ActivityActor | null,
): Promise<ResolveOutcome> {
  const { state } = await readOrganizerState(store);
  const suggestion = (state.pending as OrganizerSuggestion[]).find((item) => item.id === args.id);
  if (!suggestion) {
    return {
      applied: false,
      offer: null,
      pending: state.pending.length,
      changes: countChanges(state.pending),
      undo: null,
      error: "That suggestion is no longer waiting.",
    };
  }

  let undo: OrganizerUndo | null = null;
  let error: string | null = null;
  if (args.decision === "accept") {
    try {
      undo = await apply(store, clearance, suggestion, now, actor, args.steps ?? null, args.sent ?? null);
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
    offer: offer && suggestion.kind !== "change" && suggestion.kind !== "route" ? suggestion.kind : null,
    pending: next.pending.length,
    changes: countChanges(next.pending),
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

export type OrganizerAction =
  | "gather"
  | "record"
  | "read"
  | "resolve"
  | "clear"
  | "autopilot"
  | "undo"
  | "routing"
  | "outline"
  | "deliver"
  | "withdraw";

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
      return JSON.stringify(await gatherOrganizerWork(store, clearance, now, { changes: input.changes === true }));
    case "record": {
      const suggestions = Array.isArray(input.suggestions) ? (input.suggestions as OrganizerSuggestion[]) : [];
      const readUpTo = typeof input.changesReadUpTo === "number" ? input.changesReadUpTo : undefined;
      return JSON.stringify(await recordOrganizerSweep(store, suggestions, now, readUpTo));
    }
    case "read":
      return JSON.stringify(await readOrganizerPending(store));
    case "clear":
      return JSON.stringify(await clearOrganizerPending(store));
    case "resolve": {
      const decision = input.decision === "accept" ? "accept" : input.decision === "dismiss" ? "dismiss" : null;
      if (!decision) throw new FileOpError("PATH_INVALID", "Accept or dismiss, nothing else.");
      const steps = Array.isArray(input.steps) ? input.steps.filter((step): step is string => typeof step === "string").slice(0, 32) : null;
      const sentInput = input.sent as Record<string, unknown> | undefined;
      const sent = sentInput && typeof sentInput === "object" ? { team: text(sentInput.team, "team"), path: text(sentInput.path, "path") } : null;
      return JSON.stringify(await resolveOrganizerSuggestion(store, clearance, { id: text(input.id, "suggestion"), decision, steps, sent }, now, acting));
    }
    case "routing": {
      const change = {
        ...(typeof input.team === "string" && typeof input.on === "boolean" ? { team: input.team, on: input.on } : {}),
        ...(typeof input.keep === "string" ? { keep: input.keep } : {}),
      };
      const next = await updateState(store, (state) => setRouting(state, change));
      return JSON.stringify({ routing: next.routing });
    }
    case "outline":
      return JSON.stringify(await outlineTeam(store, await listEverything(store, clearance), now));
    case "deliver":
      return JSON.stringify(await deliverRoute(store, clearance, input, now, acting));
    case "withdraw":
      return JSON.stringify(await withdrawRoute(store, clearance, input, now, acting));
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
    if (suggestion.kind === "change" || suggestion.kind === "route" || !kinds.has(suggestion.kind)) continue;
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
    else if (token.kind === "field") undo = readFieldUndo(token);
    else if (token.kind === "batch" && Array.isArray(token.undos)) {
      const undos = token.undos.slice(0, 32).map((one: unknown) => {
        const part = (one ?? {}) as Record<string, unknown>;
        return part.kind === "move" ? { kind: "move" as const, from: text(part.from, "path"), to: text(part.to, "path") } : readFieldUndo(part);
      });
      undo = { kind: "batch", undos };
    }
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
    if (undo.kind === "batch") {
      // Each part on its own: one note changed since must not keep the rest.
      let applied = 0;
      for (const part of undo.undos) {
        try {
          await undoOne(store, clearance, part, now, actor);
          applied += 1;
        } catch (thrown) {
          if (!(thrown instanceof FileOpError)) throw thrown;
        }
      }
      return applied > 0 ? { applied: true } : { applied: false, error: "Those notes changed since. Nothing was undone." };
    }
    if (undo.kind === "field") {
      await restoreField(store, clearance, undo, now, actor);
    } else if (undo.kind === "status") {
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

const UNDO_FIELDS = new Set(["owner", "priority", "status"]);

/** A field to put back. Only the three fields a change card ever sets. */
function readFieldUndo(token: Record<string, unknown>): FieldUndo {
  if (typeof token.field !== "string" || !UNDO_FIELDS.has(token.field)) {
    throw new FileOpError("PATH_INVALID", "That change can't be undone from here.");
  }
  return { kind: "field", path: text(token.path, "path"), field: token.field as FieldUndo["field"], value: typeof token.value === "string" ? token.value : "" };
}

async function undoOne(
  store: FileStore,
  clearance: Clearance,
  part: { kind: "move"; from: string; to: string } | FieldUndo,
  now: number,
  actor: ActivityActor | null,
) {
  if (part.kind === "field") {
    await restoreField(store, clearance, part, now, actor);
    return;
  }
  const moved = await movePath(store, { from: part.from, to: part.to, clearance, now });
  await recordActivity(store, { action: "file.move", paths: [moved.from, moved.to], details: { count: moved.paths.length, organizer: "undo" }, actor });
}
