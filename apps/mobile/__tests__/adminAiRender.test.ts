/**
 * @jest-environment jsdom
 */

/**
 * The AI tab, actually rendered (`features/admin/AiSection.tsx`'s `Library`).
 *
 * The owner, 2026-10-16: "I also cant edit anything inline, everything just
 * opens up the md file". So these pin that a row opens in place, not in the
 * note editor: a skill's Markdown is read, edited and saved back with the
 * version it was read at, and a test list is edited as a form whose save
 * changes only the line edited.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockPush = jest.fn();
const mockRead = jest.fn<(args: { path: string }) => Promise<unknown>>();
const mockWrite = jest.fn<(args: { path: string; text: string; expectedEtag?: string }) => Promise<unknown>>();

jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
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
import { Library, type AiView } from "../features/admin/AiFiles";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";

const SKILL = "---\nreach: [tex]\n---\n\n# Write a reply\n\nShort and warm.\n";
const TEST = "---\njob: texting-assistant\n---\n\n# Core\n\n## 1. When's my dentist?\n\n- kind: task\n- must: say Tuesday at 3 pm\n- must not: make up a date\n";

const notes: FolderNote[] = [
  { path: "ai/production/texting-assistant.md", props: JSON.stringify({ properties: { models: { main: "anthropic/claude-haiku-5-5" } }, heading: "Tex", lede: "" }) },
  { path: "ai/production/skills/write-reply.md", updatedAt: Date.now(), props: JSON.stringify({ properties: {}, heading: "Write a reply", lede: "Short and warm." }) },
  { path: "ai/tests/core.md", props: JSON.stringify({ properties: { job: "texting-assistant" }, heading: "Core", lede: "" }) },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockPush.mockClear();
  mockRead.mockReset();
  mockWrite.mockReset();
  mockRead.mockImplementation(async ({ path }) => ({ kind: "file", path, text: path.startsWith("ai/tests/") ? TEST : SKILL, etag: "v1", readOnly: false }));
  mockWrite.mockImplementation(async ({ path }) => ({ kind: "written", path, etag: "v2" }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render(view: AiView) {
  await act(async () => {
    root.render(createElement(Library, { workspaceId: "ws" as never, catalog: buildCatalog(notes), view, onView: () => {}, onSaved: () => {}, days: 30 }));
  });
}

function type(element: HTMLElement, value: string) {
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the Jobs view", () => {
  test("draws Tex under Talking to people, with the setup's model", async () => {
    await render("jobs");
    const group = byTestId("admin-ai-group-people")!;
    expect(group.textContent).toContain("Talking to people");
    expect(group.textContent).toContain("Tex, by text");
    expect(group.textContent).toContain("Haiku 5.5");
  });
});

describe("a skill opens in place", () => {
  test("its Markdown is edited and saved back with the version it was read at", async () => {
    await render("skills");
    await act(async () => byTestId("admin-ai-row-write-reply")!.click());
    expect(mockPush).not.toHaveBeenCalled();
    const editor = byTestId("admin-ai-editor-text")!;
    expect((editor as HTMLTextAreaElement).value).toBe(SKILL);
    await act(async () => type(editor, `${SKILL}\n- Never sign off with a question.\n`));
    await act(async () => byTestId("admin-ai-editor-save")!.click());
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ path: "ai/production/skills/write-reply.md", text: `${SKILL}\n- Never sign off with a question.\n`, expectedEtag: "v1" }),
    );
  });
});

describe("a test list opens as a form", () => {
  test("editing one rule saves the note with only that line changed", async () => {
    await render("tests");
    await act(async () => byTestId("admin-ai-row-core")!.click());
    expect(byTestId("admin-ai-case-form")).not.toBeNull();
    expect(byTestId("admin-ai-case-title")!.querySelector("input")?.value ?? (byTestId("admin-ai-case-title") as HTMLInputElement).value).toBe("When's my dentist?");
    const lines = TEST.split("\n");
    const mustIndex = lines.indexOf("- must: say Tuesday at 3 pm");
    await act(async () => type(byTestId(`admin-ai-line-${mustIndex}-value`)!, "say Tuesday, October 13 at 3 pm"));
    await act(async () => byTestId("admin-ai-editor-save")!.click());
    const saved = mockWrite.mock.calls[0]![0];
    const expected = [...lines];
    expected[mustIndex] = "- must: say Tuesday, October 13 at 3 pm";
    expect(saved).toEqual(expect.objectContaining({ path: "ai/tests/core.md", text: expected.join("\n"), expectedEtag: "v1" }));
  });
});
