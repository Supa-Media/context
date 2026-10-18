/**
 * @jest-environment jsdom
 */

/**
 * The share dialog with a note's own list: what reaches the server when somebody is added, their role changed or
 * they are removed, and that the old verbs (minting a share, pointing the note at one group) are never used there.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ShareDialog } from "../features/console/files/ShareDialog";
import type { GrantList, GrantWrite } from "../features/console/files/shareDialog/grants";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

const LIST: GrantList = {
  version: 1,
  kind: "file",
  base: null,
  tier: "team",
  from: null,
  domains: ["acme.example"],
  grantees: [{ kind: "email", email: "pat@example.test", role: "view" }],
};

const MEMBERS = [
  { userId: "u1", role: "owner", name: "Owner", email: "owner@example.test", isMe: true },
  { userId: "u2", role: "member", name: "Marcus", email: "marcus@example.test", isMe: false },
];

function mount(list: GrantList, overrides: Record<string, unknown> = {}) {
  const save = jest.fn(async (_write: GrantWrite, _version: number) => null as string | null);
  const onShare = jest.fn();
  const onShareWithGroup = jest.fn();
  const onSetScope = jest.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(ShareDialog as never, {
        path: "1-projects/plan.md",
        shares: [],
        origin: "https://example.invalid",
        onShare,
        onShareWithGroup,
        onCopyLink: async () => ({ ok: true, message: null }),
        onRevoke: () => {},
        onSetPreviewTitle: () => {},
        onClose: () => {},
        onSetScope,
        groups: [{ name: "acme-leads", label: "leads", liveCount: 2 }],
        context: { slug: "acme", kind: "shared", viewerIsOwner: true },
        access: { visibility: "@#0190", exception: true, members: MEMBERS },
        grants: { list, save, saving: false },
        ...overrides,
      } as never),
    );
  });
  return { save, onShare, onShareWithGroup, onSetScope };
}

const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function press(node: HTMLElement | null): void {
  if (node === null) throw new Error("nothing to press");
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
}

function type(value: string): void {
  const input = document.body.querySelector<HTMLInputElement>('[aria-label="Share with"]');
  if (input === null) throw new Error("no field");
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("a note with a list", () => {
  test("adding a member with edit writes the whole list, with the base the note already reads as", async () => {
    const { save, onShare } = mount(LIST);
    type("marc");
    press(byId("share-suggest-u2"));
    press(byId("share-role-edit"));
    await act(async () => press(byId("share-submit")));
    expect(save).toHaveBeenCalledWith({
      base: "team",
      grantees: [
        { email: "pat@example.test", role: "view" },
        { userId: "u2", role: "edit" },
      ],
    }, 1);
    expect(onShare).not.toHaveBeenCalled();
  });

  test("a group is added to the list rather than replacing it", async () => {
    const { save, onShareWithGroup } = mount(LIST);
    type("leads");
    press(byId("share-suggest-acme-leads"));
    await act(async () => press(byId("share-submit")));
    expect(save.mock.calls[0][0].grantees).toEqual([
      { email: "pat@example.test", role: "view" },
      { handle: "@acme-leads", role: "view" },
    ]);
    expect(onShareWithGroup).not.toHaveBeenCalled();
  });

  test("a row's menu changes the role, or removes them", async () => {
    const { save } = mount(LIST);
    press(byId("share-grant-menu-email:pat@example.test"));
    await act(async () => press(byId("share-grant-edit-email:pat@example.test")));
    expect(save.mock.calls[0][0]).toEqual({ base: "team", grantees: [{ email: "pat@example.test", role: "edit" }] });
    press(byId("share-grant-menu-email:pat@example.test"));
    await act(async () => press(byId("share-grant-remove-email:pat@example.test")));
    expect(save.mock.calls[1][0]).toEqual({ base: "team", grantees: [] });
  });

  test("the note's own token is not drawn as a group, and general access reads the list's tier", () => {
    mount(LIST);
    expect(byId("share-scope-group")).toBeNull();
    expect(byId("share-audience")?.textContent).toContain("Everyone in @acme");
  });

  test("a domain set to join lets the workspace in on a private note", async () => {
    const { onSetScope, save } = mount({ ...LIST, tier: "private", base: "private" });
    type("acme.example");
    press(byId("share-suggest-domain:acme.example"));
    await act(async () => press(byId("share-submit")));
    expect(onSetScope).toHaveBeenCalledWith("private", "team");
    expect(save).not.toHaveBeenCalled();
  });

  test("a refusal is said in the dialog", async () => {
    const { save } = mount(LIST);
    save.mockResolvedValueOnce("Nobody here goes by that name.");
    press(byId("share-grant-menu-email:pat@example.test"));
    await act(async () => press(byId("share-grant-remove-email:pat@example.test")));
    expect(byId("share-copy-problem")?.textContent).toContain("Nobody here");
  });

  test("a note following its folder offers its own list, which copies the folder's", async () => {
    const { save } = mount({ ...LIST, from: "1-projects" });
    await act(async () => press(byId("share-grants-own")));
    expect(save).toHaveBeenCalledWith({ base: "team", grantees: [{ email: "pat@example.test", role: "view" }] }, 1);
  });
});
