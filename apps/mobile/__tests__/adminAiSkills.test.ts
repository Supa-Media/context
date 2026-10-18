/**
 * @jest-environment jsdom
 */

/**
 * The AI tab's Skills screen, actually rendered (`features/admin/AiSkills.tsx`,
 * board 14). Tex's switch edits the live texting setup's `skills:` list, and
 * the other switches edit the skill's own `reach:` line. These pin that a
 * switch writes the note it names with the version it was read at, and that
 * turning Tex off asks first and leaves no empty `skills:` section behind.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockGo = jest.fn<(place: unknown) => void>();
const mockReload = jest.fn<() => void>();
const mockRead = jest.fn<(args: { path: string }) => Promise<unknown>>();
const mockWrite = jest.fn<(args: { path: string; text: string; expectedEtag?: string }) => Promise<unknown>>();

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
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
import { AiSkills } from "../features/admin/AiSkills";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";

const TEXTING = "---\nmodels:\n  main: anthropic/claude-haiku-5-5\nskills:\n  write-reply: when they want a reply written\n---\n\nPrompt\n";
const TEXTING_WITHOUT_SKILL = "---\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nPrompt\n";
const SKILL = "---\nreach: [tex]\n---\n\n# Write a reply\n";

const notes: FolderNote[] = [
  { path: "ai/production/texting-assistant.md", props: JSON.stringify({ properties: { models: { main: "anthropic/claude-haiku-5-5" } }, heading: "Tex", lede: "" }) },
  { path: "ai/production/skills/write-reply.md", size: 400, updatedAt: Date.now(), props: JSON.stringify({ properties: { reach: ["tex"] }, heading: "Write a reply", lede: "Short and warm." }) },
  { path: "ai/tests/core.md", props: JSON.stringify({ properties: { job: "texting-assistant", covers: ["write-reply"] }, heading: "Core", lede: "" }) },
];

let container: HTMLDivElement;
let root: Root;

/*
  jsdom performs no layout, so the window reports a width of zero and the table
  would draw its phone rows, which carry no switches. Pin a pointer width, as
  the costs render test does, so the table's cells are drawn.
*/
function setWidth(px: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: px, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  setWidth(1280);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockGo.mockClear();
  mockReload.mockClear();
  mockRead.mockReset();
  mockWrite.mockReset();
  mockRead.mockImplementation(async ({ path }) => ({
    kind: "file",
    path,
    text: path === "ai/production/texting-assistant.md" ? TEXTING : SKILL,
    etag: "v1",
    readOnly: false,
  }));
  mockWrite.mockImplementation(async ({ path }) => ({ kind: "written", path, etag: "v2" }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** Renders the screen with `skill` selected, then lets the live texting note load. */
async function render(skill: string | null) {
  await act(async () => {
    root.render(
      createElement(AiSkills, {
        workspaceId: "ws" as never,
        catalog: buildCatalog(notes),
        reads: new Map(),
        go: mockGo,
        reload: mockReload,
        openInNotes: () => {},
        me: "Maya",
        skill,
      }),
    );
  });
  await settle();
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("the Skills view", () => {
  test("Tex is on for write-reply, read from the live texting setup's skills", async () => {
    await render("write-reply");
    expect(byTestId("admin-ai-skill-write-reply-tex")!.getAttribute("aria-checked")).toBe("true");
    expect(byTestId("admin-ai-skill-write-reply-mcp")!.getAttribute("aria-checked")).toBe("false");
    expect(byTestId("admin-ai-skill-write-reply-helpers")!.getAttribute("aria-checked")).toBe("false");
  });

  test("EVERY AI writes reach: [tex, mcp] at the version the skill was read at", async () => {
    await render("write-reply");
    await act(async () => byTestId("admin-ai-skill-write-reply-mcp")!.click());
    await settle();
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ path: "ai/production/skills/write-reply.md", text: "---\nreach: [tex, mcp]\n---\n\n# Write a reply\n", expectedEtag: "v1" }),
    );
    expect(mockReload).toHaveBeenCalled();
  });

  test("Tex off asks first, then writes the setup without the skill or an empty skills section", async () => {
    await render("write-reply");
    await act(async () => byTestId("admin-ai-skill-write-reply-tex")!.click());
    expect(mockWrite).not.toHaveBeenCalled();
    expect(byTestId("admin-ai-skill-warning")!.textContent).toBe("Tex stops reading Write a reply from the next text.");
    await act(async () => byTestId("admin-ai-skill-tex-off")!.click());
    await settle();
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ path: "ai/production/texting-assistant.md", text: TEXTING_WITHOUT_SKILL, expectedEtag: "v1" }),
    );
    const saved = mockWrite.mock.calls[0]![0].text;
    expect(saved).not.toContain("write-reply");
    expect(saved).not.toContain("skills:");
  });

  test("Keep leaves Tex on and writes nothing", async () => {
    await render("write-reply");
    await act(async () => byTestId("admin-ai-skill-write-reply-tex")!.click());
    await act(async () => byTestId("admin-ai-skill-tex-keep")!.click());
    await settle();
    expect(mockWrite).not.toHaveBeenCalled();
    expect(byTestId("admin-ai-skill-warning")).toBeNull();
    expect(byTestId("admin-ai-skill-write-reply-tex")!.getAttribute("aria-checked")).toBe("true");
  });
});
