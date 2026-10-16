/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("convex/react", () => ({ useConvex: () => undefined }));

import { VaultList, VaultPanel, type VaultActions } from "../features/console/settings/panels/VaultPanel";
import {
  inFilter,
  vaultAgo,
  vaultClientLine,
  vaultCountLine,
  vaultLastUsedLine,
  vaultNoClientsLine,
  vaultPinLine,
  vaultRefusedLine,
  vaultRowLine,
  vaultRowPill,
  vaultSavedLine,
  type VaultEntry,
} from "../features/vault/vaultSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Settings › Vault, drawn as vault board 2: cards with the one website, the
 * AIs on each key and when one last used it, and the picked key's detail with
 * Cut off, Allow and the last use in a sentence. The page is handed names,
 * yeses and uses only, so these prove the words and that each button asks the
 * server for the right thing.
 */

const NOW = new Date(Date.UTC(2026, 9, 16, 12));
const MIN = 60_000;
const pinned: VaultEntry = {
  entryId: "v000000000000000000000001",
  type: "secret",
  name: "Stripe",
  sites: [],
  envs: ["dev", "prod"],
  shared: false,
  proxy: {
    host: "api.example.com",
    style: "bearer",
    name: null,
    ask: true,
    clients: [
      { id: "client-a", name: "Claude Code", at: Date.UTC(2026, 9, 16) },
      { id: "client-b", name: null, at: Date.UTC(2026, 9, 14) },
    ],
    uses: [
      { id: "client-a", name: "Claude Code", count: 31, at: NOW.getTime() - 4 * MIN, method: "GET", path: "/v1/customers/cus_8Hd2" },
      { id: "client-b", name: null, count: 3, at: NOW.getTime() - 3 * 24 * 60 * MIN, method: "POST", path: "/v1/charges" },
    ],
    refused: [{ id: "client-c", name: "ChatGPT", at: Date.UTC(2026, 9, 15) }],
    waiting: 0,
  },
  savedAt: Date.UTC(2026, 9, 10),
  savedByYou: true,
};
const waiting: VaultEntry = {
  ...pinned,
  entryId: "v000000000000000000000004",
  name: "Convex deploy key",
  proxy: { ...pinned.proxy!, clients: [], uses: [], refused: [], waiting: 1 },
};
const unpinned: VaultEntry = { ...pinned, entryId: "v000000000000000000000002", name: "Bank notes", envs: [], proxy: null };
const login: VaultEntry = { ...unpinned, entryId: "v000000000000000000000003", type: "login", name: "Bank", sites: ["bank.example.test"] };

