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
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));

import { VaultLinkBody } from "../features/vault/VaultLinkScreen";
import type { VaultDraft } from "../features/vault/VaultAddForm";
import { parseVaultPrefill, resolveVaultLinkView, type Described, type VaultRequest } from "../features/vault/vaultLink";
import { CARD_EMPTY, cardBlocker, cardDraft, cardLabel, groupCardNumber, groupExpiry, luhnOk } from "../features/vault/vaultCard";
import { vaultCountLine, vaultRowLine, type VaultEntry } from "../features/vault/vaultSettings";
import { editBetween } from "../features/vault/VaultKeyEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Cards on the vault's add link and in Settings: the form sends the card
 * whole in the control plane's shape and nothing else, the number and code
 * are secure inputs that never reach an attribute, and a list names a card
 * by brand, last four and expiry. The control plane checks the card again
 * (`apps/convex/__tests__/vaultCards.test.ts`); this proves the app's side.
 */

// The card networks' published test numbers: never a real card.
const VISA = "4242424242424242";
const AMEX = "378282246310005";
const NOW = new Date(Date.UTC(2026, 9, 21));
const personal = { handle: "ada", name: "Ada", kind: "personal" as const };
const add: VaultRequest = { kind: "add", workspace: personal, grantee: null, entry: null, expiresAt: 1 };

describe("checking a card before Save", () => {
  test("the number is grouped as typed, Amex as 4-6-5", () => {
    expect(groupCardNumber("42424242 4242-4242")).toBe("4242 4242 4242 4242");
    expect(groupCardNumber(AMEX)).toBe("3782 822463 10005");
    expect(groupCardNumber("4242424242424242424242")).toBe("4242 4242 4242 4242 424");
  });

  test("the expiry becomes MM/YY as digits are typed", () => {
    expect(groupExpiry("0")).toBe("0");
    expect(groupExpiry("08")).toBe("08");
    expect(groupExpiry("082")).toBe("08/2");
    expect(groupExpiry("0829")).toBe("08/29");
    expect(groupExpiry("08/")).toBe("08/");
    expect(groupExpiry("8/29")).toBe("8/29");
  });

  test("a card that won't save says why, one thing at a time", () => {
    const card = { ...CARD_EMPTY, number: VISA, expiry: "08/29", cvc: "737" };
    expect(cardBlocker(card, NOW)).toBeNull();
    expect(cardBlocker({ ...card, number: "" }, NOW)).toBe("To save, enter the card number.");
    expect(cardBlocker({ ...card, number: "4242424242424241" }, NOW)).toBe("Check the card number.");
    expect(cardBlocker({ ...card, expiry: "13/29" }, NOW)).toBe("Enter the expiry as MM/YY.");
    expect(cardBlocker({ ...card, expiry: "09/26" }, NOW)).toBe("This card has expired.");
    expect(cardBlocker({ ...card, expiry: "10/26" }, NOW)).toBeNull();
    expect(cardBlocker({ ...card, cvc: "73" }, NOW)).toBe("The security code is 3 digits.");
    expect(cardBlocker({ ...card, number: AMEX, cvc: "737" }, NOW)).toBe("An Amex security code is 4 digits.");
    expect(luhnOk(VISA)).toBe(true);
  });

  test("the draft is digits only, with the year in full and blanks left out", () => {
    expect(cardDraft({ ...CARD_EMPTY, number: "4242 4242 4242 4242", expiry: "08/29", cvc: "737" }, NOW)).toEqual({
      number: VISA,
      expMonth: "8",
      expYear: "2029",
      cvc: "737",
    });
    expect(cardDraft({ ...CARD_EMPTY, number: "4242", expiry: "08/29", cvc: "737" }, NOW)).toBeNull();
  });

  test("a card is named the way Tex is told about it", () => {
    expect(cardLabel({ brand: "visa", last4: "4242", expMonth: "08", expYear: "2029" })).toBe("Visa ••4242, expires 08/29");
    expect(cardLabel(undefined)).toBe("Card");
  });
});

