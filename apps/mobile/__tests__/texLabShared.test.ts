/**
 * The Lab picker's "Shared with devs" tab, the engine's half (Dev2, 2026-11-16; gateway `labSandbox/shared.js`): the
 * list asked of the gateway, a shared chat opened read only by its key, and its history read through the test chat's
 * route, so ▶ on its real texts plays what ran.
 *
 * Every name and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-16):
 *  1. `openSandbox` leaving out a shared chat's `chatId` -> "a shared chat opens by its key" fails;
 *  2. `chatKeyOf` null for a shared chat -> "its history is read through the route" fails.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { isReadOnly, openSandbox, readSandboxShared, resetSandboxState, sandbox, setSandboxCall, sharedLedger, type SandboxOp } from "../features/tex/lab/engine/sandbox";
import { chatKeyOf } from "../features/tex/lab/views/mine/playProd";

const calls: Array<{ op: SandboxOp; body: Record<string, unknown> }> = [];
function gateway(answers: Partial<Record<SandboxOp, Record<string, unknown> | Error>>) {
  setSandboxCall(async (op, body) => {
    calls.push({ op, body });
    const a = answers[op];
    if (a instanceof Error) throw a;
    return a ?? {};
  });
}

afterEach(() => {
  calls.length = 0;
  setSandboxCall(null);
  resetSandboxState();
});

describe("chats shared with the developers", () => {
  test("the tab lists what the gateway says, 1:1s and groups", async () => {
    gateway({ shared: { chats: [{ chatId: "u:usam", name: "@sam", kind: "1:1", people: 1, sharedBy: ["sam"] }, { chatId: "c".repeat(64), name: "Trip", kind: "group", people: 3, sharedBy: ["sam", "lee"], lastAt: 5 }, { name: "no id" }] } });
    await readSandboxShared();
    expect(sandbox.sharedChats).toEqual([
      { chatId: "u:usam", name: "@sam", kind: "dm", people: 1, sharedBy: ["sam"], lastAt: null },
      { chatId: "c".repeat(64), name: "Trip", kind: "group", people: 3, sharedBy: ["sam", "lee"], lastAt: 5 },
    ]);
  });

  test("a list that fails says so, never an empty tab", async () => {
    gateway({ shared: new Error("Only Tex developers read shared chats.") });
    await readSandboxShared();
    expect(sandbox.problem).toMatch(/shared chats didn't load: Only Tex developers/);
  });

  test("a shared chat opens by its key, read only", async () => {
    gateway({ open: { sandboxId: "0123456789abcdef", people: [{ handle: "sam", name: "@sam" }], rows: [{ id: "e1", who: "You", text: "book a table", prod: true, at: 1 }] } });
    await openSandbox({ kind: "shared", chatId: "u:usam", name: "@sam" }, "main");
    expect(calls[0]).toEqual({ op: "open", body: { source: "shared", chatId: "u:usam", versionId: "main" } });
    expect(isReadOnly()).toBe(true);
    expect(isReadOnly({ kind: "chat", chatId: "me", name: "x" })).toBe(false);
  });

  test("its history is read through the route, by its own key", async () => {
    gateway({ ledger: { manifest: null, entries: [{ v: 1, id: "a", at: 1, kind: "text", text: "hi", from: { kind: "person" } }], before: 7 } });
    sandbox.source = { kind: "shared", chatId: "u:usam", name: "@sam" };
    expect(chatKeyOf()).toBe("u:usam");
    const page = await sharedLedger("u:usam", { kinds: ["text"], before: 9 });
    expect(calls[0]).toEqual({ op: "ledger", body: { chatId: "u:usam", kinds: ["text"], before: 9 } });
    expect(page.kind).toBe("ok");
    if (page.kind === "ok") expect(page.value.older).toBe(7);
  });

  test("a chat no longer shared reads as not yours", async () => {
    gateway({ ledger: new Error("That chat isn't shared with the developers (or no longer is).") });
    expect((await sharedLedger("u:usam", {})).kind).toBe("notYours");
  });
});
