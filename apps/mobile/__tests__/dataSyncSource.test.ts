/**
 * @jest-environment jsdom
 */

/**
 * Fetch from a URL in the app (`features/console/files/data/`): the connect dialog's url form, the files it writes,
 * the call that arms the sync, and what a url source's page and card say of its last run.
 *
 * The properties with teeth: the form never hands on an address the sync object would refuse, nor a dataset that
 * leaves its source's folder; a url source's status line says only what its sync object said, never "Last row"
 * from a row's own date; a refusal is shown in the sync's own words; a sheet a url source keeps is read-only.
 *
 * SABOTAGE (confirmed, reverted): drop the `fetch` early return in `sourceStatus` (`words.ts`) → "says only what
 * the sync object said" fails; drop `fetch` from `SYNCED` in `syncedSheet.ts` → "a url source's sheet is kept up
 * to date" fails; let `publicAddress` take `http:` → "never hands on an address" fails.
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
import { SourcePage, urlSyncLine } from "../features/console/files/data/SourcePage";
import { publicAddress, urlSourceFiles, type UrlSourceFiles } from "../features/console/files/data/dataWrites";
import { callDataSync, dataSyncUrl, syncStateOf } from "../features/console/files/data/dataSync";
import { sourceAt, sourceKindOf } from "../features/console/files/data/sources";
import { keptBy } from "../features/console/files/data/syncedSheet";
import { sourceStatus } from "../features/console/files/data/words";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const NOW = Date.parse("2026-11-25T12:30:00Z");
const ABOUT: ListNote = {
  path: "data/status-example-com/about.md",
  properties: { source: "url", name: "status.example.com", url: "https://status.example.com/incidents.json", dataset: "incidents", key: "id" },
};

function listing(path: string, names: string[]): FolderListing {
  const entries = names.map((name) => ({ kind: "file", path: `${path}/${name}`, name, visibility: "team", inherited: "team", exception: false, readOnly: false }) as FileEntry);
  return { path, folderDefault: "team", truncated: false, manifestUsable: true, entries } as unknown as FolderListing;
}
const SOURCE = sourceAt("data/status-example-com", () => listing("data/status-example-com", ["about.md", "incidents.csv"]), [ABOUT]);
// A sheet whose last row is dated an hour ago: a url source never reads its status from it.
const SHEETS = new Map([["data/status-example-com/incidents.csv", { columns: [{ name: "id", type: "text" }, { name: "opened", type: "date" }], rows: [{ id: "INC-1", opened: "2026-11-25T11:30Z" }] }]]) as unknown as Parameters<typeof sourceStatus>[1];

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
/** A JSON answer, as the gateway sends one; jsdom has no Response, and the call reads only status and json(). */
const json = (body: unknown, status = 200) => ({ status, json: async () => JSON.parse(JSON.stringify(body)) as unknown }) as unknown as Response;
function type(id: string, text: string) {
  const at = find(id);
  const field = (at instanceof HTMLInputElement ? at : (at?.querySelector("input") ?? null)) as HTMLInputElement | null;
  if (field === null) throw new Error(`no field ${id}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the files a url source is made of", () => {
  test("an about.md saying source: url with the address and dataset, and the dataset's empty sheet", () => {
    const files = urlSourceFiles("data", " https://www.status.example.com/incidents.json ", "Open incidents", new Set());
    if (typeof files === "string") throw new Error(files);
    expect(files.folder).toBe("data/status-example-com");
    expect(files.about.path).toBe("data/status-example-com/about.md");
    expect(files.about.text).toMatch(/^---\nsource: url\nname: "status\.example\.com"\nurl: "https:\/\/www\.status\.example\.com\/incidents\.json"\ndataset: open-incidents\n---\n/);
    expect(files.sheet).toEqual({ path: "data/status-example-com/open-incidents.csv", text: "" });
    // The app reads what it wrote as a url source.
    expect(sourceKindOf("url")).toBe("fetch");
  });

  test("never hands on an address the sync object would refuse, nor a dataset that leaves its folder", () => {
    for (const bad of ["http://status.example.com/x", "https://10.0.0.1/x", "https://localhost/x", "https://user:pw@status.example.com/", "https://status.example.com:8443/x", "https://intranet/x", "not an address"]) {
      expect(publicAddress(bad)).toBeNull();
      expect(typeof urlSourceFiles("data", bad, "x", new Set())).toBe("string");
    }
    const files = urlSourceFiles("data", "https://status.example.com/x", "../../secrets", new Set());
    if (typeof files === "string") throw new Error(files);
    expect(files.sheet.path).toBe("data/status-example-com/secrets.csv");
  });

  test("takes a free folder beside the sources already there", () => {
    const files = urlSourceFiles("data", "https://status.example.com/x", "a", new Set(["data/status-example-com", "data/status-example-com/about.md"]));
    if (typeof files === "string") throw new Error(files);
    expect(files.folder).toBe("data/status-example-com-2");
  });
});

describe("the call that arms the sync", () => {
  test("is the workspace's own address, and reads back the run it made", async () => {
    expect(dataSyncUrl("https://mcp.example.test/mcp", "acme")).toBe("https://mcp.example.test/@acme/files/data-sync");
    expect(dataSyncUrl("https://mcp.example.test/mcp", "Bad Slug")).toBeNull();
    const sent: { auth: string | null; body: unknown }[] = [];
    let refused = true;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push({ auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      if (refused) {
        refused = false;
        return json({}, 401);
      }
      return json({ about: ABOUT.path, armed: true, last: { at: NOW, outcome: "ok", rows: 2, extra: "dropped" } });
    }) as unknown as typeof fetch;
    const answer = await callDataSync({ url: "https://mcp.example.test/@acme/files/data-sync", workspaceId: "w1", body: { op: "arm", about: ABOUT.path }, fetchImpl, token: async (refresh) => (refresh === false ? "old" : "new") });
    expect(answer).toEqual({ ok: true, sources: [{ about: ABOUT.path, armed: true, last: { at: NOW, outcome: "ok", rows: 2 } }] });
    expect(sent.map((one) => one.auth)).toEqual(["Bearer old", "Bearer new"]);
    expect(sent[1]!.body).toEqual({ workspaceId: "w1", op: "arm", about: ABOUT.path });
  });

  test("a refusal comes back in the gateway's own words", async () => {
    const fetchImpl = (async () => json({ error: "refused", message: "The address must be https on a public name, with no port, login or IP address." }, 400)) as unknown as typeof fetch;
    const answer = await callDataSync({ url: "https://mcp.example.test/@acme/files/data-sync", workspaceId: "w1", body: { op: "arm", about: ABOUT.path }, fetchImpl, token: async () => "t" });
    expect(answer).toEqual({ ok: false, said: "The address must be https on a public name, with no port, login or IP address." });
    const forbidden = (async () => json({}, 403)) as unknown as typeof fetch;
    expect(await callDataSync({ url: "https://x.test/@a/files/data-sync", workspaceId: "w1", body: { op: "arm", about: "a" }, fetchImpl: forbidden, token: async () => "t" })).toEqual({ ok: false, said: "Only this workspace's owners and editors can sync a source." });
  });
});

describe("a url source's status line", () => {
  test("says only what the sync object said, never a row's own date", () => {
    expect(sourceStatus(SOURCE, SHEETS, NOW).text).toBe("Not synced yet");
    const synced = syncStateOf({ about: ABOUT.path, armed: true, last: { at: NOW - 5 * 60_000, outcome: "ok", rows: 182 } });
    expect(sourceStatus(SOURCE, SHEETS, NOW, synced)).toEqual({ tone: "ok", text: "Synced 5 min ago", short: "5 min ago" });
    const failed = syncStateOf({ about: ABOUT.path, armed: true, last: { at: NOW - 25 * 60_000, outcome: "failed", said: "Nothing was written: status.example.com answered 500." } });
    expect(sourceStatus(SOURCE, SHEETS, NOW, failed).text).toBe("Sync failed 25 min ago");
    const stopped = syncStateOf({ about: ABOUT.path, armed: false, last: { at: NOW - 60 * 60_000, outcome: "stopped", said: "Stopped: its about.md is no longer in a source folder of the Data folder." } });
    expect(sourceStatus(SOURCE, SHEETS, NOW, stopped)).toMatchObject({ tone: "bad", text: "Stopped 1h ago" });
    expect(urlSyncLine("x", failed, NOW)).toBe("Nothing was written: status.example.com answered 500.");
    expect(urlSyncLine("x", synced, NOW)).toBe("Synced 5 min ago · 182 rows");
  });

  test("a url source's sheet is kept up to date, so it opens read-only", () => {
    expect(keptBy("data/status-example-com/incidents.csv", "data", [ABOUT])).toEqual({ name: "status.example.com", folder: "data/status-example-com" });
  });
});

describe("the connect dialog", () => {
  test("offers both of board 02's own ways, and the url form hands on the files it would write", async () => {
    const made: UrlSourceFiles[] = [];
    await mount(
      h(ConnectSourceDialog, {
        dataFolder: "data",
        taken: new Set<string>(),
        sheet: false,
        onMake: async () => null,
        onMakeUrl: async (files: UrlSourceFiles) => {
          made.push(files);
          return null;
        },
        onClose: () => {},
      }),
    );
    expect(find("connect-way-push")?.textContent).toContain("Send from your code");
    expect(find("connect-way-url")?.textContent).toContain("Fetch from a URL");
    await press("connect-way-url");
    expect(find("connect-url")).not.toBeNull();
    type("connect-url-address", "http://status.example.com/x");
    type("connect-url-dataset", "incidents");
    await press("connect-url-make");
    expect(find("connect-problem")?.textContent).toMatch(/https address on a public name/);
    expect(made).toEqual([]);
    type("connect-url-address", "https://status.example.com/incidents.json");
    await press("connect-url-make");
    expect(made.map((files) => [files.about.path, files.sheet.path])).toEqual([["data/status-example-com/about.md", "data/status-example-com/incidents.csv"]]);
  });

  test("where a url source can't be armed, it is not offered: Send from your code opens at once", async () => {
    await mount(h(ConnectSourceDialog, { dataFolder: "data", taken: new Set<string>(), sheet: false, onMake: async () => null, onClose: () => {} }));
    expect(find("connect-way-url")).toBeNull();
    expect(find("connect-push")).not.toBeNull();
  });
});

describe("a url source's page", () => {
  test("shows its address, dataset and last sync, and Sync now only to who may", async () => {
    const failed = syncStateOf({ about: ABOUT.path, armed: true, last: { at: NOW - 25 * 60_000, outcome: "failed", said: "Nothing was written: status.example.com points at a private address." } });
    const node = await mount(h(SourcePage, { source: SOURCE, sheets: SHEETS, metrics: [], compact: false, now: NOW, sync: failed, endpoint: "https://x.test/api/sheets/rows", actions: {}, onOpen: () => {} }));
    const text = node.textContent ?? "";
    expect(text).toContain("https://status.example.com/incidents.json");
    expect(text).toContain("incidents.csv");
    expect(text).toContain("Sync failed 25 min ago · every hour · read-only");
    expect(text).toContain("Nothing was written: status.example.com points at a private address.");
    expect(text).not.toMatch(/Last row [^·]+ · every hour/);
    expect(text).not.toContain("Sync now");
    expect(text).not.toContain("vault");
    let pressed = 0;
    const editor = await mount(h(SourcePage, { source: SOURCE, sheets: SHEETS, metrics: [], compact: false, now: NOW, sync: failed, endpoint: "https://x.test/api/sheets/rows", actions: { syncNow: () => (pressed += 1) }, onOpen: () => {} }));
    expect(editor.textContent).toContain("Sync now");
    const button = [...editor.querySelectorAll('[role="button"]')].find((el) => el.textContent?.includes("Sync now")) as HTMLElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(pressed).toBe(1);
  });
});
