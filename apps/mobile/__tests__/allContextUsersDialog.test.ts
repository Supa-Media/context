/**
 * @jest-environment jsdom
 */

/**
 * The share dialog in the pinned workspace (`docs/decisions/privacy-and-sharing/all-context-users.md`): General
 * access offers Restricted, Members of @context-lc, All Context users and Anyone with the link, widest last. Members
 * is base `team` there (and a row written before 2026-10-19, base `private` plus the members grant, reads the same);
 * All Context users is base `team` plus the accounts grant. Neither built-in grant is ever a person on People, and
 * picking All Context users from below asks first, in place. Ordinary workspaces keep their three positions.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - pass `membersGranted` as false in `ShareDialog` (a members grant read as Restricted): "a members grant is the
 *    Members position" fails;
 *  - drop the members entry in `requestOf` (`grants.ts`): "adding somebody keeps the members grant" fails;
 *  - drop the accounts entry in `requestOf`: "adding somebody keeps the accounts grant" fails;
 *  - pass no `accountsGranted` in `ShareDialog`: "plain team is Members" fails;
 *  - draw the accounts grant on People (`peopleOf`): "never a person on People, the accounts grant either" fails;
 *  - draw every list entry in `GrantRows` (`list.grantees` for `peopleOf`): "never a person on People" fails;
 *  - drop the `team` case from `asksFirst`: "All Context users asks first" fails;
 *  - ask on every `team` pick: "narrowing a link to it never asks" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ShareDialog } from "../features/console/files/ShareDialog";
import type { GrantList, GrantWrite } from "../features/console/files/shareDialog/grants";
import type { NoteShare } from "../features/console/files/shares";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

const MEMBERS = [
  { userId: "u1", role: "owner", name: "Ada Park", email: "ada@example.com", isMe: true },
  { userId: "u2", role: "editor", name: "Jonah Reyes", email: "jonah@example.com", isMe: false },
  { userId: "u3", role: "member", name: "Mira Okafor", email: "mira@example.com", isMe: false },
  { userId: "u4", role: "member", name: "Theo Lind", email: "theo@example.com", isMe: false },
];

const MEMBERS_LIST: GrantList = {
  version: 7,
  kind: "file",
  base: "private",
  tier: "private",
  from: null,
  domains: [],
  grantees: [{ kind: "members", role: "view", count: 4 }],
};

const LC = { slug: "context-lc", kind: "shared", viewerIsOwner: true, offersAllUsers: true };

function mount(list: GrantList, overrides: Record<string, unknown> = {}) {
  const save = jest.fn(async (_write: GrantWrite, _version: number) => null as string | null);
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
        path: "2-areas/roadmap/q4-roadmap.md",
        shares: [],
        origin: "https://example.invalid",
        onShare: () => {},
        onCopyLink: async () => ({ ok: true, message: null }),
        onRevoke: () => {},
        onSetPreviewTitle: () => {},
        onClose: () => {},
        onSetScope,
        context: LC,
        // The owner reads a listed note as its own token, which is not a group.
        access: { visibility: "@#0190", exception: true, members: MEMBERS },
        grants: { list, save, saving: false },
        ...overrides,
      } as never),
    );
  });
  return { save, onSetScope };
}

const byId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (id: string) => byId(id)?.textContent ?? "";

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

/** The menu's positions, in order, by their test ids. */
function positions(): string[] {
  press(byId("share-audience"));
  return [...document.body.querySelectorAll<HTMLElement>('[data-testid^="share-audience-"]')].map((node) =>
    node.getAttribute("data-testid")!.slice("share-audience-".length),
  );
}

const TEAM_LIST: GrantList = { ...MEMBERS_LIST, base: "team", tier: "team", grantees: [] };
const ACCOUNTS_LIST: GrantList = { ...TEAM_LIST, grantees: [{ kind: "accounts", role: "view" }] };
const TEAM_ACCESS = { access: { visibility: "team", exception: false, members: MEMBERS } };

describe("plain team is Members", () => {
  test("named Members of @context-lc, counted, never All Context users", () => {
    mount(TEAM_LIST, TEAM_ACCESS);
    expect(text("share-audience")).toContain("Members of @context-lc");
    expect(text("share-access")).toContain("All 4 members can open it");
    expect(byId("share-all-users-note")).toBeNull();
  });
});

