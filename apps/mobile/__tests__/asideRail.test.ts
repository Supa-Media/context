/**
 * @jest-environment jsdom
 */
/**
 * The right rail is always there, open or folded (Dev2, 2026-11-20: "the
 * meeting and tex icon just live forever in a thin right column"): its
 * chevron sits on top and folds or opens the panel, the open tab's own icon
 * folds it again, another tab switches, and search rides on it too.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AsideStrip } from "../features/console/aside/AsideStrip";
import type { AsideTab } from "../features/console/aside/tabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()!();
  document.body.innerHTML = "";
});

function rail(props: { open: boolean; showing?: AsideTab; waiting?: string; search?: boolean; vaultWaiting?: boolean }) {
  const onUnfold = jest.fn<(tab: AsideTab | null) => void>();
  const onFold = jest.fn<() => void>();
  const onSearch = jest.fn<() => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(AsideStrip, {
        tabs: props.vaultWaiting === undefined ? ["meetings", "tex"] : ["meetings", "tex", "vault"],
        showing: props.showing ?? "tex",
        recording: false,
        open: props.open,
        waiting: props.waiting ?? "",
        onUnfold,
        onFold,
        onSearch: props.search === false ? null : onSearch,
        vaultWaiting: props.vaultWaiting ?? false,
      }),
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const press = (id: string) => {
    const node = find(id);
    if (node === null) throw new Error(`no element with testID ${id}`);
    act(() => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const order = () => Array.from(find("aside-strip")!.children).map((c) => c.getAttribute("data-testid"));
  return { find, press, order, onUnfold, onFold, onSearch };
}

describe("the right rail", () => {
  test("open: the chevron on top folds, the open tab folds, another tab switches", () => {
    const r = rail({ open: true });
    expect(r.order()[0]).toBe("aside-fold");
    r.press("aside-fold");
    expect(r.onFold).toHaveBeenCalledTimes(1);
    r.press("aside-tab-tex");
    expect(r.onFold).toHaveBeenCalledTimes(2);
    expect(r.onUnfold).not.toHaveBeenCalled();
    r.press("aside-tab-meetings");
    expect(r.onUnfold).toHaveBeenCalledWith("meetings");
  });

  test("folded: the chevron opens it as it was, a tab opens it on that tab", () => {
    const r = rail({ open: false });
    expect(r.order()[0]).toBe("aside-unfold");
    r.press("aside-unfold");
    expect(r.onUnfold).toHaveBeenLastCalledWith(null);
    r.press("aside-strip-tex");
    expect(r.onUnfold).toHaveBeenLastCalledWith("tex");
    expect(r.onFold).not.toHaveBeenCalled();
  });

  test("search sits under the chevron, above the tabs, and opens the palette", () => {
    const r = rail({ open: true });
    expect(r.order()).toEqual(["aside-fold", "aside-strip-search", null, "aside-tab-meetings", "aside-tab-tex"]);
    r.press("aside-strip-search");
    expect(r.onSearch).toHaveBeenCalledTimes(1);
    expect(rail({ open: true, search: false }).find("aside-strip-search")).toBeNull();
  });

  test("what waits for a yes rides on Tex's icon, in its name too", () => {
    const r = rail({ open: false, waiting: "2" });
    expect(r.find("aside-tab-tex-count")?.textContent).toBe("2");
    expect(r.find("aside-strip-tex")?.getAttribute("aria-label")).toBe("Tex, 2 waiting");
    expect(rail({ open: false }).find("aside-tab-tex-count")).toBeNull();
  });
});

/*
  The approved vault prototype (Dev, 2026-11-23) marks the key when an AI
  waits for a yes on one of its keys, until the Vault is the tab showing.
  SABOTAGE: drop the dot from `AsideStrip` and the first line fails.
*/
describe("the vault's key on the rail", () => {
  test("is dotted while a key's ask waits, except while the Vault is open", () => {
    expect(rail({ open: false, vaultWaiting: true }).find("aside-tab-vault-dot")).not.toBeNull();
    expect(rail({ open: true, showing: "vault", vaultWaiting: true }).find("aside-tab-vault-dot")).toBeNull();
    expect(rail({ open: false, vaultWaiting: false }).find("aside-tab-vault-dot")).toBeNull();
  });
});

describe("the rail beside the panel (Dev2, 2026-11-21 roast)", () => {
  test("open, a hairline divides the rail from the panel; folded there is no panel to divide from", () => {
    const open = rail({ open: true });
    expect(getComputedStyle(open.find("aside-strip")!).borderLeftWidth).not.toMatch(/^0(px)?$|^$/);
    const folded = rail({ open: false });
    expect(getComputedStyle(folded.find("aside-strip")!).borderLeftWidth).toMatch(/^0(px)?$|^$/);
  });

  test("the toggle is named as the left sidebar's is, a panel to show or hide rather than an arrow", () => {
    expect(rail({ open: true }).find("aside-fold")?.getAttribute("aria-label")).toBe("Hide the side panel");
    expect(rail({ open: false }).find("aside-unfold")?.getAttribute("aria-label")).toBe("Show the side panel");
  });
});
