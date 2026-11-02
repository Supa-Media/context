/** `list_notes` and `read_note`. */

import { canSee, effectiveVisibility } from "../../privacy/engine.js";
import {
  eligible as collaborationEligible,
  supported as collaborationSupported,
  readDocumentIfStarted,
} from "@context/collaboration";
import { describeDrawing, isDrawingPath, parseDrawing } from "../../../../../packages/drawings/src/excalidraw.js";
import { drawingEmbedLine } from "../../notes/embeds.js";
import { encryptedNoteRefusal, openStoredNote } from "../../notes/sealing.js";
import { forwardPath, readForwarding } from "../../forwarding.js";
import { listVisibleNoteKeys } from "../../notes/visibleKeys.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { normalizePath } from "../../notes/paths.js";
import { probeWithLegacyFallback } from "../../notes/storage.js";
import { splitMessageAnchor } from "../../search/commsIndex.js";
import { toolError, toolText } from "../results.js";
import comments from "../../../../../packages/shared/src/comments.cjs";
import mail from "../../../../../packages/shared/src/mail.cjs";

export async function toolListNotes(store, scope, rules, overrides, prefixArg) {
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix");
  const visible = await listVisibleNoteKeys(store, scope, rules, overrides, prefix);
  if (!visible.length) return toolText("(no visible notes under that prefix)");
  const lines = visible
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, size }) => `${key} (${size} bytes)`);
  return toolText(lines.join("\n"));
}

