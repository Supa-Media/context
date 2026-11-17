/**
 * @jest-environment jsdom
 */

/**
 * The Lab's clash picks (`views/bar/PromoteClashes.web.tsx`): a Promote refused because main changed the same thing
 * names each clash; the person picks main's or this draft's for each and promotes again with those picks, as tex_dev's
 * `promote { draft, picks }` does. A clash with no draft side blocks the picked Promote.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-17):
 *   `picksToSend` ignoring an unpickable clash        "a clash with no draft side can't be promoted past" fails
 *   the button sending no picks                        "picking each and promoting sends the picks" fails
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const mockPromote = jest.fn<(picks?: unknown) => Promise<void>>(async () => undefined);
jest.mock("../features/tex/lab/store", () => ({ promoteVersion: (picks?: unknown) => mockPromote(picks) }));

import { PromoteClashes, picksToSend } from "../features/tex/lab/views/bar/PromoteClashes.web";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clashes = [
  { what: "Front door effort", main: "high", draft: "low", pick: true },
  { what: "the words of prompt module rules", main: "changed them", draft: "changed them", pick: true },
];

let root: Root | null = null;
let box: HTMLDivElement;
function show(promote: Parameters<typeof PromoteClashes>[0]["promote"], dirty = false) {
  box = document.createElement("div");
  document.body.appendChild(box);
  root = createRoot(box);
  const onDone = jest.fn();
  act(() => root!.render(createElement(PromoteClashes, { promote, dirty, onDone })));
  return onDone;
}
const click = (el: Element | null) => act(() => (el as HTMLButtonElement).click());
const picked = () => box.querySelector<HTMLButtonElement>("#promotePicked")!;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  box?.remove();
  mockPromote.mockClear();
});

describe("Promote's clash picks", () => {
  test("picking each and promoting sends the picks", () => {
    const onDone = show({ state: "refused", pr: null, why: "main changed the same things", clashes, picks: [] });
    expect(box.querySelectorAll(".clash")).toHaveLength(2);
    expect(picked().disabled).toBe(true);
    const [first, second] = [...box.querySelectorAll(".clash")];
    click(first.querySelectorAll("button")[1]);
    expect(picked().disabled).toBe(true);
    click(second.querySelectorAll("button")[0]);
    expect(picked().disabled).toBe(false);
    click(picked());
    expect(mockPromote).toHaveBeenCalledWith([
      { what: "Front door effort", take: "draft" },
      { what: "the words of prompt module rules", take: "main" },
    ]);
    expect(onDone).toHaveBeenCalled();
  });

  test("a clash with no draft side can't be promoted past", () => {
    const stuck = [...clashes, { what: "wire fd → gone (wait)", main: "changed so this edit no longer applies", draft: "no step gone", pick: false }];
    expect(picksToSend(stuck, { "Front door effort": "main", "the words of prompt module rules": "main", "wire fd → gone (wait)": "draft" })).toBeNull();
    show({ state: "refused", pr: null, why: "x", clashes: stuck });
    expect(box.textContent).toMatch(/fresh draft/);
    expect(picked().disabled).toBe(true);
  });

  test("an unsaved draft can't promote, a plain refusal shows why, and nothing shows otherwise", () => {
    show({ state: "refused", pr: null, why: "x", clashes, picks: [{ what: "Front door effort", take: "main" }, { what: "the words of prompt module rules", take: "draft" }] }, true);
    expect(picked().disabled).toBe(true);
    act(() => root!.unmount());
    show({ state: "refused", pr: null, why: 'step "brandnew" is new', clashes: [] });
    expect(box.querySelector("#promoteWhy")?.textContent).toMatch(/brandnew/);
    act(() => root!.unmount());
    show({ state: "opened", pr: "https://github.com/x/y/pull/1", why: null });
    expect(box.innerHTML).toBe("");
  });
});
