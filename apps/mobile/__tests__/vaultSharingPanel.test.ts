/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("convex/react", () => ({ useConvex: () => undefined }));

import { VaultList, type VaultActions } from "../features/console/settings/panels/VaultPanel";
import { aisByPerson, giveSuggestions, initialsOf, moveLine, shareRowLine, takeBackLine, type VaultShareChoices } from "../features/vault/vaultPeople";
import { inFilter, vaultClientLine, vaultLastUsedLine, vaultSavedLine, type VaultEntry, type VaultLevel } from "../features/vault/vaultSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Giving a vault key (vault sharing boards 1 to 3): the People section on a
 * key its reader manages, with each person's AIs under them, Give to a person,
 * a group or everyone, and Take back that says once in bold red what it does;
 * and the reader's side of a key given to them for their AIs only.
 */

const NOW = new Date(Date.UTC(2026, 9, 17, 12));
const SAVED = Date.UTC(2026, 9, 16);
const GIVEN = Date.UTC(2026, 9, 17);

const owned: VaultEntry = {
  entryId: "v000000000000000000000011",
  type: "secret",
  name: "Context Convex Readonly",
  sites: [],
  envs: [],
  shared: true,
  proxy: {
    host: "api.convex.example",
    style: "bearer",
    name: null,
    ask: true,
    clients: [
      { id: "client-claude", name: "Claude Code", at: SAVED, by: "user_me", byName: "You", mine: true },
      { id: "client-claude", name: "Claude Code", at: GIVEN, by: "user_sayo", byName: "Sayo Adeyemi", mine: false },
      { id: "client-codex", name: "Codex", at: GIVEN, by: "user_zay", byName: "Zay Okafor", mine: false },
    ],
    uses: [
      { id: "client-claude", name: "Claude Code", count: 31, at: SAVED, method: "GET", path: "/v1/x", by: "user_me", byName: "You", mine: true },
      { id: "client-claude", name: "Claude Code", count: 12, at: NOW.getTime() - 4 * 60_000, method: "GET", path: "/api/deployments", by: "user_sayo", byName: "Sayo Adeyemi", mine: false },
    ],
    refused: [],
    waiting: 0,
  },
  savedAt: SAVED,
  savedByYou: true,
  savedBy: "You",
  level: "see",
  manage: true,
  givenBy: null,
  givenToYou: false,
  people: [
    { to: "user_me", kind: "person", name: "You", handle: "seyi", count: null, level: "see", at: SAVED, isYou: true },
    { to: "user_sayo", kind: "person", name: "Sayo Adeyemi", handle: "sayo", count: null, level: "use", at: GIVEN, isYou: false },
    { to: "@supa-leads", kind: "group", name: "Leads", handle: null, count: 3, level: "use", at: GIVEN, isYou: false },
  ],
};

const choices: VaultShareChoices = {
  workspace: { handle: "supa", kind: "shared" },
  people: [
    { userId: "user_me", name: "Seyi", handle: "seyi", role: "owner", isMe: true },
    { userId: "user_sayo", name: "Sayo Adeyemi", handle: "sayo", role: "editor", isMe: false },
    { userId: "user_olu", name: "Olumide Salami With A Very Long Family Name", handle: "olumide", role: "member", isMe: false },
  ],
  groups: [{ to: "@supa-leads", label: "Leads", count: 3 }],
  members: 6,
};

const given: VaultEntry = {
  ...owned,
  entryId: "v000000000000000000000012",
  proxy: { ...owned.proxy!, clients: [owned.proxy!.clients[1]].map((c) => ({ ...c, byName: "You", mine: true })), uses: [] },
  savedByYou: false,
  savedBy: "Seyi",
  level: "use",
  manage: false,
  givenBy: "Seyi",
  givenToYou: true,
  people: [],
};

