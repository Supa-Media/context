/**
 * @jest-environment jsdom
 */

/**
 * The Golden cases tab (`features/admin/AiCases.tsx`, board 13), actually
 * rendered. A test list's cases are picked and edited in place: a drafted case
 * says so until a person checks it, and Save writes the note back with only
 * the lines the form changed, at the version it was read at.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockRead = jest.fn<(args: { path: string }) => Promise<unknown>>();
const mockWrite = jest.fn<(args: { path: string; text: string; expectedEtag?: string }) => Promise<unknown>>();

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
// Stable functions, as Convex's own hooks return: a new one per render would re-run every effect.
const mockCloudflare = async () => ({ configured: false, workersAi: [], gateway: [], billedUsd: 0 });
jest.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => null }));
jest.mock("convex/react", () => ({
  useConvex: () => ({}),
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
        workspaces: { listMyWorkspaces: named("workspaces.listMyWorkspaces") },
        agentGrant: { mintConsoleGrant: named("agentGrant.mintConsoleGrant") },
        admin: { aiCostsReport: named("admin.aiCostsReport"), aiCostsCloudflare: named("admin.aiCostsCloudflare"), aiCostsAccount: named("admin.aiCostsAccount") },
      },
    },
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AiCases } from "../features/admin/AiCases";
import type { AiNoteRow } from "../features/admin/aiCatalog";

const PATH = "ai/tests/texting-assistant.md";
const TEST = [
  "---",
  "job: texting-assistant",
  "run_as: Maya",
  "---",
  "",
  "# Core",
  "",
  "## 1. When's my dentist?",
  "",
  "- kind: task",
  "- must: say Tuesday at 3 pm",
  "- must not: make up a date",
  "",
  "## 2. What do I need to do before Lisbon",
  "",
  "- kind: task",
  "- must: list the Lisbon to-dos",
  "- drafted: improver",
  "",
].join("\n");

const tests: AiNoteRow[] = [
  { path: PATH, name: "texting-assistant", title: "Texting assistant", lede: "", updatedAt: null, size: null, properties: { job: "texting-assistant" } },
];

let container: HTMLDivElement;
let root: Root;
let reload: ReturnType<typeof jest.fn<() => void>>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  reload = jest.fn<() => void>();
  mockRead.mockReset();
  mockWrite.mockReset();
  mockRead.mockImplementation(async ({ path }) => ({ kind: "file", path, text: TEST, etag: "v1", readOnly: false }));
  mockWrite.mockImplementation(async ({ path }) => ({ kind: "written", path, etag: "v2" }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render() {
  await act(async () => {
    root.render(createElement(AiCases, { workspaceId: "ws" as never, job: "texting-assistant", tests, setups: [], reload, me: "Maya" }));
  });
}

function type(element: HTMLElement, value: string) {
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the Golden cases tab", () => {
  test("a drafted case shows drafted until a person checks it", async () => {
    await render();
    expect(byTestId("admin-ai-case-row-1")!.textContent).not.toContain("drafted");
    expect(byTestId("admin-ai-case-row-2")!.textContent).toContain("drafted");
    await act(async () => byTestId("admin-ai-case-row-2")!.click());
    expect(byTestId("admin-ai-drafted")!.textContent).toContain("Drafted by improver. It does not count until a person checks it.");
  });

  test("editing one must line and saving writes only that line changed", async () => {
    await render();
    expect(byTestId("admin-ai-case-form")).not.toBeNull();
    const lines = TEST.split("\n");
    const mustIndex = lines.indexOf("- must: say Tuesday at 3 pm");
    await act(async () => type(byTestId(`admin-ai-line-${mustIndex}-value`)!, "say Tuesday, October 13 at 3 pm"));
    await act(async () => byTestId("admin-ai-cases-save")!.click());
    const expected = [...lines];
    expected[mustIndex] = "- must: say Tuesday, October 13 at 3 pm";
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledWith(expect.objectContaining({ path: PATH, text: expected.join("\n"), expectedEtag: "v1" }));
    expect(reload).toHaveBeenCalled();
  });

  test("marking a drafted case as checked and saving removes its drafted line", async () => {
    await render();
    await act(async () => byTestId("admin-ai-case-row-2")!.click());
    await act(async () => byTestId("admin-ai-case-mark-checked")!.click());
    await act(async () => byTestId("admin-ai-cases-save")!.click());
    const lines = TEST.split("\n");
    const expected = lines.filter((line) => line !== "- drafted: improver");
    expect(mockWrite).toHaveBeenCalledWith(expect.objectContaining({ path: PATH, text: expected.join("\n"), expectedEtag: "v1" }));
  });
});
