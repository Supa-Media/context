/**
 * The host end of the message bridge: `HostSink`, `HostBridge` and
 * `createHostBridge`. Split out of `../host.ts` — see that facade for why
 * `ready` resends the whole desired state rather than flushing a queue.
 */

import {
  PROTOCOL_VERSION,
  acceptsChange,
  acceptsCommand,
  decode,
  echoes,
  encode,
  TO_HOST_TYPES,
  type EditorCommand,
  type ToGuest,
  type ToHost,
} from "../protocol";

/**
 * Base64 back to bytes.
 *
 * Re-exported rather than defined here: it lives in `files/imageBytes.ts`
 * beside `base64FromBytes`, which is its inverse, so the app has one base64
 * implementation for images rather than one per caller. It moved when the
 * workspace-icon picker needed it — importing it from *this* module would have
 * pulled `EDITOR_BUNDLE`, the whole committed editor build, into the settings
 * panel's import graph.
 */
import { bytesFromBase64 } from "../../imageBytes";
import { webUrl } from "../../webUrl";

export { bytesFromBase64 };

export interface HostSink {
  onChange: (text: string) => void;
  /** A local Yjs update from the durable native guest. */
  onCollaborationUpdate?: (documentId: string, update: string) => void;
  /**
   * Return the new rendered revision when the versioned path accepted a
   * change. `null` means the versioned editor deliberately refused it (for
   * example while its durable snapshot is still loading). `undefined` means
   * this sink is a legacy editor and the host should use onChange instead.
   */
  onVersionedChange?: (text: string, baseSnapshot: string) => string | null | undefined;
  onSave: () => void;
  onFocus?: (focused: boolean) => void;
  /**
   * How tall the document laid out — see the `height` message.
   *
   * The web view is given this height at compact, where it is a child of the
   * note's page scroller and a `flex: 1` there measures to nothing.
   */
  onHeight?: (height: number) => void;
  /** Where the caret is inside the document — see the `caret` message. */
  onCaret?: (caret: { top: number; bottom: number }) => void;
  /** The guest failed to start. A blank rectangle otherwise. */
  onFailed?: (message: string) => void;
  /**
   * A link to another note was followed. See the `open-link` message.
   *
   * `"background"` is a ⌘-click or middle-click and must not move the person:
   * the note opens in a tab behind the one they are reading.
   */
  onOpenNote?: (path: string, mode: "foreground" | "background") => void;
  /**
   * A web link was tapped, and the host has already checked it is `https:`,
   * `http:` or `mailto:`. See the `open-url` case.
   */
  onOpenUrl?: (url: string) => void;
  /**
   * A form block on the note was filled in and submitted.
   *
   * Absent means this surface cannot send one, and the guest is told so rather
   * than left waiting: see the `form-submit` case below, which replies with a
   * refusal instead of dropping the message. A request with no reply is a
   * button that stays on "Sending…" for the rest of the session.
   */
  onSubmitForm?: (submission: {
    formId: string;
    values: ReadonlyArray<{ field: string; value: string }>;
  }) => Promise<{ ok: boolean; message: string }>;
  onReadFormResponses?: (
    responsesPath: string,
  ) => Promise<{ ok: boolean; text?: string; message: string }>;
  onVoteForm?: (vote: {
    formId: string;
    responseId: string;
    vote: "up" | "none";
  }) => Promise<{ ok: boolean; message: string }>;
  onUpdateFormResponse?: (change: {
    formId: string;
    responseId: string;
    values: ReadonlyArray<{ field: string; value: string }>;
  }) => Promise<{ ok: boolean; message: string }>;
  onRetractFormResponse?: (change: {
    formId: string;
    responseId: string;
  }) => Promise<{ ok: boolean; message: string }>;
  /**
   * The bytes behind an image the note embeds, as a `data:` URL.
   *
   * Absent means this surface has no bucket behind it, and the guest is told
   * `null` rather than left waiting — every branch of the two cases below
   * replies, for the reason `onSubmitForm` gives.
   */
  onLoadImage?: (target: string) => Promise<string | null>;
  /** Store a pasted image, and answer with the key to embed. */
  onStoreImage?: (image: {
    bytes: ArrayBuffer;
    contentType: string;
  }) => Promise<{ target: string } | { error: string }>;
  /**
   * Ask the running plugins what they would offer at this point in the line.
   *
   * Absent means this surface has no plugin runtime behind it, and the guest is
   * told so with `setSuggest(false)` rather than left asking — but the guest is
   * a separate bundle that can be paired with a host it does not know, so the
   * `suggest-ask` case below still answers when this is missing. An empty list
   * is a real answer; a dropped request is a completion that never resolves.
   */
  onSuggest?: (line: string, ch: number) => Promise<{ text: string }[]>;
  /** Take the pick. Resolves to the rewritten line, or `null` if nothing
   * answered — including when nobody was asked. */
  onPickSuggestion?: (index: number) => Promise<string | null>;
}

