/**
 * The drawn list: a caption naming what it lists, then one row per note.
 *
 * Built to sit in the note rather than float over it — the same hairlines,
 * type and colours as the text around it, no card. The caption is the handle:
 * pressing it puts the caret in the block, which gives the source back.
 */

import { EditorView, WidgetType } from "@codemirror/view";
import { folderLabel } from "../paths";
import {
  selectRows,
  type ListConfig,
  type ListFence,
  type ListHostRef,
  type ListRow,
  type ListSource,
} from "./model";
import { captionFor, formatValue, rowTitle } from "./words";

const LIST_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class ListWidget extends WidgetType {
  private readonly hostGeneration: number;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly fence: ListFence,
    private readonly host: ListHostRef | null,
  ) {
    super();
    this.hostGeneration = host?.generation ?? 0;
  }

  /* On the text alone, so a keystroke elsewhere keeps the drawn rows. */
  eq(other: ListWidget): boolean {
    return other.fence.source === this.fence.source && other.hostGeneration === this.hostGeneration;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = el("div", "cm-lp-list");
    const caption = el("button", "cm-lp-list-cap");
    caption.type = "button";
    caption.innerHTML = LIST_ICON;
    caption.append(el("span", "", this.fence.config === null ? "Folder list" : captionFor(this.fence.config, folderLabel)));
    caption.title = "Edit this list";
    caption.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.fence.bodyFrom }, scrollIntoView: false });
      view.focus();
    });
    wrap.append(caption);

    const rows = el("div", "cm-lp-list-rows");
    const foot = el("div", "cm-lp-list-foot");
    wrap.append(rows, foot);

    const config = this.fence.config;
    if (config === null) {
      wrap.classList.add("cm-lp-list-broken");
      foot.textContent = "This list can’t be shown because the formatting is off.";
      foot.append(el("div", "cm-lp-list-why", this.fence.error ?? "the block could not be read"));
      return wrap;
    }

    let run = 0;
    const load = (): void => {
      const context = this.host?.current ?? null;
      if (context === null) {
        this.paint(rows, foot, config, null, null);
        return;
      }
      const mine = ++run;
      void context
        .load(config.from, config.subfolders)
        .then((source) => {
          if (mine === run) this.paint(rows, foot, config, source, context.selfPath);
        })
        .catch(() => {
          if (mine === run) this.paint(rows, foot, config, null, null);
        });
    };
    load();
    this.unsubscribe = this.host?.current?.subscribe?.(load) ?? null;
    return wrap;
  }

  private paint(
    rows: HTMLElement,
    foot: HTMLElement,
    config: ListConfig,
    source: ListSource | null,
    selfPath: string | null,
  ): void {
    rows.replaceChildren();
    foot.textContent = "";
    if (source === null) {
      foot.textContent = "This list shows once this workspace’s notes are on this device.";
      return;
    }
    const selection = selectRows(config, source.notes, selfPath);
    const now = Date.now();
    for (const row of selection.rows) rows.append(this.drawRow(row, now));
    if (selection.rows.length === 0) {
      foot.textContent = config.where.length > 0 ? "No notes match yet." : "No notes in this folder yet.";
    } else if (selection.truncated) {
      const more = selection.total - selection.rows.length;
      foot.textContent = `${more} more not shown.`;
    }
    if (!source.complete) {
      foot.textContent = [foot.textContent, "Some notes are still downloading."].filter(Boolean).join(" ");
    }
  }

  private drawRow(row: ListRow, now: number): HTMLElement {
    const link = el("a", "cm-lp-list-row");
    link.href = "#";
    link.setAttribute("data-path", row.path);
    link.append(el("span", "cm-lp-list-title", rowTitle(row)));
    for (const { key, value } of row.values) {
      const text = formatValue(key, value, now);
      link.append(el("span", "cm-lp-list-value", text));
    }
    link.addEventListener("click", (event) => {
      event.preventDefault();
      this.host?.current?.open(row.path, event.metaKey || event.ctrlKey);
    });
    return link;
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /* Presses on a row or the caption are theirs; anywhere else places the caret. */
  ignoreEvent(event: Event): boolean {
    const target = event.target as Element | null;
    return target?.closest?.(".cm-lp-list-row, .cm-lp-list-cap") != null;
  }
}
