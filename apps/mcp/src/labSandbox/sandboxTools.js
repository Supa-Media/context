/**
 * WHAT A TEST TURN'S WRITE TOOLS DO IN THE SANDBOX (Dev2, 2026-11-16: "all the write tools should work but in a sandbox
 * that is discarded, so new notes etc, simulated email sends, we should be generating pages that are working but just
 * are short lived and disappear with the sandbox"; decision `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * `policy.js` `toolAnswer` hands a write tool here before anything else would run it. What is handled here is done in
 * the test chat's own object (`object.js`), never anywhere else:
 *
 *  - `write_note` (not a website action): the note is written into the test chat (`sb_notes`), whole, and a later
 *    turn's `read_note`, `read_notes` or `fetch` of it reads it there (`overlayRead`), and its `list_notes`, `search_notes`
 *    and `search` name it (`afterRead`). A `.page.md` is a page: it is served from the test chat (`pages.js`) at an
 *    address only the test chat's owner can open, and the write carries that `url`;
 *  - `remember`: the line is added to the note in the test chat; a read of a real note then shows it below the note;
 *  - `send_email` and `save_email_draft`: nothing is sent; the write keeps who to, the subject and the whole body, and
 *    `send_email` answers held for the yes of whoever it goes from (`as`, or the person), as the real gate holds it;
 *  - a picture Tex sends (`chatRun.js`'s line, `uploadPicture`): kept in the test chat and served like a page.
 *
 * Everything else that changes something keeps today's answer in `policy.js`: recorded, and answered as done.
 */

import { SANDBOX_TTL_MS } from "../../../../packages/lab/gateway/labSandbox/object.js";
// `MEMORY_FOLDER` in tools/notes/remember.js; importing it here would close an import cycle through the tools.
const MEMORY_FOLDER = "inbox/memories";

/** A page or picture's id: 128 random bits, hex. */
export const assetId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** Where the gateway serves a test chat's page or picture to its owner (`pages.js`). */
export const PAGE_PREFIX = "/tex-lab/sandbox/page/";
/** A write's `body` in the Lab's list is cut here; the note itself is kept whole. */
const WRITE_BODY_CHARS = 20_000;
const CTX = /^@[a-z0-9][a-z0-9-]{0,63}$/;

const said = (text) => ({ content: [{ type: "text", text }] });
const text = (value, most = 2_000) => (typeof value === "string" ? value.slice(0, most) : "");
const list = (value) => (Array.isArray(value) ? value : typeof value === "string" && value !== "" ? [value] : []).filter((v) => typeof v === "string").map((v) => v.slice(0, 200)).slice(0, 50);
const ctxOf = (args) => (typeof args?.context === "string" && CTX.test(args.context) ? args.context : "");
const isPage = (path) => /\.page\.md$/i.test(path);
/** The caller's own workspace as `@name`, lower case, once `tools/session.js` has said it (`gate.ownWorkspace`), else "". */
const ownOf = (gate) => (typeof gate?.ownWorkspace === "string" && CTX.test(gate.ownWorkspace.toLowerCase()) ? gate.ownWorkspace.toLowerCase() : "");
/**
 * Where a call's note lives in the test chat: "" for the caller's own workspace, whether the call named it or not, else
 * the `@name` it named. A plain path and `context: "@own"` are one place, as they are for real (Lab test chat,
 * 2026-11-23: notes written with the own context read as "not found" by plain path, and a job rewrote all six).
 */
function placeOf(args, gate) {
  const ctx = ctxOf(args).toLowerCase();
  return ctx !== "" && ctx === ownOf(gate) ? "" : ctx;
}
/** The places to look for a call's note: its own, then, for the own workspace, a row kept under its name before it was known. */
function placesOf(args, gate) {
  const place = placeOf(args, gate);
  const own = ownOf(gate);
  return place === "" && own !== "" ? ["", own] : [place];
}
/** The test chat's note at `path`, from the first of `places` that holds one, or null. */
async function noteIn(gate, places, path) {
  for (const ctx of places) {
    const found = (await gate.call("note.get", { ctx, path })).found;
    if (found) return found;
  }
  return null;
}
/** Every note the test chat holds in `places`, the first place's copy of a path winning. */
async function notesIn(gate, places) {
  const byPath = new Map();
  for (const ctx of places) for (const note of (await gate.call("note.list", { ctx })).notes ?? []) if (!byPath.has(note.path)) byPath.set(note.path, note);
  return [...byPath.values()];
}

