/**
 * @jest-environment jsdom
 */

/**
 * THE TASK COMPOSER: ENTER ADDS AND STAYS OPEN, ESCAPE LEAVES, @NAME ASSIGNS.
 *
 * Mounted through react-native-web, so the keys are real DOM key events on the
 * real field. What it hands `onAdd` is words — Urgent is `p0`, a due date is a
 * day — and the screen never says "P0".
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QuickAddComposer, type QuickAddComposerProps, type QuickAddTask } from "../features/console/files/folderPage/tasks/QuickAddComposer";
import type { OwnerResults } from "../features/console/files/owners";

const roots: (() => void)[] = [];
const NOW = new Date(2026, 8, 28, 15, 30);

beforeEach(() => {
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1280, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true });
  window.dispatchEvent(new Event("resize"));
});
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const all = (testID: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testID}"]`)];
const one = (testID: string): HTMLElement => {
  const found = all(testID)[0];
  if (found === undefined) throw new Error(`no ${testID}`);
  return found;
};
const text = () => (document.body.textContent ?? "").replace(/[⁦-⁩]/g, "");

async function mount(props: Partial<QuickAddComposerProps> & Pick<QuickAddComposerProps, "onAdd">) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  await act(async () => {
    root.render(
      createElement(SafeAreaProvider, {
        initialMetrics: { frame: { x: 0, y: 0, width: 1280, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
        children: createElement(QuickAddComposer, { onCancel: () => {}, now: NOW, ...props }),
      }),
    );
  });
}

async function type(testID: string, value: string) {
  const input = one(testID) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(testID: string, name: string) {
  await act(async () => {
    one(testID).dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function press(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

const PEOPLE = [
  { value: "@sayo", name: "Sayo Adé", isMe: true },
  { value: "@seyi", name: "Seyi Olujide", isMe: false },
];
function owners(asked: string[] = []) {
  return {
    prefer: [],
    search: async (query: string): Promise<OwnerResults> => {
      asked.push(query);
      const q = query.toLowerCase();
      return {
        people: PEOPLE.filter((person) => person.value.includes(q) || person.name.toLowerCase().includes(q)),
        agents: ["Claude"].filter((agent) => agent.toLowerCase().includes(q)),
        truncated: false,
      };
    },
  };
}

describe("the task composer", () => {
  test("draws its parts in the owner's words, with the tip", async () => {
    await mount({ onAdd: () => null, owners: owners(), groupLabel: "To do" });
    const shown = text();
    for (const words of ["New task in To do", "Priority", "Owner", "+ Tag", "Due date", "Cancel", "Add task", "Tip: you can also type @Sayo to assign while you write."]) {
      expect(shown).toContain(words);
    }
    expect(shown).not.toMatch(/P0|frontmatter|folder|markdown/i);
  });

  test("Enter adds the task and keeps the composer open, empty, for the next", async () => {
    const added: QuickAddTask[] = [];
    await mount({ onAdd: (task) => (added.push(task), null) });
    await type("quick-add-title", "Order the coffee beans");
    await key("quick-add-title", "Enter");
    expect(added).toEqual([{ title: "Order the coffee beans", priority: null, owners: [], tags: [], due: null }]);
    expect((one("quick-add-title") as HTMLInputElement).value).toBe("");
    await type("quick-add-title", "Take photos");
    await key("quick-add-title", "Enter");
    expect(added.map((task) => task.title)).toEqual(["Order the coffee beans", "Take photos"]);
    expect(all("quick-add")).toHaveLength(1);
  });

  test("a second Enter while the first is saving adds the task once, and what is typed meanwhile is kept", async () => {
    const added: QuickAddTask[] = [];
    let finish: (value: string | null) => void = () => {};
    await mount({ onAdd: (task) => (added.push(task), new Promise<string | null>((resolve) => (finish = resolve))) });
    await type("quick-add-title", "Order the beans");
    await key("quick-add-title", "Enter");
    await key("quick-add-title", "Enter");
    expect(added).toHaveLength(1);
    await type("quick-add-title", "Next one");
    await act(async () => finish(null));
    expect((one("quick-add-title") as HTMLInputElement).value).toBe("Next one");
  });

  test("an empty title adds nothing", async () => {
    const added: QuickAddTask[] = [];
    await mount({ onAdd: (task) => (added.push(task), null) });
    await type("quick-add-title", "   ");
    await key("quick-add-title", "Enter");
    await press(one("quick-add-submit"));
    expect(added).toEqual([]);
  });

  test("a refusal is shown and the title kept", async () => {
    await mount({ onAdd: async () => "That name is taken." });
    await type("quick-add-title", "Plan");
    await key("quick-add-title", "Enter");
    expect(one("quick-add-problem").textContent).toBe("That name is taken.");
    expect((one("quick-add-title") as HTMLInputElement).value).toBe("Plan");
  });

  test("Escape cancels", async () => {
    let cancelled = 0;
    await mount({ onAdd: () => null, onCancel: () => (cancelled += 1) });
    await key("quick-add-title", "Escape");
    expect(cancelled).toBe(1);
  });

  test("@name assigns the one owner it names and leaves the title without it", async () => {
    const added: QuickAddTask[] = [];
    await mount({ onAdd: (task) => (added.push(task), null), owners: owners() });
    await type("quick-add-title", "Order the beans @Sayo");
    await wait(200);
    expect(one("quick-add-owner").textContent).toContain("@sayo");
    await key("quick-add-title", "Enter");
    expect(added[0]).toMatchObject({ title: "Order the beans", owners: ["@sayo"] });
  });

  test("@name is resolved at Enter even when typed faster than the lookup", async () => {
    const added: QuickAddTask[] = [];
    await mount({ onAdd: (task) => (added.push(task), null), owners: owners() });
    await type("quick-add-title", "@claude write the menu");
    await key("quick-add-title", "Enter");
    await wait(0);
    expect(added[0]).toMatchObject({ title: "write the menu", owners: ["Claude"] });
  });

  test("an @name that names nobody stays in the title, and nobody is assigned", async () => {
    const added: QuickAddTask[] = [];
    await mount({ onAdd: (task) => (added.push(task), null), owners: owners() });
    await type("quick-add-title", "Ask @nobody");
    await key("quick-add-title", "Enter");
    await wait(0);
    expect(added[0]).toMatchObject({ title: "Ask @nobody", owners: [] });
  });

  test("priority is picked by its word and handed over as the scale", async () => {
    const added: QuickAddTask[] = [];
    await mount({ onAdd: (task) => (added.push(task), null) });
    await press(one("quick-add-priority"));
    expect(text()).toContain("Urgent");
    expect(text()).toContain("No priority");
    await press(one("quick-add-menu-p0"));
    expect(one("quick-add-priority").textContent).toBe("Urgent");
    await type("quick-add-title", "Sign the lease");
    await press(one("quick-add-submit"));
    expect(added[0]).toMatchObject({ priority: "p0" });
  });

  test("tags come from the project's, or are typed; due is a preset or a typed day", async () => {
    const added: QuickAddTask[] = [];
    await mount({ onAdd: (task) => (added.push(task), null), tagSuggestions: ["Kitchen", "Setup"] });
    await press(one("quick-add-tag"));
    expect(all("quick-add-tag-suggestion").map((node) => node.textContent?.replace(/[⁦-⁩]/g, ""))).toEqual(["Kitchen", "Setup"]);
    await press(all("quick-add-tag-suggestion")[0]!);
    await type("quick-add-tag-field", "bug");
    await key("quick-add-tag-field", "Enter");
    expect(all("quick-add-tag-chip")).toHaveLength(2);
    await press(one("quick-add-due"));
    await press(one("quick-add-menu-tomorrow"));
    expect(one("quick-add-due").textContent).toBe("Tomorrow");
    await press(one("quick-add-due"));
    await press(one("quick-add-menu-pick"));
    await type("quick-add-due-field", "Oct 13");
    await key("quick-add-due-field", "Enter");
    expect(one("quick-add-due").textContent).toBe("Oct 13");
    await type("quick-add-title", "Fix the fridge");
    await key("quick-add-title", "Enter");
    expect(added[0]).toEqual({ title: "Fix the fridge", priority: null, owners: [], tags: ["Kitchen", "bug"], due: "2026-10-13" });
    // The next task starts clean.
    expect(one("quick-add-due").textContent).toBe("Due date");
  });

  test("Escape in the tag field closes the field, not the composer", async () => {
    let cancelled = 0;
    await mount({ onAdd: () => null, onCancel: () => (cancelled += 1) });
    await press(one("quick-add-tag"));
    await key("quick-add-tag-field", "Escape");
    expect(all("quick-add-tag-panel")).toHaveLength(0);
    expect(cancelled).toBe(0);
  });

  test("the compact form for a subtask: one line, Enter adds and stays", async () => {
    const added: QuickAddTask[] = [];
    await mount({ onAdd: (task) => (added.push(task), null), compact: true, owners: owners() });
    expect(all("quick-add-compact")).toHaveLength(1);
    expect(all("quick-add-priority")).toHaveLength(0);
    expect(all("quick-add-tip")).toHaveLength(0);
    await type("quick-add-title", "Preheat @seyi");
    await key("quick-add-title", "Enter");
    await wait(0);
    expect(added[0]).toMatchObject({ title: "Preheat", owners: ["@seyi"] });
    expect((one("quick-add-title") as HTMLInputElement).value).toBe("");
  });
});
