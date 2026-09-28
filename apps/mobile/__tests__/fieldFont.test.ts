/**
 * @jest-environment jsdom
 */

/**
 * Every text field is at least 16px on a phone, so mobile Safari never zooms
 * the page when one takes focus (the owner's phone pass, 2026-09-27).
 *
 * Three halves: the rule itself, the shared `TextField` rendering at the right
 * size on both layouts, and a scan holding every `TextInput` in the app to the
 * rule — a field added next month at 13px is exactly the regression nobody
 * sees on a desktop.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { FIELD_MIN_PHONE, fieldFontSize } from "../features/design/fieldFont";
import { TextField } from "../features/design/components/Input";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("fieldFontSize", () => {
  test("raises a field under 16 on a phone and leaves a pointer layout alone", () => {
    expect(FIELD_MIN_PHONE).toBe(16);
    expect(fieldFontSize(13, true)).toBe(16);
    expect(fieldFontSize(15, true)).toBe(16);
    expect(fieldFontSize(22, true)).toBe(22);
    expect(fieldFontSize(13, false)).toBe(13);
  });
});

function fontSizeAt(width: number): string {
  // jsdom lays nothing out; react-native-web measures these and refreshes on
  // `resize` (see `paletteRender/fixtures.ts`).
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(TextField, { label: "Email", value: "", testID: "field" }));
  });
  const input = container.querySelector<HTMLInputElement>('[data-testid="field"]')!;
  const size = getComputedStyle(input).fontSize;
  act(() => root.unmount());
  container.remove();
  return size;
}

describe("TextField", () => {
  test("is 16px on a phone", () => {
    expect(fontSizeAt(390)).toBe("16px");
  });

  test("keeps the console's 15px on a desktop", () => {
    expect(fontSizeAt(1280)).toBe("15px");
  });
});

/**
 * Files whose fields are 16px or larger on a phone some other way, each with
 * the reason. Anything else that renders a `TextInput` must use `useFieldFont`
 * or `FIELD_MIN_PHONE`.
 */
const SIZED_ANOTHER_WAY: Readonly<Record<string, string>> = {
  "features/design/components/Palette.tsx": "the touch sheet sets touchType.lede (17)",
  "features/meetings/components/NotesPad.tsx": "pointerType.body, 16",
  "features/meetings/components/MeetingTitleField.tsx": "pointerType.h2, 23",
  "features/console/plugins/PluginSuggestDialog.tsx": "pointerType.body, 16",
  "features/console/settings/SettingsList.tsx": "searchTouch sets touchType.ui on a phone",
  "features/console/files/shareDialog/RecipientPicker.tsx": "inputCompact sets touchType.ui on a phone",
  "features/console/files/LiveEditor.tsx": "the phone's fallbackReading is pointerType.body, 16",
  // Known 15px on a phone. The note editor was out of the scope of the change
  // that added this guard; take it off this list when its properties get
  // `useFieldFont`.
  "features/console/files/noteEditor/PropertyFields.tsx": "note editor, not yet raised (15px)",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("every TextInput in the app", () => {
  const root = join(__dirname, "..");
  const withFields = [...sources(join(root, "features")), ...sources(join(root, "app"))]
    .filter((path) => readFileSync(path, "utf8").includes("<TextInput"))
    .map((path) => relative(root, path));

  test("the scan finds the fields it is meant to hold", () => {
    expect(withFields).toContain("features/design/components/Input.tsx");
    expect(withFields.length).toBeGreaterThan(20);
  });

  test("is 16px or more on a phone, or says why it already is", () => {
    const unsized = withFields.filter((path) => {
      if (SIZED_ANOTHER_WAY[path] !== undefined) return false;
      const text = readFileSync(join(root, path), "utf8");
      return !text.includes("useFieldFont(") && !text.includes("FIELD_MIN_PHONE");
    });
    expect(unsized).toEqual([]);
  });

  test("the exemptions still name files with fields in them", () => {
    for (const path of Object.keys(SIZED_ANOTHER_WAY)) expect(withFields).toContain(path);
  });
});
