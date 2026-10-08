/**
 * The console's folder-icon map, without a renderer.
 *
 * The rules that move an icon with its folder are the server's and are tested
 * with the server (`@context/shared`'s `folderIcons.cjs`). These are the
 * console's own promises about the map it holds: a lookup that answers only
 * for folders that have an icon, a rename that carries the icon and everything
 * under it, and nothing that changes the object it was handed.
 */

import { describe, expect, test } from "@jest/globals";
import {
  iconFor,
  iconMapOf,
  movedIcons,
  removedIcons,
  withIcon,
} from "../features/console/files/folderIcons";

describe("reading the icon map", () => {
  test("a folder with an icon answers with it, and one without answers null", () => {
    const icons = iconMapOf([{ path: "2-areas/cooking", icon: "🍳" }]);
    expect(iconFor(icons, "2-areas/cooking")).toBe("🍳");
    expect(iconFor(icons, "2-areas")).toBeNull();
  });

  test("an object property name is not an icon", () => {
    // A folder called `constructor` must not draw `Object`'s constructor as its glyph.
    const icons = iconMapOf([]);
    expect(iconFor(icons, "constructor")).toBeNull();
    expect(iconFor(icons, "toString")).toBeNull();
    expect(iconFor(icons, "__proto__")).toBeNull();
  });

  test("a folder literally named __proto__ keeps its icon and does not change the map's prototype", () => {
    const icons = iconMapOf([{ path: "__proto__", icon: "🔒" }]);
    expect(iconFor(icons, "__proto__")).toBe("🔒");
    expect(Object.getPrototypeOf(icons)).toBe(Object.prototype);
  });
});

describe("setting an icon", () => {
  test("sets one folder and returns a new map", () => {
    const before = iconMapOf([]);
    const after = withIcon(before, "1-projects", "🚀");
    expect(iconFor(after, "1-projects")).toBe("🚀");
    expect(before).toEqual({});
  });

  test("null takes the icon back off, and leaves the others", () => {
    const before = iconMapOf([
      { path: "1-projects", icon: "🚀" },
      { path: "2-areas", icon: "🌱" },
    ]);
    const after = withIcon(before, "1-projects", null);
    expect(iconFor(after, "1-projects")).toBeNull();
    expect(iconFor(after, "2-areas")).toBe("🌱");
    expect(iconFor(before, "1-projects")).toBe("🚀");
  });
});

describe("a move carries the icon with the folder", () => {
  const icons = iconMapOf([
    { path: "1-projects", icon: "🚀" },
    { path: "1-projects/site", icon: "🌐" },
    { path: "1-projects-old", icon: "📦" },
  ]);

  test("the folder and everything beneath it follow, and a sibling that only shares a prefix does not", () => {
    const after = movedIcons(icons, "1-projects", "4-archive/1-projects");
    expect(iconFor(after, "4-archive/1-projects")).toBe("🚀");
    expect(iconFor(after, "4-archive/1-projects/site")).toBe("🌐");
    expect(iconFor(after, "1-projects")).toBeNull();
    expect(iconFor(after, "1-projects-old")).toBe("📦");
  });

  test("a move that touches no icon answers with the same map, so nothing re-renders", () => {
    expect(movedIcons(icons, "3-resources", "2-areas/resources")).toBe(icons);
  });
});

describe("a delete takes the icon with the folder", () => {
  const icons = iconMapOf([
    { path: "1-projects", icon: "🚀" },
    { path: "1-projects/site", icon: "🌐" },
    { path: "1-projects-old", icon: "📦" },
  ]);

  test("the folder and everything beneath it go, and the look-alike sibling stays", () => {
    const after = removedIcons(icons, "1-projects");
    expect(iconFor(after, "1-projects")).toBeNull();
    expect(iconFor(after, "1-projects/site")).toBeNull();
    expect(iconFor(after, "1-projects-old")).toBe("📦");
  });

  test("a folder with no icon answers with the same map", () => {
    expect(removedIcons(icons, "3-resources")).toBe(icons);
  });
});