describe("a members grant is the Members position", () => {
  test("named Members of @context-lc, counted, and never drawn as Restricted or a group", () => {
    mount(MEMBERS_LIST);
    expect(text("share-audience")).toContain("Members of @context-lc");
    expect(text("share-access")).toContain("All 4 members can open it");
    expect(text("share-access")).toContain("See members");
    expect(byId("share-scope-group")).toBeNull();
    expect(text("share-access")).not.toContain("Restricted");
  });

  test("never a person on People", () => {
    mount(MEMBERS_LIST);
    expect(byId("share-grant-members")).toBeNull();
    expect(document.body.textContent).not.toContain("Every member");
  });

  test("never a person on People, the accounts grant either", () => {
    mount(ACCOUNTS_LIST, TEAM_ACCESS);
    expect(byId("share-grant-accounts")).toBeNull();
    expect(document.body.textContent).not.toContain("Anyone signed in to Context, ");
  });

  test("adding somebody keeps the accounts grant", async () => {
    const { save } = mount(ACCOUNTS_LIST, TEAM_ACCESS);
    type("pat@example.test");
    press(byId("share-suggest-pat@example.test"));
    await act(async () => press(byId("share-submit")));
    expect(save).toHaveBeenCalledWith(
      { base: "team", grantees: [{ accounts: true, role: "view" }, { email: "pat@example.test", role: "view" }] },
      7,
    );
  });

  test("adding somebody keeps the members grant", async () => {
    const { save } = mount(MEMBERS_LIST);
    type("pat@example.test");
    press(byId("share-suggest-pat@example.test"));
    await act(async () => press(byId("share-submit")));
    expect(save).toHaveBeenCalledWith(
      { base: "private", grantees: [{ members: true, role: "view" }, { email: "pat@example.test", role: "view" }] },
      7,
    );
  });
});

describe("the menu", () => {
  test("four positions, widest last, with one line each", () => {
    mount(MEMBERS_LIST);
    expect(positions()).toEqual(["private", "members", "team", "anyone"]);
    expect(text("share-audience-private")).toContain("Only owners of @context-lc can open it");
    expect(text("share-audience-members")).toContain("All 4 members can open it");
    expect(text("share-audience-team")).toContain("All Context users");
    expect(text("share-audience-team")).toContain("Anyone signed in to Context can open it");
    expect(text("share-audience-anyone")).toContain("without signing in");
  });

  test("an ordinary workspace keeps its three", () => {
    mount({ ...TEAM_LIST }, { context: { slug: "field-notes", kind: "shared", viewerIsOwner: true } });
    expect(positions()).toEqual(["private", "team", "anyone"]);
    expect(text("share-audience-team")).toContain("Everyone in @field-notes");
  });
});

describe("All Context users", () => {
  test("the row says the reach, with the neutral tag in place of the folder's", () => {
    mount(ACCOUNTS_LIST, TEAM_ACCESS);
    expect(text("share-audience")).toContain("All Context users");
    expect(text("share-access")).toContain("Anyone signed in to Context can open it");
    expect(text("share-all-users-note")).toBe("Not just members. Keep anything sensitive out.");
    expect(byId("share-inherited")).toBeNull();
    expect(byId("share-see-members")).toBeNull();
  });

  test("All Context users asks first, in place, and only the yes widens", () => {
    const { onSetScope } = mount(MEMBERS_LIST);
    press(byId("share-audience"));
    press(byId("share-audience-team"));
    expect(onSetScope).not.toHaveBeenCalled();
    expect(text("share-access")).toContain("Not open to them yet");
    expect(text("share-confirm-all-users")).toBe(
      "Anyone signed in to Context will be able to open Q4 roadmap, not just the 4 members. Signing up is open to all, so keep anything sensitive out.CancelOpen to all users",
    );
    press(byId("share-confirm-all-users-yes"));
    expect(onSetScope).toHaveBeenCalledWith("members", "team");
  });

  test("leaving it never asks", () => {
    const { onSetScope } = mount(ACCOUNTS_LIST, TEAM_ACCESS);
    press(byId("share-audience"));
    press(byId("share-audience-members"));
    expect(onSetScope).toHaveBeenCalledWith("team", "members");
  });

  test("narrowing a link to it never asks", () => {
    const link = { shareId: "s1", entryPath: "2-areas/roadmap/q4-roadmap.md", audience: "anyone", recipient: "anyone" } as unknown as NoteShare;
    const { onSetScope } = mount(TEAM_LIST, { shares: [link], access: { visibility: "team", exception: false, members: MEMBERS } });
    press(byId("share-audience"));
    press(byId("share-audience-team"));
    expect(onSetScope).toHaveBeenCalledWith("anyone", "team");
    expect(byId("share-confirm-all-users")).toBeNull();
  });
});
