/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of giving a vault key (vault sharing boards, 2026-10-17): the
 * People section with the Give field open, Take back asking once, and a key
 * given to you for your AIs, at 1440 and 390. Same technique as
 * `storage-shots.ts`: the shipped `VaultList`, handed fake actions, rendered by
 * react-dom, written out as self-contained `.html` and photographed by
 * Playwright. Every name and value is invented; the long ones are deliberate.
 *
 *     pnpm exec jest --testMatch '**\/scripts/vault-sharing-shots.ts' --testPathIgnorePatterns '[]'
 *     node scripts/capture-trash-shots.mjs <VAULT_SHARING_SHOTS_DIR> <png dir>
 */

import { afterEach, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("convex/react", () => ({ useConvex: () => undefined }));

const OUT = resolve(process.env.VAULT_SHARING_SHOTS_DIR ?? "/tmp/vault-sharing-shots");

const { StyleSheet } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } } };
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { VaultList } = require("../features/console/settings/panels/VaultPanel") as typeof import("../features/console/settings/panels/VaultPanel");
type VaultEntry = import("../features/vault/vaultSettings").VaultEntry;
type VaultActions = import("../features/console/settings/panels/VaultPanel").VaultActions;

const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const SAVED = NOW.getTime() - DAY;
const GIVEN = NOW.getTime() - 60 * 60 * 1000;
const LONG = "Olumide Salami-Adebayo of the Riverside Editorial Collective";

const owned: VaultEntry = {
  entryId: "v000000000000000000000011",
  type: "secret",
  name: "Context Convex Readonly deploy key for the staging and production dashboards",
  sites: [],
  envs: ["dev", "staging", "prod"],
  shared: true,
  proxy: {
    host: "api.convex.example",
    style: "bearer",
    name: null,
    ask: true,
    clients: [
      { id: "c-claude", name: "Claude Code", at: SAVED, by: "user_me", byName: "You", mine: true },
      { id: "c-claude", name: "Claude Code", at: GIVEN, by: "user_sayo", byName: "Sayo Adeyemi", mine: false },
      { id: "c-codex", name: "Codex", at: GIVEN, by: "user_zay", byName: "Zay Okafor", mine: false },
    ],
    uses: [
      { id: "c-claude", name: "Claude Code", count: 31, at: SAVED, method: "GET", path: "/v1/x", by: "user_me", byName: "You", mine: true },
      { id: "c-claude", name: "Claude Code", count: 12, at: NOW.getTime() - 4 * 60_000, method: "GET", path: "/api/deployments", by: "user_sayo", byName: "Sayo Adeyemi", mine: false },
    ],
    refused: [],
    waiting: 0,
  },
  savedAt: SAVED,
  savedByYou: true,
  savedBy: "You",
  level: "see",
  manage: true,
  givenBy: null,
  givenToYou: false,
  people: [
    { to: "user_me", kind: "person", name: "You", handle: "seyi", count: null, level: "see", at: SAVED, isYou: true },
    { to: "user_sayo", kind: "person", name: "Sayo Adeyemi", handle: "sayo", count: null, level: "use", at: GIVEN, isYou: false },
    { to: "@supa-leads", kind: "group", name: "Leadership and engineering leads", handle: null, count: 3, level: "see", at: GIVEN, isYou: false },
  ],
};
const sentry: VaultEntry = { ...owned, entryId: "v000000000000000000000013", name: "Sentry", shared: false, people: owned.people!.slice(0, 1), proxy: { ...owned.proxy!, host: "sentry.example", clients: [], uses: [] } };
const given: VaultEntry = {
  ...owned,
  entryId: "v000000000000000000000012",
  proxy: { ...owned.proxy!, clients: [{ ...owned.proxy!.clients[1], byName: "You", mine: true }], uses: [{ ...owned.proxy!.uses[1], byName: "You", mine: true }] },
  savedByYou: false,
  savedBy: "Seyi",
  level: "use",
  manage: false,
  givenBy: "Seyi",
  givenToYou: true,
  people: [],
};

