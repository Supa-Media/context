/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of the share dialog with a note's own list (people, groups and
 * emails, each with view or edit), for the design audit every UI change here
 * gets before it ships. Boards 1 to 4 of the approved share-with-people canvas.
 *
 * Same technique as `design-shots.ts` and `editor-accessory-shots.ts`: the
 * shipped component, rendered by react-dom into a real DOM, written out as a
 * self-contained `.html`, and photographed by Playwright — never a mock-up. A
 * picture of a component nobody ships is worth nothing in a review.
 *
 *     pnpm exec jest --testMatch '**\/scripts/share-grants-shots.ts' --testPathIgnorePatterns '[]'
 *
 * Each board is written at a desktop and a phone width, in the Paper theme.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = process.env.SHOTS_OUT ?? resolve(__dirname, "../../../docs/design/share-grants");

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


const LONG = "Oluwaseyi Adebayo-Richardson, director of worship and creative operations";
const LIST = {
  version: 3,
  kind: "file",
  base: "private",
  tier: "private",
  from: null,
  domains: ["publicworship.life"],
  grantees: [
    { kind: "group", groupId: "g1", name: "public-worship-leads", label: "Worship leads and chapter directors", count: 4, role: "edit" },
    { kind: "user", userId: "u4", label: "Lara K", detail: "lara@example.invalid", member: true, role: "view" },
    { kind: "user", userId: "u9", label: LONG, member: false, role: "view" },
    { kind: "email", email: "pat.longname-with-a-very-long-address@example-organization.invalid", role: "view" },
  ],
};
const grants = (list: Record<string, unknown> = {}) => ({
  grants: { list: { ...LIST, ...list }, save: async () => null, saving: false },
});
const INHERITED = grants({ base: null, tier: "team", from: "artists", grantees: LIST.grantees.slice(0, 3) });

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;

function board(name: string, overrides: Record<string, unknown>, steps: () => void = () => {}): void {
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

const field = () => document.body.querySelector<HTMLElement>('[aria-label="Share with"]');

describe("share dialog with a list", () => {
  test("1. a note shared with a group, a member, someone outside and an email", () => {
    board("g1-shared", grants(), () => expect(byId("share-grant-group:g1")).not.toBeNull());
  });

  test("1b. a row's menu: view, edit, remove", () => {
    board("g1b-row-menu", grants(), () => {
      press(byId("share-grant-menu-user:u9"));
      expect(byId("share-grant-remove-user:u9")).not.toBeNull();
    });
  });

  test("2. typing offers people, groups and an email", () => {
    board("g2-typing", grants(), () => {
      type(field(), "la");
      expect(byId("share-suggestions")).not.toBeNull();
    });
  });

  test("2b. picking someone, then view or edit", () => {
    board("g2b-picked", grants(), () => {
      type(field(), "john");
      press(byId("share-suggest-u3"));
      press(byId("share-role-edit"));
      expect(byId("share-role-edit")?.getAttribute("aria-checked")).toBe("true");
    });
  });

  test("2c. an email outside the workspace", () => {
    board("g2c-email", grants(), () => {
      type(field(), "someone.new@example.invalid");
      press(byId("share-suggest-someone.new@example.invalid"));
      expect(byId("share-submit")).not.toBeNull();
    });
  });

  test("2d. a domain that joins the workspace", () => {
    board("g2d-domain", grants(), () => {
      type(field(), "publicworship.life");
      expect(byId("share-suggest-domain:publicworship.life")).not.toBeNull();
    });
  });

  test("2e. a domain that does not join yet", () => {
    board("g2e-domain-off", grants(), () => {
      type(field(), "example.org");
      expect(byId("share-reaching-domain:example.org")).not.toBeNull();
    });
  });

  test("3. a note inside a shared folder", () => {
    board("g3-inherited", { ...INHERITED, access: { visibility: "team", exception: false, members: MEMBERS } }, () =>
      expect(byId("share-grants-own")).not.toBeNull(),
    );
  });

  test("3b. a note with its own list, which can go back to the folder's", () => {
    board("g3b-own", grants({ base: "team", tier: "team" }), () => expect(byId("share-grants-back")).not.toBeNull());
  });
});
