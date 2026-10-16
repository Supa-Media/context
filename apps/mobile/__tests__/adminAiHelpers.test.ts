/**
 * @jest-environment jsdom
 */

/**
 * The Helper agents table, actually rendered (`features/admin/AiHelpers.tsx`,
 * board 15). Pins that all four helpers are listed, and that a caller's switch
 * is a yes before it writes: turning Connected AIs on shows the warning, and
 * only "Allow" saves `callers:` into the helper's note, with the version it
 * was read at, so nobody can widen who may ask for email without a person.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockRead = jest.fn<(args: { path: string }) => Promise<unknown>>();
const mockWrite = jest.fn<(args: { path: string; text: string; expectedEtag?: string }) => Promise<unknown>>();

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
// A pointer-width window: the table draws its cells, not the phone's two-line rows.
jest.mock("react-native", () => ({
  ...jest.requireActual<typeof import("react-native")>("react-native"),
  useWindowDimensions: () => ({ width: 1280, height: 800, scale: 1, fontScale: 1 }),
}));
// Stable functions, as Convex's own hooks return: a new one per render would re-run every effect.
const mockCloudflare = async () => ({ configured: false, workersAi: [], gateway: [], billedUsd: 0 });
jest.mock("convex/react", () => ({
  useQuery: () => undefined,
  useAction: (ref: unknown) => {
    const name = String((ref as { _name?: string })?._name ?? ref);
    if (name.includes("writeNote")) return mockWrite;
    if (name.includes("readNote")) return mockRead;
    return mockCloudflare;
  },
}));
jest.mock("@context/convex/_generated/api", () => {
  const named = (name: string) => ({ _name: name });
  return {
    api: {
      functions: {
        files: { readNote: named("files.readNote"), writeNote: named("files.writeNote") },
        admin: { aiCostsReport: named("admin.aiCostsReport"), aiCostsCloudflare: named("admin.aiCostsCloudflare"), aiCostsAccount: named("admin.aiCostsAccount") },
      },
    },
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AiHelpers } from "../features/admin/AiHelpers";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";

const HELPER_NOTE = "---\nhelper: mail-checker\ncallers: [texting-assistant]\n---\n\n# Mail checker\n";

const notes: FolderNote[] = [
  { path: "ai/agents/mail-checker.md", props: JSON.stringify({ properties: { callers: ["texting-assistant"] }, heading: "Mail checker", lede: "" }) },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockRead.mockReset();
  mockWrite.mockReset();
  mockRead.mockImplementation(async ({ path }) => ({ kind: "file", path, text: HELPER_NOTE, etag: "v1", readOnly: false }));
  mockWrite.mockImplementation(async ({ path }) => ({ kind: "written", path, etag: "v2" }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render() {
  await act(async () => {
    root.render(
      createElement(AiHelpers, {
        workspaceId: "ws" as never,
        catalog: buildCatalog(notes),
        reads: new Map(),
        go: () => {},
        reload: () => {},
        openInNotes: () => {},
        me: "Maya",
        helper: "mail-checker",
      }),
    );
  });
}

describe("the helper agents table", () => {
  test("lists all four helpers and what the mail checker needs a person for", async () => {
    await render();
    const table = byTestId("admin-ai-helpers-table")!;
    for (const label of ["Mail checker", "Improver", "Judge", "Nightly dream"]) expect(table.textContent).toContain(label);
    expect(table.textContent).toContain("every send");
    expect(byTestId("admin-ai-helper-mail-checker")).not.toBeNull();
  });
});

describe("who may call the mail checker", () => {
  test("Tex is switched on from its note", async () => {
    await render();
    expect(byTestId("admin-ai-caller-texting-assistant")!.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("admin-ai-caller-connected-ais")!.getAttribute("aria-checked")).toBe("false");
  });

  test("turning Connected AIs on asks first, and only Allow writes callers with the version read", async () => {
    await render();
    await act(async () => byTestId("admin-ai-caller-connected-ais")!.click());
    expect(byTestId("admin-ai-caller-warning")!.textContent).toContain("Connected AIs may then ask the Mail checker to send email.");
    expect(mockWrite).not.toHaveBeenCalled();

    await act(async () => byTestId("admin-ai-caller-allow")!.click());
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const saved = mockWrite.mock.calls[0]![0];
    expect(saved).toEqual(expect.objectContaining({ path: "ai/agents/mail-checker.md", expectedEtag: "v1" }));
    expect(saved.text).toContain("callers: [texting-assistant, connected-ais]");
  });
});
