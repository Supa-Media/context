/**
 * @jest-environment jsdom
 */
/**
 * THE VAULT IS ITS OWN PLACE, NOT A PAGE OF SETTINGS (Dev, 2026-11-23: "it's
 * not really supposed to exist in settings ... it's kind of its own thing").
 *
 * On a layout with a right panel it is the rail's Vault tab; a phone has no
 * panel, so there it is a button on the account sheet beside Settings,
 * Meetings and Tex, and a page where a note would be. Its address is
 * `?vault=1`, and the `?settings=vault` link that emails already carry still
 * lands on it.
 *
 * SABOTAGE, applied and reverted:
 *  - `showVault` not called from `useConsoleVaultRoute`: the pointer tests fail
 *    on `aside-vault`.
 *  - the old alias dropped from `vaultFromQuery`: the `?settings=vault` test
 *    and the alias unit test fail.
 *  - `vault` handed to the switcher on a pointer layout: "a pointer layout
 *    keeps the Vault on the rail" fails.
 */
import { describe, expect, jest, test } from "@jest/globals";
// `./fixtures` first, for the mocks it registers (see `switcherAndNav.test.ts`).
import { mockConsoleState, mountConsole } from "./fixtures";
import { routeVault, vaultFromQuery, vaultHref } from "../../features/console/vault/route";
import { settingsFromQuery } from "../../features/console/nav";

// The tab's list is `VaultList`'s own tests'; here only where the vault is.
jest.mock("../../features/console/vault/useVaultActions", () => ({
  useVaultActions: () => null,
}));

const withQuery = (query: Record<string, string>, run: () => void) => {
  mockConsoleState.query = query;
  mockConsoleState.paramsSet.length = 0;
  try {
    run();
  } finally {
    mockConsoleState.query = {};
    mockConsoleState.paramsSet.length = 0;
  }
};

describe("the vault's address", () => {
  test("?vault=1 asks for it, and so does an old ?settings=vault link", () => {
    expect(vaultFromQuery("1", undefined)).toBe(true);
    expect(vaultFromQuery(["1"], undefined)).toBe(true);
    expect(vaultFromQuery(undefined, "vault")).toBe(true);
    expect(vaultFromQuery(undefined, undefined)).toBe(false);
    expect(vaultFromQuery("0", "email")).toBe(false);
    expect(vaultHref("supa")).toBe("/console/@supa?vault=1");
  });

  test("Settings has no Vault section left to open", () => {
    expect(settingsFromQuery("vault")).toBeNull();
  });

  test("opening it closes the other pages in the slot, and closing takes the old alias off too", () => {
    const set: Record<string, unknown>[] = [];
    const route = routeVault({ setParams: (params) => set.push(params) }, false, "ws_1");
    route.openVault();
    route.closeVault();
    expect(set).toEqual([
      { vault: "1", map: undefined, trash: undefined, settings: undefined },
      { vault: undefined, settings: undefined },
    ]);
  });
});

describe("on a layout with a right panel", () => {
  test("?vault=1 opens the panel on the Vault tab once and clears itself", () => {
    withQuery({ vault: "1" }, () => {
      const app = mountConsole(1440);
      expect(app.find("aside-vault")).not.toBeNull();
      expect(app.find("aside-tab-vault")).not.toBeNull();
      expect(mockConsoleState.paramsSet).toEqual([{ vault: undefined, settings: undefined }]);
      app.unmount();
    });
  });

  test("an old ?settings=vault link lands on the tab, not on Settings", () => {
    withQuery({ settings: "vault" }, () => {
      const app = mountConsole(1440);
      expect(app.find("aside-vault")).not.toBeNull();
      expect(mockConsoleState.paramsSet).toEqual([{ vault: undefined, settings: undefined }]);
      app.unmount();
    });
  });

  test("a pointer layout keeps the Vault on the rail, not in the account menu", () => {
    const app = mountConsole(1440);
    app.press(app.find("account-switcher"));
    expect(app.find("switcher-vault")).toBeNull();
    app.unmount();
  });
});

describe("on a phone", () => {
  test("the account sheet offers the Vault right after Tex, and it opens ?vault=1", () => {
    const app = mountConsole(390);
    app.press(app.find("account-menu"));
    const ids = Array.from(document.body.querySelectorAll('[data-testid^="switcher-"]')).map((node) =>
      node.getAttribute("data-testid"),
    );
    expect(ids.indexOf("switcher-vault")).toBe(ids.indexOf("switcher-tex") + 1);
    mockConsoleState.paramsSet.length = 0;
    app.press(app.find("switcher-vault"));
    expect(mockConsoleState.paramsSet).toEqual([{ vault: "1", map: undefined, trash: undefined, settings: undefined }]);
    app.unmount();
  });

  test("?vault=1 stays on the address, for the page, and opens no panel", () => {
    withQuery({ vault: "1" }, () => {
      const app = mountConsole(390);
      expect(app.find("aside-panel")).toBeNull();
      expect(mockConsoleState.paramsSet).toEqual([]);
      app.unmount();
    });
  });
});
