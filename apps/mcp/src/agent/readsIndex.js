/**
 * WHAT THIS CHAT HAS READ, AND WHERE (one record per chat, part 4; Dev2,
 * 2026-11-13: build every part but the chat copy).
 *
 * The ledger already keeps every tool call with what it gave back
 * (`ledger.js` `toolEntry`). This is an index over those entries, never a
 * second copy: a page, a search or a note an earlier turn or job read, with
 * where it came from and how long ago, one line each. A turn is shown the
 * lines in its per-text block (`runTheModel.js` `turnNote`) and opens any of
 * them whole with `read_back`, so "I can't see it now" never reads as "it was
 * never there" (2026-11-12, the Katz's private room) once the hour's stretch
 * (`stretch.js`) has passed.
 *
 * Who may see a read is decided exactly as the stretch decides what it
 * carries: only an entry read under this turn's own carry key (`stretch.js`
 * `carryKey`), never one read from another workspace (the ledger kept no
 * result). The rest are left out of the index, their arguments too, since a
 * query or an address is as private as what came back.
 *
 * A page is opened as it was read: the web is public and may have changed.
 * A note is never handed back from the ledger: `read_back` reads it again now
 * through the turn's own access (`reread`), so a note made private since is
 * refused as any read of it would be. And a group's index lists pages only: a
 * note's path is listed only in a one-to-one chat, whose one reader is the
 * person who read it, so a path made private since never reaches a room.
 *
 * Reading one back counts as reading it: opening one marks the turn exactly as
 * the original call would have (`markRead`): a page or a search as the web
 * tools do (`turnWeb.js`), a note as the egress ledger's `recordRead` does, so
 * a page makes it untrusted as if it had read the page itself
 * (`docs/decisions/texting-assistant/turn-trust.md`).
 */

import { markUntrusted, recordRead } from "../privacy/egress.js";
import { NOTE_READS, WEB_READS } from "./toldFacts.js";

/** Most reads listed; older ones are not named. */
export const MAX_INDEXED_READS = 20;
/** The tool names whose calls are reads this index keeps. */
export const INDEXED_READS = Object.freeze([...WEB_READS, ...NOTE_READS]);
const MAX_SOURCE_CHARS = 160;

export const READS_PREFACE = "Earlier reads in this chat, newest first (read_back opens one whole, as it was read):";

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A read's reference: stable for the entry, short enough to type. */
export const readRef = (entry) => `r${String(entry.id).replace(/[^A-Za-z0-9]/g, "").slice(0, 10)}`;

/** Where a read came from: its address, query or note path, or null when it is no read this index keeps. */
function sourceOf(entry) {
  const args = entry.args && typeof entry.args === "object" ? entry.args : {};
  const name = entry.name; // what ran, never the six-tool name the model wrote (`sixTools.js`)
  if (WEB_READS.has(name)) {
    const url = [args.url, ...(Array.isArray(args.urls) ? args.urls : [])].find((value) => typeof value === "string" && value !== "");
    if (url) return url;
    if (Array.isArray(args.steps)) {
      const go = args.steps.find((step) => step?.do === "goto" && typeof step.url === "string");
      if (go) return go.url;
    }
    return typeof args.query === "string" && args.query !== "" ? `search: ${args.query}` : name;
  }
  if (NOTE_READS.has(name)) {
    const path = [args.path, ...(Array.isArray(args.paths) ? args.paths : [])].find((value) => typeof value === "string" && value !== "");
    return path ?? name;
  }
  return null;
}

/** Whether a tool entry may be shown to a turn running under `grant`. */
function readable(entry, grant) {
  return entry?.kind === "tool" && entry.ok === true && entry.withheld === undefined && typeof entry.id === "string" &&
    typeof grant === "string" && entry.grant === grant && Number.isSafeInteger(entry.at) && sourceOf(entry) !== null;
}

