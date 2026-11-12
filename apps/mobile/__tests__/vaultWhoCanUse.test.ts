/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: () => null,
  useLocalSearchParams: () => ({}),
}));
jest.mock("convex/react", () => ({
  useAction: () => async () => null,
  useMutation: () => async () => null,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));

import { VaultLinkBody } from "../features/vault/VaultLinkScreen";
import { missingLine } from "../features/vault/VaultWhoCanUse";
import type { VaultDraft } from "../features/vault/VaultAddForm";
import { resolveVaultLinkView, type Described, type Outcome, type VaultChat, type VaultRequest } from "../features/vault/vaultLink";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * "Who can use it" on a vault link texted in a group chat (Dev2, 2026-11-12):
 * the chat is picked already, the workspace choice shows who in the chat is a
 * member with "Add" beside who isn't, and Save sends the choice. Fake names.
 */

const crystal = { handle: "crystal-care", name: "Crystal Care", kind: "shared" as const };
const personal = { handle: "ada", name: "Ada", kind: "personal" as const };
const chat: VaultChat = {
  label: "Group chat with Segun, Mom and Dad",
  people: [
    { name: "You", handle: "seyi", status: "you" },
    { name: "Segun", handle: "segun", status: "member" },
    { name: "Mom", handle: "mom", status: "not_member" },
    { name: "Dad", handle: "dad", status: "not_member" },
  ],
  canInvite: true,
};
const fromChat: VaultRequest = { kind: "add", workspace: crystal, grantee: null, entry: null, expiresAt: 1, chat };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  request: VaultRequest,
  outcome: Outcome,
  handlers: { onSave?: (draft: VaultDraft) => Promise<boolean>; onInvite?: (handle: string) => Promise<"invited" | "already"> } = {},
) {
  const described: Described = { kind: "shown", request };
  const view = resolveVaultLinkView({ token: "tok", auth: { isLoading: false, isAuthenticated: true }, prefill: { name: "Gusto", site: "gusto.com" }, described, outcome });
  act(() =>
    root.render(
      createElement(VaultLinkBody, {
        view,
        onSave: handlers.onSave ?? (async () => true),
        onShare: () => {},
        onReveal: () => {},
        onDecline: () => {},
        onSwitchAccount: () => {},
        onInvite: handlers.onInvite,
      }),
    ),
  );
}

const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function press(id: string) {
  const el = find(id);
  if (el === null) throw new Error(`no ${id}`);
  act(() => el.click());
}
function type(id: string, text: string) {
  const field = find(id);
  if (field === null) throw new Error(`no field called ${id}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const checked = (id: string) => find(id)?.getAttribute("aria-checked");

describe("who can use a login saved from a chat", () => {
  test("the chat is picked already, and Save sends it", async () => {
    const saved: VaultDraft[] = [];
    render(fromChat, { kind: "idle" }, { onSave: async (draft) => (saved.push(draft), true) });
    expect(container.textContent).toContain(`People in ${chat.label}`);
    expect(checked("vault-who-chat")).toBe("true");
    expect(checked("vault-who-workspace")).toBe("false");
    expect(container.textContent).toContain("Everyone in @crystal-care");
    type("vault-password", "correct-horse-fake");
    press("vault-save");
    await flush();
    expect(saved[0]).toMatchObject({ type: "login", site: "gusto.com", share: "chat" });
  });

  test("picking the workspace shows who is in it, and Add invites one person on its own tap", async () => {
    const invited: string[] = [];
    const saved: VaultDraft[] = [];
    render(fromChat, { kind: "idle" }, {
      onSave: async (draft) => (saved.push(draft), true),
      onInvite: async (handle) => (invited.push(handle), "invited"),
    });
    expect(find("vault-who-members")).toBeNull();
    press("vault-who-workspace");
    expect(checked("vault-who-workspace")).toBe("true");
    const members = find("vault-who-members")?.textContent ?? "";
    expect(members).toContain("Segun✓ In workspace");
    expect(members).toContain("MomNot in workspace");
    expect(find("vault-who-add-segun")).toBeNull();
    // Nothing is sent by opening the list.
    expect(invited).toEqual([]);
    press("vault-who-add-mom");
    await flush();
    expect(invited).toEqual(["mom"]);
    expect(find("vault-who-members")?.textContent).toContain("MomInvite sent");
    expect(find("vault-who-add-mom")).toBeNull();
    expect(find("vault-who-add-dad")).not.toBeNull();
    type("vault-password", "correct-horse-fake");
    press("vault-save");
    await flush();
    expect(saved[0]).toMatchObject({ share: "workspace" });
  });

  test("somebody who isn't an owner sees who is missing but no Add", () => {
    render({ ...fromChat, chat: { ...chat, canInvite: false } }, { kind: "idle" }, { onInvite: async () => "invited" });
    press("vault-who-workspace");
    expect(find("vault-who-add-mom")).toBeNull();
    expect(find("vault-who-missing")?.textContent).toContain("An owner of the workspace can add them.");
  });

  test("only me sends me", async () => {
    const saved: VaultDraft[] = [];
    render(fromChat, { kind: "idle" }, { onSave: async (draft) => (saved.push(draft), true) });
    press("vault-who-me");
    type("vault-password", "correct-horse-fake");
    press("vault-save");
    await flush();
    expect(saved[0]).toMatchObject({ share: "me" });
  });

  test("a personal link outside any chat has no choice to make, and sends none", async () => {
    const saved: VaultDraft[] = [];
    render({ kind: "add", workspace: personal, grantee: null, entry: null, expiresAt: 1 }, { kind: "idle" }, { onSave: async (draft) => (saved.push(draft), true) });
    expect(find("vault-who")).toBeNull();
    type("vault-password", "correct-horse-fake");
    press("vault-save");
    await flush();
    expect(saved[0]?.share).toBeUndefined();
  });

  test("saved for the chat says Tex carries on there", () => {
    render(fromChat, { kind: "saved", name: "Gusto", site: "gusto.com", type: "login", sharedWith: "chat" });
    expect(find("vault-link-saved")?.textContent).toContain(`Saved for ${chat.label}`);
    expect(find("vault-link-saved")?.textContent).toContain("Tex is signing in to gusto.com now and will answer in the chat.");
    render(fromChat, { kind: "saved", name: "Gusto", site: "gusto.com", type: "login", sharedWith: "me" });
    expect(find("vault-link-saved")?.textContent).not.toContain("Saved for");
  });

  test("the line under the list names who can't be covered yet", () => {
    expect(missingLine([chat.people[2], chat.people[3]], true)).toBe(
      "Mom and Dad are in this chat but not the workspace, so Tex can't use it for them yet. Add invites them to join.",
    );
    expect(missingLine([chat.people[2]], false)).toContain("Mom is in this chat");
  });
});
