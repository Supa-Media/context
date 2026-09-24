/**
 * The popover a list's caption opens: which folder, which notes, what order,
 * what beside each title.
 *
 * It edits a draft and hands every complete version to `write`, which rewrites
 * the block — so the rows behind it change as the choice is made, and the note
 * is the only place the filter lives. A half-written condition (no property
 * yet, or no value) stays in the draft and out of the note until it is whole.
 *
 * Plain DOM, built by the widget that owns it, for the reason the image alt
 * field gives: the editor redraws widgets on every transaction, so anything
 * that has to survive typing lives in the widget's own DOM.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import type { ListCondition, ListConfig, ListNote } from "./model";

export interface ListPanelHost {
  /** The notes the list last drew from, for suggesting property names. */
  notes(): readonly ListNote[];
  /** Write a complete config into the block; the reason when it would not read back. */
  write(config: ListConfig): string | null;
  /** Put the caret in the block, which gives the source back. */
  editAsText(): void;
  close(): void;
}

type Op = ListCondition["op"];

const OPERATORS: ReadonlyArray<{ op: Op; label: string }> = [
  { op: "is", label: "is" },
  { op: "is not", label: "is not" },
  { op: "contains", label: "contains" },
  { op: "is set", label: "has a value" },
  { op: "is not set", label: "is empty" },
];

const MAX_COLUMNS = 4;
const MAX_SUGGESTIONS = 40;

interface DraftCondition {
  property: string;
  op: Op;
  value: string;
}

interface Draft {
  from: string;
  subfolders: boolean;
  where: DraftCondition[];
  sortKey: string;
  order: "asc" | "desc";
  show: string[];
  limit: number;
}

let panelCount = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toDraft(config: ListConfig): Draft {
  return {
    from: config.from,
    subfolders: config.subfolders,
    where: config.where.map((c) => ({ property: c.property, op: c.op, value: c.value ?? "" })),
    sortKey: config.sort.key,
    order: config.sort.order,
    show: [...config.show],
    limit: config.limit,
  };
}

const takesValue = (op: Op): boolean => op !== "is set" && op !== "is not set";

/** The draft as a config, leaving out any condition that is not whole yet. */
export function draftConfig(draft: Draft): ListConfig {
  return {
    from: draft.from.trim().replace(/\/+$/, ""),
    where: draft.where
      .filter((c) => c.property.trim() !== "" && (!takesValue(c.op) || c.value.trim() !== ""))
      .map((c) =>
        takesValue(c.op)
          ? { property: c.property.trim(), op: c.op, value: c.value.trim() }
          : { property: c.property.trim(), op: c.op },
      ),
    sort: { key: draft.sortKey, order: draft.order },
    show: [...draft.show],
    limit: draft.limit,
    subfolders: draft.subfolders,
  };
}

/** Property names the listed notes use, most common first. `title` is the row itself. */
export function propertyNames(notes: readonly ListNote[]): string[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const key of Object.keys(note.properties)) {
      if (key === "title") continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SUGGESTIONS)
    .map(([key]) => key);
}