describe("the words", () => {
  test("the Give field offers everyone, groups and people in the workspace, not who already has it", () => {
    expect(giveSuggestions(choices, "o", owned).map((one) => one.title)).toEqual([
      "Everyone in @supa",
      "Olumide Salami With A Very Long Family Name",
    ]);
    expect(giveSuggestions(choices, "", owned)[0]).toEqual({
      to: "*",
      kind: "everyone",
      title: "Everyone in @supa",
      sub: "6 people, and anyone who joins later",
    });
    expect(giveSuggestions(choices, "@olu", owned).map((one) => one.sub)).toEqual(["@olumide · member"]);
    expect(giveSuggestions(choices, "seyi", owned)).toEqual([]);
    expect(giveSuggestions(choices, "lead", { ...owned, people: [] })).toEqual([{ to: "@supa-leads", kind: "group", title: "Leads", sub: "Group · 3 people" }]);
  });

  test("each row's line, and what Take back says", () => {
    const [saver, sayo, leads] = owned.people!;
    expect(shareRowLine(saver, true, NOW)).toBe("Saved it · can change it");
    expect(shareRowLine(sayo, false, NOW)).toBe("Given 17 Oct");
    expect(shareRowLine(leads, false, NOW)).toBe("Given 17 Oct · 3 people");
    expect(takeBackLine(sayo)).toBe("Sayo Adeyemi and Sayo Adeyemi's AIs lose the key now.");
    expect(takeBackLine(leads)).toBe("Everyone in Leads who has it no other way, and their AIs, lose it now.");
    expect(initialsOf("Sayo Adeyemi")).toBe("SA");
    expect(initialsOf("@supa")).toBe("SU");
    expect(moveLine("supa")).toBe("It leaves your personal workspace for @supa. Only you have it there until you give it to someone, and your AIs ask again the first time they use it.");
  });

  test("every AI sits under its person; somebody with it through a group gets a row of their own", () => {
    const { rows, others } = aisByPerson(owned);
    expect(rows.get("user_me")!.map((c) => c.id)).toEqual(["client-claude"]);
    expect(rows.get("user_sayo")!.map((c) => c.by)).toEqual(["user_sayo"]);
    expect(others).toEqual([{ by: "user_zay", name: "Zay Okafor", clients: [owned.proxy!.clients[2]] }]);
  });

  test("somebody else's AI is named as theirs, and its count is its own", () => {
    expect(vaultClientLine(owned.proxy!.clients[1], owned.proxy!.uses, NOW)).toBe("Sayo Adeyemi said yes 17 Oct · used 12 times");
    expect(vaultLastUsedLine(owned, NOW)).toBe("Sayo Adeyemi's Claude Code read your deployments, 4 minutes ago.");
    expect(vaultSavedLine(given, NOW)).toBe("Given to you by Seyi · for your AIs");
    expect(vaultSavedLine({ ...given, givenBy: null, savedBy: "Seyi" }, NOW)).toBe("Saved by Seyi on 16 Oct");
    expect(inFilter(owned, "given")).toBe(true);
    expect(inFilter({ ...owned, shared: false }, "given")).toBe(false);
  });
});

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

function fakes(listed: VaultEntry[], shareChoices: VaultShareChoices = choices) {
  const calls: unknown[][] = [];
  const entries = listed.map((entry) => ({ ...entry }));
  const keep = (next: VaultEntry) => {
    entries[entries.findIndex((e) => e.entryId === next.entryId)] = next;
    return next;
  };
  const actions: VaultActions = {
    list: async () => entries.map((entry) => ({ ...entry })),
    cutOff: async (entryId, clientId, by) => {
      calls.push(["cut", entryId, clientId, by]);
      const entry = entries.find((e) => e.entryId === entryId)!;
      return keep({ ...entry, proxy: { ...entry.proxy!, clients: entry.proxy!.clients.filter((c) => !(c.id === clientId && c.by === by)) } });
    },
    allow: async () => {
      throw new Error("not here");
    },
    link: async (kind, entryId) => {
      calls.push(["link", kind, entryId]);
      return `tok-${kind}-${entryId}`;
    },
    calls: {
      describe: async () => ({ kind: "view", workspace: { handle: "supa", name: "Supa", kind: "shared" as const }, grantee: null, entry: { type: "secret", name: "x", sites: [], fields: [] }, expiresAt: 1 }),
      save: async () => ({ name: "", site: "" }),
      reveal: async (token) => {
        calls.push(["reveal", token]);
        return { type: "secret", name: "x", sites: [], username: "", password: "", fields: [] };
      },
      edit: async () => ({ changed: [] }),
      remove: async () => ({ name: "" }),
    },
    choices: async () => shareChoices,
    give: async (entryId, to, level: VaultLevel) => {
      calls.push(["give", entryId, to, level]);
      const entry = entries.find((e) => e.entryId === entryId)!;
      const row = { to, kind: "person" as const, name: "Olumide Salami With A Very Long Family Name", handle: "olumide", count: null, level, at: GIVEN, isYou: false };
      return keep({ ...entry, people: [...(entry.people ?? []).filter((p) => p.to !== to), row] });
    },
    moveTargets: async () => [{ workspaceId: "ws_team", handle: "supa", name: "Supa" }],
    move: async (entryId, toWorkspaceId) => {
      calls.push(["move", entryId, toWorkspaceId]);
      entries.splice(entries.findIndex((e) => e.entryId === entryId), 1);
      return { handle: "supa" };
    },
    takeBack: async (entryId, to) => {
      calls.push(["take", entryId, to]);
      const entry = entries.find((e) => e.entryId === entryId)!;
      if (to === "user_me") {
        entries.splice(entries.indexOf(entry), 1);
        return null;
      }
      return keep({ ...entry, people: (entry.people ?? []).filter((p) => p.to !== to), proxy: { ...entry.proxy!, clients: entry.proxy!.clients.filter((c) => c.by !== to) } });
    },
  };
  return { actions, calls };
}

