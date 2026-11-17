/**
 * @jest-environment jsdom
 */

/**
 * /lab's Eval plan page, actually rendered: the whole route mounted as staff, the page reached by its nav row. What it
 * proves: the page is in the Lab's nav and its address (`?page=evals`), it names the retrieval gap and both milestones
 * with their targets, the structure section shows Jhon's picture (the file, not a redrawing), and its Testing link opens Testing.
 *
 * Every value here is fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-16):
 *   (a) "evals" dropped from labPlace.ts VIEWS          the address round-trip test fails
 *   (b) the evals row dropped from TexLab.web.tsx NAV    the nav test fails (no row to click)
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockAnswers = new Map<string, unknown>();
const mockTexHost = true;

jest.mock("convex/react", () => {
  const { getFunctionName } = jest.requireActual<typeof import("convex/server")>("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      return args === "skip" ? undefined : mockAnswers.get(name);
    },
    useMutation: () => async () => null,
  };
});
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  return { Redirect: ({ href }: { href: string }) => createElement("div", { "data-testid": "redirect", "data-href": href }) };
});
jest.mock("../features/site/host", () => ({ isTexHost: () => mockTexHost }));
// The test chat under the canvas reaches the gateway with the person's own grant; no gateway here.
// Testing itself needs a signed-in session; here only the switch to it matters.
jest.mock("../features/tex/lab/views/testing/Testing.web", () => ({ Testing: () => null }));
jest.mock("../features/tex/lab/views/canvas/sandboxCall", () => ({ useSandboxCall: () => false }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
// jsdom has no CSS.escape; the browser has it. The case editor's Keep uses it to find its own boxes.
if (!("CSS" in globalThis)) {
  (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (ch) => "\\" + ch) };
}

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import TexLabRoute from "../app/(app)/lab";
import { clone, lab, MAIN } from "../features/tex/lab/engine/state";
import { placeOf, searchOf } from "../features/tex/lab/views/labPlace";

const roots: Array<() => void> = [];
function render(el: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(el));
  return container;
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
});

beforeEach(() => {
  lab.cur = clone(MAIN);
  lab.versions = [MAIN];
  lab.caseEdits = {};
  lab.dirty = false;
  lab.mode = "lab";
  lab.view = "canvas";
  lab.viewer = null;
  lab.sel = null;
  lab.cfocus = null;
});

function mountLab() {
  mockAnswers.set("functions/admin:amIAdmin", true);
  mockAnswers.set("functions/texLab:list", { me: "u1", versions: [], caseEdits: [] });
  return render(createElement(TexLabRoute));
}
const q = (s: string) => document.querySelector<HTMLElement>(s);
function click(el: Element | null | undefined) {
  if (!el) throw new Error("expected an element to click");
  act(() => (el as HTMLElement).click());
}

describe("/lab Eval plan", () => {
  test("its nav row opens the page, with the retrieval gap and both milestones", () => {
    mountLab();
    click(q('[data-view="evals"]'));
    const page = q('[data-testid="eval-plan"]');
    expect(page).not.toBeNull();
    const text = page!.textContent ?? "";
    expect(text).toContain("What we measure today: Tex's replies");
    expect(text).toContain("The gap: context retrieval");
    expect(text).toContain("Milestone 1: memory trial");
    expect(text).toContain("87%");
    expect(text).toContain("90%");
    expect(text).toContain("60");
    expect(text).toContain("Milestone 2: testing on real chat data");
    expect(text).toContain("Consent comes first");
  });

  test("the structure section shows Jhon's picture, not a placeholder", () => {
    mountLab();
    click(q('[data-view="evals"]'));
    expect(q('[data-testid="eval-structure-placeholder"]')).toBeNull();
    const img = q('[data-testid="eval-structure-picture"]') as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("/lab/eval-structure.webp");
    expect(img?.getAttribute("alt")).toContain("Tex Eval System");
  });

  test("the picture's file is in the app's public folder", () => {
    const { existsSync } = jest.requireActual<typeof import("fs")>("fs");
    const { join } = jest.requireActual<typeof import("path")>("path");
    expect(existsSync(join(__dirname, "..", "public", "lab", "eval-structure.webp"))).toBe(true);
  });

  test("Open Testing switches the Lab to Testing", () => {
    mountLab();
    click(q('[data-view="evals"]'));
    click([...document.querySelectorAll("button")].find((b) => b.textContent === "Open Testing"));
    expect(lab.mode).toBe("testing");
  });

  test("its address round-trips as ?page=evals", () => {
    const place = placeOf("?page=evals");
    expect(place.view).toBe("evals");
    expect(searchOf(place)).toBe("?page=evals");
  });
});
