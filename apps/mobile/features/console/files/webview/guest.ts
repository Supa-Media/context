/**
 * The half of the editor that runs inside the `WebView`.
 *
 * This is the same CodeMirror the console runs on a laptop — `editorSetup.ts`
 * builds the configuration for both — wired to a JSON bridge instead of to
 * React. Nothing here is React Native, nothing here is React, and nothing here
 * imports anything from `features/` that is not pure: esbuild compiles this
 * file for WKWebView (see `build.mjs`), and Metro never sees it.
 *
 * ## Why it takes a bridge rather than talking to `window`
 *
 * `window.ReactNativeWebView` exists only inside a real web view. Taking the
 * two functions it provides as an argument means the whole of this file runs
 * under jsdom in the ordinary Jest suite, against a real `EditorView` and a
 * real lezer tree, with a bridge that pushes messages into an array. That is
 * how `webviewBridge.test.ts` can prove the thing this file most needs proving —
 * that a read-only note refuses a programmatic edit — without a simulator.
 *
 * `entry.ts` is the ten lines that supply the real bridge.
 *
 * ## What crosses, and what does not
 *
 * Text, an `editable` flag, a palette, a keyboard inset, and a save. The
 * selection does not cross, and preserving it is the reason: see `echoes`.
 */

import { EditorView } from "@codemirror/view";
import { Compartment, StateEffect } from "@codemirror/state";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import {
  editability,
  editorStateFor,
  replaceDocument,
  runCommand,
  type EditorHandlers,
  type HandlerRef,
} from "../editorSetup";
import type { NoteLinkRef } from "../noteLinks";
import type { FormHostRef } from "../formBlock";
import type { ImageHostRef } from "../imageBlock";
import { pluginSuggestSource, type PluginSuggestRef } from "../pluginSuggest";
import {
  PROTOCOL_VERSION,
  acceptsChange,
  acceptsCommand,
  decode,
  decodeCommand,
  echoes,
  TO_GUEST_TYPES,
  type ToGuest,
  type ToHost,
} from "./protocol";

/**
 * The suggestions off the wire, or none of them.
 *
 * `decode` proves a message is one of ours and says nothing about its payload,
 * and this payload becomes a list somebody picks from. So it is checked here —
 * `decodeCommand`'s rule, one level in.
 *
 * **All or nothing, and the reason is the pick.** A pick crosses back as an
 * *index* into this same list, which the host routes to the plugin that offered
 * it, which indexes its own array with it. Dropping the one malformed row and
 * offering the other nine would be the obvious kindness and would renumber
 * every row after it: the reader picks the label they read and the plugin
 * rewrites their line from the row below it. A list that cannot be picked from
 * correctly is not a list worth showing, and a silent list is a plugin that
 * looks like it has nothing to say rather than one that says the wrong thing.
 *
 * In practice nothing legitimate trips this — the items reach the host already
 * parsed out of a sandbox message — which is the point: if it ever fires,
 * something upstream is wrong and guessing is the worst available response.
 */
function suggestItems(value: unknown): { text: string }[] {
  if (!Array.isArray(value)) return [];
  const items: { text: string }[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return [];
    const { text } = item as { text?: unknown };
    if (typeof text !== "string") return [];
    items.push({ text });
  }
  return items;
}

export interface GuestBridge {
  /** Hand a message to the host. */
  post: (message: ToHost) => void;
  /** Receive messages from the host. Called once, on mount. */
  listen: (handler: (raw: string) => void) => void;
  /**
   * Run `flush` no more than once before the next frame.
   *
   * Injected so a test can drive it synchronously, and so this file states the
   * coalescing rule rather than assuming `requestAnimationFrame` exists. See
   * `coalesce` for why one frame is the right bound.
   */
  schedule?: (flush: () => void) => void;
}

export interface MountedGuest {
  view: EditorView;
  destroy: () => void;
  /** Deliver a raw message as if it had come from the host. Used by tests. */
  receive: (raw: string) => void;
}