/** The address a test chat's page or picture is served at, or null for a test chat opened before pages were kept. */
export function assetUrl(about, id) {
  if (typeof about?.sandboxId !== "string" || typeof about?.origin !== "string") return null;
  return `${about.origin}${PAGE_PREFIX}${about.sandboxId}/${id}`;
}

/**
 * The write tools a test chat does itself. `gate` is the text's (`harness.js`): `call(op, fields)` reaches the test
 * chat's object, `rowId` the text, `about` the test chat. Answers the tool's result, or null when it is not one of these.
 */
/** Where production files a fact with no note: a new note of its own under the memory folder, named by day and words. */
const memoryPath = (fact) => `${MEMORY_FOLDER}/${new Date().toISOString().slice(0, 10)}-${fact.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "fact"}.md`;

export async function sandboxWrite(name, args, gate) {
  const a = args && typeof args === "object" ? args : {};
  const ctx = ctxOf(a);
  const where = ctx ? ` in ${ctx}` : "";
  if (name === "write_note" && a.site === undefined && typeof a.path === "string" && typeof a.content === "string") {
    const path = a.path.trim().replace(/^\/+/, "");
    await gate.call("note.put", { ctx: placeOf(a, gate), path, body: a.content, by: gate.rowId });
    let url = null;
    if (isPage(path)) {
      const id = assetId();
      url = assetUrl(gate.about, id);
      if (url !== null) await gate.call("asset.put", { id, kind: "page", title: path, type: "text/markdown", ref: JSON.stringify({ ctx, path }), body: "", by: gate.rowId });
    }
    await gate.write({ kind: isPage(path) ? "page" : "note", title: `${path}${where}`, body: a.content.slice(0, WRITE_BODY_CHARS), ...(url ? { url, expires: Date.now() + SANDBOX_TTL_MS } : {}), tool: name });
    return said(`Saved ${path}${where}.${url ? ` The page opens at ${url}` : ""}`);
  }
  if (name === "remember" && typeof a.fact === "string" && a.fact.trim() !== "") {
    const path = typeof a.note === "string" && a.note.trim() !== "" ? a.note.trim().replace(/^\/+/, "") : memoryPath(a.fact);
    const line = `- ${a.fact.trim().replace(/\s+/g, " ").slice(0, 500)}`;
    const kept = (await gate.call("note.get", { ctx: "", path })).found;
    if (kept && kept.body !== null && !kept.gone) {
      const lines = kept.body.split("\n");
      const old = typeof a.replaces === "string" ? lines.findIndex((l) => l.replace(/^- /, "").trim() === a.replaces.replace(/^- /, "").trim()) : -1;
      const body = old >= 0 ? lines.map((l, i) => (i === old ? line : l)).join("\n") : `${kept.body.replace(/\n*$/, "\n")}${line}\n`;
      await gate.call("note.put", { path, body, by: gate.rowId });
    } else {
      // A real note's own text stays where it is; the line is added below it when the test chat reads it.
      await gate.call("note.put", { path, body: line, adds: true, by: gate.rowId });
    }
    await gate.write({ kind: "note", title: path, body: line, tool: name });
    return said(`Remembered in ${path}.`);
  }
  if (name === "send_email" || name === "save_email_draft") {
    const to = list(a.to);
    const subject = text(a.subject, 200);
    const body = text(a.body, WRITE_BODY_CHARS);
    const cc = list(a.cc);
    const who = typeof a.as === "string" && a.as.trim() !== "" ? `@${a.as.trim().replace(/^@/, "")}` : "the person";
    await gate.write({ kind: name === "send_email" ? "email" : "draft", title: subject || "(no subject)", to, ...(cc.length ? { cc } : {}), subject, body, tool: name, sent: false, ...(name === "send_email" ? { held: who } : {}) });
    if (name === "save_email_draft") return said(`Saved a draft "${subject}".`);
    // Held, as the real gate holds every texted email for a yes (`tools/emailGate.js`, `tools/offerFor.js` for `as`);
    // before 2026-11-26 this answered "Sent", and a turn that rightly offered an email for @seyi's 👍 said it had gone.
    return { ...said(`Held for ${who}'s 👍, not sent: "${subject}" to ${to.join(", ") || "nobody"}. In a test chat it stays here.`), held: true };
  }
  return null;
}

/** The text of one read answer. */
const textOf = (result) => (Array.isArray(result?.content) ? result.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "");

/**
 * A read the test chat answers itself: `read_note` (and a `fetch` of a path) of a note a test turn wrote whole, or
 * deleted. Null to read the real one (and `afterRead` adds what the test chat added to it).
 */
