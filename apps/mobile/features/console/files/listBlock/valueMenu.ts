/**
 * The small menu a list's value opens: pick a status or an owner for one row,
 * type a new one, or clear it.
 *
 * It only chooses. The row's note is rewritten by the host (`setProperty`),
 * which reads the note, changes that one frontmatter line and writes it back
 * against the version it read — so the menu never holds a copy of a note and
 * never writes one. What it offers is the values the listed notes already use,
 * so a team's words ("planned", "blocked", "Seyi's Codex") are one press away
 * and a new word is still one line of typing.
 *
 * Plain DOM, owned by the list drawing, for the reason `panel.ts` gives.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { compareGroups } from "../../../../../mcp/src/lists.js";
import type { ListNote } from "./model";

export interface ValueMenuHost {
  /** Apply a choice; `null` clears. Resolves to a sentence when it did not land. */
  choose(value: string | null): Promise<string | null>;
  close(refocus: boolean): void;
}

const MAX_CHOICES = 12;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== "") node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The values one property takes across the listed notes, in the order a
 * grouped list draws them: lifecycle words first, then a to z. Only single
 * values — a list-valued property is not something one choice can set.
 */
export function valueChoices(notes: readonly ListNote[], key: string): string[] {
  const seen = new Map<string, string>();
  for (const note of notes) {
    const value = note.properties[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    const folded = value.trim().toLowerCase();
    if (!seen.has(folded)) seen.set(folded, value.trim());
  }
  return [...seen.values()].sort(compareGroups).slice(0, MAX_CHOICES);
}

/** Whether a drawn value can be changed from the list: one plain value, or none. */
export function isEditableValue(key: string, value: unknown): boolean {
  return key !== "updated" && key !== "title" && !Array.isArray(value);
}

export class ValueMenu {
  readonly dom = el("div", "cm-lp-list-menu");
  private readonly problem = el("div", "cm-lp-list-menu-problem");
  private busy = false;

  constructor(
    readonly key: string,
    readonly path: string,
    current: string | null,
    choices: readonly string[],
    private readonly host: ValueMenuHost,
  ) {
    this.dom.setAttribute("role", "menu");
    this.dom.setAttribute("aria-label", `Change ${key}`);
    const list = el("div", "cm-lp-list-menu-items");
    const all = current !== null && !choices.some((c) => c.toLowerCase() === current.toLowerCase()) ? [current, ...choices] : [...choices];
    for (const choice of all) {
      const on = current !== null && choice.toLowerCase() === current.toLowerCase();
      list.append(this.item(isolateForDisplay(choice), on, () => (on ? this.host.close(true) : this.pick(choice))));
    }
    if (current !== null) list.append(this.item(`No ${key}`, false, () => this.pick(null), "cm-lp-list-menu-clear"));

    const input = el("input", "cm-lp-list-menu-new");
    input.type = "text";
    input.placeholder = all.length > 0 ? "Something else…" : `Set ${key}…`;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", `New ${key}`);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (input.value.trim() !== "") void this.pick(input.value);
      }
    });
    this.dom.append(list, input, this.problem);
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
  }

  /** The first item, or the field when there are none. */
  focus(): void {
    (this.dom.querySelector<HTMLElement>(".cm-lp-list-menu-item") ?? this.dom.querySelector<HTMLElement>("input"))?.focus({
      preventScroll: true,
    });
  }

  private item(label: string, on: boolean, act: () => void, extra = ""): HTMLButtonElement {
    const button = el("button", `cm-lp-list-menu-item${on ? " cm-lp-list-menu-on" : ""}${extra ? ` ${extra}` : ""}`);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(on));
    button.append(el("span", "cm-lp-list-menu-check", on ? "✓" : ""), el("span", "", label));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      act();
    });
    return button;
  }

  private async pick(value: string | null): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.dom.classList.add("cm-lp-list-menu-busy");
    this.problem.textContent = "";
    const problem = await this.host.choose(value);
    this.busy = false;
    this.dom.classList.remove("cm-lp-list-menu-busy");
    if (problem === null) this.host.close(true);
    else this.problem.textContent = problem;
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.host.close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const stops = [...this.dom.querySelectorAll<HTMLElement>(".cm-lp-list-menu-item, .cm-lp-list-menu-new")];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next = stops[(at + (event.key === "ArrowDown" ? 1 : stops.length - 1)) % stops.length];
    event.preventDefault();
    next?.focus();
  }
}