export async function toolReadNote(store, scope, rules, overrides, pathArg) {
  const named = normalizePath(pathArg);
  if (!named) return toolError("invalid path");
  // A search hit inside a channel-day note is keyed `<notePath>#<anchor>`,
  // and that is the string an agent's next call arrives with. The file is
  // what gets read — it is the unit `canSee` decides and the unit a share
  // link covers — so the anchor is dropped here, exactly as the console's
  // `noteFromQuery` drops it. Without this the one key search prints for a
  // message is the one key `read_note` answers "not found" for.
  const requested = splitMessageAnchor(named).path;
  if (!requested) return toolError("invalid path");
  /*
    **THE REFUSAL MUST COST WHAT THE OTHER REFUSAL COSTS.**

    `canSee` used to refuse right here, before the bucket had been touched at
    all, while a path the caller could have seen went to storage and missed
    first. The two refusals are byte-identical to read — `privacyGroups`
    asserts that — and were 1 storage round trip against 4 to measure. Same
    words, different cost, so the cheap refusal was the one where the manifest
    is holding something back.

    A team connection enumerating names inside a folder it CAN see would learn
    from the cost alone which of them carry an exact-note override, and an
    override is written only when somebody deliberately made a note there
    private. Their own listing cannot tell them that: a held-back note is
    absent from it either way. That is non-negotiable #5's "infer the
    existence of", reached with a clock instead of a read.

    So the lookup runs the same way for everybody and the decision is taken at
    the end. Two things make that safe rather than merely equal:

      - **It is metadata until the last step.** The resolution uses
        `probeWithLegacyFallback`, and the body is fetched only once both
        questions have passed. This matters concretely: `S3Store.get` buffers
        the whole object with `response.arrayBuffer()` before any caller asks
        for text, so resolving an invisible path with a real `get` would pull a
        private note's plaintext into the worker on behalf of somebody who may
        not read it. R2 would not, and the difference between the two adapters
        is exactly why this is a probe.
      - **The forwarding lookup runs whenever the answer will be a refusal**,
        not only when the note is absent. Skipping it for a note that exists
        but is hidden would put the leak back one level down, keyed on
        existence instead of visibility.

    With the id layer (every workspace since 2026-10-22) "is it there" is the
    tree row, and the read asks the tree once (`oneRead`, `store/idLayout.js`):
    that one answer is whether the note is there, which key holds it, and
    which note id its collaboration head is filed under. The bucket is touched
    only after both questions have passed, so every refusal costs the same,
    the lookup and the forwarding read, whether the name is held back, missing,
    or both, and a successful read is the lookup, then the body (2026-11-01:
    it was seven calls one after another, three of them the same lookup).

    A store with no id layer still asks the bucket for metadata first, on the
    terms above.
  */
  const view = typeof store.oneRead === "function" ? store.oneRead(store) : store;
  const seen = canSee(requested, scope, rules, overrides);
  let path = requested;
  let present = await notePresent(view, requested);
  // Asked beside the body, only for a note this caller may read: whether a collaboration document holds it.
  let started = seen && present ? startedDocument(view, requested) : null;
  // Metadata may describe a deletion marker. Resolve only authorized bytes
  // before deciding whether the old path needs forwarding.
  let obj = seen && present ? await getWithLegacyFallback(view, requested) : null;
  if (seen && present && !obj) present = false;
  if (!present || !seen) {
    started = null;
    /*
      A STALE PATH IS FORWARDED, BUT ONLY AFTER IT HAS MISSED.

      The address somebody is holding may be where the note *was* — a link from
      an old chat, a path an agent wrote down, a folder that has since been
      renamed. `forwarding.js` knows where it went, so the miss is worth one
      more lookup before answering "not found".

      **On a miss, never before it.** A path means what it says today: if a
      note now lives at the requested path, that note is the answer, even when
      something else once lived there. Only an address that resolves to nothing
      has anything to gain from a forwarding table — which also keeps the extra
      GET off every successful read.

      `canSee` is re-asked at the destination, so this cannot widen anything:
      a note forwarded into a private folder is not found, exactly as it would
      be if the caller had asked for its current path directly.
    */
    // `null` is a trail into somewhere this caller may not see: not found, as before.
    const forwarded = forwardPath(await readForwarding(view), requested);
    if (forwarded !== null && forwarded !== requested && canSee(forwarded, scope, rules, overrides)) {
      const landed = await notePresent(view, forwarded);
      if (landed && !present && seen) {
        const landedObject = await getWithLegacyFallback(view, forwarded);
        if (landedObject) {
          present = true;
          path = forwarded;
          obj = landedObject;
        }
      }
    }
  }
  // Both questions, asked once, in one place.
  if (!seen || !present) return toolError("not found");
  if (!obj) return toolError("not found");
  const stored = await obj.text();
  // Decrypted here, at request time, and nowhere else. The caller is handed the
  // plaintext plus a line saying the note is encrypted, so an agent can tell
  // its user what they are looking at — and so that a client echoing what it
  // read back into `write_note` is writing plaintext, which is exactly what the
  // write path expects.
  const opened = await openStoredNote(store, stored);
  if (!opened.ok) return encryptedNoteRefusal(path);
  const marker = opened.encrypted ? "\nencryption: v1" : "";
  let collaboration = null;
  if (!opened.encrypted && collaborationSupported(view) && collaborationEligible(path, opened.text)) {
    try {
      // A read starts no document: a note nothing has edited together is its
      // Markdown, served with the Markdown's etag. Starting one costs a first
      // read ~15 storage calls, the most of any part of it, and nothing needs
      // it: every tool that checks an etag names the version the same way
      // (`notes/version.js`), so the Markdown etag is accepted until the note
      // changes.
      collaboration = await (started ?? readDocumentIfStarted(view, path));
    } catch {
      // Once a supported store has initialized collaboration state, the
      // engine's materialized text is authoritative. Serving the raw object
      // after a state read fails could hand an agent stale bytes which its next
      // write would overwrite or reject. Fail closed without exposing bucket
      // state details.
      return toolError("this note cannot be opened safely for collaborative editing right now");
    }
  }
  // The full Yjs snapshot is for the JSON file/browser surface. MCP agents
  // only need the stable document identity and opaque base etag; including
  // megabytes of base64 in prose needlessly consumes their context budget.
  const collaborationMarker = collaboration
    ? `\ndocument_id: ${collaboration.documentId}`
    : "";
  /*
   * A DRAWING IS DESCRIBED, NOT DUMPED.
   *
   * `<name>.excalidraw.md` is a Markdown file whose body is a compressed JSON
   * payload. Returning it verbatim spends the caller's whole context on bytes
   * it cannot decode, so a drawing comes back as `describeDrawing` renders it:
   * what is in it, what the labels say, and which shape points at which. The
   * console draws the real picture from the same parse (`packages/drawings`),
   * so the words and the image never describe different drawings.
   *
   * The etag is still the file's, because it still identifies the file. What a
   * caller must not do is write this text back — `toolWriteNote` refuses that
   * explicitly rather than trusting anyone to notice.
   */
  if (isDrawingPath(path) && !opened.encrypted) {
    const drawing = parseDrawing(opened.text, path);
    return withOpened(toolText(
      `etag: ${obj.etag}\npath: ${path}\nvisibility: ${effectiveVisibility(path, rules, overrides)}\n` +
        `kind: drawing\n\n${describeDrawing(drawing, { path })}\n\n` +
        "*This is a description. The drawing itself is unchanged in the bucket, and " +
        "write_note will not overwrite it with text.*"
    ), { path, text: "", encrypted: false });
  }
  const actualText = collaboration?.text ?? opened.text;
  return withOpened(toolText(
    `etag: ${collaboration?.etag ?? obj.etag}\npath: ${path}\nvisibility: ${effectiveVisibility(path, rules, overrides)}${marker}${collaborationMarker}` +
      // Said out loud rather than served silently: a caller that arrived on a
      // stale address is holding one somewhere, and the next write must use
      // the path it is being given rather than the one it asked for.
      `${path === requested ? "" : `\nmoved_from: ${requested}`}` +
      `${drawingEmbedLine(actualText)}${commentsLine(actualText)}${mailLine(actualText)}\n\n${actualText}`
  ), { path, text: actualText, encrypted: opened.encrypted });
}