function ago(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * The reads a turn may be shown, newest first: `{listed, all}`, each `{ref, entry, source}`. `tools` are the chat's tool entries,
 * `before` leaves out what the stretch already carries whole (its start, or null for none); `notes: false` lists pages only (a group).
 */
export function readsOf(tools, { grant, before = null, limit = MAX_INDEXED_READS, notes = true } = {}) {
  const seen = new Set();
  const reads = [];
  for (const entry of [...(Array.isArray(tools) ? tools : [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    if (!readable(entry, grant) || seen.has(entry.id) || (!notes && NOTE_READS.has(entry.name))) continue;
    seen.add(entry.id);
    reads.push({ ref: readRef(entry), entry, source: clip(sourceOf(entry), MAX_SOURCE_CHARS) });
  }
  const listed = reads.filter((read) => !(Number.isSafeInteger(before) && read.entry.at >= before));
  return { listed: listed.slice(0, limit), all: reads };
}

/** The index as the per-text block shows it, or "" with nothing to list. */
export function readsNote(listed, { now = Date.now() } = {}) {
  if (!Array.isArray(listed) || listed.length === 0) return "";
  return [READS_PREFACE, ...listed.map((read) => `- ${read.ref} · ${ago(now - read.entry.at)} · ${read.entry.name}: ${read.source}`)].join("\n");
}

/**
 * `read_back`: one earlier read, whole. A page as the ledger kept it: `open(id)` reads that one entry with its result (the
 * index is read without them). A note read again now: `reread(name, args)` runs the read under the turn's own access.
 * `onRead({name, args, result})` is told each read opened, as the call that made it.
 */
export function readBackTool({ reads, open, reread = null, onRead = null }) {
  const byRef = new Map(reads.map((read) => [read.ref, read]));
  return {
    tool: {
      name: "read_back",
      description:
        "Open something this chat read earlier, by its reference from the list of earlier reads: a page or a search whole, as it was read then; a note as it is now. " +
        "Use it before saying a page or note never said something, or when a later text asks about what an earlier one found.",
      inputSchema: { type: "object", properties: { ref: { type: "string", description: "The read's reference, like r1a2b3c4d5e." } }, required: ["ref"] },
    },
    call: async (args) => {
      const ref = typeof args?.ref === "string" ? args.ref.trim() : "";
      const read = byRef.get(ref);
      if (!read) return { isError: true, content: [{ type: "text", text: `No earlier read ${ref || "(none named)"} in this chat that you can open. Read it again with the tool you'd use for it.` }] };
      if (NOTE_READS.has(read.entry.name)) {
        const args = read.entry.args ?? {};
        const again = typeof reread === "function" ? await Promise.resolve(reread(read.entry.name, args)).catch(() => null) : null;
        if (!again || again.isError === true) return { isError: true, content: [{ type: "text", text: `${read.ref} can't be read again now: the note may have moved or no longer be yours to read.` }] };
        onRead?.({ name: read.entry.name, args, result: again });
        return again;
      }
      const whole = await Promise.resolve(open(read.entry.id)).catch(() => null);
      // The entry read back must be the one listed, under the same grant: never another's, whatever the id.
      if (whole?.id !== read.entry.id || !readable(whole, read.entry.grant) || typeof whole.result !== "string") {
        return { isError: true, content: [{ type: "text", text: `${read.ref} can't be opened now. Read it again with the tool you'd use for it.` }] };
      }
      const cut = Number.isSafeInteger(whole.cut) ? `\n\n(Kept to its first ${whole.result.length} of ${whole.cut} characters.)` : "";
      const result = { content: [{ type: "text", text: `${read.source}, read ${new Date(whole.at).toISOString()}:\n\n${whole.result}${cut}` }] };
      onRead?.({ name: whole.name, args: whole.args ?? {}, result });
      return result;
    },
  };
}

/** Mark the turn's egress ledger for a read opened again, as its first call marked the turn that made it. */
export function markRead(ledger, call) {
  if (WEB_READS.has(call?.name)) markUntrusted(ledger); // a page or a search is an outsider's words (`turnWeb.js`)
  else recordRead(ledger, call);
}