describe("the add form", () => {
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

  function render(onSave: (draft: VaultDraft) => Promise<boolean>, prefill = {}) {
    const described: Described = { kind: "shown", request: add };
    const view = resolveVaultLinkView({ token: "tok", auth: { isLoading: false, isAuthenticated: true }, prefill, described, outcome: { kind: "idle" } });
    act(() =>
      root.render(
        createElement(VaultLinkBody, { view, onSave, onShare: () => {}, onReveal: () => {}, onDecline: () => {}, onSwitchAccount: () => {} }),
      ),
    );
  }
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const press = (id: string) => act(() => find(id)!.click());
  function type(id: string, text: string) {
    const field = find(id) as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const attributes = () =>
    [...container.querySelectorAll("*")]
      .flatMap((el) => [...el.attributes].filter((attr) => attr.name !== "value" && attr.name !== "style").map((attr) => attr.value))
      .join("\n");

  test("a card link opens on Card, sends the card alone, and keeps the number out of every attribute", async () => {
    const saved: VaultDraft[] = [];
    render(async (draft) => (saved.push(draft), true), { type: "card", name: "Team Visa" });
    expect(container.textContent).toContain("Save your Team Visa card");
    expect(find("vault-type-card")?.getAttribute("aria-checked")).toBe("true");
    expect(find("vault-username")).toBeNull();
    expect(find("vault-field-add")).toBeNull();
    expect(find("vault-save")?.getAttribute("aria-disabled")).toBe("true");
    expect(find("vault-save-why")?.textContent).toBe("To save, enter the card number.");

    type("vault-card-number", "4242424242424242");
    expect((find("vault-card-number") as HTMLInputElement).value).toBe("4242 4242 4242 4242");
    expect((find("vault-card-number") as HTMLInputElement).type).toBe("password");
    type("vault-card-expiry", "0899");
    type("vault-card-cvc", "737");
    expect((find("vault-card-cvc") as HTMLInputElement).type).toBe("password");
    type("vault-card-postal", "94110");
    expect(attributes().includes("4242 4242")).toBe(false);
    expect(attributes().includes("737")).toBe(false);
    press("vault-save");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(saved).toEqual([
      {
        type: "card",
        name: "Team Visa",
        site: "",
        username: "",
        password: "",
        fields: [],
        card: { number: VISA, expMonth: "8", expYear: "2099", cvc: "737", postalCode: "94110" },
      },
    ]);
  });

  test("the agent's link can ask for a card, and nothing else it says changes the kind", () => {
    expect(parseVaultPrefill({ type: "card" }).type).toBe("card");
    expect(parseVaultPrefill({ type: "Card " }).type).toBe("card");
    expect(parseVaultPrefill({ type: "cards" }).type).toBe("login");
  });
});

describe("a card in Settings", () => {
  const entry: VaultEntry = {
    entryId: "v0",
    type: "card",
    name: "Team Visa",
    sites: [],
    envs: [],
    card: { brand: "visa", last4: "4242", expMonth: "08", expYear: "2029" },
    shared: false,
    proxy: null,
    savedAt: 1,
    savedByYou: true,
  };

  test("its row names the card and where it pays, never the number", () => {
    expect(vaultRowLine(entry)).toBe("Visa ••4242, expires 08/29 · any checkout, asks you each time");
    expect(vaultRowLine({ ...entry, sites: ["shop.example"] })).toBe("Visa ••4242, expires 08/29 · pays on shop.example, asks you each time");
    expect(vaultCountLine([entry])).toBe("1 card");
    expect(vaultCountLine([entry, { ...entry, type: "secret" }])).toBe("1 key · 1 card");
  });

  test("an edit of a card sends its name and site only", () => {
    const before = { name: "Team Visa", site: "", username: "", password: "", fields: [], proxy: { on: false } } as never;
    const after = { name: "Ops Visa", site: "shop.example", username: "x", password: "y", fields: [{ name: "number", perEnv: false, values: { _: "1" } }], proxy: { on: false } } as never;
    expect(editBetween(entry, before, after)).toEqual({ name: "Ops Visa", site: "shop.example" });
  });
});
