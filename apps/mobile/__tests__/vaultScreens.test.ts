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
import {
  resolveVaultLinkView,
  type Described,
  type Outcome,
  type RevealedEntry,
  type VaultRequest,
} from "../features/vault/vaultLink";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `/vault/<token>` on the glass: the secret form sends what was typed in the
 * backend's shape, and the view page shows a value only after Reveal and
 * never puts one where the DOM's names live — an accessible name, a test id,
 * a title — because a click breadcrumb and a replay's attribute list are
 * built from exactly those. `vaultLink.test.ts` and `vaultFields.test.ts`
 * prove the rules; this proves the screens use them.
 */

const personal = { handle: "ada", name: "Ada", kind: "personal" as const };
const stripe = {
  type: "secret" as const,
  name: "Stripe",
  sites: ["dashboard.stripe.com"],
  fields: [
    { name: "STRIPE_SECRET_KEY", perEnv: true, set: ["dev", "prod"] },
    { name: "Account id", perEnv: false, set: ["_"] },
  ],
};
const REVEALED: RevealedEntry = {
  type: "secret",
  name: "Stripe",
  sites: ["dashboard.stripe.com"],
  username: "",
  password: "",
  fields: [
    { name: "STRIPE_SECRET_KEY", perEnv: true, values: { dev: "sk_test_fake_dev_111", prod: "sk_test_fake_prod_999" } },
    { name: "Account id", perEnv: false, values: { _: "acct_fake_42" } },
  ],
};
const VALUES = ["sk_test_fake_dev_111", "sk_test_fake_prod_999", "acct_fake_42"];

const add: VaultRequest = { kind: "add", workspace: personal, grantee: null, entry: null, expiresAt: 1 };
const viewLink: VaultRequest = { kind: "view", workspace: personal, grantee: null, entry: stripe, expiresAt: 1 };

