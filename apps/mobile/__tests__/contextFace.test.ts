/**
 * @jest-environment jsdom
 */
/**
 * Context's own mail (its setup checks) is drawn with Context's mark, not the generic robot (Dev, 2026-11-27: "can we
 * use the context logo or something here"). See `features/console/faces/ContextFace.tsx`.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { isContextSender } from "../features/console/faces/ContextFace";
import { OwnerFace } from "../features/console/files/folderPage/Glyphs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: (() => void)[] = [];
afterEach(() => {
  while (unmounts.length > 0) unmounts.pop()!();
});

describe("Context as a sender", () => {
  test("is `context` signed by Context or by no app", () => {
    expect(isContextSender("context", "Context")).toBe(true);
    expect(isContextSender("context", null)).toBe(true);
    expect(isContextSender("Context", undefined)).toBe(true);
  });

  test("is not a bot or agent that merely signs from another app, nor another name", () => {
    expect(isContextSender("context", "Cursor · @seyi")).toBe(false);
    expect(isContextSender("contextual", "Context")).toBe(false);
    expect(isContextSender("speed", "Context")).toBe(false);
  });

  test("is drawn with Context's mark", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(OwnerFace, { face: { kind: "context" }, size: 32 })));
    unmounts.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    expect(container.querySelector('[data-testid="owner-face-context"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="owner-face-agent"]')).toBeNull();
  });
});
