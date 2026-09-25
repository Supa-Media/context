/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of the share dialog, for the design audit every UI change here
 * gets before it ships (`docs/decisions/app-and-console.md`).
 *
 * Same technique as `design-shots.ts` and `editor-accessory-shots.ts`: the
 * shipped component, rendered by react-dom into a real DOM, written out as a
 * self-contained `.html`, and photographed by Playwright — never a mock-up. A
 * picture of a component nobody ships is worth nothing in a review.
 *
 *     pnpm exec jest --testMatch '**\/scripts/share-sheet-shots.ts' --testPathIgnorePatterns '[]'
 *
 * Each board is written at a desktop and a phone width, in the Paper theme.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(__dirname, "../../../docs/design/share-sheet");

const { ShareDialog } = require("../features/console/files/ShareDialog") as typeof import("../features/console/files/ShareDialog");
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { StyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
});

function stampViewport(width: number, height: number): void {
  for (const [key, value] of [
    ["clientWidth", width],
    ["clientHeight", height],
  ] as const) {
    Object.defineProperty(document.documentElement, key, { value, configurable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function page(title: string, body: string, css: string, width: number, height: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #F4F1EA; }
  #note { position: absolute; inset: 0; padding: 72px 12% 0; background: #FFFDF9; color: #4A443C; font: 17px/1.65 "Instrument Sans", sans-serif; }
  #note h1 { font-size: 30px; color: #1A1714; margin: 0 0 16px; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot"><div id="note"><h1>Artist role</h1><p>Being an artist is like running a business: expect ten or more hours a week on craft, rehearsal and the work nobody sees.</p><p>Artists lead worship on Sundays and at street gatherings, write and arrange new songs, and mentor anyone joining the team.</p></div>${body}</div></body></html>`;
}

function mount(node: ReturnType<typeof createElement>, width: number, height: number): void {
  stampViewport(width, height);
  container = document.createElement("div");
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root!.render(createElement(ThemeProvider, { scheme: "light", children: node }));
  });
}

/** The sheet is a `Modal`: react-native-web portals it outside the container. */
const sheet = () => document.body.querySelector<HTMLElement>('[aria-label^="Share "]');
const byId = (testId: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function press(node: HTMLElement | null): void {
  if (node === null) throw new Error("nothing to press");
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

function type(node: HTMLElement | null, value: string): void {
  if (node === null) throw new Error("nothing to type into");
  act(() => {
    const input = node as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function write(name: string, width: number, height: number): void {
  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  // The whole portalled modal: its menus are siblings of the card, not inside it.
  const modal = [...document.body.children].filter((node) => node !== container);
  expect(sheet()).not.toBeNull();
  writeFileSync(file, page(name, modal.map((node) => node.outerHTML).join(""), css, width, height));
}

const MEMBERS = [
  { userId: "u1", role: "owner", name: "Seyi O", email: "seyi@example.invalid", isMe: true },
  { userId: "u2", role: "editor", name: "Layomi A", email: "layomi@example.invalid", isMe: false },
  { userId: "u3", role: "editor", name: "John B", email: "john@example.invalid", isMe: false },
  { userId: "u4", role: "member", name: "Lara K", email: "lara@example.invalid", isMe: false },
];

const GROUPS = [{ name: "public-worship-leads", label: "leads", liveCount: 3 }];
const NOTE = "artists/artist-role.md";

const share = (overrides: Record<string, unknown>) => ({
  shareId: "s-person",
  token: "a".repeat(64),
  recipient: "Kemi D",
  audience: "name",
  entryPath: NOTE,
  titleInPreview: false,
  collecting: false,
  createdAt: 1,
  ...overrides,
});
const OPEN_LINK = share({ shareId: "s-open", recipient: "Anyone with the link", audience: "anyone" });

function dialog(overrides: Record<string, unknown> = {}) {
  return createElement(ShareDialog as never, {
    path: NOTE,
    shares: [],
    origin: "https://example.invalid",
    onShare: () => {},
    onCopyLink: async () => ({ ok: true, message: null }),
    onRevoke: () => {},
    onSetPreviewTitle: () => {},
    onClose: () => {},
    onShareWithGroup: () => {},
    onRemovalRoute: () => {},
    onCreateGroup: () => {},
    onSetScope: () => {},
    onSetSlug: async () => true,
    onSetCollecting: async () => true,
    groupSlug: "public-worship",
    entryKind: "file",
    groups: GROUPS,
    context: { slug: "public-worship", kind: "shared", viewerIsOwner: true },
    access: { visibility: "private", exception: true, members: MEMBERS },
    advanced: {
      action: {
        id: "encrypt",
        label: "Encrypt with a password…",
        detail: "Only people you tell the password can read it. Not Context, and not your AI tools.",
        icon: "lock",
        testID: "share-lock-note",
        onPress: () => {},
      },
    },
    ...overrides,
  } as never);
}

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 820 },
  { name: "phone", width: 390, height: 844 },
] as const;

/** One board at both widths: mount, act, assert, write. */
function board(
  name: string,
  overrides: Record<string, unknown>,
  steps: () => void = () => {},
): void {
  for (const viewport of VIEWPORTS) {
    mount(dialog(overrides), viewport.width, viewport.height);
    steps();
    write(`${name}-${viewport.name}`, viewport.width, viewport.height);
    act(() => root!.unmount());
    container!.remove();
    root = null;
    container = null;
  }
}

const TEAM = { access: { visibility: "team", exception: false, members: MEMBERS } };

describe("share dialog shots", () => {
  test("a restricted note", () => {
    board("01-restricted", {}, () => expect(byId("share-audience")).not.toBeNull());
  });

  test("typing a name offers people, groups and a way to make one", () => {
    board("02-typing", {}, () => {
      type(document.body.querySelector('[aria-label="Share with"]'), "la");
      expect(byId("share-suggestions")).not.toBeNull();
    });
  });

  test("a picked person waits for Share", () => {
    board("03-picked", {}, () => {
      type(document.body.querySelector('[aria-label="Share with"]'), "layomi");
      press(byId("share-suggest-u2"));
      expect(byId("share-submit")).not.toBeNull();
    });
  });

  test("shared with people and a group", () => {
    board("04-shared", {
      shares: [share({}), share({ shareId: "s-2", recipient: "Tola F" })],
    });
  });

  test("inherited from its folder", () => {
    board("05-inherited", TEAM, () => expect(byId("share-inherited")).not.toBeNull());
  });

  test("the audience menu", () => {
    board("06-audience-menu", TEAM, () => {
      press(byId("share-audience"));
      expect(byId("share-audience-anyone")).not.toBeNull();
    });
  });

  test("going public asks first", () => {
    board("07-going-public", TEAM, () => {
      press(byId("share-audience"));
      press(byId("share-audience-anyone"));
      expect(byId("share-confirm-public")).not.toBeNull();
    });
  });

  test("a live public link, with its options", () => {
    board("08-public-link", { ...TEAM, shares: [OPEN_LINK] }, () =>
      expect(byId("share-collect-row")).not.toBeNull(),
    );
  });

  test("a person's menu", () => {
    board("09-person-menu", { shares: [share({})] }, () => {
      press(byId("share-row-menu-s-person"));
      expect(byId("share-revoke-s-person")).not.toBeNull();
    });
  });

  test("a member's menu offers routes, not a button that picks one silently", () => {
    board("10-member-menu", TEAM, () => {
      press(byId("share-see-members"));
      press(byId("share-access-remove-u2"));
      expect(byId("share-route-note-private")).not.toBeNull();
      expect(byId("share-route-workspace-remove")).not.toBeNull();
    });
  });

  test("a note pointed at a group", () => {
    board("11-group", {
      access: { visibility: "@public-worship-leads", exception: true, members: MEMBERS },
    });
  });

  test("the header menu", () => {
    board("12-more-menu", { ...TEAM, shares: [OPEN_LINK] }, () => {
      press(byId("share-more"));
      expect(byId("share-lock-note")).not.toBeNull();
    });
  });

  test("a folder", () => {
    board("13-folder", { path: "artists", entryKind: "folder", ...TEAM });
  });

  test("a refused group name is said here, and nothing is lost", async () => {
    for (const viewport of VIEWPORTS) {
      mount(
        dialog({ onCreateGroup: () => Promise.reject(new Error("That name is already taken.")) }),
        viewport.width,
        viewport.height,
      );
      type(document.body.querySelector('[aria-label="Share with"]'), "leads");
      press(byId("share-make-group"));
      press(byId("share-group-pick-u3"));
      await act(async () => {
        press(document.body.querySelector('[aria-label="Create"]'));
      });
      expect(byId("share-group-problem")?.textContent).toContain("already taken");
      expect(byId("share-group-pick-u3")?.getAttribute("aria-checked")).toBe("true");
      write(`14-group-refused-${viewport.name}`, viewport.width, viewport.height);
      act(() => root!.unmount());
      container!.remove();
      root = null;
      container = null;
    }
  });
});
