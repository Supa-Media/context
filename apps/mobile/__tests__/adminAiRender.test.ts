/**
 * @jest-environment jsdom
 */

/**
 * The AI tab, actually rendered (`features/admin/AiSection.tsx`'s `Catalog`).
 * The Jobs view draws every declared job under its group; the Skills view
 * lists a skill; pressing a skill's row opens its note in the editor, at the
 * note's own address.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Catalog, type AiView } from "../features/admin/AiSection";
import { buildCatalog, type FolderNote } from "../features/admin/aiCatalog";

const notes: FolderNote[] = [
  { path: "ai/production/texting-assistant.md", props: JSON.stringify({ properties: {}, heading: "Tex", lede: "" }) },
  {
    path: "ai/production/skills/write-reply.md",
    updatedAt: Date.now(),
    props: JSON.stringify({ properties: { title: "Write a reply" }, heading: "", lede: "Short and warm." }),
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockPush.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(view: AiView, onView: (view: AiView) => void = () => {}) {
  const catalog = buildCatalog(notes);
  act(() => {
    root.render(createElement(Catalog, { catalog, view, onView }));
  });
}

describe("the Jobs view", () => {
  test("draws Tex under Talking to people", () => {
    render("jobs");
    expect(container.textContent).toContain("Tex, by text");
    const group = container.querySelector<HTMLElement>('[data-testid="admin-ai-group-people"]');
    expect(group).not.toBeNull();
    expect(group!.textContent).toContain("Talking to people");
    expect(group!.textContent).toContain("Tex, by text");
  });

  test("the background group is drawn with its own heading", () => {
    render("jobs");
    expect(container.querySelector('[data-testid="admin-ai-group-background"]')!.textContent).toContain(
      "Working in the background",
    );
  });
});

describe("the Skills view", () => {
  test("lists a skill by its title", () => {
    render("skills");
    expect(container.textContent).toContain("Write a reply");
    expect(container.textContent).toContain("Short and warm.");
  });

  test("pressing a skill row pushes its note's address", () => {
    render("skills");
    const row = container.querySelector<HTMLElement>('[data-testid="admin-ai-row-write-reply"]');
    expect(row).not.toBeNull();
    act(() => {
      row!.click();
    });
    expect(mockPush).toHaveBeenCalledTimes(1);
    const href = mockPush.mock.calls[0]![0] as string;
    expect(href).toContain("note=");
    expect(href).toContain(encodeURIComponent("ai/production/skills/write-reply.md"));
  });
});