export interface HostBridge {
  /** Authoritative text. A no-op when it is the echo of the last `change`. */
  setDoc: (text: string, revision?: string) => void;
  setRevision: (revision: string) => void;
  /** Set (or clear with null) the canonical Yjs state for durable mode. */
  setCrdtSnapshot: (snapshot: { documentId: string; update: string } | null) => void;
  /** Hold the guest read-only while durable state is loading. */
  setCrdtMode: (enabled: boolean) => void;
  setEditable: (editable: boolean) => void;
  setTheme: (vars: Readonly<Record<string, string>>) => void;
  /** How many points of the editor something else is covering. */
  setInset: (bottom: number) => void;
  /**
   * Which note is open, and which paths the console knows of.
   *
   * A relative link cannot be resolved without the first, and the guest has no
   * other way to learn it — a note's path is not in its bytes.
   */
  setLinks: (path: string | null, paths?: readonly string[]) => void;
  /**
   * Run one of the accessory bar's commands against the editor.
   *
   * Nothing comes back. A command is a transaction inside the guest, and what
   * it produces — a document change — comes back the same way typing does, as
   * an ordinary `change`. A command that reported its own result would be a
   * second path into the draft, and the one that skips `NoteEditor`'s
   * frontmatter.
   */
  run: (command: EditorCommand) => void;
  /**
   * Whether a plugin can be asked for in-editor suggestions right now.
   *
   * The console knows this and the guest cannot: the plugins run out here, in
   * their own sandboxes. Told rather than asked, so that a note on a surface
   * with no plugin running costs no bridge traffic per keystroke — see the
   * `suggest` message.
   */
  setSuggest: (available: boolean) => void;
  /** A raw `onMessage` payload. */
  receive: (raw: string) => void;
  /** Testing seam: what the guest is believed to hold. */
  known: () => string;
}

/**
 * The host end of the bridge.
 *
 * ## Why `ready` resends everything rather than flushing a queue
 *
 * The web view is not listening while it loads, so the first `doc`, `editable`
 * and `theme` all arrive before anything can receive them. A queue would work
 * and would have an ordering to get wrong; sending the whole of the desired
 * state when the guest announces itself has no ordering at all, is idempotent,
 * and — the part a queue does not give you — is also the right behaviour if the
 * web view ever reloads underneath us, which is a state a WKWebView can enter
 * on its own after a memory warning.
 */
/**
 * How many note paths are worth sending across the bridge.
 *
 * See `setLinks`. Chosen as "a large workspace still fits" rather than measured:
 * five thousand keys is a few hundred kilobytes of JSON, once per note opened,
 * and the thing it buys is bare `[[name]]` links resolving. A bucket past it
 * loses that one style rather than paying the cost on every open.
 */
export const LINK_PATHS_CAP = 5000;

/** Two path lists that are the same list. Identity is not enough: the console
 * rebuilds this array as folders load. */