let container: HTMLDivElement;
let root: Root;
let copied: string[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(
  request: VaultRequest,
  outcome: Outcome,
  handlers: { onSave?: (draft: VaultDraft) => Promise<boolean>; onReveal?: () => void } = {},
  prefill = {},
) {
  const described: Described = { kind: "shown", request };
  const view = resolveVaultLinkView({ token: "tok", auth: { isLoading: false, isAuthenticated: true }, prefill, described, outcome });
  act(() =>
    root.render(
      createElement(VaultLinkBody, {
        view,
        onSave: handlers.onSave ?? (async () => true),
        onShare: () => {},
        onReveal: handlers.onReveal ?? (() => {}),
        onDecline: () => {},
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
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Every attribute value in the page, which is where a name ends up and a value must not. */
function attributeText(): string {
  return [...container.querySelectorAll("*")]
    .flatMap((el) => [...el.attributes].filter((attr) => attr.name !== "value" && attr.name !== "style").map((attr) => attr.value))
    .join("\n");
}

describe("the secret form", () => {
  test("a secret link opens on Secret with the agent's fields, per environment", () => {
    render(add, { kind: "idle" }, {}, { type: "secret", name: "Stripe", fields: "STRIPE_SECRET_KEY,WEBHOOK_SECRET" });
    expect(container.textContent).toContain("Save your Stripe keys");
    expect(find("vault-type-secret")?.getAttribute("aria-checked")).toBe("true");
    expect((find("vault-field-0-name") as HTMLInputElement).value).toBe("STRIPE_SECRET_KEY");
    expect(find("vault-field-1-prod")).not.toBeNull();
    expect(find("vault-username")).toBeNull();
  });

  test("Save waits for a value, then sends names and only the values typed", async () => {
    const saved: VaultDraft[] = [];
    render(add, { kind: "idle" }, { onSave: async (draft) => (saved.push(draft), true) }, { type: "secret", name: "Stripe", fields: "STRIPE_SECRET_KEY" });
    expect(find("vault-save")?.getAttribute("aria-disabled")).toBe("true");
    type("vault-field-0-prod", "sk_test_fake_prod_999");
    press("vault-field-add");
    type("vault-field-1-name", "Account id");
    press("vault-field-1-envs");
    type("vault-field-1-value", "acct_fake_42");
    press("vault-save");
    await flush();
    expect(saved).toEqual([
      {
        type: "secret",
        name: "Stripe",
        site: "",
        username: "",
        password: "",
        fields: [
          { name: "STRIPE_SECRET_KEY", perEnv: true, values: { prod: "sk_test_fake_prod_999" } },
          { name: "Account id", perEnv: false, values: { _: "acct_fake_42" } },
        ],
      },
    ]);
  });

  test("a repeated field name is said beside the row and holds Save", () => {
    render(add, { kind: "idle" }, {}, { type: "secret", name: "Stripe", fields: "KEY" });
    type("vault-field-0-dev", "v");
    press("vault-field-add");
    type("vault-field-1-name", "key");
    expect(container.textContent).toContain("KEY is already a field.");
    expect(find("vault-save")?.getAttribute("aria-disabled")).toBe("true");
  });

  test("pasting a .env fills the chosen environment and drops the pasted text", () => {
    render(add, { kind: "idle" }, {}, { type: "secret", name: "Stripe", fields: "STRIPE_SECRET_KEY" });
    press("vault-dotenv-open");
    press("vault-dotenv-env-staging");
    type("vault-dotenv-text", "export STRIPE_SECRET_KEY=sk_test_fake_staging\nNEW_ONE='n v'\nnot a line");
    press("vault-dotenv-fill");
    expect((find("vault-field-0-staging") as HTMLInputElement).value).toBe("sk_test_fake_staging");
    expect((find("vault-field-1-staging") as HTMLInputElement).value).toBe("n v");
    expect(find("vault-dotenv-text")).toBeNull();
    expect(find("vault-dotenv-said")?.textContent).toBe("Filled 2 values for staging. 1 line was left out.");
  });

  test("values are secure inputs, and no value reaches an attribute", () => {
    render(add, { kind: "idle" }, {}, { type: "secret", name: "Stripe", fields: "STRIPE_SECRET_KEY" });
    type("vault-field-0-prod", "sk_test_fake_prod_999");
    expect(find("vault-field-0-prod")?.getAttribute("type")).toBe("password");
    expect(find("vault-field-0-prod")?.getAttribute("aria-label")).toBe("STRIPE_SECRET_KEY for prod, value");
    expect(attributeText()).not.toContain("sk_test_fake_prod_999");
    press("vault-field-0-prod-reveal");
    expect(find("vault-field-0-prod")?.getAttribute("type")).not.toBe("password");
  });

  test("a login keeps today's form, with fields of its own on request", async () => {
    const saved: VaultDraft[] = [];
    render(add, { kind: "idle" }, { onSave: async (draft) => (saved.push(draft), true) }, { name: "Netflix", site: "netflix.com" });
    expect(container.textContent).toContain("Save your Netflix login");
    type("vault-password", "correct-horse-fake");
    press("vault-field-add");
    expect(find("vault-field-0-value")).not.toBeNull();
    type("vault-field-0-name", "PIN");
    type("vault-field-0-value", "0000");
    press("vault-save");
    await flush();
    expect(saved[0]).toMatchObject({
      type: "login",
      site: "netflix.com",
      password: "correct-horse-fake",
      fields: [{ name: "PIN", perEnv: false, values: { _: "0000" } }],
    });
  });
});

describe("the view page", () => {
  test("names the fields and where they are set, and shows no value before Reveal", () => {
    let revealed = 0;
    render(viewLink, { kind: "idle" }, { onReveal: () => revealed++ });
    const text = container.textContent ?? "";
    expect(text).toContain("STRIPE_SECRET_KEY");
    expect(text).toContain("dashboard.stripe.com");
    for (const value of VALUES) expect(container.innerHTML).not.toContain(value);
    expect(find("vault-view-field-0-hidden")).not.toBeNull();
    press("vault-view-env-staging");
    expect(find("vault-view-field-0-missing")?.textContent).toBe("Not set for staging");
    press("vault-view-reveal");
    expect(revealed).toBe(1);
  });

  test("revealed: values in text only, per environment, never in an attribute", () => {
    render(viewLink, { kind: "revealed", entry: REVEALED });
    expect(find("vault-view-field-0-value")?.textContent).toBe("sk_test_fake_dev_111");
    press("vault-view-env-prod");
    expect(find("vault-view-field-0-value")?.textContent).toBe("sk_test_fake_prod_999");
    expect(find("vault-view-field-1-value")?.textContent).toBe("acct_fake_42");
    expect(find("vault-view-field-0-copy")?.getAttribute("aria-label")).toBe("Copy STRIPE_SECRET_KEY for prod");
    const attributes = attributeText();
    for (const value of VALUES) expect(attributes).not.toContain(value);
  });

  test("Copy writes one value; Copy as .env writes that environment", async () => {
    render(viewLink, { kind: "revealed", entry: REVEALED });
    press("vault-view-env-prod");
    press("vault-view-field-0-copy");
    await flush();
    press("vault-view-dotenv");
    await flush();
    expect(copied).toEqual([
      "sk_test_fake_prod_999",
      "# Stripe (prod)\nSTRIPE_SECRET_KEY=sk_test_fake_prod_999\nACCOUNT_ID=acct_fake_42\n",
    ]);
    expect(find("vault-view-dotenv")?.textContent).toBe("Copied");
  });

  test("Hide covers the values again without asking twice", () => {
    let revealed = 0;
    render(viewLink, { kind: "revealed", entry: REVEALED }, { onReveal: () => revealed++ });
    press("vault-view-hide");
    for (const value of VALUES) expect(container.innerHTML).not.toContain(value);
    press("vault-view-reveal");
    expect(revealed).toBe(0);
    expect(find("vault-view-field-0-value")).not.toBeNull();
  });

  test("a login shows its username and password behind the same Reveal", () => {
    const login: VaultRequest = {
      ...viewLink,
      entry: { type: "login", name: "Netflix", sites: ["netflix.com"], fields: [] },
    };
    render(login, { kind: "idle" });
    expect(container.textContent).toContain("Username");
    expect(container.innerHTML).not.toContain("correct-horse-fake");
    render(login, {
      kind: "revealed",
      entry: { type: "login", name: "Netflix", sites: ["netflix.com"], username: "ada@example.com", password: "correct-horse-fake", fields: [] },
    });
    expect(find("vault-view-password-value")?.textContent).toBe("correct-horse-fake");
    expect(find("vault-view-dotenv")).toBeNull();
    expect(attributeText()).not.toContain("correct-horse-fake");
  });
});