describe("the words", () => {
  test("the count, and a row says where the key goes, or why no AI uses it", () => {
    expect(vaultCountLine([pinned, unpinned, login])).toBe("2 keys · 1 login");
    expect(vaultCountLine([login, login, login])).toBe("3 logins");
    expect(vaultCountLine([pinned])).toBe("1 key");
    expect(vaultRowLine(pinned)).toBe("Only to api.example.com · dev, prod");
    expect(vaultRowLine(unpinned)).toBe("Not given to AIs · you copy it yourself");
    expect(vaultRowLine(login)).toBe("Login · Tex fills it on bank.example.test");
  });

  test("a row's pill: who waits, when it was last used, or no AI yet", () => {
    expect(vaultRowPill(pinned, NOW)).toEqual({ text: "used 4 min ago", tone: "ok" });
    expect(vaultRowPill(waiting, NOW)).toEqual({ text: "1 AI waiting for you", tone: "warn" });
    expect(vaultRowPill({ ...waiting, proxy: { ...waiting.proxy!, waiting: 0 } }, NOW)).toEqual({ text: "no AI yet", tone: "neutral" });
    expect(vaultRowPill(unpinned, NOW)).toBeNull();
    expect(vaultAgo(NOW.getTime() - 26 * 60 * MIN, NOW)).toBe("yesterday");
    expect(vaultAgo(NOW.getTime() - 2 * 24 * 60 * MIN, NOW)).toBe("2 days ago");
  });

  test("the detail: who saved it, how it is sent, each AI with its yes and uses, and a no", () => {
    expect(vaultSavedLine(pinned, NOW)).toBe("Saved by you on 10 Oct");
    expect(vaultPinLine(pinned.proxy!)).toBe("as a sign-in header");
    expect(vaultPinLine({ ...pinned.proxy!, style: "header", name: "x-api-key" })).toBe("as the x-api-key header");
    const [claude, other] = pinned.proxy!.clients;
    expect(vaultClientLine(claude, pinned.proxy!.uses, NOW)).toBe("You said yes 16 Oct · used 31 times");
    expect(vaultClientLine(other, [], new Date(Date.UTC(2027, 1, 1)))).toBe("You said yes 14 Oct 2026");
    expect(vaultRefusedLine(pinned.proxy!.refused[0], NOW)).toBe("You said no 15 Oct");
    expect(vaultNoClientsLine(pinned.proxy!)).toMatch(/you'll be asked/);
  });

  test("the last use in a sentence, naming what the address was about and never an id", () => {
    expect(vaultLastUsedLine(pinned, NOW)).toBe("Claude Code read your customers, 4 minutes ago.");
    const wrote = { ...pinned, proxy: { ...pinned.proxy!, uses: [{ ...pinned.proxy!.uses[1], at: NOW.getTime() - 2 * 60 * MIN }] } };
    expect(vaultLastUsedLine(wrote, NOW)).toBe("An AI wrote to your charges, 2 hours ago.");
    const bare = { ...pinned, proxy: { ...pinned.proxy!, uses: [{ ...pinned.proxy!.uses[0], path: "/v2/8f3a9c" }] } };
    expect(vaultLastUsedLine(bare, NOW)).toBe("Claude Code read api.example.com, 4 minutes ago.");
    expect(vaultLastUsedLine(unpinned, NOW)).toBeNull();
  });

  test("the filters", () => {
    expect(inFilter(pinned, "ai", NOW)).toBe(true);
    expect(inFilter(login, "ai", NOW)).toBe(false);
    expect(inFilter(login, "logins", NOW)).toBe(true);
    expect(inFilter(pinned, "stale", NOW)).toBe(false);
    expect(inFilter({ ...unpinned, savedAt: Date.UTC(2026, 0, 1) }, "stale", NOW)).toBe(true);
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

function fakes(listed: VaultEntry[]) {
  const calls: unknown[][] = [];
  // The server's copy, changed by each call as the server would.
  const entries = listed.map((entry) => ({ ...entry }));
  const keep = (next: VaultEntry) => {
    entries[entries.findIndex((e) => e.entryId === next.entryId)] = next;
    return next;
  };
  const actions: VaultActions = {
    list: async () => entries.map((entry) => ({ ...entry })),
    cutOff: async (entryId, clientId) => {
      calls.push(["cut", entryId, clientId]);
      const entry = entries.find((e) => e.entryId === entryId)!;
      const clients = clientId === undefined ? [] : entry.proxy!.clients.filter((c) => c.id !== clientId);
      return keep({ ...entry, proxy: { ...entry.proxy!, clients, waiting: 0 } });
    },
    allow: async (entryId, clientId) => {
      calls.push(["allow", entryId, clientId]);
      const entry = entries.find((e) => e.entryId === entryId)!;
      const refusal = entry.proxy!.refused.find((no) => no.id === clientId)!;
      return keep({ ...entry, proxy: { ...entry.proxy!, clients: [...entry.proxy!.clients, refusal], refused: [] } });
    },
    link: async (kind, entryId) => {
      calls.push(["link", kind, entryId]);
      return `tok-${kind}`;
    },
    calls: {
      describe: async (token) => {
        calls.push(["describe", token]);
        const workspace = { handle: "seyi", name: "Seyi", kind: "personal" as const };
        if (token === "tok-add") return { kind: "add", workspace, grantee: null, entry: null, expiresAt: 1 };
        const fields = [{ name: "API_KEY", perEnv: false, set: ["_"] }];
        return { kind: "view", workspace, grantee: null, entry: { type: "secret", name: "Shown", sites: [], fields }, expiresAt: 1 };
      },
      save: async (token, draft) => {
        calls.push(["save", token, draft.name]);
        entries.push({ ...unpinned, entryId: "v000000000000000000000009", name: draft.name, savedAt: NOW.getTime() });
        return { name: draft.name, site: "" };
      },
      reveal: async (token) => {
        calls.push(["reveal", token]);
        return { type: "secret", name: "Shown", sites: [], username: "", password: "", fields: [{ name: "API_KEY", perEnv: false, values: { _: "fake-value-123" } }] };
      },
    },
  };
  return { actions, calls };
}

describe("side by side, as the board draws it", () => {
  test("the first key is picked, with its website, its AIs and its last use", async () => {
    const { actions } = fakes([pinned, waiting, login]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    expect(find("vault-count")?.textContent).toBe("2 keys · 1 login");
    expect(find(`vault-pill-${pinned.entryId}`)?.textContent).toBe("used 4 min ago");
    expect(find(`vault-pill-${waiting.entryId}`)?.textContent).toBe("1 AI waiting for you");
    expect(find(`vault-detail-${pinned.entryId}`)).not.toBeNull();
    expect(find("vault-site")?.textContent).toBe("api.example.comas a sign-in header");
    expect(container.textContent).toContain("You said yes 16 Oct · used 31 times");
    expect(container.textContent).toContain("You said no 15 Oct");
    expect(find("vault-last-used")?.textContent).toBe("Claude Code read your customers, 4 minutes ago.");
    press(`vault-row-${login.entryId}`);
    expect(find(`vault-detail-${login.entryId}`)?.textContent).toContain("bank.example.test");
  });

  test("the filter chips narrow the list", async () => {
    const { actions } = fakes([pinned, unpinned, login]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    press("vault-filter-logins");
    expect(find(`vault-row-${pinned.entryId}`)).toBeNull();
    expect(find(`vault-row-${login.entryId}`)).not.toBeNull();
    expect(find(`vault-detail-${login.entryId}`)).not.toBeNull();
    press("vault-filter-ai");
    expect(find(`vault-row-${login.entryId}`)).toBeNull();
    expect(find(`vault-row-${unpinned.entryId}`)).toBeNull();
  });

  test("Cut off removes one AI, Cut off every AI removes them all, Allow lets a refused one in", async () => {
    const { actions, calls } = fakes([pinned]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    press("vault-cut-client-a");
    await flush();
    expect(calls).toContainEqual(["cut", pinned.entryId, "client-a"]);
    expect(find("vault-cut-client-a")).toBeNull();
    expect(find("vault-cut-client-b")).not.toBeNull();
    press("vault-allow-client-c");
    await flush();
    expect(calls).toContainEqual(["allow", pinned.entryId, "client-c"]);
    expect(find("vault-allow-client-c")).toBeNull();
    expect(find("vault-cut-client-c")).not.toBeNull();
    press(`vault-cut-all-${pinned.entryId}`);
    await flush();
    expect(calls).toContainEqual(["cut", pinned.entryId, undefined]);
    expect(find("vault-cut-client-b")).toBeNull();
    expect(container.textContent).toContain("No AI yet");
  });
});

describe("on a narrow screen", () => {
  test("the list comes first; a key opens in its place, with a way back", async () => {
    const { actions } = fakes([pinned, unpinned]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW })));
    await flush();
    expect(find(`vault-detail-${pinned.entryId}`)).toBeNull();
    press(`vault-row-${pinned.entryId}`);
    expect(find(`vault-detail-${pinned.entryId}`)).not.toBeNull();
    expect(find(`vault-row-${unpinned.entryId}`)).toBeNull();
    press("vault-back");
    expect(find(`vault-row-${unpinned.entryId}`)).not.toBeNull();
  });

  test("New key opens its form in place, and a save picks the new key", async () => {
    const { actions, calls } = fakes([unpinned]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW })));
    await flush();
    press("vault-new");
    await flush();
    await flush();
    expect(find("vault-inline-add")).not.toBeNull();
    expect(find(`vault-row-${unpinned.entryId}`)).toBeNull();
    expect(calls).toEqual([
      ["link", "add", undefined],
      ["describe", "tok-add"],
    ]);
    press("vault-inline-cancel");
    expect(find("vault-inline-add")).toBeNull();
    expect(find(`vault-row-${unpinned.entryId}`)).not.toBeNull();

    press("vault-new");
    await flush();
    await flush();
    type("vault-name", "Fresh bank");
    type("vault-site", "fresh.example.test");
    type("vault-username", "me@example.test");
    type("vault-password", "fake-password-1");
    press("vault-save");
    await flush();
    await flush();
    expect(calls).toContainEqual(["save", "tok-add", "Fresh bank"]);
    expect(find("vault-inline-add")).toBeNull();
    expect(find("vault-detail-v000000000000000000000009")?.textContent).toContain("Fresh bank");
  });

  test("Show the key reveals its values under the key, and Hide drops them", async () => {
    const { actions, calls } = fakes([unpinned]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    expect(container.textContent).not.toContain("AIs that can use it");
    press(`vault-show-${unpinned.entryId}`);
    await flush();
    await flush();
    expect(calls).toEqual([
      ["link", "view", unpinned.entryId],
      ["describe", "tok-view"],
      ["reveal", "tok-view"],
    ]);
    expect(find("vault-inline-view")?.textContent).toContain("fake-value-123");
    expect(find(`vault-show-${unpinned.entryId}`)?.textContent).toBe("Hide the key");
    expect(find("vault-view-hide")).toBeNull();
    press(`vault-show-${unpinned.entryId}`);
    expect(find("vault-inline-view")).toBeNull();
    expect(container.textContent).not.toContain("fake-value-123");
  });

  test("picking another key closes the one shown, values and all", async () => {
    const { actions } = fakes([unpinned, login]);
    act(() => root.render(createElement(VaultList, { actions, now: NOW, layoutWidth: 1100 })));
    await flush();
    press(`vault-show-${unpinned.entryId}`);
    await flush();
    await flush();
    expect(container.textContent).toContain("fake-value-123");
    press(`vault-row-${login.entryId}`);
    expect(container.textContent).not.toContain("fake-value-123");
    press(`vault-row-${unpinned.entryId}`);
    expect(container.textContent).not.toContain("fake-value-123");
    expect(find(`vault-show-${unpinned.entryId}`)?.textContent).toBe("Show the key");
  });

  test("a refusal is said in the server's words", async () => {
    const actions: VaultActions = {
      list: async () => [],
      cutOff: async () => {
        throw new Error("unused");
      },
      allow: async () => {
        throw new Error("unused");
      },
      link: async () => {
        throw Object.assign(new Error("x"), { data: { code: "FORBIDDEN", message: "Editors and owners add keys here." } });
      },
      calls: {
        describe: async () => {
          throw new Error("unused");
        },
        save: async () => {
          throw new Error("unused");
        },
        reveal: async () => {
          throw new Error("unused");
        },
      },
    };
    act(() => root.render(createElement(VaultList, { actions })));
    await flush();
    expect(container.textContent).toContain("No keys yet");
    press("vault-new");
    await flush();
    expect(container.textContent).toContain("Editors and owners add keys here.");
  });

  test("with no workspace client it draws its heading and says so", () => {
    act(() => root.render(createElement(VaultPanel, { sectioned: true, workspaceId: null })));
    expect(container.textContent).toContain("Vault");
    expect(container.textContent).toContain("No workspace is open.");
  });
});
