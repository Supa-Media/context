/** `list_notes` and `read_note`. */

import { canSee, effectiveVisibility } from "../../privacy/engine.js";
import { eligible as collaborationEligible, supported as collaborationSupported, readDocument as readCollaborationDocument } from "@context/collaboration";
import { describeDrawing, isDrawingPath, parseDrawing } from "../../../../../packages/drawings/src/excalidraw.js";
import { drawingEmbedLine } from "../../notes/embeds.js";
import { encryptedNoteRefusal, openStoredNote } from "../../notes/sealing.js";
import { forwardPath, readForwarding } from "../../forwarding.js";
import { getVisibleMovedNote, listVisibleNoteKeysWithMoves } from "../../notes/visibleKeys.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { normalizePath } from "../../notes/paths.js";
import { probeWithLegacyFallback } from "../../notes/storage.js";
import { splitMessageAnchor } from "../../search/commsIndex.js";
import { toolError, toolText } from "../results.js";

export async function toolListNotes(store, scope, rules, overrides, prefixArg) {
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix");
  const visible = await listVisibleNoteKeysWithMoves(store, scope, rules, overrides, prefix);
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

    The price is one metadata listing on a successful read. It is paid on the
    hottest tool in the product, deliberately, and it is the only shape that
    makes the two refusals indistinguishable rather than merely close.
  */
  const seen = canSee(requested, scope, rules, overrides);
  let path = requested;
  const found = await getVisibleMovedNote(
    store, scope, rules, overrides, requested, probeWithLegacyFallback,
  );
  let present = Boolean(found.object);
  // The logical path is what the reader is told; the physical one is where the
  // bytes are. A note caught mid-move answers at its source and is reported at
  // its destination, so conflating the two reports the wrong address.
  let physicalPath = found.physicalPath;
  let logicalMove = found.logicalMove === true;
  // Metadata may describe a deletion marker. Resolve only authorized bytes
  // before deciding whether the old path needs forwarding.
  let obj = seen && present ? await getWithLegacyFallback(store, physicalPath) : null;
  if (seen && present && !obj) present = false;
  if (!present || !seen) {
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
    const forwarded = forwardPath(await readForwarding(store), requested);
    if (forwarded !== requested && canSee(forwarded, scope, rules, overrides)) {
      const landed = await getVisibleMovedNote(
        store, scope, rules, overrides, forwarded, probeWithLegacyFallback,
      );
      if (landed.object && !present && seen) {
        const landedObject = await getWithLegacyFallback(store, landed.physicalPath);
        if (landedObject) {
          present = true;
          path = forwarded;
          physicalPath = landed.physicalPath;
          logicalMove = landed.logicalMove === true;
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
  if (!logicalMove && !opened.encrypted && collaborationSupported(store) && collaborationEligible(path, opened.text)) {
    try {
      // Reads must not create a collaboration identity while the raw
      // large-folder materializer still owns the path.
      collaboration = await readCollaborationDocument(store, physicalPath);
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
    return toolText(
      `etag: ${obj.etag}\npath: ${path}\nvisibility: ${effectiveVisibility(path, rules, overrides)}\n` +
        `kind: drawing\n\n${describeDrawing(drawing, { path })}\n\n` +
        "*This is a description. The drawing itself is unchanged in the bucket, and " +
        "write_note will not overwrite it with text.*"
    );
  }
  const actualText = collaboration?.text ?? opened.text;
  return toolText(
    `etag: ${collaboration?.etag ?? obj.etag}\npath: ${path}\nvisibility: ${effectiveVisibility(path, rules, overrides)}${marker}${collaborationMarker}` +
      // Said out loud rather than served silently: a caller that arrived on a
      // stale address is holding one somewhere, and the next write must use
      // the path it is being given rather than the one it asked for.
      `${path === requested ? "" : `\nmoved_from: ${requested}`}` +
      `${drawingEmbedLine(actualText)}\n\n${actualText}`
  );
}
