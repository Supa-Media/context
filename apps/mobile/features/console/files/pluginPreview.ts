import { parseLinks } from "@context/shared/src/links";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type Tooltip, type ViewUpdate } from "@codemirror/view";
import type { LinkPreview } from "../plugins/sandboxTypes";

/**
 * A plugin's read preview, drawn by Context over the reader's own link.
 *
 * ## What an Obsidian plugin does here, and what Context does instead
 *
 * `registerMarkdownPostProcessor` is how a plugin decorates a note as it reads.
 * YouVersion Linker registers one that finds every `bible.com` link in the
 * rendered markdown, fetches the verse, and hangs a tooltip on the link.
 * Obsidian hands that processor the real rendered document and lets it write
 * into it.
 *
 * Context cannot, and this is the same refusal `pluginSuggest.ts` documents one
 * file over: `docs/decisions/plugins.md` rules out third-party callbacks, DOM
 * and `EditorView` access in the trusted realm, and #545 restated it. So the
 * halves are split at the boundary rather than carried across it.
 *
 * **The plugin decides what a link says; Context decides how it looks.** The
 * guest runs the processor against a document it builds inside the sandbox and
 * reports the *text* each link ended up with. This module asks for that once
 * per note and draws it in a tooltip of its own. The only thing that crosses is
 * a string per href.
 *
 * ## Why it is prefetched rather than fetched on hover
 *
 * A preview crosses to a sandbox, out through the brokered egress path, to a
 * third-party site and back. On a hover that is several seconds of nothing,
 * which is indistinguishable from a feature that does not work. A post-
 * processor is a whole-document pass in Obsidian too — and YouVersion caches
 * per render, so asking link-by-link would defeat the plugin's own caching as
 * well as the reader's patience.
 *
 * So the note's links are asked about when the note settles, and the hover is a
 * lookup. A link with no answer yet simply has no tooltip, which is what a link
 * with no plugin looks like: nothing new, rather than a spinner.
 */

/** An external link in the note, with the span a hover has to fall inside. */
export interface ExternalLinkSpan {
  from: number;
  to: number;
  href: string;
  /** The label, which is what the plugin is shown as the link's text. */
  text: string;
}

/**
 * Every external `http(s)` link in `text`, with its label and its whole span.
 *
 * Built on `parseLinks` rather than a regex of its own, for the reason
 * `noteLinksIn` gives next door: the parser already knows what a link is,
 * including which ones are inside a code fence and therefore not links at all,
 * and a second pattern here would be a second and disagreeing answer.
 *
 * Wiki links are skipped. `[[…]]` addresses a note in this bucket and cannot
 * carry a scheme, so there is no external target for a processor to work on.
 */
