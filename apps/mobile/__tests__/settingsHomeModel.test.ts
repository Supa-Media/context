/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => undefined,
  useMutation: () => async () => undefined,
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useConvex: () => undefined,
  useQuery: () => undefined,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TEX_SETTINGS } from "@context/shared/src/texSettings.cjs";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import type { ConsoleData } from "../features/console/types";
import { settingsHome, texListRows, readableLine } from "../features/console/settings/home/homeModel";
import { SETTINGS_SECTIONS } from "../features/console/settings/sections";

/**
 * The one-page settings home (Dev2, 2026-11-12), read as data.
 *
 * SABOTAGE: drop a key from `settingsHome`'s `pick` lists and "every section
 * this context has is a row" fails; write a Tex row by hand instead of from
 * `TEX_SETTINGS` and "one list" fails when the registry changes.
 */
function demoData(): ConsoleData {
  let out: ConsoleData | null = null;
  function Probe() {
    out = useDemoConsoleData();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
  if (out === null) throw new Error("the demo console did not resolve");
  return out;
}

const data = demoData();

describe("every setting is on the page", () => {
  test("every section this context has is a row, once", () => {
    const home = settingsHome({ data, sections: SETTINGS_SECTIONS, texLine: "+15555550177", canSignOut: true });
    const opened = home
      .flatMap((section) => section.rows)
      .flatMap((row) => (row.action.kind === "open" ? [row.action.key] : []));
    for (const entry of SETTINGS_SECTIONS) expect(opened).toContain(entry.key);
  });

  test("a section this context does not have is absent, not greyed", () => {
    const sections = SETTINGS_SECTIONS.filter((entry) => entry.key !== "premium");
    const home = settingsHome({ data, sections, canSignOut: false });
    const ids = home.flatMap((section) => section.rows).map((row) => row.id);
    expect(ids).not.toContain("premium");
    expect(ids).not.toContain("sign-out");
    // No Tex line configured: no row promising one.
    expect(ids).not.toContain("tex-line");
  });

  test("leaving is on the page: the workspace's download is its own row", () => {
    const home = settingsHome({ data, sections: SETTINGS_SECTIONS, canSignOut: true });
    const workspace = home.find((section) => section.id === "workspace");
    expect(workspace?.rows.map((row) => row.id)).toContain("download");
  });

  test("everything in the Workspace section is that workspace's, and it comes after everything that follows you", () => {
    const home = settingsHome({ data, sections: SETTINGS_SECTIONS, texLine: "+15555550177", canSignOut: true });
    const ids = home.map((section) => section.id);
    expect(ids.indexOf("workspace")).toBeGreaterThan(ids.indexOf("account"));
    expect(ids.indexOf("workspace")).toBeGreaterThan(ids.indexOf("tex"));
    const workspaceKeys = home
      .find((section) => section.id === "workspace")!
      .rows.flatMap((row) => (row.action.kind === "open" ? [row.action.key] : []));
    const scopeOf = new Map(SETTINGS_SECTIONS.map((entry) => [entry.key, entry.scope]));
    for (const key of workspaceKeys) expect(scopeOf.get(key)).toBe("context");
  });

  test("a row's line is its value, never a sentence about the setting", () => {
    const home = settingsHome({ data, sections: SETTINGS_SECTIONS, texLine: "+15555550177", canSignOut: true });
    for (const row of home.flatMap((section) => section.rows)) {
      if (row.line === null) continue;
      expect(row.line.split(/\s+/).length).toBeLessThanOrEqual(7);
      expect(row.line).not.toMatch(/\.$/);
    }
  });
});

describe("the Tex rows are the list Tex reads by text", () => {
  test("one row per 1:1 setting, except the ones with a page of their own", () => {
    const own = new Set(["talk", "apps", "vault", "vault_delete"]);
    const expected = TEX_SETTINGS.filter((setting) => setting.where.includes("1:1") && !own.has(setting.key));
    expect(texListRows().map((row) => row.title)).toEqual(expected.map((setting) => setting.label));
    for (const row of texListRows()) expect(row.line).toBeNull();
  });

  test("the page gathers the settings Tex changes by text into one row that says so", () => {
    const home = settingsHome({ data, sections: SETTINGS_SECTIONS, canSignOut: true });
    const tex = home.find((section) => section.id === "tex")!;
    const row = tex.rows.find((entry) => entry.id === "tex-by-text");
    expect(row?.action.kind).toBe("byText");
    expect(tex.rows.filter((entry) => entry.action.kind === "byText")).toHaveLength(1);
  });

  test("a setting Tex changes by text says so instead of offering a button", () => {
    for (const row of texListRows()) {
      const setting = TEX_SETTINGS.find((entry) => entry.label === row.title)!;
      expect(row.action.kind).toBe(setting.byText ? "byText" : "none");
    }
  });
});

test("a US line reads the way people write it", () => {
  expect(readableLine("+15555550177")).toBe("+1 (555) 555-0177");
  expect(readableLine("+447700900123")).toBe("+447700900123");
});
