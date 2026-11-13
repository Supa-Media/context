/**
 * @jest-environment jsdom
 */

/**
 * /lab, actually rendered: the Tex Architecture Lab's chrome (Dev2, 2026-11-13: build the Lab artifact
 * for real, "EXACTLY like the artifact"). The host decides; somebody who is not staff sees "Staff only" and nothing
 * is asked for; the sidebar is the artifact's (views, test user Maya, her workspaces and group chat, versions); a
 * view's row opens its page; saved versions come from the staff-shared list and open on a click.
 *
 * Every value here is fake. This repository is public.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-13):
 *   `TexLabRoute` redirecting off tex.lc again                  "it opens on context.lc as on tex.lc" fails
 *   `useLabSync` asking without the staff check ("skip" gone)   "not staff" fails
 *   `go` not setting the view                                   "a view's row opens its page" fails
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

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
jest.mock("../features/site/host", () => ({ isTexHost: () => mockTexHost }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import TexLabRoute from "../app/(app)/lab";
import OldTexLabRoute from "../app/(app)/admin/lab";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockAnswers.clear();
  mockArgs.clear();
  mockTexHost = true;
});

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(TexLabRoute)));
  return container;
}
const q = (s: string) => document.querySelector<HTMLElement>(s);
const text = (s: string) => [...document.querySelectorAll(s)].map((e) => e.textContent?.trim());

const ADMIN = "functions/admin:amIAdmin";
const LIST = "functions/texLab:list";
const graph = JSON.stringify({ nodes: [], edges: [] });

describe("/lab", () => {
  test("it opens on context.lc as on tex.lc, and the first address redirects to it (Dev2, 2026-11-13)", () => {
    mockTexHost = false;
    mount();
    expect(q('[data-testid="tex-lab"]')).not.toBeNull();
    const old = document.createElement("div");
    document.body.appendChild(old);
    const root = createRoot(old);
    act(() => root.render(createElement(OldTexLabRoute)));
    expect(old.querySelector('[data-testid="redirect"]')?.getAttribute("data-href")).toBe("/lab");
    act(() => root.unmount());
  });

  test("somebody who is not staff sees Staff only, and the shared list is not asked for", () => {
    mockAnswers.set(ADMIN, false);
    mount();
    expect(q('[data-testid="tex-lab-staff-only"]')).not.toBeNull();
    expect(mockArgs.get(LIST)).toBe("skip");
  });

  test("until the staff check answers, no view is drawn, so no view's query runs for somebody who is not staff", () => {
    mount();
    expect(q('[data-testid="tex-lab"]')).not.toBeNull();
    expect(q(".bar")).toBeNull();
    expect(q('[data-testid="tex-lab-staff-only"]')).toBeNull();
  });

  test("the sidebar is the artifact's, a view's row opens its page, and a saved version opens on a click", () => {
    mockAnswers.set(ADMIN, true);
    mockAnswers.set(LIST, { me: "u1", names: { u1: "@staff" }, versions: [{ versionId: "vabc", name: "Faster judge", authorId: "u1", graph, picks: "{}", areas: null, results: "[]", createdAt: 1, updatedAt: 2 }], caseEdits: [] });
    mount();
    expect(text("#side > .rowi .nm")).toEqual(["Architecture", "Context modules", "Conversations", "Tools", "Speed and cost", "Test cases", "Run", "Compare versions"]);
    expect(text("#wsList .nm")).toEqual(["maya", "fashion-brand", "band"]);
    expect(text("#gcList .nm")).toEqual(["band chat"]);
    expect(text("#verList .nm")).toEqual(["main", "Faster judge"]);
    expect(q("#syncState")?.textContent).toBe("Shared · 1 saved version");
    expect(q("#saveBtn")?.hasAttribute("disabled")).toBe(true);

    act(() => q('[data-view="tools"]')!.click());
    expect(q("#v-tools")?.hidden).toBe(false);
    expect(q("#v-canvas")?.hidden).toBe(true);
    expect(q('[data-view="tools"]')?.getAttribute("aria-current")).toBe("true");

    act(() => q('[data-ver="vabc"]')!.click());
    expect(q("#verRename")?.hidden).toBe(false);
    expect((q("#verRename") as HTMLInputElement).value).toBe("Faster judge");
  });
});
