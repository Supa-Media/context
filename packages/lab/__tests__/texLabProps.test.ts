/**
 * @jest-environment jsdom
 */

/**
 * /lab, driven through the engine: the properties panel (a step's panel, its model form and reads stack,
 * a wire's panel), the module viewer, and the Context modules page. The Lab is rendered whole; the state is set with
 * the engine's own functions and the controls are clicked or changed the way a person would.
 *
 * Every value here is fake. This repository is public. The same panels were also checked against the artifact
 * itself in a browser (same clicks on both pages, markup and graph compared after every step).
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-13):
 *   `setMod` keeping a value equal to main's                     "set back to the main value is dropped" fails
 *   the viewer's save without the unchanged-text guard            "text unchanged adds no module edit" fails
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockArgs = new Map<string, unknown>();
let mockTexHost = true;

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      mockArgs.set(name, args);
      return args === "skip" ? undefined : mockAnswers.get(name);
    },
    useMutation: () => async () => null,
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../../../apps/mobile/features/site/host", () => ({ isTexHost: () => mockTexHost }));
// The test chat under the canvas reaches the gateway with the person's own grant; no gateway here.
jest.mock("@context/lab/app/views/canvas/sandboxCall", () => ({ useSandboxCall: () => false }));
// The Tests view has no focus export yet, and the workspace browser is not in the repo yet.

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TexLab } from "@context/lab/app/TexLab.web";
import { G, edit, go, set, lab, node, MAIN, clone } from "@context/lab/app/engine/state";
import { mods } from "@context/lab/app/engine/modules";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockArgs.clear();
  mockTexHost = true;
});

const ADMIN = "functions/admin:amIAdmin";
const LIST = "functions/texLab:list";

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexLab)));
  return container;
}

const q = (s: string) => document.querySelector<HTMLElement>(s);
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];

function click(s: string) {
  const el = q(s);
  expect(el).not.toBeNull();
  act(() => el!.click());
}

function commit(s: string, value: string) {
  const el = q(s) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(el).not.toBeNull();
  act(() => {
    el!.value = value;
    el!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  mockAnswers.set(ADMIN, true);
  mockAnswers.set(LIST, { me: "u1", versions: [], caseEdits: [] });
  act(() =>
    set({ cur: clone(MAIN), versions: [MAIN], sel: null, view: "canvas", viewer: null, addCtxOpen: false, modFocus: null, cfocus: null, dirty: false, undoStack: [] }),
  );
});

describe("/lab properties panel, viewer and modules page", () => {
  test("a step's panel shows its name, its reads stack, and says when its reads run in another order than listed", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "fd" } }));

    expect(q("#props")?.hidden).toBe(false);
    expect((q("#nLabel") as HTMLInputElement).value).toBe("Front door");
    const ctx = node("fd")!.ctx;
    expect(qa("#stack .blk2").length).toBe(ctx.length);
    // Main's front door lists About me after the chat, but it changes less, so it runs above it (Dev2, 2026-11-20).
    expect(q("#order-warn")?.textContent).toMatch(/About me: you put it \d+(st|nd|rd|th), it runs \d+(st|nd|rd|th)/);
    expect(q('#stack .blk2[data-openmod="about"] .runs.up')).not.toBeNull();
    expect(q("#stack .cutline")).toBeNull();

    click("[data-sortreads]");
    expect(q("#order-warn")).toBeNull();
    expect(node("fd")!.ctx.indexOf("about")).toBeLessThan(node("fd")!.ctx.findIndex((c) => c.startsWith("chat:")));
    expect(q("#stack .cutline")).not.toBeNull();
  });

  test("the goal is the first thing under the step's name, read as text and edited in place", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "fd" } }));
    const goal = node("fd")!.goal!;
    expect(goal).toBeTruthy();
    // Right after the name row, before the facts line, the card switch and every setting (Dev, 2026-11-26).
    const order = [...q("#props .insbd")!.children].map((el) => el.id || el.className);
    expect(order.indexOf("nGoalText")).toBe(order.indexOf("ph") + 1);
    expect(q("#nGoalText")?.textContent).toBe(goal);
    expect(q("#nGoal")).toBeNull();

    // Esc leaves it as it was.
    click("#nGoalText");
    const box = q("#nGoal") as HTMLTextAreaElement;
    expect(box.value).toBe(goal);
    act(() => {
      box.value = "Thrown away";
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(q("#nGoal")).toBeNull();
    expect(node("fd")!.goal).toBe(goal);

    // Leaving the box saves it.
    click("#nGoalText");
    const box2 = q("#nGoal") as HTMLTextAreaElement;
    act(() => {
      box2.value = "  Answers every text first.  ";
      box2.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(node("fd")!.goal).toBe("Answers every text first.");
    expect(q("#nGoalText")?.textContent).toContain("Answers every text first.");
  });

  test("a group's wires are listed once per line the canvas draws, with how many wires share it", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "frontDoor" } }));
    const raw = G().edges.filter((e) => e.from === "frontDoor" || e.to === "frontDoor");
    const lines = new Set(raw.map((e) => `${e.from}>${e.to}:${e.mode}`));
    // Main's front door box carries several wires from Intake, each under its own condition, on one drawn line.
    expect(raw.length).toBeGreaterThan(lines.size);
    const rows = qa(".wr[data-wire]");
    expect(rows.length).toBe(lines.size);
    expect(rows.map((r) => r.textContent).filter((t) => /×\d/.test(t!)).length).toBeGreaterThan(0);
    // The facts line counts each step once, however many wires join it.
    const froms = new Set(raw.filter((e) => e.to === "frontDoor").map((e) => e.from));
    expect(froms.size).toBeLessThan(raw.filter((e) => e.to === "frontDoor").length);
    expect(q("#props .runmeta")?.textContent).toContain(froms.size === 1 ? "from " : `from ${froms.size} steps`);
  });

  test("a step with no goal says what one is for", () => {
    mount();
    act(() => edit(() => void (node("fd")!.goal = "")));
    act(() => set({ sel: { t: "node", id: "fd" } }));
    expect(q("#nGoalText.empty")?.textContent).toBe("Add a goal: why this step exists, and what breaks without it.");
  });

  test("editing the step's name forks main and changes the step", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "fd" } }));

    commit("#nLabel", "Door 2");

    expect(lab.cur.id).not.toBe("main");
    expect(node("fd")!.label).toBe("Door 2");
    expect(lab.dirty).toBe(true);
  });

  test("the down arrow swaps the first two reads", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "fd" } }));
    const before = [...node("fd")!.ctx];

    click('[data-dn="0"]');

    expect(node("fd")!.ctx[0]).toBe(before[1]);
    expect(node("fd")!.ctx[1]).toBe(before[0]);
  });

  test("the remove button takes the first read out", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "fd" } }));
    const before = [...node("fd")!.ctx];

    click('[data-rm="0"]');

    expect(node("fd")!.ctx).toEqual(before.slice(1));
  });

  test("a model that answers typed questions only sets a one-question schema and hides the free text switch", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "mail" } }));

    commit("#setModel", "clef");

    expect(node("mail")!.model).toBe("clef");
    expect(node("mail")!.outSchema).toEqual([{ name: "answer", type: "choice", options: "yes, no, unsure" }]);
    expect(q("#nOutKind")).toBeNull();
  });

  test("a custom model is added, used, edited and deleted", () => {
    mount();
    act(() => set({ sel: { t: "node", id: "fd" } }));

    click("#mNewModel");
    const name = q("#mfName") as HTMLInputElement;
    expect(name).not.toBeNull();
    name.value = "Kimi K2";
    click("#mfSave");

    const keys = Object.keys(G().models ?? {}).filter((k) => k.startsWith("x-kimi-k2-"));
    expect(keys.length).toBe(1);
    const key = keys[0];
    expect(G().models![key].name).toBe("Kimi K2");
    expect(node("fd")!.model).toBe(key);

    commit("#setModel", "haiku-5-5");
    expect(q("#mEditModel")).toBeNull();

    commit("#setModel", key);
    click("#mEditModel");
    expect(q("#mfDel")).not.toBeNull();

    click("#mfDel");
    expect(G().models?.[key]).toBeUndefined();
  });

  test("the wire panel changes a wire's kind and deleting it clears the selection", () => {
    mount();
    act(() => set({ sel: { t: "edge", i: 0 } }));
    expect(q("#eP")).toBeNull();

    click('#eMode [data-v="loop"]');

    expect(G().edges[0].mode).toBe("loop");
    expect(q("#eP")).not.toBeNull();

    click("#eDel");

    expect(lab.sel).toBeNull();
    expect(q("#props")?.hidden).toBe(true);
  });

  test("a provisional wire picks what stops or restarts its step and what it may do before its go (Dev2, 2026-11-17)", () => {
    mount();
    act(() => set({ sel: { t: "edge", i: 0 } }));
    click('#eMode [data-v="provisional"]');
    expect(G().edges[0].mode).toBe("provisional");
    expect(G().edges[0].when).toEqual(["*"]);
    expect(q('[data-allow="revertible"]')?.getAttribute("aria-pressed")).toBe("true");

    click('[data-when="stop:quiet"]');
    click('[data-when="restart:wait"]');
    click('#eAllow [data-allow="read"]');
    expect(G().edges[0]).toMatchObject({ when: ["stop:quiet", "restart:wait"], allow: "read" });

    // Back to Next: the verdicts and the allow go, as Next reads neither.
    click('#eMode [data-v="wait"]');
    expect(G().edges[0].when).toEqual(["*"]);
    expect(G().edges[0].allow).toBeUndefined();
  });

  test("the module viewer saves new text, counting its tokens, and then offers to go back to main", () => {
    mount();
    act(() => set({ viewer: { kind: "module", key: "map" } }));
    expect(q("#vText")).not.toBeNull();

    commit("#vText", "new text");
    click("#vSave");

    expect(G().modules!.map.text).toBe("new text");
    expect(G().modules!.map.tok).toBe(Math.ceil(8 / 4));
    expect(lab.viewer).toBeNull();

    act(() => set({ viewer: { kind: "module", key: "map" } }));
    expect(q("#vReset")).not.toBeNull();

    click("#vReset");

    expect(G().modules?.map).toBeUndefined();
  });

  test("saving the viewer with the text unchanged adds no module edit", () => {
    mount();
    act(() => set({ viewer: { kind: "module", key: "map" } }));

    click("#vSave");

    expect(G().modules?.map).toBeUndefined();
    expect(lab.cur.id).toBe("main");
  });

  test("the modules page lists a card per module; New module adds one that is focused; its delete removes it", () => {
    mount();
    act(() => go("modules"));

    expect(qa("#modPg .mcard").length).toBe(Object.keys(mods()).length);

    click("#mNew");

    expect(G().modules?.m1?.custom).toBe(true);
    expect(q("#mod-m1")?.classList.contains("focus")).toBe(true);

    click('[data-mdel="m1"]');

    expect(G().modules?.m1).toBeUndefined();
  });

  test("a module field set back to the main value is dropped from the version", () => {
    mount();
    act(() => go("modules"));
    const input = q('[data-mk="hist"][data-mf="tok"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    commit('[data-mk="hist"][data-mf="tok"]', input!.value);

    expect(G().modules?.hist).toBeUndefined();
  });
});
