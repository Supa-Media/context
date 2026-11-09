/**
 * Holding a link on a touch screen: a menu with Open, Edit link, Remove link
 * and Copy link (owner, 2026-11-09: "for links can't it be a long hold to open
 * a menu").
 *
 * With Show Markdown off (`livePreview/symbols.ts`) a link's address is never
 * on screen, so this is how it is changed: the menu's Edit link opens the same
 * Link sheet that adds one, over the link's words, and the pick replaces the
 * whole link. Remove link keeps the words.
 *
 * ## The gesture
 *
 * A tap still opens the link (`noteLinks.ts`). A hold is recognised by what
 * the platform does with it, not by racing its recogniser: either the finger
 * comes up still and late (above `TAP_MAX_MS`), or, as on iOS, the platform
 * claims the touch and puts a selection inside the link's words. Either one,
 * shortly after a still touch began on the link, is the hold. A touch that
 * moves is a scroll and is forgotten.
 *
 * The held link is kept in a state field, mapped through every change, so the
 * menu's answer (which arrives over the bridge some time later on iOS) edits
 * the link that was held, or nothing if its text has changed since.
 */

import { Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { wikiTargetText } from "./livePreview/wikiTarget";
import { TAP_MAX_MS, TAP_SLOP } from "./noteLinkGestures";
import { webUrl } from "./webUrl";

/** What the host's menu needs to know about a held link. */
export interface HeldLink {
  /** The words on screen. */
  label: string;
  /** A note link's target note, or a web link's address. */
  path?: string;
  anchor?: string;
  url?: string;
  /** Whether Remove link can keep words: a bare address has none apart from itself. */
  removable: boolean;
}

interface Held {
  from: number;
  to: number;
  /** The link's source when held: an edit only lands while it is still this. */
  source: string;
  label: string;
}

type Span = { from: number; to: number; path?: string; anchor?: string; url?: string; tag?: string };

/** How soon after a still touch a selection inside the link counts as the platform's hold. */
const HOLD_MIN_MS = 250;
const HOLD_MAX_MS = 1500;

const setHeld = StateEffect.define<Held | null>();

const heldLink = StateField.define<Held | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setHeld)) return effect.value;
    if (value === null || tr.changes.empty) return value;
    return { ...value, from: tr.changes.mapPos(value.from, 1), to: tr.changes.mapPos(value.to, -1) };
  },
});

/**
 * The words a link shows, or `null` when it has none apart from its address
 * (`<https://…>`, a bare `https://…`).
 */
export function linkLabel(source: string): string | null {
  const wiki = /^\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]$/.exec(source);
  if (wiki !== null) return wiki[2] !== undefined && wiki[2].trim() !== "" ? wiki[2] : wikiTargetText(wiki[1]!);
  const markdown = /^\[([^\]]*)\]\([^)]*\)$/.exec(source);
  if (markdown !== null) return markdown[1]!;
  return null;
}

function heldIn(state: EditorState): Held | null {
  return state.field(heldLink, false) ?? null;
}

/** Remember `span` as the held link and say what the menu should show. */
export function holdLink(view: EditorView, span: Span): HeldLink {
  const source = view.state.sliceDoc(span.from, span.to);
  const label = linkLabel(source);
  if (view.state.field(heldLink, false) === undefined) {
    view.dispatch({ effects: StateEffect.appendConfig.of(heldLink) });
  }
  view.dispatch({ effects: setHeld.of({ from: span.from, to: span.to, source, label: label ?? source }) });
  return {
    label: label ?? source,
    ...(span.path === undefined ? {} : { path: span.path }),
    ...(span.anchor === undefined ? {} : { anchor: span.anchor }),
    ...(span.url === undefined ? {} : { url: span.url }),
    removable: label !== null,
  };
}

/** The held link, if its text is still what was held. */
function stillHeld(state: EditorState): Held | null {
  const held = heldIn(state);
  if (held === null || state.sliceDoc(held.from, held.to) !== held.source) return null;
  return held;
}

/**
 * Remove link: the link becomes its words, with the caret after them. A no-op
 * when nothing is held, or the link has changed since.
 */
