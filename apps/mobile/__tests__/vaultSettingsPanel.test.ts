/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

jest.mock("convex/react", () => ({ useConvex: () => undefined }));

import { VaultList, VaultPanel, type VaultActions } from "../features/console/settings/panels/VaultPanel";
import { vaultClientLine, vaultNoClientsLine, vaultPinLine, vaultRowLine, type VaultEntry } from "../features/vault/vaultSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Settings › Vault (vault board 2): names, the one website, the AIs a person
 * said yes to, and Cut off. The page is handed names only, so these prove
 * the words and that each button asks the server for the right thing.
 */

const JUNE = Date.UTC(2026, 5, 3, 12);
const pinned: VaultEntry = {
  entryId: "v000000000000000000000001",
  type: "secret",
  name: "Payments",
  sites: [],
  envs: ["dev", "prod"],
  shared: false,
  proxy: {
    host: "api.example.com",
    style: "bearer",
    name: null,
    ask: true,
    clients: [
      { id: "client-a", name: "Claude", at: JUNE },
      { id: "client-b", name: null, at: JUNE },
    ],
  },
};
const unpinned: VaultEntry = { ...pinned, entryId: "v000000000000000000000002", name: "Bank notes", envs: [], proxy: null };
const login: VaultEntry = { ...unpinned, entryId: "v000000000000000000000003", type: "login", name: "Bank", sites: ["bank.example.test"] };

describe("the words", () => {
  test("a row says where the key goes, or why no AI uses it", () => {
    expect(vaultRowLine(pinned)).toBe("Only to api.example.com · dev, prod");
    expect(vaultRowLine({ ...pinned, envs: [] })).toBe("Only to api.example.com");
    expect(vaultRowLine(unpinned)).toBe("Not given to AIs · you copy it yourself");
    expect(vaultRowLine(login)).toBe("Login · Tex fills it on bank.example.test");
  });

  test("the detail names the website and how the key is sent", () => {
    expect(vaultPinLine(pinned.proxy!)).toBe("Only ever sent to api.example.com as a sign-in header.");
    expect(vaultPinLine({ ...pinned.proxy!, style: "header", name: "x-api-key" })).toMatch(/the x-api-key header/);
    expect(vaultPinLine({ ...pinned.proxy!, style: "query", name: "key" })).toMatch(/\?key= in the address/);
  });

  test("an AI is named with the day of the yes, and nobody yet reads by the ask", () => {
    expect(vaultClientLine(pinned.proxy!.clients[0], new Date(Date.UTC(2026, 9, 1)))).toBe("Claude · You said yes Jun 3");
    expect(vaultClientLine(pinned.proxy!.clients[1], new Date(Date.UTC(2027, 9, 1)))).toBe("An AI · You said yes Jun 3, 2026");
    expect(vaultNoClientsLine(pinned.proxy!)).toMatch(/you'll be asked/);
    expect(vaultNoClientsLine({ ...pinned.proxy!, ask: false })).toMatch(/without asking/);
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
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function fakes(entries: VaultEntry[]) {
  const calls: unknown[][] = [];
  const actions: VaultActions = {
    list: async () => entries,
    cutOff: async (entryId, clientId) => {
      calls.push(["cut", entryId, clientId]);
      const entry = entries.find((e) => e.entryId === entryId)!;
      const clients = clientId === undefined ? [] : entry.proxy!.clients.filter((c) => c.id !== clientId);
      return { ...entry, proxy: { ...entry.proxy!, clients } };
    },
    link: async (kind, entryId) => void calls.push(["link", kind, entryId]),
  };
  return { actions, calls };
}

describe("the list", () => {
  test("lists keys by name and opens one to its AIs", async () => {
    const { actions } = fakes([pinned, unpinned]);
    act(() => root.render(createElement(VaultList, { actions })));
    await flush();
    expect(container.textContent).toContain("2 keys");
    expect(container.textContent).toContain("Only to api.example.com · dev, prod");
    expect(container.textContent).not.toContain("AIs that can use it");
    press(`vault-row-${pinned.entryId}`);
    expect(container.textContent).toContain("AIs that can use it");
    expect(container.textContent).toContain("Claude · You said yes");
  });

  test("Cut off removes one AI, Cut off every AI removes them all", async () => {
    const { actions, calls } = fakes([pinned]);
    act(() => root.render(createElement(VaultList, { actions })));
    await flush();
    press(`vault-row-${pinned.entryId}`);
    press("vault-cut-client-a");
    await flush();
    expect(calls).toContainEqual(["cut", pinned.entryId, "client-a"]);
    expect(find("vault-cut-client-a")).toBeNull();
    expect(find("vault-cut-client-b")).not.toBeNull();
    press(`vault-cut-all-${pinned.entryId}`);
    await flush();
    expect(calls).toContainEqual(["cut", pinned.entryId, undefined]);
    expect(find("vault-cut-client-b")).toBeNull();
    expect(container.textContent).toContain("No AI yet");
  });

  test("New key and Show the key ask for a fresh link", async () => {
    const { actions, calls } = fakes([unpinned]);
    act(() => root.render(createElement(VaultList, { actions })));
    await flush();
    press("vault-new");
    await flush();
    press(`vault-row-${unpinned.entryId}`);
    expect(container.textContent).not.toContain("AIs that can use it");
    press(`vault-show-${unpinned.entryId}`);
    await flush();
    expect(calls).toEqual([
      ["link", "add", undefined],
      ["link", "view", unpinned.entryId],
    ]);
  });

  test("a refusal is said in the server's words", async () => {
    const actions: VaultActions = {
      list: async () => [],
      cutOff: async () => {
        throw new Error("unused");
      },
      link: async () => {
        throw Object.assign(new Error("x"), { data: { code: "FORBIDDEN", message: "Editors and owners add keys here." } });
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