export async function overlayRead(name, args, gate) {
  const path = name === "read_note" ? args?.path : name === "fetch" && typeof args?.id === "string" && !/^[a-z]+:/i.test(args.id) ? args.id : null;
  if (typeof path !== "string" || path === "") return null;
  const note = await noteIn(gate, placesOf(args, gate), path.replace(/^\/+/, ""));
  if (!note) return null;
  if (note.gone) return { content: [{ type: "text", text: `There is no note at ${path}.` }], isError: true };
  if (note.body === null) return null;
  const body = [note.body, ...note.adds].join("\n");
  // `read_note` answers as the real one does, its etag and path first, so code that reads a note's header (the nightly's
  // `readAboutMe`, `readWithEtag`) finds it: without them a note the test chat wrote read as missing (Lab, 2026-11-20).
  if (name !== "read_note") return said(body);
  return said(headed(path, body));
}

/** A test chat's note as `read_note` answers one: its etag and path, then its words. */
const headed = (path, body) => `etag: ${labEtag(body)}\npath: ${path.replace(/^\/+/, "")}\n\n${body}`;

/**
 * A real `read_notes` answer (one part per path, `path: X\nerror: ...` for a miss) with each note the test chat wrote
 * whole put in place of its miss. Null when it held none of them.
 */
function readNotesWithOverlay(args, result, notes) {
  const asked = [...new Set(Array.isArray(args?.paths) ? args.paths.filter((p) => typeof p === "string") : [])];
  const parts = Array.isArray(result?.content) ? result.content : [];
  if (asked.length === 0 || parts.length !== asked.length) return null;
  let changed = false;
  const content = parts.map((part, index) => {
    const path = asked[index].replace(/^\/+/, "");
    const note = notes.find((n) => n.path === path);
    if (!note || note.gone || note.body === null || !/^path: [^\n]*\nerror: /.test(part?.text ?? "")) return part;
    changed = true;
    return { type: "text", text: headed(path, [note.body, ...note.adds].join("\n")) };
  });
  if (!changed) return null;
  const missing = content.filter((part) => /^path: [^\n]*\nerror: /.test(part?.text ?? "")).length;
  return missing === content.length ? { content, isError: true } : { content };
}

/** A test chat's own note version: its words' FNV-1a hash, plain so no workspace is named in it (`etagPlace.js`). */
function labEtag(body) {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) h = Math.imul(h ^ body.charCodeAt(i), 0x01000193);
  return `lab-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * A real read with the test chat's own changes put in: a note's added lines below it (`read_note`, `read_notes`), and
 * the notes written here named after a listing or a search whose words they hold. The real answer is never dropped.
 */
export async function afterRead(name, args, result, gate) {
  if (!["read_note", "read_notes", "list_notes", "search_notes", "search"].includes(name)) return result;
  // A real read that missed may be of a note this test chat wrote; only `read_notes` reaches here with one (`overlayRead`
  // answers `read_note` and `fetch` before the real read).
  if (result?.isError === true && name !== "read_notes") return result;
  const notes = await notesIn(gate, placesOf(args, gate));
  if (notes.length === 0) return result;
  if (name === "read_notes") {
    const patched = readNotesWithOverlay(args, result, notes);
    if (patched) result = patched;
    if (result?.isError === true) return result;
  }
  const extra = [];
  if (name === "read_note" || name === "read_notes") {
    const asked = name === "read_note" ? [args?.path] : Array.isArray(args?.paths) ? args.paths : [];
    for (const note of notes) if (note.body === null && note.adds.length > 0 && asked.some((p) => typeof p === "string" && p.replace(/^\/+/, "") === note.path)) extra.push(`Added to ${note.path} in this chat:\n${note.adds.join("\n")}`);
  } else {
    const named = [args?.folder, args?.path, args?.prefix].find((v) => typeof v === "string");
    const folder = typeof named === "string" ? named.replace(/^\/+|\/+$/g, "") : "";
    const words = String(args?.query ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const hit = (note) =>
      name === "list_notes" ? folder === "" || note.path.startsWith(`${folder}/`) : words.length > 0 && words.some((w) => `${note.path}\n${note.body ?? ""}\n${note.adds.join("\n")}`.toLowerCase().includes(w));
    const found = notes.filter(hit).slice(0, 20);
    if (found.length > 0) extra.push(`Also here, written in this chat:\n${found.map((note) => `- ${note.path}`).join("\n")}`);
  }
  if (extra.length === 0) return result;
  return { ...result, content: [...(Array.isArray(result?.content) ? result.content : [{ type: "text", text: textOf(result) }]), { type: "text", text: extra.join("\n\n") }] };
}
