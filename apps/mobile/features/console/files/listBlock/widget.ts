/**
 * The drawn list: a caption naming what it lists, then one row per note.
 *
 * Built to sit in the note rather than float over it — the same hairlines,
 * type and colours as the text around it, no card. The caption is the handle:
 * pressing it opens the filter popover, which rewrites the block as choices are
 * made. A block that will not parse, or a note that cannot be edited, has no
 * popover; there the caption puts the caret in the block instead.
 *
 * ## Why the DOM outlives the widget
 *
 * Every choice in the popover rewrites the block, and a rewritten block is a
 * new widget. Rebuilding the DOM for it would close the popover under the hand
 * that is using it, so `updateDOM` hands the new fence to the drawing already
 * on screen (`ListView`, kept per element) and the popover stays open.
 */

import { EditorView, WidgetType } from "@codemirror/view";
import { folderLabel } from "../paths";
import { planListRewrite } from "./edit";
import {
  loadsSubfolders,
  selectRows,
  type ListConfig,
  type ListFence,
  type ListHostRef,
  type ListNote,
  type ListRow,
  type ListSource,
} from "./model";
import { ListPanel } from "./panel";
import { captionFor, formatValue, groupLabel, listProblem, rowTitle } from "./words";

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

/** "3/5" with a thin bar: sub-projects closed out of all of them. */
function drawProgress(progress: { done: number; total: number }): HTMLElement {
  const wrap = el("span", "cm-lp-list-progress");
  wrap.title = `${progress.done} of ${progress.total} sub-projects done`;
  const bar = el("span", "cm-lp-list-progress-bar");
  const fill = el("span", "cm-lp-list-progress-fill");
  fill.style.width = `${Math.round((100 * progress.done) / Math.max(1, progress.total))}%`;
  bar.append(fill);
  wrap.append(bar, document.createTextNode(`${progress.done}/${progress.total}`));
  return wrap;
}

const drawings = new WeakMap<HTMLElement, ListView>();

export class ListWidget extends WidgetType {
  private readonly hostGeneration: number;

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
    const drawing = new ListView(view, this.fence, this.host);
    drawings.set(drawing.dom, drawing);
    return drawing.dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const drawing = drawings.get(dom);
    if (drawing === undefined) return false;
    drawing.update(view, this.fence, this.host);
    return true;
  }

  destroy(dom: HTMLElement): void {
    drawings.get(dom)?.destroy();
    drawings.delete(dom);
  }

  /* Presses on a row, the caption or the popover are theirs; anywhere else places the caret. */
  ignoreEvent(event: Event): boolean {
    const target = event.target as Element | null;
    return target?.closest?.(".cm-lp-list-row, .cm-lp-list-cap, .cm-lp-list-panel, .cm-lp-list-twisty") != null;
  }
}

/** One list on screen: its caption, rows and foot, and the popover when open. */
export class ListView {
  readonly dom = el("div", "cm-lp-list");
  private readonly caption = el("button", "cm-lp-list-cap");
  private readonly captionText = el("span", "");
  private readonly rows = el("div", "cm-lp-list-rows");
  private readonly foot = el("div", "cm-lp-list-foot");
  private run = 0;
  private unsubscribe: (() => void) | null = null;
  private notes: readonly ListNote[] = [];
  /** Projects whose sub-projects are shown, by path. Kept across redraws. */
  private readonly open = new Set<string>();
  private panel: ListPanel | null = null;
  private readonly outside = (event: MouseEvent): void => {
    if (!this.dom.contains(event.target as Node)) this.closePanel(false);
  };

  constructor(
    private view: EditorView,
    private fence: ListFence,
    private host: ListHostRef | null,
  ) {
    this.caption.type = "button";
    this.caption.innerHTML = LIST_ICON;
    this.caption.append(this.captionText);
    this.caption.addEventListener("mousedown", (event) => event.preventDefault());
    this.caption.addEventListener("click", () => this.pressCaption());
    this.dom.append(this.caption, this.rows, this.foot);
    this.draw();
  }

  update(view: EditorView, fence: ListFence, host: ListHostRef | null): void {
    this.view = view;
    this.fence = fence;
    this.host = host;
    this.draw();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.run++;
    this.closePanel(false);
  }

  private editable(): boolean {
    return this.fence.config !== null && !this.view.state.readOnly;
  }

  private draw(): void {
    const config = this.fence.config;
    this.captionText.textContent = config === null ? "Folder list" : captionFor(config, folderLabel);
    this.caption.title = this.editable() ? "Change what this list shows" : "Edit this list";
    this.caption.setAttribute("aria-expanded", String(this.panel !== null));
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dom.classList.toggle("cm-lp-list-broken", config === null);
    if (config === null) {
      this.run++;
      this.closePanel(false);
      this.rows.replaceChildren();
      this.foot.textContent = "This list can’t be shown because the formatting is off.";
      this.foot.append(el("div", "cm-lp-list-why", listProblem(this.fence.error)));
      return;
    }
    this.panel?.refresh(config);
    this.load(config);
    this.unsubscribe = this.host?.current?.subscribe?.(() => this.load(config)) ?? null;
  }

  private load(config: ListConfig): void {
    const context = this.host?.current ?? null;
    if (context === null) {
      this.paint(config, null, null);
      return;
    }
    const mine = ++this.run;
    void context
      .load(config.from, loadsSubfolders(config))
      .then((source) => {
        if (mine === this.run) this.paint(config, source, context.selfPath);
      })
      .catch(() => {
        if (mine === this.run) this.paint(config, null, null);
      });
  }