/** The most notes one `read_notes` call opens. */
export const READ_NOTES_MAX = 25;

/**
 * `read_notes`: several notes in one call. Every path is looked up in the
 * tree together (`prime`, one round trip for all of them), then each is read
 * exactly as `read_note` reads it, side by side. Each note is its own part of
 * the answer, starting with its path; one that cannot be read says
 * "not found" in the same words whether it is missing or held back, as
 * `read_note` does.
 */
export async function toolReadNotes(store, scope, rules, overrides, pathsArg) {
  if (!Array.isArray(pathsArg) || pathsArg.length === 0) return toolError("paths needs at least one note path");
  if (pathsArg.length > READ_NOTES_MAX) return toolError(`read_notes opens at most ${READ_NOTES_MAX} notes at a time`);
  if (!pathsArg.every((path) => typeof path === "string")) return toolError("every path has to be a string");
  const paths = [...new Set(pathsArg)];
  const view = typeof store.oneRead === "function" ? store.oneRead(store) : store;
  if (typeof view.prime === "function") {
    const named = paths.map((path) => splitMessageAnchor(normalizePath(path) ?? "").path).filter(Boolean);
    await view.prime(named);
  }
  const results = await Promise.all(paths.map((path) => toolReadNote(view, scope, rules, overrides, path)));
  const content = results.map((result, index) => {
    const text = result.content?.map((part) => part.text ?? "").join("\n") ?? "";
    return { type: "text", text: result.isError ? `path: ${paths[index]}\nerror: ${text}` : text };
  });
  const answer = results.every((result) => result.isError) ? { content, isError: true } : { content };
  // The notes it opened, at the paths they were read at, for the activity log (`tools/session.js`). Not enumerable: the client's answer is unchanged.
  const read = results.filter((result) => !result.isError && result.opened?.path).map((result) => result.opened.path);
  return Object.defineProperty(answer, "notesRead", { value: read, enumerable: false });
}

/**
 * Whether a note is at `path`: the tree row where the store has the id layer
 * (`noteAt`, from the read's one lookup), and otherwise the bucket's metadata,
 * never the body (see `toolReadNote`).
 */
async function notePresent(view, path) {
  if (typeof view.noteAt === "function") return (await view.noteAt(path)) !== null;
  return Boolean(await probeWithLegacyFallback(view, path));
}

/**
 * The collaboration document at `path`, asked for at once so its head is read
 * beside the note's body rather than after it, or `null` where there can be
 * none. The answer is used only where the read would have asked anyway
 * (supported store, eligible plain note, at the path it read); otherwise it
 * is dropped. Its failure is held until then, so a dropped one is not thrown.
 */
function startedDocument(view, path) {
  if (!collaborationSupported(view) || !collaborationEligible(path, "")) return null;
  const pending = readDocumentIfStarted(view, path);
  pending.catch(() => {});
  return pending;
}

/**
 * The note a successful read opened, for a tool that reads a note to work on
 * it (`related.js`): where it resolved to, its text, and whether it was
 * encrypted, so nothing parses the answer's header back. Not enumerable, so
 * the answer a client receives is unchanged. A drawing hands over no text.
 */
function withOpened(result, note) {
  return Object.defineProperty(result, "opened", { value: note, enumerable: false });
}

/**
 * One header line when the note carries comments, so an agent that opens a
 * note learns there is feedback waiting and has the ids it needs to answer
 * through `write_note`'s `comment` argument. The threads themselves are in the
 * text below, in the note's own `comments` block.
 */
function commentsLine(text) {
  const described = comments.describeComments(text);
  return described ? `\ncomments: ${described}; answer with write { action: "comment", args: { action: "reply" | "resolve", thread } }` : "";
}

/**
 * One header line when agents have sent each other mail on this note
 * (`tools/notes/mail.js`), so an agent opening it knows the conversation is
 * there and how to join it. The messages are in the note's `mail` block below.
 */
function mailLine(text) {
  const { events } = mail.parseMail(text);
  const sent = events.filter((event) => event.kind === "mail");
  if (!events.length) return "";
  const joined = [...new Set(events.filter((event) => event.kind === "joined").map((event) => event.from))];
  return (
    `\nmail: ${sent.length} message${sent.length === 1 ? "" : "s"}` +
    `${joined.length ? ` between ${joined.join(", ")}` : ""}; ` +
    'read only the mail with fetch { args: { mail: true } }, join with write { action: "mail", args: { join: "name" } }'
  );
}