/** The values one property takes across the notes, for the value field. */
export function propertyValues(notes: readonly ListNote[], property: string): string[] {
  const seen = new Set<string>();
  for (const note of notes) {
    const value = note.properties[property];
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      const text = String(item).trim();
      if (text !== "") seen.add(text);
      if (seen.size >= MAX_SUGGESTIONS) break;
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function columnLabel(key: string): string {
  return key === "updated" ? "Last saved" : isolateForDisplay(key);
}

function orderLabels(key: string): [asc: string, desc: string] {
  if (key === "updated") return ["Oldest first", "Newest first"];
  return ["A to Z", "Z to A"];
}

export class ListPanel {
  readonly dom: HTMLElement;
  private draft: Draft;
  private written: string;
  private readonly id = ++panelCount;
  private readonly body: HTMLElement;
  private readonly problem: HTMLElement;

  constructor(
    config: ListConfig,
    private readonly host: ListPanelHost,
  ) {
    this.draft = toDraft(config);
    this.written = JSON.stringify(draftConfig(this.draft));
    this.dom = el("div", "cm-lp-list-panel");
    this.dom.setAttribute("role", "dialog");
    this.dom.setAttribute("aria-label", "Folder list");
    this.dom.tabIndex = -1;
    this.body = el("div", "cm-lp-list-panel-body");
    this.problem = el("div", "cm-lp-list-panel-problem");
    this.problem.setAttribute("role", "status");
    const foot = el("div", "cm-lp-list-panel-foot");
    const asText = el("button", "cm-lp-list-panel-quiet cm-lp-list-panel-text", "Edit as text");
    asText.type = "button";
    asText.addEventListener("click", () => this.host.editAsText());
    const done = el("button", "cm-lp-list-panel-done", "Done");
    done.type = "button";
    done.addEventListener("click", () => this.host.close());
    foot.append(asText, done);
    this.dom.append(this.body, this.problem, foot);
    this.dom.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.host.close();
      }
    });
    this.paint();
  }

  /** The block changed. Keep the draft unless somebody else changed it. */
  refresh(config: ListConfig): void {
    if (JSON.stringify(config) === this.written) return;
    this.draft = toDraft(config);
    this.written = JSON.stringify(draftConfig(this.draft));
    this.paint();
  }

  /** Focus the popover itself, so Tab starts at its first field without a ring on open. */
  focus(): void {
    this.dom.focus({ preventScroll: true });
  }

  private commit(repaint: boolean): void {
    const config = draftConfig(this.draft);
    const text = JSON.stringify(config);
    if (text !== this.written) {
      const problem = this.host.write(config);
      this.problem.textContent = problem === null ? "" : `This can’t be listed: ${problem}.`;
      if (problem === null) this.written = text;
    }
    if (repaint) this.paint();
  }

  /** Rebuild the fields, keeping focus on the field that had it. */
  private paint(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.field ?? null;
    const names = propertyNames(this.host.notes());
    this.body.replaceChildren(this.fromSection(), this.whereSection(names), this.orderSection(names), this.showSection(names));
    if (focused !== null) this.body.querySelector<HTMLElement>(`[data-field="${focused}"]`)?.focus();
  }

  private section(title: string): HTMLElement {
    const section = el("div", "cm-lp-list-panel-section");
    section.append(el("div", "cm-lp-list-panel-label", title));
    return section;
  }

  private input(field: string, value: string, placeholder: string, onChange: (value: string) => void): HTMLInputElement {
    const input = el("input", "cm-lp-list-panel-field");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.dataset.field = field;
    input.setAttribute("aria-label", placeholder);
    input.addEventListener("change", () => onChange(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onChange(input.value);
      }
    });
    return input;
  }

  private select<T extends string>(
    field: string,
    label: string,
    options: ReadonlyArray<{ value: T; label: string }>,
    current: T,
    onChange: (value: T) => void,
  ): HTMLSelectElement {
    const select = el("select", "cm-lp-list-panel-field cm-lp-list-panel-select");
    select.dataset.field = field;
    select.setAttribute("aria-label", label);
    for (const option of options) {
      const node = el("option", "", option.label);
      node.value = option.value;
      node.selected = option.value === current;
      select.append(node);
    }
    select.addEventListener("change", () => onChange(select.value as T));
    return select;
  }

  private datalist(id: string, values: readonly string[]): HTMLDataListElement {
    const list = el("datalist", "");
    list.id = id;
    for (const value of values) {
      const option = el("option", "");
      option.value = value;
      list.append(option);
    }
    return list;
  }

  private fromSection(): HTMLElement {
    const section = this.section("Folder");
    const row = el("div", "cm-lp-list-panel-row");
    row.append(
      this.input("from", this.draft.from, "Folder path", (value) => {
        this.draft.from = value;
        this.commit(false);
      }),
    );
    const toggle = el("label", "cm-lp-list-panel-check");
    const box = el("input", "");
    box.type = "checkbox";
    box.checked = this.draft.subfolders;
    box.dataset.field = "subfolders";
    box.addEventListener("change", () => {
      this.draft.subfolders = box.checked;
      this.commit(false);
    });
    toggle.append(box, document.createTextNode("Include subfolders"));
    section.append(row, toggle);
    return section;
  }

  private whereSection(names: readonly string[]): HTMLElement {
    // No heading until there is a condition: "+ Add a condition" says it alone.
    const section = this.draft.where.length > 0 ? this.section("Where") : el("div", "cm-lp-list-panel-section");
    const nameList = `cm-lp-list-names-${this.id}`;
    section.append(this.datalist(nameList, names));
    this.draft.where.forEach((condition, index) => {
      const row = el("div", "cm-lp-list-panel-row cm-lp-list-panel-condition");
      const property = this.input(`where-${index}-property`, condition.property, "Property", (value) => {
        condition.property = value;
        this.commit(true);
      });
      property.setAttribute("list", nameList);
      row.append(
        property,
        this.select(`where-${index}-op`, "Test", OPERATORS.map((o) => ({ value: o.op, label: o.label })), condition.op, (op) => {
          condition.op = op;
          this.commit(true);
        }),
      );
      if (takesValue(condition.op)) {
        const valueList = `cm-lp-list-values-${this.id}-${index}`;
        const value = this.input(`where-${index}-value`, condition.value, "Value", (text) => {
          condition.value = text;
          this.commit(false);
        });
        value.setAttribute("list", valueList);
        row.append(value, this.datalist(valueList, propertyValues(this.host.notes(), condition.property.trim())));
      }
      const remove = el("button", "cm-lp-list-panel-remove", "×");
      remove.type = "button";
      remove.dataset.field = `where-${index}-remove`;
      remove.setAttribute("aria-label", "Remove this condition");
      remove.addEventListener("click", () => {
        this.draft.where.splice(index, 1);
        this.commit(true);
      });
      row.append(remove);
      section.append(row);
    });
    const add = el("button", "cm-lp-list-panel-quiet cm-lp-list-panel-add", "Add a condition");
    add.type = "button";
    add.dataset.field = "where-add";
    add.addEventListener("click", () => {
      this.draft.where.push({ property: "", op: "is", value: "" });
      this.paint();
      this.body.querySelector<HTMLElement>(`[data-field="where-${this.draft.where.length - 1}-property"]`)?.focus();
    });
    section.append(add);
    return section;
  }

  private orderSection(names: readonly string[]): HTMLElement {
    const section = this.section("Sort");
    const keys = ["updated", "title", ...names];
    if (!keys.includes(this.draft.sortKey)) keys.push(this.draft.sortKey);
    const row = el("div", "cm-lp-list-panel-row");
    row.append(
      this.select(
        "sort-key",
        "Order by",
        keys.map((key) => ({ value: key, label: key === "title" ? "Title" : columnLabel(key) })),
        this.draft.sortKey,
        (key) => {
          this.draft.sortKey = key;
          this.draft.order = key === "updated" ? "desc" : "asc";
          this.commit(true);
        },
      ),
    );
    // One quiet button that names the order and flips it, rather than a second menu.
    const [asc, desc] = orderLabels(this.draft.sortKey);
    const flip = el("button", "cm-lp-list-panel-flip", this.draft.order === "asc" ? asc : desc);
    flip.type = "button";
    flip.dataset.field = "sort-order";
    flip.title = "Reverse the order";
    flip.addEventListener("click", () => {
      this.draft.order = this.draft.order === "asc" ? "desc" : "asc";
      this.commit(true);
    });
    row.append(flip);
    section.append(row);
    return section;
  }

  private showSection(names: readonly string[]): HTMLElement {
    const section = this.section("Show");
    const keys = ["updated", ...names];
    for (const key of this.draft.show) if (!keys.includes(key)) keys.push(key);
    const chips = el("div", "cm-lp-list-panel-chips");
    const full = this.draft.show.length >= MAX_COLUMNS;
    for (const key of keys) {
      const on = this.draft.show.includes(key);
      const chip = el("button", on ? "cm-lp-list-panel-chip cm-lp-list-panel-chip-on" : "cm-lp-list-panel-chip", columnLabel(key));
      chip.type = "button";
      chip.dataset.field = `show-${key}`;
      chip.setAttribute("aria-pressed", String(on));
      chip.disabled = !on && full;
      chip.addEventListener("click", () => {
        this.draft.show = on ? this.draft.show.filter((k) => k !== key) : [...this.draft.show, key];
        this.commit(true);
      });
      chips.append(chip);
    }
    section.append(chips);
    if (keys.length === 1) {
      section.append(el("div", "cm-lp-list-panel-hint", "Properties from the notes’ frontmatter show up here."));
    }
    return section;
  }
}