describe("the People section", () => {
  test("shows who has it with their AIs nested, and gives the key to somebody picked by name", async () => {
    const { actions, calls } = fakes([owned]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    const sayo = find("vault-person-user_sayo")!;
    expect(sayo.textContent).toContain("Sayo Adeyemi");
    expect(sayo.textContent).toContain("Their AIs use it ▾");
    expect(sayo.textContent).toContain("Claude Code · Sayo Adeyemi said yes 17 Oct · used 12 times");
    expect(find("vault-people")!.textContent).toContain("Has it through a group or everyone");
    expect(find("vault-person-user_me")!.textContent).not.toContain("Take back");
    type("vault-give-input", "olu");
    press("vault-give-to-user_olu");
    // "They can see it too", then Give.
    const see = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((el) => el.textContent === "They can see it too")!;
    act(() => see.click());
    press("vault-give");
    await flush();
    expect(calls).toContainEqual(["give", owned.entryId, "user_olu", "see"]);
    expect(find("vault-person-user_olu")).not.toBeNull();
  });

  test("Take back says what happens once, and only then takes it", async () => {
    const { actions, calls } = fakes([owned]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    press("vault-take-user_sayo");
    expect(calls.some((call) => call[0] === "take")).toBe(false);
    expect(find("vault-person-user_sayo")!.textContent).toContain("Sayo Adeyemi and Sayo Adeyemi's AIs lose the key now.");
    press("vault-take-keep-user_sayo");
    expect(find("vault-take-yes-user_sayo")).toBeNull();
    press("vault-take-user_sayo");
    press("vault-take-yes-user_sayo");
    await flush();
    expect(calls).toContainEqual(["take", owned.entryId, "user_sayo"]);
    expect(find("vault-person-user_sayo")).toBeNull();
  });

  test("a level is changed in place, and anybody's AI can be cut off by name", async () => {
    const { actions, calls } = fakes([owned]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    press("vault-level-@supa-leads");
    press("vault-level-@supa-leads-see");
    await flush();
    expect(calls).toContainEqual(["give", owned.entryId, "@supa-leads", "see"]);
    press("vault-cut-user_zay-client-codex");
    await flush();
    expect(calls).toContainEqual(["cut", owned.entryId, "client-codex", "user_zay"]);
  });

  test("a personal workspace's key offers no field, and moves to a shared workspace after saying so once", async () => {
    const { actions, calls } = fakes([owned], { ...choices, workspace: { handle: "seyi", kind: "personal" } });
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    expect(find("vault-give-personal")!.textContent).toContain("Only you. To give it to teammates, move it to a shared workspace.");
    expect(find("vault-give-input")).toBeNull();
    press("vault-move-supa");
    expect(calls.some((call) => call[0] === "move")).toBe(false);
    expect(container.textContent).toContain("It leaves your personal workspace for @supa.");
    press("vault-move-keep");
    press("vault-move-supa");
    press("vault-move-yes");
    await flush();
    expect(calls).toContainEqual(["move", owned.entryId, "ws_team"]);
    expect(find(`vault-row-${owned.entryId}`)).toBeNull();
    expect(find("vault-notice")!.textContent).toBe("Moved to @supa. Open @supa's Settings › Vault to give it to people.");
  });
});

describe("a key given to you for your AIs", () => {
  test("opens nothing to see, has no Edit and no People, and can be given back", async () => {
    const { actions, calls } = fakes([given]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    expect(container.textContent).toContain("Given to you by Seyi · for your AIs");
    expect(find("vault-use-only")).not.toBeNull();
    expect(calls.some((call) => call[0] === "link")).toBe(false);
    expect(find("vault-edit")).toBeNull();
    expect(find("vault-people")).toBeNull();
    press("vault-hand-back");
    expect(container.textContent).toContain("You and your AIs lose the key now.");
    press("vault-hand-back-yes");
    await flush();
    expect(calls).toContainEqual(["take", given.entryId, "user_me"]);
    expect(container.textContent).toContain("Handed back.");
  });
});