export function externalLinksIn(text: string): ExternalLinkSpan[] {
  const found: ExternalLinkSpan[] = [];
  for (const link of parseLinks(text)) {
    if (link.kind !== "inline") continue;
    if (!/^https?:\/\//i.test(link.target)) continue;
    /*
      Scanning outward from the target rather than re-matching, the way `widen`
      does: the parser has already decided where this link is, and the label is
      the part between the brackets in front of it.
    */
    const close = text.indexOf(")", link.end);
    const open = text.lastIndexOf("[", link.start);
    if (open === -1 || close === -1) continue;
    const label = text.slice(open + 1, text.indexOf("]", open));
    found.push({ from: open, to: close + 1, href: link.target, text: label });
  }
  return found;
}

/** The link a position falls inside, or `null`. */
export function externalLinkAt(
  spans: readonly ExternalLinkSpan[],
  pos: number,
): ExternalLinkSpan | null {
  return spans.find((span) => pos >= span.from && pos <= span.to) ?? null;
}

/**
 * What this editor knows about its links, and who to ask.
 *
 * A mutable ref rather than a facet value, following `FormHostRef` and
 * `NoteLinkRef`: the extension is built once when the editor mounts and the
 * host's callbacks change with every render, so what is configured has to be a
 * stable object the host writes into.
 */
export interface PluginPreviewRef {
  /**
   * Ask the running plugins about these links; absent where none can run.
   *
   * Resolves to whatever they attached, which may cover none of the links, some
   * of them, or all — a processor is under no obligation to be interested.
   */
  ask?: (links: LinkPreview[]) => Promise<LinkPreview[]>;
  /** What came back, keyed by href. Written by the extension, read on hover. */
  previews: Map<string, string>;
  /**
   * Bumped by the host when the open note changes.
   *
   * The editor is reused across notes, so without this a preview fetched for
   * one note would be shown over an identical link in the next — the same href,
   * a different page, and no way to tell from inside here.
   */
  generation: number;
}

/**
 * How long the editor waits after a keystroke before asking about links again.
 *
 * Long enough that typing a URL does not send a request per character, short
 * enough that pasting a link and reading it feels like the same action.
 */
export const PREVIEW_SETTLE_MS = 600;

/**
 * The preview extension: a prefetcher and a tooltip.
 *
 * Both halves are Context's own code. The prefetcher is a `ViewPlugin` and the
 * tooltip is `hoverTooltip` — CodeMirror talking to CodeMirror, with the
 * plugin's contribution arriving as strings through `ref.ask`.
 */
export function pluginLinkPreview(ref: PluginPreviewRef): Extension {
  return [
    /*
      A `ViewPlugin` rather than an `updateListener`, and the difference is the
      whole feature. A listener only runs on an *update*, so a note opened with
      links already in it — which is every note somebody opens to read — was
      never scanned at all, and the first version of this shipped past a test
      suite that only ever typed. The constructor is the mount.
    */
    ViewPlugin.fromClass(
      class {
        constructor(view: EditorView) {
          schedule(ref, view);
        }

        update(update: ViewUpdate) {
          if (!update.docChanged) return;
          schedule(ref, update.view);
        }

        destroy() {
          const pending = timers.get(ref);
          if (pending === undefined) return;
          clearTimeout(pending);
          timers.delete(ref);
        }
      },
    ),
    hoverTooltip((view, pos) => previewTooltipAt(ref, view.state, pos)),
  ];
}

/**
 * The tooltip for a position, or null — the whole of what a hover produces.
 *
 * A named function rather than a lambda inside the extension because it is the
 * part worth testing directly: `hoverTooltip` only calls its source through
 * CodeMirror's own pointer bookkeeping, and a test that simulated a mouse to
 * reach this would be testing CodeMirror. This is what Context answers.
 */
export function previewTooltipAt(
  ref: PluginPreviewRef,
  state: EditorState,
  pos: number,
): Tooltip | null {
  const line = state.doc.lineAt(pos);
  const span = externalLinkAt(externalLinksIn(line.text), pos - line.from);
  if (span === null) return null;
  const text = ref.previews.get(span.href);
  if (text === undefined || text === "") return null;
  return {
    pos: line.from + span.from,
    end: line.from + span.to,
    above: true,
    create: () => ({ dom: previewDom(text) }),
  };
}

/**
 * The tooltip's DOM, built here and never by the plugin.
 *
 * `textContent` per line rather than any markup: the string arrived from a
 * sandbox, and the whole point of reporting text instead of elements is that
 * there is nothing in it that can be interpreted. A plugin that sends
 * `<img onerror=…>` sends those characters, and this draws those characters.
 */
export function previewDom(text: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "cm-plugin-preview";
  for (const line of text.split("\n")) {
    const row = document.createElement("div");
    row.textContent = line;
    root.appendChild(row);
  }
  return root;
}

const timers = new WeakMap<PluginPreviewRef, ReturnType<typeof setTimeout>>();
const asked = new WeakMap<PluginPreviewRef, string>();

/**
 * Ask about this note's links, once it has stopped moving.
 *
 * The request is keyed on the links themselves plus the host's generation, so a
 * note that is being edited anywhere other than its links is not re-fetched,
 * and the same note reopened is. `previews` is cleared when the generation
 * moves rather than when the answer lands: a stale preview is worse than none,
 * because it is drawn under a link the reader is looking at now.
 */
function schedule(ref: PluginPreviewRef, view: EditorView): void {
  const existing = timers.get(ref);
  if (existing !== undefined) clearTimeout(existing);
  timers.set(
    ref,
    setTimeout(() => {
      timers.delete(ref);
      if (ref.ask === undefined) return;
      const links = externalLinksIn(view.state.doc.toString())
        .map((span) => ({ href: span.href, text: span.text }));
      const key = `${ref.generation}\n${links.map((one) => one.href).join("\n")}`;
      if (asked.get(ref) === key) return;
      asked.set(ref, key);
      ref.previews.clear();
      if (links.length === 0) return;
      const mine = ref.generation;
      void ref.ask(links).then((previews) => {
        /*
          The note may have been closed or replaced while the verses were in
          flight. Answering into `previews` then would hang a preview computed
          for one note over an identical-looking link in another.
        */
        if (ref.generation !== mine) return;
        for (const one of previews) ref.previews.set(one.href, one.text);
      });
    }, PREVIEW_SETTLE_MS),
  );
}

/** The tooltip's look, in the editor's own custom properties. */
export const pluginPreviewTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-hover .cm-plugin-preview": {
    maxWidth: "320px",
    padding: "8px 10px",
    borderRadius: "8px",
    background: "var(--lp-bg)",
    color: "var(--lp-content)",
    font: "13px/1.45 system-ui, sans-serif",
    whiteSpace: "pre-wrap",
  },
  ".cm-tooltip.cm-tooltip-hover": {
    border: "1px solid var(--lp-code-bg)",
    background: "var(--lp-bg)",
    borderRadius: "8px",
    boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
  },
});