/**
 * Post at most once per frame, always with the newest text.
 *
 * The naive bridge posts on every keystroke, and on a document editor that is a
 * message, a JSON parse, a `setState` and a React re-render of the console per
 * character. The naive fix — a timer debounce — is worse in a way that is easy
 * to miss: `state.draft` is what the Save button writes and what
 * `guardLeaving` reads, so a debounce makes it possible to type, tap Save
 * within the debounce window, and save the previous text.
 *
 * One post per frame has neither problem. A burst — a paste, an autocorrect
 * replacement, a fast typist, an IME commit — collapses to one message, and the
 * host is never more than a frame behind, which no finger can outrun. The
 * pending post reads the current text at flush time rather than capturing it,
 * so a document replaced while a post was queued reports the replacement and
 * not the text it replaced.
 */
export function coalesce(
  send: () => void,
  schedule: (flush: () => void) => void,
): { request: () => void; cancel: () => void } {
  let pending = false;
  let cancelled = false;
  return {
    request: () => {
      if (pending || cancelled) return;
      pending = true;
      schedule(() => {
        pending = false;
        if (!cancelled) send();
      });
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

const defaultSchedule = (flush: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 0);
};

/**
 * How tall the document laid out, including the scroller's own padding.
 *
 * **Measured off the content rather than read off the scroller.**
 * `scrollHeight` would be the obvious answer and it latches: it never reports
 * less than the element's own client height, so once the host had sized the web
 * view to a long note the number could never come back down for a short one.
 * `.cm-content` carries the document's full height whether or not the scroller
 * is showing all of it — CodeMirror's height oracle keeps a `min-height` on it
 * for exactly this reason — so it is the honest measurement in both directions.
 *
 * The padding is added because it is real space the note occupies: `--lp-pad-top`
 * and `--lp-pad-bottom` are the note's own top and bottom margin, and a web view
 * cut to the content alone would clip the last line's descenders against the
 * durability row below it.
 */
export function documentHeight(view: EditorView): number {
  const scroller = view.scrollDOM;
  const style = scroller.ownerDocument.defaultView?.getComputedStyle(scroller);
  const padding =
    style === undefined
      ? 0
      : (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  return Math.ceil(view.contentDOM.getBoundingClientRect().height + padding);
}

/**
 * Where the caret sits, in pixels from the top of the editor.
 *
 * `null` when CodeMirror cannot answer — a position outside the rendered
 * viewport, a document that has not laid out yet — because a caret message
 * carrying a guessed number would move somebody's note under their thumb for no
 * reason. Nothing is sent in that case; the next selection change asks again.
 *
 * The exception is a caret that is not in the document at all: a table cell is
 * `contenteditable` DOM belonging to a widget, so the element with focus is
 * where the person is looking and `state.selection` is not.
 *
 * `coordsAtPos` **measures**, and measuring is the one thing in CodeMirror that
 * can throw rather than return nothing: it forces a layout read through the
 * DOM's range APIs, which are absent under jsdom and can fail on a real page
 * mid-reflow. A caret position is a nicety — it decides whether the page
 * scrolls a little — so it is never worth taking the editor down with it.
 */
export function caretBox(view: EditorView): { top: number; bottom: number } | null {
  try {
    const box = view.scrollDOM.getBoundingClientRect();
    /*
      A caret in a widget's own editable DOM — a table cell — is not in the
      document's selection, which is still wherever it was before the cell was
      tapped. Measuring that would scroll the note to a line nobody is looking
      at and leave the keyboard over the cell being typed in, so the element
      with focus answers for itself. See `TableGridWidget`.
    */
    const active = view.dom.ownerDocument.activeElement;
    if (active instanceof HTMLElement && active !== view.contentDOM && view.dom.contains(active)) {
      const rect = active.getBoundingClientRect();
      return { top: rect.top - box.top, bottom: rect.bottom - box.top };
    }
    const coords = view.coordsAtPos(view.state.selection.main.head);
    if (coords === null) return null;
    return { top: coords.top - box.top, bottom: coords.bottom - box.top };
  } catch {
    return null;
  }
}

/**
 * Write the palette onto the document.
 *
 * The host sends values, never a scheme name: there are two palettes in
 * `tokens.ts` and the rule that keeps them working is that no module holds one.
 * A web view that decided its own colours would be a third palette, and the one
 * nobody would remember to update.
 */
export function applyTheme(
  target: { style: { setProperty: (name: string, value: string) => void } },
  vars: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(vars)) {
    // Only our own namespace, and only plain values. The host is trusted, but
    // this is the one place a string from outside becomes CSS, and a property
    // name is the cheapest thing in the world to constrain.
    if (!/^--lp-[a-z0-9-]+$/.test(name)) continue;
    target.style.setProperty(name, value);
  }
}

export function mountGuest(
  root: HTMLElement,
  bridge: GuestBridge,
  documentElement?: HTMLElement,
): MountedGuest {
  const schedule = bridge.schedule ?? defaultSchedule;
  const editableCompartment = new Compartment();

  /**
   * What the editor is known to hold, and what the host is known to have been
   * told. The one guard the whole bridge turns on — see `echoes` in
   * `protocol.ts`.
   */
  let latest = "";
  let latestRevision = "";
  /**
   * The editor starts refusing writes and is told otherwise by the host.
   *
   * The safe direction: a bundle that never receives its first `editable`
   * message — a bridge that failed, a host that crashed on mount — leaves a
   * note that cannot be typed into rather than one that can be typed into and
   * never saved.
   */
  let editable = false;
  /**
   * How much of the editor the keyboard, and the accessory bar riding on it,
   * are covering.
   *
   * Held here and read through a closure rather than compartmented into the
   * configuration, because it is consulted at *measure* time: the extension
   * below asks for the current number every time CodeMirror scrolls something
   * into view, so an `inset` message changes where the caret is allowed to sit
   * without reconfiguring the editor. See `coveredBottom`.
   */
  let inset = 0;

  /** The durable binding is installed only after its canonical snapshot. */
  const crdtCompartment = new Compartment();
  const remoteOrigin = { nativeRemote: true };
  let crdt: {
    documentId: string;
    doc: Y.Doc;
    text: Y.Text;
    onUpdate: (update: Uint8Array, origin: unknown) => void;
  } | null = null;
  let crdtReady = false;
  // Durable mode stays read-only between document navigation and its
  // canonical snapshot. This is separate from `crdt !== null`: a reset has no
  // binding, but must not fall back to the legacy text editor.
  let durableMode = false;
  let applyingRemote = false;

  const bytesFromBase64 = (value: string): Uint8Array => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };

  const handlers: HandlerRef = {
    current: {
      onChange: () => {},
      onSave: () => {},
    } satisfies EditorHandlers,
  };

  /**
   * What a link in this note points at, and what to do when one is followed.
   *
   * `path` starts `null`, which is the extension's own "draw no links": the
   * guest is built before it is told anything, and a relative link has nothing
   * to be relative to until the host sends `links`. The callback posts rather
   * than navigates — the guest has no idea what a note *is*, only that one was
   * asked for, and with which gesture.
   */
  const links: NoteLinkRef = {
    current: {
      path: null,
      onOpen: (path, mode) => bridge.post({ v: PROTOCOL_VERSION, type: "open-link", path, mode }),
    },
  };

  /**
   * Submissions and votes in flight, by the token that will answer them.
   *
   * A map rather than a single pending promise because two forms on one note
   * are two widgets with two buttons, and somebody can press both. The entry
   * is deleted by whichever settles it, so a reply for a token that has already
   * been answered — a duplicate delivery, a host that replied twice — finds
   * nothing and changes nothing.
   */
  const pendingForms = new Map<string, (outcome: { ok: boolean; message: string }) => void>();
  const pendingResponses = new Map<
    string,
    (outcome: { ok: boolean; text?: string; message: string }) => void
  >();
  let formToken = 0;

  /**
   * The images this note is waiting on, and the pastes in flight.
   *
   * Same arrangement as the forms above, for the same reason: a note can hold
   * several images and they all load at once, so each reply carries the token of
   * its request. A row asks again on every rebuild, so the host is the thing
   * that caches — the guest holds no bytes beyond the `<img>` that is showing
   * them.
   */
  const pendingImages = new Map<string, (src: string | null) => void>();
  const pendingStores = new Map<
    string,
    (outcome: { target: string } | { error: string }) => void
  >();
  let imageToken = 0;

  /** Base64 for the bridge, chunked so a large paste cannot blow the stack. */
  const base64Of = (bytes: ArrayBuffer | Uint8Array): string => {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = "";
    const CHUNK = 0x8000;
    for (let index = 0; index < view.length; index += CHUNK) {
      binary += String.fromCharCode(...view.subarray(index, index + CHUNK));
    }
    return btoa(binary);
  };

  /**
   * Images, over the bridge.
   *
   * `load` resolves to whatever the host says, `null` included: a host that
   * cannot find the image is the same answer as a surface that has no bucket,
   * and the row draws its own absence either way. Neither call times out, for
   * the reason the forms above give — the host replies on every branch, and a
   * host that does not is a bug in the host rather than something to paper over
   * with a spinner that gives up.
   */
  const images: ImageHostRef = {
    current: {
      load: (target) =>
        new Promise((resolve) => {
          const token = `i${++imageToken}`;
          pendingImages.set(token, resolve);
          bridge.post({ v: PROTOCOL_VERSION, type: "image-load", token, target });
        }),
      upload: (image) =>
        new Promise((resolve) => {
          const token = `s${++imageToken}`;
          pendingStores.set(token, resolve);
          bridge.post({
            v: PROTOCOL_VERSION,
            type: "image-store",
            token,
            bytes: base64Of(image.bytes),
            contentType: image.contentType,
          });
        }),
    },
  };

  /**
   * Send one filled-in form to the host and wait for its answer.
   *
   * The promise is deliberately one that **can stay pending**: there is no
   * timeout here, because the only thing a timeout could do is tell somebody
   * their bug report failed when it may well have landed, and the response file
   * has no idempotency key to make a retry safe. A host that never replies is a
   * bug in the host, and the `form-submit` case there replies on every branch
   * including the absent-capability one for exactly this reason.
   */
  const forms: FormHostRef = {
    generation: 0,
    current: {
      submit: (submission) =>
        new Promise((resolve) => {
          const token = `f${++formToken}`;
          pendingForms.set(token, resolve);
          bridge.post({
            v: PROTOCOL_VERSION,
            type: "form-submit",
            token,
            formId: submission.formId,
            values: submission.values.map((entry) => ({ ...entry })),
          });
        }),
      readResponses: (responsesPath) =>
        new Promise((resolve) => {
          const token = `r${++formToken}`;
          pendingResponses.set(token, resolve);
          bridge.post({
            v: PROTOCOL_VERSION,
            type: "form-responses",
            token,
            responsesPath,
          });
        }),
      vote: (vote) =>
        new Promise((resolve) => {
          const token = `v${++formToken}`;
          pendingForms.set(token, resolve);
          bridge.post({ v: PROTOCOL_VERSION, type: "form-vote", token, ...vote });
        }),
      update: (change) =>
        new Promise((resolve) => {
          const token = `u${++formToken}`;
          pendingForms.set(token, resolve);
          bridge.post({ v: PROTOCOL_VERSION, type: "form-update", token, ...change });
        }),
      retract: (change) =>
        new Promise((resolve) => {
          const token = `d${++formToken}`;
          pendingForms.set(token, resolve);
          bridge.post({ v: PROTOCOL_VERSION, type: "form-retract", token, ...change });
        }),
    },
  };

  /**
   * A plugin's in-editor suggestions, asked for across the bridge.
   *
   * Empty to start, and that is the meaningful state rather than a placeholder:
   * `pluginSuggestSource` answers `null` without sending anything while `ask`
   * is absent, so a note on a surface with no plugin running costs no bridge
   * traffic at all. The host fills it in with a `suggest` message when a plugin
   * that can answer is running, and empties it again when none is.
   *
   * A ref the source reads at call time, for the reason `pluginSuggest.ts`
   * gives at length: the editor's state is built once, so a source handed the
   * callbacks directly would hold whatever was true at mount for the life of
   * the editor — and "no plugin was running when this note was opened" is the
   * commonest thing that is true at mount and false a second later.
   */
  const suggests: PluginSuggestRef = {};
  /**
   * Asks and picks in flight, by the token that will answer them.
   *
   * Two maps and not one because the two answers are different shapes, and a
   * single map would make "a list of items" and "a rewritten line" the same
   * kind of thing one `settle` away from being inserted into a note. Each entry
   * is deleted by whichever settles it, so a duplicate reply finds nothing.
   */
  const pendingSuggests = new Map<string, (items: { text: string }[]) => void>();
  const pendingPicks = new Map<string, (text: string | null) => void>();
  let suggestToken = 0;

  const view = new EditorView({
    state: editorStateFor({
      doc: "",
      editable: false,
      editableCompartment,
      handlers,
      links,
      forms,
      images,
      /*
        Always installed, never conditional. The source is the thing that reads
        `suggests` at call time; installing it only when a plugin happened to be
        running at mount would be the exact staleness the ref exists to avoid,
        and `override` is one list on one facet, so it cannot be added later.
      */
      pluginSuggest: pluginSuggestSource(suggests),
      insetBottom: () => inset,
    }),
    parent: root,
  });
  // Keep the binding independently reconfigurable from editorSetup's stable
  // update listener. It starts empty and read-only until the canonical state.
  view.dispatch({ effects: StateEffect.appendConfig.of(crdtCompartment.of([])) });

  const effectiveEditable = (): boolean =>
    editable && (!durableMode || (crdt !== null && crdtReady));
  const configureEditable = (): void => {
    view.dispatch({ effects: editableCompartment.reconfigure(editability(effectiveEditable())) });
  };

  const destroyCrdt = (): void => {
    const current = crdt;
    crdt = null;
    crdtReady = false;
    if (current !== null) {
      current.doc.off("update", current.onUpdate);
      current.doc.destroy();
      view.dispatch({
        effects: [
          crdtCompartment.reconfigure([]),
          editableCompartment.reconfigure(editability(effectiveEditable())),
        ],
      });
    } else {
      configureEditable();
    }
  };

  const applyCrdtSnapshot = (documentId: string, encoded: string): void => {
    durableMode = true;
    if (crdt !== null && crdt.documentId === documentId) {
      try {
        applyingRemote = true;
        Y.applyUpdate(crdt.doc, bytesFromBase64(encoded), remoteOrigin);
      } catch {
        return;
      } finally {
        applyingRemote = false;
      }
      crdtReady = true;
      latest = crdt.text.toString();
      forms.generation = (forms.generation ?? 0) + 1;
      heights.request();
      configureEditable();
      return;
    }

    destroyCrdt();
    const doc = new Y.Doc();
    const text = doc.getText("note");
    try {
      Y.applyUpdate(doc, bytesFromBase64(encoded), remoteOrigin);
    } catch {
      doc.destroy();
      return;
    }
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (applyingRemote || origin === remoteOrigin || crdt?.documentId !== documentId) return;
      bridge.post({
        v: PROTOCOL_VERSION,
        type: "crdtUpdate",
        documentId,
        update: base64Of(update),
      });
    };
    crdt = { documentId, doc, text, onUpdate };
    crdtReady = false;
    doc.on("update", onUpdate);
    latest = text.toString();
    latestRevision = "";
    forms.generation = (forms.generation ?? 0) + 1;
    // Seed CodeMirror before installing yCollab. Its initial synchronisation
    // reads the editor buffer; doing this in the opposite order would turn the
    // canonical seed into a fresh local insertion and emit an update.
    replaceDocument(view, latest);
    view.dispatch({
      effects: [
        crdtCompartment.reconfigure(yCollab(text, null)),
        editableCompartment.reconfigure(editability(false)),
      ],
    });
    crdtReady = true;
    configureEditable();
    heights.request();
  };

  let changeBaseRevision = "";
  let changePending = false;
  const changes = coalesce(
    () => {
      bridge.post({ v: PROTOCOL_VERSION, type: "change", text: latest, baseRevision: changeBaseRevision });
      changePending = false;
    },
    schedule,
  );

  /**
   * The document's height, reported whenever it can have changed.
   *
   * Coalesced through the same one-a-frame rule as `changes`, and for a sharper
   * reason: this number is a *layout* on the host, so a message per keystroke
   * would be a React Native layout pass per keystroke on the most expensive
   * mount in the app. One a frame is a resize the eye cannot outrun.
   */
  const heights = coalesce(
    () => bridge.post({ v: PROTOCOL_VERSION, type: "height", height: documentHeight(view) }),
    schedule,
  );
  /** See the `caret` message. Nothing is sent when CodeMirror cannot answer. */
  const carets = coalesce(() => {
    const box = caretBox(view);
    if (box === null) return;
    bridge.post({ v: PROTOCOL_VERSION, type: "caret", top: box.top, bottom: box.bottom });
  }, schedule);

  handlers.current = {
    onChange: (text) => {
      // Recorded synchronously even though the post is deferred: this is what
      // an incoming `doc` is compared against, and a stale copy of it is the
      // caret jumping to the end of the note.
      if (!changePending) changeBaseRevision = latestRevision;
      changePending = true;
      latest = text;
      // A change on a note the viewer may not write should be impossible —
      // `EditorState.readOnly` refuses commands, paste and drop. If one gets
      // here anyway it is not reported, because reporting it is what turns a
      // failed edit into a dirty draft and a Save that will be refused.
      if (!acceptsChange(effectiveEditable())) return;
      // In durable mode y-codemirror has already produced the Yjs update and
      // the Y.Doc observer owns the bridge message. The text callback remains
      // useful for layout and legacy mode, but must never send a second full
      // text edit for the same transaction.
      if (crdt !== null) {
        heights.request();
        carets.request();
        return;
      }
      changes.request();
      // An edit is the commonest way both of these move: a line added makes the
      // document taller, and the caret is wherever the typing left it. The
      // ResizeObserver below would catch the height a frame later; asking here
      // means the host resizes in the same frame it receives the text.
      heights.request();
      carets.request();
    },
    onSave: () => bridge.post({ v: PROTOCOL_VERSION, type: "save" }),
  };

  const apply = (message: ToGuest): void => {
    switch (message.type) {
      case "doc": {
        // A legacy doc is an explicit mode switch. Tear down the old Y.Doc even
        // when its rendered text happens to be identical.
        durableMode = false;
        if (crdt !== null) destroyCrdt();
        else configureEditable();
        if (echoes(message.text, latest)) return;
        latest = message.text;
        latestRevision = message.revision ?? "";
        forms.generation = (forms.generation ?? 0) + 1;
        // Not an edit, the one write a read-only note still accepts, and not an
        // entry in the undo history. All three live in `replaceDocument`.
        replaceDocument(view, message.text);
        // A different note is a different height, and this is the one document
        // change that does not go through `onChange`.
        heights.request();
        return;
      }
      case "revision":
        latestRevision = message.revision;
        return;
      case "crdtSnapshot":
        applyCrdtSnapshot(message.documentId, message.update);
        return;
      case "crdtReset":
        durableMode = true;
        destroyCrdt();
        return;
      case "editable": {
        editable = message.editable;
        configureEditable();
        return;
      }
      case "theme": {
        applyTheme(documentElement ?? root, message.vars);
        // The palette carries the *measure* too — type size, leading, the note's
        // own padding — so a theme message reflows the document.
        heights.request();
        return;
      }
      case "suggest": {
        if (message.available) {
          suggests.ask = (line, ch) =>
            new Promise((resolve) => {
              const token = `s${++suggestToken}`;
              pendingSuggests.set(token, resolve);
              bridge.post({ v: PROTOCOL_VERSION, type: "suggest-ask", token, line, ch });
            });
          suggests.pick = (index) =>
            new Promise((resolve) => {
              const token = `p${++suggestToken}`;
              pendingPicks.set(token, resolve);
              bridge.post({ v: PROTOCOL_VERSION, type: "suggest-pick", token, index });
            });
        } else {
          /*
            Deleted rather than set to a function that answers nothing, because
            `pluginSuggestSource` reads `ask === undefined` as "there is nobody
            to ask" and returns before it has built a completion at all. A stub
            would be a source that runs, awaits and resolves empty on every
            keystroke — the cost this message exists to avoid.

            Anything already in flight still settles: the promises were made
            before this arrived and the host answers every request it receives.
          */
          delete suggests.ask;
          delete suggests.pick;
        }
        return;
      }
      case "suggest-result": {
        const settle = pendingSuggests.get(message.token);
        pendingSuggests.delete(message.token);
        settle?.(suggestItems(message.items));
        return;
      }
      case "suggest-pick-result": {
        const settle = pendingPicks.get(message.token);
        pendingPicks.delete(message.token);
        /*
          The one reply on this protocol that becomes an **edit**, so its type
          is checked rather than trusted — `decodeCommand`'s rule, one level in.
          Anything that is not a string is `null`, which `pluginSuggestSource`
          reads as "nothing answered" and writes nothing for.

          Measured rather than assumed: taking this check out and answering a
          pick with an object does not insert `[object Object]`, it **wedges**.
          CodeMirror's `insert` takes a string or a `Text`, and handed neither it
          does not return — the test suite stops producing output rather than
          failing. A hung editor on somebody's phone, from one malformed reply.
        */
        settle?.(typeof message.text === "string" ? message.text : null);
        return;
      }
      case "form-result": {
        const settle = pendingForms.get(message.token);
        // Deleted before the callback runs, so a resolver that somehow posts
        // again cannot be answered by this same entry.
        pendingForms.delete(message.token);
        settle?.({ ok: message.ok, message: message.message });
        return;
      }
      case "image-loaded": {
        const settle = pendingImages.get(message.token);
        // Deleted before the callback runs, as `form-result` is and for the
        // same reason.
        pendingImages.delete(message.token);
        settle?.(typeof message.src === "string" ? message.src : null);
        return;
      }
      case "image-stored": {
        const settle = pendingStores.get(message.token);
        pendingStores.delete(message.token);
        settle?.(
          typeof message.target === "string"
            ? { target: message.target }
            : { error: message.error ?? "That image could not be stored." },
        );
        return;
      }
      case "form-responses-result": {
        const settle = pendingResponses.get(message.token);
        pendingResponses.delete(message.token);
        settle?.({ ok: message.ok, text: message.text, message: message.message });
        return;
      }
      case "links": {
        /*
          Replaced whole rather than merged. A note with no bare links sends no
          `paths`, and merging would leave the previous note's list in place —
          which is the shape that resolves `[[name]]` against a context nobody
          is in any more.
        */
        links.current = {
          ...links.current,
          path: message.path,
          paths: message.paths,
        };
        // The decorations are built by a view plugin keyed on document and
        // viewport changes, and this is neither: without a nudge the note that
        // arrived a moment ago would show its links only after the first
        // keystroke.
        view.dispatch({});
        return;
      }
      case "inset": {
        inset = Math.max(0, message.bottom);
        applyTheme(documentElement ?? root, { "--lp-inset-bottom": `${inset}px` });
        /*
          The keyboard has just covered part of the note, and the caret may be
          under it. Three things have to be true for it to come back out, and
          only the third of them is this line:

           - the scroller has to be able to scroll that far, which is the
             padding written above;
           - "in view" has to mean *above the keyboard*, which is the scroll
             margin `inset` now feeds — without it CodeMirror is satisfied by a
             caret anywhere inside the web view's rectangle, and the web view
             keeps its full height while the keyboard is drawn over it;
           - and something has to ask, which is this.

          The first two also apply to every subsequent keystroke, because
          CodeMirror scrolls the caret into view for itself on typed input and
          consults the same facet when it does.
        */
        view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
        return;
      }
      case "command": {
        /**
         * A key on the accessory bar, run against the real editor state.
         *
         * Two refusals before the command runs, and a third inside it.
         * `decodeCommand` is the guest declining to act on a shape it does not
         * recognise — the host builds these, but the guest is a separate bundle
         * that can be paired with a host it does not know, which is the same
         * reason `decode` exists one level up.
         *
         * `acceptsCommand` is the read-only gate, and it is here as well as on
         * the host for exactly the reason `acceptsChange` is: **every key on
         * this bar except the dismiss key is a programmatic edit**, and "the
         * other side checked" is the assumption that made
         * `EditorView.editable.of(false)` look sufficient for a year.
         * `runCommand` checks the live facet a third time, which is the one
         * that cannot be got round by a stale `editable` in this closure.
         */
        const command = decodeCommand(message.command);
        if (command === null) return;
        if (!acceptsCommand(effectiveEditable(), command)) return;
        runCommand(view, command);
        return;
      }
    }
  };

  const receive = (raw: string): void => {
    const message = decode<ToGuest>(raw, TO_GUEST_TYPES);
    if (message === null) return;
    apply(message);
  };

  bridge.listen(receive);

  /*
    `focusin` and `focusout` on the editor's own root, rather than `focus` and
    `blur` on `contentDOM`.

    A table cell is `contenteditable` DOM belonging to a widget, so somebody
    typing in a grid has the caret in the note and `contentDOM` does **not**
    have focus (see `TableGridWidget`). The old pair reported that as a blur,
    and on a phone the accessory bar is the only way out of the keyboard — so
    tapping a cell put the keyboard up and took away the bar that dismisses it.

    `focus` and `blur` do not bubble and `focusin` and `focusout` do, which is
    the whole of why the event names change. Moving between two cells is not
    leaving the note, so a `focusout` whose destination is still inside the
    editor reports nothing.
  */
  let focused = false;
  const report = (next: boolean): void => {
    if (next === focused) return;
    focused = next;
    bridge.post({ v: PROTOCOL_VERSION, type: "focus", focused: next });
    // The keyboard is about to come up over the note. Where the caret is is
    // the question the host is about to have to answer.
    if (next) carets.request();
  };
  const onFocus = () => report(true);
  const onBlur = (event: FocusEvent) => {
    const to = event.relatedTarget;
    if (to instanceof Node && view.dom.contains(to)) return;
    report(false);
  };
  view.dom.addEventListener("focusin", onFocus);
  view.dom.addEventListener("focusout", onBlur);

  /*
    Moving the caret without changing the document — an arrow key, a tap into
    another paragraph, an autocorrect replacement's selection — reaches nothing
    else in this file. `selectionchange` is a document-level event, which is why
    it is added to the owner document rather than to the editor.
  */
  const owner = view.contentDOM.ownerDocument;
  const onSelectionChange = () => carets.request();
  owner.addEventListener("selectionchange", onSelectionChange);

  /*
    Everything else that changes the document's height: a rotation, a width
    change, a decoration that lays out a frame after the text it belongs to.
    Guarded because jsdom has no ResizeObserver and the whole of this file runs
    under it in `webviewBridge.test.ts` — the messages that matter are requested
    explicitly above, so the observer is a safety net rather than the mechanism.
  */
  const Observer = (owner.defaultView as { ResizeObserver?: typeof ResizeObserver } | null)
    ?.ResizeObserver;
  const resize = Observer === undefined ? null : new Observer(() => heights.request());
  resize?.observe(view.contentDOM);

  bridge.post({ v: PROTOCOL_VERSION, type: "ready" });
  // The host is showing an estimate until this arrives, so it is asked for
  // immediately rather than waiting for the first edit.
  heights.request();

  return {
    view,
    receive,
    destroy: () => {
      changes.cancel();
      heights.cancel();
      carets.cancel();
      resize?.disconnect();
      owner.removeEventListener("selectionchange", onSelectionChange);
      view.dom.removeEventListener("focusin", onFocus);
      view.dom.removeEventListener("focusout", onBlur);
      destroyCrdt();
      view.destroy();
    },
  };
}