  private paint(config: ListConfig, source: ListSource | null, selfPath: string | null): void {
    const { rows, foot } = this;
    rows.replaceChildren();
    foot.textContent = "";
    if (source === null) {
      foot.textContent = "This list shows once this workspace’s notes are on this device.";
      return;
    }
    this.notes = source.notes;
    const selection = selectRows(config, source.notes, selfPath);
    const now = Date.now();
    const counts = new Map<string, number>();
    for (const row of selection.rows) counts.set(row.group ?? "", (counts.get(row.group ?? "") ?? 0) + 1);
    let group: string | null = null;
    for (const row of selection.rows) {
      if (config.group !== null && row.group !== group) {
        group = row.group ?? "";
        rows.append(this.drawGroup(config.group, group, counts.get(group) ?? 0));
      }
      rows.append(this.drawRow(row, now, config, false));
      if (row.children !== undefined && row.children.length > 0 && this.open.has(row.path)) {
        row.children.forEach((child, index) => {
          const drawn = this.drawRow(child, now, config, true);
          if (index === row.children!.length - 1) drawn.classList.add("cm-lp-list-sub-last");
          rows.append(drawn);
        });
      }
    }
    const noun = config.rows === "projects" ? "projects" : "notes";
    if (selection.rows.length === 0) {
      foot.textContent =
        config.where.length > 0
          ? `No ${noun} match yet.`
          : config.rows === "projects"
            ? "No projects here yet. A folder or note becomes one when it has a status."
            : "No notes in this folder yet.";
    } else if (selection.truncated) {
      const more = selection.total - selection.rows.length;
      foot.textContent = `${more} more not shown.`;
    }
    if (!source.complete) {
      foot.textContent = [foot.textContent, "Some notes are still downloading."].filter(Boolean).join(" ");
    }
  }

  private drawGroup(property: string, value: string, count: number): HTMLElement {
    const head = el("div", "cm-lp-list-group", groupLabel(property, value));
    head.append(el("span", "cm-lp-list-group-count", String(count)));
    return head;
  }

  private drawRow(row: ListRow, now: number, config: ListConfig, sub: boolean): HTMLElement {
    const link = el("a", sub ? "cm-lp-list-row cm-lp-list-sub" : "cm-lp-list-row");
    link.href = "#";
    link.setAttribute("data-path", row.path);
    const children = row.children?.length ?? 0;
    if (config.rows === "projects" && !sub) {
      const twisty = el("button", "cm-lp-list-twisty");
      twisty.type = "button";
      if (children > 0) {
        const open = this.open.has(row.path);
        twisty.textContent = open ? "\u25BE" : "\u25B8";
        twisty.setAttribute("aria-expanded", String(open));
        twisty.setAttribute("aria-label", open ? "Hide sub-projects" : "Show sub-projects");
        twisty.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (open) this.open.delete(row.path);
          else this.open.add(row.path);
          this.load(config);
        });
      } else {
        twisty.disabled = true;
        twisty.tabIndex = -1;
        twisty.setAttribute("aria-hidden", "true");
      }
      link.append(twisty);
    }
    const title = el("span", "cm-lp-list-title");
    title.append(el("span", "cm-lp-list-name", rowTitle(row)));
    if (row.progress) title.append(drawProgress(row.progress));
    // A sub-project is not in a group of its own, so it says its own value,
    // beside its name rather than in a column its parent does not have.
    if (sub && config.group !== null && row.group) {
      title.append(el("span", "cm-lp-list-own", formatValue(config.group, row.group, now)));
    }
    link.append(title);
    for (const { key, value } of row.values) {
      link.append(el("span", "cm-lp-list-value", formatValue(key, value, now)));
    }
    link.addEventListener("click", (event) => {
      event.preventDefault();
      this.host?.current?.open(row.path, event.metaKey || event.ctrlKey);
    });
    return link;
  }

  private pressCaption(): void {
    if (this.panel !== null) {
      this.closePanel(true);
      return;
    }
    const config = this.fence.config;
    if (config === null || !this.editable()) {
      this.editAsText();
      return;
    }
    this.panel = new ListPanel(config, {
      notes: () => this.notes,
      write: (next) => this.write(next),
      editAsText: () => this.editAsText(),
      close: () => this.closePanel(true),
    });
    this.dom.classList.add("cm-lp-list-open");
    this.caption.setAttribute("aria-expanded", "true");
    this.caption.after(this.panel.dom);
    this.dom.ownerDocument.addEventListener("mousedown", this.outside, true);
    this.panel.focus();
  }

  private closePanel(refocus: boolean): void {
    if (this.panel === null) return;
    this.panel.dom.remove();
    this.panel = null;
    this.dom.classList.remove("cm-lp-list-open");
    this.caption.setAttribute("aria-expanded", "false");
    this.dom.ownerDocument.removeEventListener("mousedown", this.outside, true);
    if (refocus) this.caption.focus();
  }

  /** Rewrite the block this drawing stands for. */
  private write(config: ListConfig): string | null {
    const from = this.view.posAtDOM(this.dom);
    const plan = planListRewrite(this.view.state, from, config);
    if ("error" in plan) return plan.error;
    this.view.dispatch(plan.spec);
    return null;
  }

  private editAsText(): void {
    this.closePanel(false);
    // From the DOM rather than the fence: an edit above the list moves the
    // block without rebuilding this drawing, so its fence can be out of date.
    const open = this.view.state.doc.lineAt(this.view.posAtDOM(this.dom));
    const anchor = Math.min(open.to + 1, this.view.state.doc.length);
    this.view.dispatch({ selection: { anchor }, scrollIntoView: false });
    this.view.focus();
  }
}
