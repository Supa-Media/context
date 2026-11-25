/**
 * @jest-environment jsdom
 */

/**
 * Cloudflare in the app (`features/console/files/data/`): board 02's Apps for an owner, the token form,
 * the files it writes, the call that hands the key to the gateway, and an app source's page.
 *
 * The properties with teeth: the key is never written into a file (only sent, once, in the connect call); an app
 * already connected is connected again in place, never as a second folder; the Apps are drawn only for an owner.
 *
 * SABOTAGE (confirmed, reverted): put the key in `appAboutText` → "never writes the key" fails; drop `existing` in
 * `appSourceFiles` → "connects an app again in place" fails; draw the Apps without `onConnectApp` → "only an owner
 * sees the Apps" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
}));

import { ThemeProvider } from "../features/design/theme";
import { ConnectSourceDialog } from "../features/console/files/data/ConnectSource";
import { SourcePage } from "../features/console/files/data/SourcePage";
import { appSourceFiles, type AppSourceFiles } from "../features/console/files/data/dataWrites";
import { callDataSync, syncStateOf } from "../features/console/files/data/dataSync";
import { sourceAt } from "../features/console/files/data/sources";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const NOW = Date.parse("2026-11-25T12:30:00Z");
const KEY = "Zz9".repeat(14);
const ABOUT: ListNote = { path: "data/cloudflare/about.md", properties: { source: "cloudflare", name: "Cloudflare", dataset: "ai-spend" } };

function listing(path: string, names: string[]): FolderListing {
  const entries = names.map((name) => ({ kind: "file", path: `${path}/${name}`, name, visibility: "team", inherited: "team", exception: false, readOnly: false }) as FileEntry);
  return { path, folderDefault: "team", truncated: false, manifestUsable: true, entries } as unknown as FolderListing;
}
const CLOUDFLARE = sourceAt("data/cloudflare", () => listing("data/cloudflare", ["about.md", "ai-spend.csv"]), [ABOUT]);

let roots: { root: Root; node: HTMLElement }[] = [];
afterEach(() => {
  for (const { root, node } of roots) {
    act(() => root.unmount());
    node.remove();
  }
  roots = [];
});

async function mount(element: ReactElement): Promise<HTMLElement> {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  roots.push({ root, node });
  await act(async () => {
    root.render(h(ThemeProvider, { scheme: "light", children: element }));
  });
  return node;
}
const find = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function press(id: string) {
  const element = find(id);
  if (element === null) throw new Error(`no ${id}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
function type(id: string, text: string) {
  const at = find(id);
  const field = (at instanceof HTMLInputElement ? at : (at?.querySelector("input") ?? null)) as HTMLInputElement | null;
  if (field === null) throw new Error(`no field ${id}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const json = (body: unknown, status = 200) => ({ status, json: async () => JSON.parse(JSON.stringify(body)) as unknown }) as unknown as Response;

describe("the files an app source is made of", () => {
  test("never writes the key: the about.md says only what the source is, beside its empty sheet", () => {
    const files = appSourceFiles("data", "cloudflare", { key: KEY, account: " " }, null, new Set()) as AppSourceFiles;
    expect(files.about?.path).toBe("data/cloudflare/about.md");
    expect(files.about?.text).toMatch(/^---\nsource: cloudflare\nname: "Cloudflare"\ndataset: ai-spend\n---/);
    expect(files.about?.text).not.toContain(KEY);
    expect(files.sheet).toEqual({ path: "data/cloudflare/ai-spend.csv", text: "" });
    expect(files.key).toBe(KEY);
    expect("account" in files).toBe(false);
    const second = appSourceFiles("data", "cloudflare", { key: " token ", account: " abc " }, null, new Set(["data/cloudflare/about.md"])) as AppSourceFiles;
    expect(second.folder).toBe("data/cloudflare-2");
    expect(second.key).toBe("token");
    expect(second.account).toBe("abc");
    expect(appSourceFiles("data", "cloudflare", { key: "  " }, null, new Set())).toMatch(/Paste an API token/);
  });

  test("connects an app again in place, writing nothing that is already there", () => {
    const again = appSourceFiles("data", "cloudflare", { key: KEY }, CLOUDFLARE, new Set(["data/cloudflare/about.md", "data/cloudflare/ai-spend.csv"])) as AppSourceFiles;
    expect(again).toMatchObject({ folder: "data/cloudflare", about: null, sheet: null, key: KEY });
  });
});

describe("the connect call", () => {
  test("sends the key once, in the body, and reads back the run", async () => {
    const sent: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return json({ about: ABOUT.path, app: "cloudflare", armed: true, last: { at: NOW, outcome: "ok", rows: 3 } });
    }) as unknown as typeof fetch;
    const answer = await callDataSync({ url: "https://mcp.example.test/@acme/files/data-sync", workspaceId: "w1", body: { op: "connect", about: ABOUT.path, key: KEY }, fetchImpl, token: async () => "t" });
    expect(answer).toEqual({ ok: true, sources: [{ about: ABOUT.path, armed: true, last: { at: NOW, outcome: "ok", rows: 3 } }] });
    expect(sent).toEqual([{ workspaceId: "w1", op: "connect", about: ABOUT.path, key: KEY }]);
    const refused = (async () => json({ error: "refused", message: "Cloudflare refused the token." }, 400)) as unknown as typeof fetch;
    expect(await callDataSync({ url: "https://x.test/@a/files/data-sync", workspaceId: "w1", body: { op: "connect", about: "a", key: "sk" }, fetchImpl: refused, token: async () => "t" })).toEqual({ ok: false, said: "Cloudflare refused the token." });
    const forbidden = (async () => json({}, 403)) as unknown as typeof fetch;
    expect(await callDataSync({ url: "https://x.test/@a/files/data-sync", workspaceId: "w1", body: { op: "disconnect", app: "cloudflare" }, fetchImpl: forbidden, token: async () => "t" })).toEqual({ ok: false, said: "Only this workspace's owners can connect an app." });
  });
});

describe("the connect dialog's Apps", () => {
  test("only an owner sees the Apps; the key form hands on the files and the key", async () => {
    await mount(h(ConnectSourceDialog, { dataFolder: "data", taken: new Set<string>(), sheet: false, onMake: async () => null, onMakeUrl: async () => null, onClose: () => {} }));
    expect(find("connect-app-cloudflare")).toBeNull();
    for (const { root, node } of roots) {
      act(() => root.unmount());
      node.remove();
    }
    roots = [];
    const made: AppSourceFiles[] = [];
    await mount(
      h(ConnectSourceDialog, {
        dataFolder: "data",
        taken: new Set<string>(["data/cloudflare/about.md"]),
        sheet: false,
        onMake: async () => null,
        onMakeUrl: async () => null,
        onConnectApp: async (files: AppSourceFiles) => {
          made.push(files);
          return null;
        },
        sources: [CLOUDFLARE],
        onClose: () => {},
      }),
    );
    expect(find("connect-app-cloudflare")?.textContent).toContain("Connected");
    // The payments app waits on the gateway, so its tile isn't drawn.
    expect(find("connect-app-stripe")).toBeNull();
    expect(document.body.textContent).toContain("Only workspace owners can connect apps.");
    await press("connect-app-cloudflare");
    expect(find("connect-cloudflare")).not.toBeNull();
    expect(find("connect-app-account")).not.toBeNull();
    expect((find("connect-app-key")?.querySelector("input") ?? find("connect-app-key"))?.getAttribute("type")).toBe("password");
    type("connect-app-key", KEY);
    await press("connect-app-make");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ app: "cloudflare", folder: "data/cloudflare", about: null, key: KEY });
  });
});

describe("an app source's page", () => {
  test("says its key is sealed and how its last sync went, and offers Connect again and Disconnect only to an owner", async () => {
    const stopped = syncStateOf({ about: ABOUT.path, armed: false, last: { at: NOW - 60 * 60_000, outcome: "stopped", said: "Stopped: Cloudflare refused the token. An owner can connect it again here." } });
    const reader = await mount(h(SourcePage, { source: CLOUDFLARE, sheets: new Map(), metrics: [], compact: false, now: NOW, sync: stopped, endpoint: "https://x.test/api/sheets/rows", actions: {}, onOpen: () => {} }));
    const text = reader.textContent ?? "";
    expect(text).toContain("Stopped 1h ago · every hour · read-only");
    expect(text).toContain("Read-only, kept sealed by Context, never in this file");
    expect(text).toContain("Stopped: Cloudflare refused the token.");
    expect(text).not.toContain("Connect again");
    expect(text).not.toContain("Disconnect");
    const pressed: string[] = [];
    const owner = await mount(
      h(SourcePage, { source: CLOUDFLARE, sheets: new Map(), metrics: [], compact: false, now: NOW, sync: stopped, endpoint: "https://x.test/api/sheets/rows", actions: { reconnect: () => pressed.push("again"), disconnect: () => pressed.push("off") }, onOpen: () => {} }),
    );
    for (const label of ["Connect again", "Disconnect"]) {
      const button = [...owner.querySelectorAll('[role="button"]')].find((el) => el.textContent === label) as HTMLElement;
      await act(async () => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
    expect(pressed).toEqual(["again", "off"]);
  });
});
