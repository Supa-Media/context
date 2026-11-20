/**
 * @jest-environment jsdom
 */

/**
 * A link to a Lab test chat (`/lab?sandbox=<id>`, as `tex_dev sandbox open` prints it) that cannot be opened.
 * Dev2, 2026-11-20: "Whenever I open these links, it doesn't load the chat. It just loads the Maya one-on-one, and
 * then I get this convex error." The console grant's mint failed, so neither `use` nor `get` answered; the dock kept
 * the default source's name (Maya) and showed the raw error, and the link was spent. Now it names the link, says why,
 * and offers to try the same chat again.
 *
 * Every id and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-20):
 *  1. `attachSandbox` not setting `linked` -> "the picker names the link" fails;
 *  2. the problem left unprefixed -> "says which link could not be opened" fails;
 *  3. `linked` not cleared when `use` answers -> "an opened link is just the chat" fails.
 */
import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { attachSandbox, resetSandboxState, sandbox, setSandboxCall } from "@context/lab/app/engine/sandbox";
import { ChatPick } from "@context/lab/app/views/canvas/SandboxChatPick.web";

const MINT_FAILED = "[CONVEX A(functions/agentGrant:mintConsoleGrant)] [Request ID: 0000000000000000] Server Error";

afterEach(() => {
  document.body.innerHTML = "";
  setSandboxCall(null);
  resetSandboxState();
});

describe("a link to a test chat that cannot be opened", () => {
  test("says which link could not be opened and why, and keeps it to try again", async () => {
    const ops: string[] = [];
    setSandboxCall(async (op) => {
      ops.push(op);
      throw new Error(MINT_FAILED);
    });
    await attachSandbox("aaaa1111bbbb2222", "main");
    expect(ops).toEqual(["use", "get"]);
    expect(sandbox.linked).toBe("aaaa1111bbbb2222");
    expect(sandbox.problem).toBe(`Couldn't open the linked test chat aaaa1111bbbb2222: ${MINT_FAILED}`);
    expect(sandbox.busy).toBe(false);
  });

  test("the picker names the link, not the chat the dock showed before", async () => {
    setSandboxCall(async () => {
      throw new Error(MINT_FAILED);
    });
    await attachSandbox("aaaa1111bbbb2222", "main");
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => root.render(createElement(ChatPick, { versionId: "main" })));
    expect(el.textContent).toContain("Linked test chat");
    expect(el.textContent).not.toContain("Maya");
    act(() => root.unmount());
  });

  test("an opened link is just the chat, and trying again after a failure opens it", async () => {
    let fail = true;
    setSandboxCall(async (op, body) => {
      if (fail) throw new Error(MINT_FAILED);
      if (op === "use") return { sandboxId: body.sandboxId, rows: [], source: { source: "maya" }, versionId: "main" };
      return {};
    });
    await attachSandbox("aaaa1111bbbb2222", "main");
    expect(sandbox.linked).toBe("aaaa1111bbbb2222");
    fail = false;
    await attachSandbox("aaaa1111bbbb2222", "main");
    expect(sandbox.linked).toBeNull();
    expect(sandbox.id).toBe("aaaa1111bbbb2222");
    expect(sandbox.problem).toBeNull();
  });
});