function actions(entries: VaultEntry[], kind: "personal" | "shared" = "shared"): VaultActions {
  return {
    moveTargets: async () => [
      { workspaceId: "ws_supa", handle: "supa", name: "Supa" },
      { workspaceId: "ws_long", handle: "riverside-editorial-collective", name: "Riverside" },
    ],
    move: async () => ({ handle: "supa" }),
    list: async () => entries,
    cutOff: async () => entries[0],
    allow: async () => entries[0],
    link: async () => "tok",
    calls: {
      describe: async () => ({ kind: "view", workspace: { handle: "supa", name: "Supa", kind: "shared" as const }, grantee: null, entry: { type: "secret", name: owned.name, sites: [], fields: [{ name: "CONVEX_READONLY_DEPLOY_KEY", perEnv: true, set: ["dev", "staging", "prod"] }] }, expiresAt: Date.now() + DAY }),
      save: async () => ({ name: "", site: "" }),
      reveal: async () => ({ type: "secret", name: owned.name, sites: [], username: "", password: "", fields: [{ name: "CONVEX_READONLY_DEPLOY_KEY", perEnv: true, values: { dev: "fake-a", staging: "fake-b", prod: "fake-c" } }] }),
      edit: async () => ({ changed: [] }),
      remove: async () => ({ name: "" }),
    },
    choices: async () => ({
      workspace: { handle: kind === "shared" ? "supa" : "seyi", kind },
      people: [
        { userId: "user_me", name: "Seyi", handle: "seyi", role: "owner", isMe: true },
        { userId: "user_sayo", name: "Sayo Adeyemi", handle: "sayo", role: "editor", isMe: false },
        { userId: "user_olu", name: LONG, handle: "olumide", role: "member", isMe: false },
      ],
      groups: [{ to: "@supa-leads", label: "Leadership and engineering leads", count: 3 }],
      members: 6,
    }),
    give: async () => entries[0],
    takeBack: async () => entries[0],
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function press(id: string) {
  const node = byId(id);
  if (node === null) throw new Error(`nothing to press: ${id}`);
  await act(async () => node.click());
}
async function type(id: string, text: string) {
  const field = byId(id)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function shot(name: string, entries: VaultEntry[], width: number, steps: () => Promise<void>, kind: "personal" | "shared" = "shared") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const height = width > 500 ? 900 : 844;
  await act(async () => {
    root!.render(
      createElement(ThemeProvider, {
        scheme: "light",
        children: createElement(VaultList, { actions: actions(entries, kind), layoutWidth: width > 500 ? 1100 : 358 }),
      }),
    );
  });
  await settle();
  await steps();
  await settle();
  const css = `${StyleSheet.getSheet().textContent}\n${[...document.head.querySelectorAll("style")].map((n) => n.textContent ?? "").join("\n")}`;
  const pad = width > 500 ? "24px 170px" : "16px";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<style>html,body{margin:0}body{-webkit-font-smoothing:antialiased;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f3ee}#shot{width:${width}px;min-height:${height}px;box-sizing:border-box;padding:${pad}}</style>
<style id="rnw">${css}</style></head><body><div id="shot">${container.innerHTML}</div></body></html>`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  expect(container.innerHTML.length).toBeGreaterThan(0);
  act(() => root!.unmount());
  container.remove();
  root = null;
  container = null;
}

test("vault sharing shots", async () => {
  await shot("1-give-desktop", [owned, sentry, given], 1440, async () => {
    await type("vault-give-input", "o");
  });
  await shot("2-take-back-desktop", [owned, sentry, given], 1440, async () => {
    await press("vault-take-user_sayo");
  });
  await shot("3-given-to-you-desktop", [given, owned], 1440, async () => undefined);
  await shot("4-give-phone", [owned, sentry, given], 390, async () => {
    await press(`vault-row-${owned.entryId}`);
    await settle();
    await type("vault-give-input", "olu");
  });
  const personal: VaultEntry = { ...owned, shared: false, people: owned.people!.slice(0, 1), proxy: { ...owned.proxy!, clients: [owned.proxy!.clients[0]], uses: [owned.proxy!.uses[0]] } };
  await shot("6-move-desktop", [personal], 1440, async () => press("vault-move-supa"), "personal");
  await shot("7-move-phone", [personal], 390, async () => {
    await press(`vault-row-${personal.entryId}`);
    await settle();
  }, "personal");
  await shot("5-given-to-you-phone", [given, owned], 390, async () => {
    await press(`vault-row-${given.entryId}`);
    await settle();
    await press("vault-hand-back");
  });
});