function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function createHostBridge(send: (raw: string) => void, sink: HostSink): HostBridge {
  let ready = false;
  let doc = "";
  let editable = false;
  let vars: Readonly<Record<string, string>> = {};
  let inset = 0;
  /**
   * What the guest is believed to hold.
   *
   * The whole bridge turns on this: typing goes out as `change`, the reducer
   * re-renders with that same text, and writing that round trip back into the
   * editor replaces the document and resets the selection — the caret jumping
   * to the end of the note on every keystroke. Tracked here rather than in the
   * component so it cannot be reset by a re-render.
   */
  let known = "";
  let revision = "";
  let crdtSnapshot: { documentId: string; update: string } | null = null;
  let crdtMode = false;
  let linkPath: string | null = null;
  let linkPaths: readonly string[] | undefined;
  /**
   * Whether a plugin can answer a suggestion right now.
   *
   * `false` to start, which is what every surface is before its plugins have
   * loaded, and resent on `ready` with everything else.
   */
  let suggesting = false;

  const post = (message: ToGuest) => {
    if (!ready) return;
    send(encode(message));
  };

  return {
    setDoc: (text, nextRevision = revision) => {
      /*
        `doc` is assigned BEFORE the echo check, and `known` after it, and the
        difference between those two lines is somebody's unsaved note.

        They are answering different questions. `known` is what the guest is
        believed to hold, so an echo must leave it alone — that is the guard
        that keeps the caret where the person put it. `doc` is what the *next*
        `ready` will be answered with, and an echo is still authoritative text:
        it is the round trip of what the person just typed.

        Assigning it inside the echo branch's shadow froze it at the text the
        note was opened with. A WKWebView reload — which this bridge resends
        state for precisely because one can happen on its own after a memory
        warning — then rewound the editor to that text, and because
        `replaceDocument` is annotated `externalDoc` no `change` came back, so
        `known` was left naming the rewound document and the next keystroke
        overwrote the draft. No undo entry, nothing said. Moving this line back
        under the check looks like tightening the echo guard and is silent data
        loss; see `webviewHost.test.ts`'s second `ready`.
      */
      doc = text;
      revision = nextRevision;
      // A legacy document message explicitly switches the guest out of the
      // durable binding. The next snapshot, if any, re-enters it.
      crdtSnapshot = null;
      crdtMode = false;
      if (echoes(text, known)) return;
      known = text;
      post({ v: PROTOCOL_VERSION, type: "doc", text, ...(revision === "" ? {} : { revision }) });
    },
    setRevision: (nextRevision) => {
      revision = nextRevision;
      post({ v: PROTOCOL_VERSION, type: "revision", revision });
    },
    setCrdtSnapshot: (snapshot) => {
      const hadSnapshot = crdtSnapshot !== null;
      crdtSnapshot = snapshot;
      if (snapshot === null) {
        // A loading/new-note transition must detach the old guest binding.
        // Keeping it alive would let edits for the previous document escape
        // while the new durable state is being recovered.
        if (ready && crdtMode && hadSnapshot) {
          send(encode({ v: PROTOCOL_VERSION, type: "crdtReset" }));
          send(encode({ v: PROTOCOL_VERSION, type: "editable", editable: false }));
        }
        return;
      }
      crdtMode = true;
      post({ v: PROTOCOL_VERSION, type: "crdtSnapshot", ...snapshot });
      post({ v: PROTOCOL_VERSION, type: "editable", editable });
    },
    setCrdtMode: (enabled) => {
      const wasCrdt = crdtMode;
      crdtMode = enabled;
      if (!ready) return;
      if (enabled && !wasCrdt) send(encode({ v: PROTOCOL_VERSION, type: "crdtReset" }));
      send(encode({
        v: PROTOCOL_VERSION,
        type: "editable",
        editable: enabled && crdtSnapshot === null ? false : editable,
      }));
      // Explicitly tear down a prior durable binding even when the legacy text
      // happens to equal the last known rendering and setDoc would otherwise
      // classify it as an echo.
      if (wasCrdt && !enabled) {
        send(encode({ v: PROTOCOL_VERSION, type: "doc", text: doc, ...(revision === "" ? {} : { revision }) }));
      }
    },
    setEditable: (next) => {
      if (next === editable && ready) return;
      editable = next;
      post({
        v: PROTOCOL_VERSION,
        type: "editable",
        editable: crdtMode && crdtSnapshot === null ? false : next,
      });
    },
    setTheme: (next) => {
      vars = next;
      post({ v: PROTOCOL_VERSION, type: "theme", vars: next });
    },
    setInset: (bottom) => {
      if (bottom === inset && ready) return;
      inset = bottom;
      post({ v: PROTOCOL_VERSION, type: "inset", bottom });
    },
    setLinks: (path, paths) => {
      /*
        Capped rather than sent whole. `paths` only improves one link style — a
        bare `[[name]]` — and a bucket's whole key list across a `postMessage`
        on every note open is not a trade worth making for it. Past the cap the
        guest is sent none, and bare links are plain text on the phone: a
        degradation that costs one style and never a wrong destination.
      */
      const capped = paths === undefined || paths.length > LINK_PATHS_CAP ? undefined : paths;
      if (path === linkPath && sameList(capped, linkPaths) && ready) return;
      linkPath = path;
      linkPaths = capped;
      post({ v: PROTOCOL_VERSION, type: "links", path, paths: capped });
    },
    setSuggest: (available) => {
      if (available === suggesting && ready) return;
      suggesting = available;
      post({ v: PROTOCOL_VERSION, type: "suggest", available });
    },
    /**
     * The first of the three refusals a bar key meets.
     *
     * `EditorView.editable.of(false)` does not stop a programmatic edit, and
     * **every key on the accessory bar is one** — so a bar over a note the
     * viewer may not write is not merely useless, it is the exact shape of the
     * bug `editability` documents. The bar is not rendered on such a note in
     * the first place; this is the refusal that does not depend on that
     * staying true.
     *
     * The dismiss key is exempt, because it writes nothing and is the one
     * control that must never be the one that is refused. See `writesDocument`.
     */
    run: (command) => {
      if (!acceptsCommand(editable, command)) return;
      post({ v: PROTOCOL_VERSION, type: "command", command });
    },
    known: () => known,
    receive: (raw) => {
      const message = decode<ToHost>(raw, TO_HOST_TYPES);
      if (message === null) return;
      switch (message.type) {
        case "ready":
          ready = true;
          // Everything, in the order the guest needs it: what it may do, how it
          // is drawn, and only then the note.
          send(encode({
            v: PROTOCOL_VERSION,
            type: "editable",
            editable: crdtMode && crdtSnapshot === null ? false : editable,
          }));
          send(encode({ v: PROTOCOL_VERSION, type: "theme", vars }));
          send(encode({ v: PROTOCOL_VERSION, type: "inset", bottom: inset }));
          send(encode({ v: PROTOCOL_VERSION, type: "links", path: linkPath, paths: linkPaths }));
          send(encode({ v: PROTOCOL_VERSION, type: "suggest", available: suggesting }));
          if (!crdtMode && crdtSnapshot === null) {
            send(encode({ v: PROTOCOL_VERSION, type: "doc", text: doc, ...(revision === "" ? {} : { revision }) }));
            known = doc;
          } else if (crdtSnapshot !== null) {
            send(encode({
              v: PROTOCOL_VERSION,
              type: "crdtSnapshot",
              documentId: crdtSnapshot.documentId,
              update: crdtSnapshot.update,
            }));
            // The initial editable message deliberately held the guest while
            // its canonical state was loading. Release that gate only after
            // the snapshot has crossed the bridge.
            send(encode({ v: PROTOCOL_VERSION, type: "editable", editable }));
          }
          return;
        case "change":
          /**
           * A note this viewer may not write cannot go dirty, whatever the web
           * view says.
           *
           * The guest already refuses — `EditorState.readOnly` is what stops a
           * command, a paste and a drop, which `EditorView.editable` on its own
           * famously does not. This is the second refusal, on the other side of
           * a process boundary, and it is here because "the other side checked"
           * is exactly the assumption that let a read-only drop rewrite a
           * document for a release.
           */
          if (crdtMode || !acceptsChange(editable)) return;
          known = message.text;
          if (sink.onVersionedChange !== undefined) {
            if (typeof message.baseRevision !== "string") return;
            const nextRevision = sink.onVersionedChange(message.text, message.baseRevision);
            if (typeof nextRevision === "string") {
              revision = nextRevision;
              post({ v: PROTOCOL_VERSION, type: "revision", revision });
            } else if (nextRevision === undefined) sink.onChange(message.text);
          } else sink.onChange(message.text);
          return;
        case "crdtUpdate":
          // A stale WebView can finish an update after navigation. Durable
          // mode alone is not an identity check: accept only the snapshot
          // currently authorized by this host bridge.
          if (
            !crdtMode ||
            crdtSnapshot === null ||
            message.documentId !== crdtSnapshot.documentId ||
            !acceptsChange(editable)
          ) return;
          sink.onCollaborationUpdate?.(message.documentId, message.update);
          return;
        case "save":
          if (!acceptsChange(editable)) return;
          sink.onSave();
          return;
        case "focus":
          sink.onFocus?.(message.focused);
          return;
        case "height":
          /*
            A height is a layout, not an edit, so it is not gated on `editable`
            — a note somebody may only read still has to be visible, which is
            the entire bug this message exists for. It is refused when it is not
            a usable number: `Infinity` or a negative would become a `height`
            style, and React Native drops a whole subtree rather than laying out
            a nonsense box.
          */
          if (!Number.isFinite(message.height) || message.height < 0) return;
          sink.onHeight?.(message.height);
          return;
        case "caret":
          if (!Number.isFinite(message.top) || !Number.isFinite(message.bottom)) return;
          sink.onCaret?.({ top: message.top, bottom: message.bottom });
          return;
        case "failed":
          sink.onFailed?.(message.message);
          return;
        /*
          Not gated on `editable`: following a link is reading, and a note
          somebody may only read is exactly the note they are most likely to be
          following links out of.
        */
        case "open-link":
          sink.onOpenNote?.(message.path, message.mode);
          return;
        /*
          A web link, and the one message here that leaves the app.

          **This is exactly the channel `NAVIGATION_ORIGINS` exists to keep
          shut**, reopened on purpose for one gesture, so it is narrowed twice.
          The scheme is allow-listed again on this side — `webUrl` is the same
          function the guest ran, and a string that does not come back from it
          unchanged is refused — because the guest is the side that would be
          compromised. And the sink does not open it silently: `LiveEditor.tsx`
          asks the person first, naming the address, so a script that should
          not exist cannot post a note's contents to a URL without someone
          reading that URL and agreeing to it.

          Not gated on `editable`, for the reason `open-link` is not.
        */
        case "open-url":
          if (typeof message.url !== "string" || webUrl(message.url) !== message.url) return;
          sink.onOpenUrl?.(message.url);
          return;
        /*
          Also not gated on `editable`, and for a stronger reason than the two
          above: a `member` is *always* on a read-only note, and a member
          filling in a form is the case markdown forms exist for. Gating this
          on `editable` would switch the feature off for everybody it is for.

          The reply always goes back, on both branches and on a throw. The
          guest has disabled its button and is showing "Sending…" until one
          arrives, so a swallowed failure is a form that can never be sent
          again without reloading the note.
        */
        /*
          The two image cases. `image-load` is not gated on `editable` — an
          image in a note somebody may only read still has to be visible — and
          `image-store` is, because a paste is a write and the server would
          refuse it anyway: the point of refusing here is that the guest hears
          a sentence instead of watching a paste vanish.
        */
        case "image-load": {
          const { token, target } = message;
          const reply = (src: string | null): void =>
            send(encode({ v: PROTOCOL_VERSION, type: "image-loaded", token, src }));
          const load = sink.onLoadImage;
          if (load === undefined) {
            reply(null);
            return;
          }
          load(target)
            .then((src) => reply(src))
            .catch(() => reply(null));
          return;
        }
        case "image-store": {
          const { token, bytes, contentType } = message;
          const reply = (outcome: { target?: string; error?: string }): void =>
            send(encode({ v: PROTOCOL_VERSION, type: "image-stored", token, ...outcome }));
          if (!editable) {
            reply({ error: "You can’t add an image to this note." });
            return;
          }
          const store = sink.onStoreImage;
          if (store === undefined) {
            reply({ error: "Images can’t be added here." });
            return;
          }
          let decoded: ArrayBuffer;
          try {
            decoded = bytesFromBase64(bytes);
          } catch {
            reply({ error: "That image did not arrive intact." });
            return;
          }
          store({ bytes: decoded, contentType })
            .then((outcome) =>
              reply("target" in outcome ? { target: outcome.target } : { error: outcome.error }),
            )
            .catch((error: unknown) =>
              reply({
                error: error instanceof Error ? error.message : "That image could not be stored.",
              }),
            );
          return;
        }
        case "form-submit": {
          const { token, formId, values } = message;
          const reply = (ok: boolean, text: string): void =>
            send(encode({ v: PROTOCOL_VERSION, type: "form-result", token, ok, message: text }));
          const submit = sink.onSubmitForm;
          if (submit === undefined) {
            reply(false, "This note can’t send responses here.");
            return;
          }
          submit({ formId, values })
            .then((outcome) => reply(outcome.ok, outcome.message))
            .catch((error: unknown) =>
              reply(false, error instanceof Error ? error.message : "That didn’t send."),
            );
          return;
        }
        case "form-responses": {
          const { token, responsesPath } = message;
          const reply = (outcome: { ok: boolean; text?: string; message: string }): void =>
            send(
              encode({
                v: PROTOCOL_VERSION,
                type: "form-responses-result",
                token,
                ...outcome,
              }),
            );
          const read = sink.onReadFormResponses;
          if (read === undefined) {
            reply({ ok: false, message: "Responses are unavailable here." });
            return;
          }
          read(responsesPath)
            .then(reply)
            .catch((error: unknown) =>
              reply({
                ok: false,
                message: error instanceof Error ? error.message : "Responses are unavailable.",
              }),
            );
          return;
        }
        case "form-vote": {
          const { token, formId, responseId, vote } = message;
          const reply = (ok: boolean, text: string): void =>
            send(encode({ v: PROTOCOL_VERSION, type: "form-result", token, ok, message: text }));
          const cast = sink.onVoteForm;
          if (cast === undefined) {
            reply(false, "Voting is unavailable here.");
            return;
          }
          cast({ formId, responseId, vote })
            .then((outcome) => reply(outcome.ok, outcome.message))
            .catch((error: unknown) =>
              reply(false, error instanceof Error ? error.message : "That vote didn’t send."),
            );
          return;
        }
        case "form-update": {
          const { token, formId, responseId, values } = message;
          const reply = (ok: boolean, text: string): void =>
            send(encode({ v: PROTOCOL_VERSION, type: "form-result", token, ok, message: text }));
          const update = sink.onUpdateFormResponse;
          if (update === undefined) {
            reply(false, "Editing is unavailable here.");
            return;
          }
          update({ formId, responseId, values })
            .then((outcome) => reply(outcome.ok, outcome.message))
            .catch((error: unknown) =>
              reply(false, error instanceof Error ? error.message : "Those changes didn’t save."),
            );
          return;
        }
        /*
          Asking is a read and picking is a write, and they are gated
          differently for that reason alone.

          The ask is not gated on `editable`: it sends the caret's line to a
          plugin, and whether a plugin may see note content is decided by
          `maySeeContent` against the `vault:read` grant, out where the
          sandboxes are. A member on a read-only note is exactly who a
          suggesting plugin is for — the same argument the form cases make one
          block up.

          The pick IS gated, because a pick exists to produce an edit.
          `EditorView.editable.of(false)` does not stop a programmatic one, so
          this is the second of the three refusals every edit meets here, on the
          other side of a process boundary from the guest's own `changeFilter`.
          There is no legitimate pick on a note the viewer may not write, so the
          plugin is not troubled for an answer that would be thrown away.
        */
        case "suggest-ask": {
          const { token } = message;
          if (typeof token !== "string") return;
          const reply = (items: { text: string }[]): void =>
            send(encode({ v: PROTOCOL_VERSION, type: "suggest-result", token, items }));
          const ask = sink.onSuggest;
          /*
            The guest is the least trusted thing in this app — it is rendering
            somebody's markdown — and `line` is about to be handed to a
            third-party plugin. A shape check rather than a length cap: the line
            is a line of the note the host itself sent in, so there is no size
            here that is suspicious, but a `line` that arrived as an object
            would reach the sandbox as `[object Object]`.
          */
          if (
            ask === undefined ||
            typeof message.line !== "string" ||
            !Number.isInteger(message.ch) ||
            message.ch < 0
          ) {
            reply([]);
            return;
          }
          ask(message.line, message.ch)
            .then(reply)
            .catch(() => reply([]));
          return;
        }
        case "suggest-pick": {
          const { token } = message;
          if (typeof token !== "string") return;
          const reply = (text: string | null): void =>
            send(encode({ v: PROTOCOL_VERSION, type: "suggest-pick-result", token, text }));
          const pick = sink.onPickSuggestion;
          if (pick === undefined || !acceptsChange(editable) || !Number.isInteger(message.index)) {
            reply(null);
            return;
          }
          pick(message.index)
            .then((text) => reply(typeof text === "string" ? text : null))
            .catch(() => reply(null));
          return;
        }
        case "form-retract": {
          const { token, formId, responseId } = message;
          const reply = (ok: boolean, text: string): void =>
            send(encode({ v: PROTOCOL_VERSION, type: "form-result", token, ok, message: text }));
          const retract = sink.onRetractFormResponse;
          if (retract === undefined) {
            reply(false, "Deleting is unavailable here.");
            return;
          }
          retract({ formId, responseId })
            .then((outcome) => reply(outcome.ok, outcome.message))
            .catch((error: unknown) =>
              reply(false, error instanceof Error ? error.message : "That response wasn’t deleted."),
            );
          return;
        }
      }
    },
  };
}