export function unlinkHeld(view: EditorView): void {
  const held = stillHeld(view.state);
  if (held === null || linkLabel(held.source) === null) return;
  view.dispatch({
    changes: { from: held.from, to: held.to, insert: held.label },
    selection: { anchor: held.from + held.label.length },
    effects: setHeld.of(null),
    userEvent: "input",
  });
}

/**
 * Edit link: the held link, selected whole, with its words named for the Link
 * sheet. `ask` is `linkSelection.ts`'s, which then replaces the selection with
 * the picked link over `label`.
 */
export function heldForEdit(state: EditorState): { from: number; to: number; label: string } | null {
  const held = stillHeld(state);
  return held === null ? null : { from: held.from, to: held.to, label: held.label };
}

/**
 * The gesture: a still touch on a link that ends late, or that the platform
 * turns into a selection inside the link. `spanUnder` is `noteLinks.ts`'s own
 * hit test, so a hold reaches exactly the words a tap does.
 */
export function linkHoldGesture(
  spanUnder: (view: EditorView, under: EventTarget | null) => Span | null,
  onHold: () => ((link: HeldLink) => void) | undefined,
) {
  let press: { span: Span; x: number; y: number; at: number } | null = null;
  const fire = (view: EditorView, span: Span): void => {
    const tell = onHold();
    if (tell !== undefined) tell(holdLink(view, span));
  };
  return [
    // Ahead of `noteLinks.ts`'s own handlers, so a tap clears the press before it follows the link.
    Prec.high(EditorView.domEventHandlers({
      touchstart(event, view) {
        press = null;
        if (event.touches.length !== 1 || onHold() === undefined) return false;
        const span = spanUnder(view, event.target);
        if (span === null || (span.path === undefined && span.url === undefined)) return false;
        const touch = event.touches[0]!;
        press = { span, x: touch.clientX, y: touch.clientY, at: Date.now() };
        return false;
      },
      touchmove(event) {
        const touch = event.touches[0];
        if (press === null || touch === undefined) return false;
        if (Math.abs(touch.clientX - press.x) > TAP_SLOP || Math.abs(touch.clientY - press.y) > TAP_SLOP) press = null;
        return false;
      },
      touchend(event, view) {
        if (press === null) return false;
        if (Date.now() - press.at <= TAP_MAX_MS) {
          press = null;
          return false;
        }
        const { span } = press;
        press = null;
        event.preventDefault();
        fire(view, span);
        return true;
      },
    })),
    // iOS claims a held touch (`touchcancel`) and selects inside the words: that selection is the hold.
    EditorView.updateListener.of((update: ViewUpdate) => {
      if (press === null || !update.selectionSet) return;
      const since = Date.now() - press.at;
      // A note replaced under the finger, or a press gone stale, is no hold.
      if (update.docChanged || since > HOLD_MAX_MS) {
        press = null;
        return;
      }
      const main = update.state.selection.main;
      if (since >= HOLD_MIN_MS && main.from >= press.span.from && main.to <= press.span.to) {
        const { view } = update;
        const { span } = press;
        press = null;
        // Not inside an update: dispatching from a listener is refused.
        queueMicrotask(() => fire(view, span));
      }
    }),
  ];
}

/**
 * A held link read off the web view bridge, or `null`. The menu draws these
 * words and may open the address, so an address must be one `webUrl` itself
 * returns, as `open-url`'s is.
 */
export function decodeHeldLink(value: unknown): HeldLink | null {
  if (typeof value !== "object" || value === null) return null;
  const link = value as Record<string, unknown>;
  if (typeof link.label !== "string" || link.label.length > 500 || typeof link.removable !== "boolean") return null;
  const optional = (key: string): boolean => link[key] === undefined || typeof link[key] === "string";
  if (!optional("path") || !optional("anchor") || !optional("url")) return null;
  if (link.url !== undefined && webUrl(link.url as string) !== link.url) return null;
  if (link.path === undefined && link.url === undefined) return null;
  return {
    label: link.label,
    removable: link.removable,
    ...(link.path === undefined ? {} : { path: link.path as string }),
    ...(link.anchor === undefined ? {} : { anchor: link.anchor as string }),
    ...(link.url === undefined ? {} : { url: link.url as string }),
  };
}
