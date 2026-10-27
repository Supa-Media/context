import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";
import { memoryS3 } from "./storeStub.helpers";
import { FAKE_STORAGE, asUser, captureError, createUser, createWorkspace, errorCode, setupTest } from "./fixtures.helpers";

/**
 * CARDS (the owner, 2026-10-21: "add cards to the vault"). A card is saved
 * whole and checked, sealed like any key; what anyone is shown of it outside
 * its own view page is brand, last four and expiry. Its details are never
 * edited piecemeal: an edit to them is refused, and a new card is saved.
 *
 * Sabotage: `normalizeCard` skipped in `saveVaultLogin` → "a number that
 * fails its check digit saves nothing"; the card guard in `vaultEdit.ts`
 * dropped → "a card's details can't be edited".
 */

type T = ReturnType<typeof setupTest>;
// The card networks' published test number: never a real card.
const NUMBER = "4242424242424242";
const CARD = { number: "4242 4242 4242 4242", expMonth: "8", expYear: "2099", cvc: "737", name: "Ada Lovelace", postalCode: "94110" };

afterEach(() => vi.unstubAllGlobals());

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.test");
  const team = await createWorkspace(t, seyi, "team-cards", { kind: "shared" });
  const backend = memoryS3(FAKE_STORAGE.bucket);
  vi.stubGlobal("fetch", backend.fetchImpl);
  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId: team });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId: team,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: seyi,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, seyi, team, backend };
}
type World = Awaited<ReturnType<typeof world>>;

async function issue(t: T, args: { workspaceId: Id<"workspaces">; userId: Id<"users">; kind: "add" | "view"; entryId?: string }) {
  const token = "tok-" + Math.random();
  await t.mutation(internal.functions.vault.issueVaultRequest, { ...args, hashedToken: await hashToken(token) });
  return token;
}

async function saveCard(w: World, card: Record<string, string> = CARD, extra: Record<string, unknown> = {}) {
  const token = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
  return asUser(w.t, w.seyi).action(api.functions.vault.saveVaultLogin, { token, type: "card", name: "Work Visa", site: "", card, ...extra } as never);
}

/**
 * Whether `text` holds `plain` as a value of its own. Ciphertext and ids are
 * long runs of hex, base64 or base64url characters, and those hold a short
 * digit string like "737" or "4242" by chance; a stored or shown card field
 * stands apart from them, behind a quote, a space, a colon or an `=`.
 */
function holdsValue(text: string, plain: string): boolean {
  const literal = plain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9+/_-])${literal}(?![A-Za-z0-9+/=_-])`).test(text);
}

/** Every form a card's details could take in plain text. */
const PLAIN = [NUMBER, CARD.number, CARD.number.replaceAll(" ", "-"), CARD.cvc, CARD.name, CARD.postalCode, "4242"];

const vaultKeys = (w: World) => [...w.backend.objects.keys()].filter((key) => key.startsWith(".context/vault/"));
const entryIdOf = (w: World) => /(v[0-9a-f]{24})\.json$/.exec(vaultKeys(w)[0])![1];

describe("a card", () => {
  test("is saved sealed as its fixed fields, and listed by brand, last four and expiry only", async () => {
    const w = await world();
    expect(await saveCard(w)).toEqual({ name: "Work Visa", site: "" });
    expect(vaultKeys(w)).toHaveLength(1);
    const raw = JSON.stringify(w.backend.snapshot());
    for (const plain of PLAIN) expect(holdsValue(raw, plain), plain).toBe(false);

    const listed = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ type: "card", name: "Work Visa", sites: [], card: { brand: "visa", last4: "4242", expMonth: "08", expYear: "2099" } });
    const shown = JSON.stringify(listed);
    for (const plain of [NUMBER, CARD.number, CARD.cvc, CARD.name, CARD.postalCode]) expect(holdsValue(shown, plain), plain).toBe(false);
  });

  test("the plain-text check finds a card field however it is written, and never inside an id or ciphertext", () => {
    const stored = JSON.stringify({ cvc: CARD.cvc, number: CARD.number, name: CARD.name, postalCode: CARD.postalCode });
    for (const text of [stored, JSON.stringify({ body: stored }), `cvc=${CARD.cvc}&zip=${CARD.postalCode}`, `last four ${"4242"}`]) {
      expect(PLAIN.some((plain) => holdsValue(text, plain)), text).toBe(true);
    }
    expect(PLAIN.some((plain) => holdsValue(JSON.stringify({ number: CARD.number.replaceAll(" ", "-") }), plain))).toBe(true);
    for (const text of ["v0a7374242c9e1f00b2d3a4b5", "nP737q4242+x/94110Z==", "k-737_4242", "AdaLovelace737"]) {
      expect(PLAIN.some((plain) => holdsValue(text, plain)), text).toBe(false);
    }
  });

  test("shows its details only on its own view page", async () => {
    const w = await world();
    await saveCard(w);
    const token = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "view", entryId: entryIdOf(w) });
    const described = await asUser(w.t, w.seyi).action(api.functions.vault.describeVaultRequest, { token });
    expect(described.entry?.type).toBe("card");
    expect(JSON.stringify(described).includes(NUMBER)).toBe(false);
    const shown = await asUser(w.t, w.seyi).action(api.functions.vault.revealVaultEntry, { token });
    expect(shown.type).toBe("card");
    expect(Object.fromEntries(shown.fields.map((field) => [field.name, field.values._]))).toEqual({
      number: NUMBER,
      exp_month: "08",
      exp_year: "2099",
      cvc: "737",
      name: "Ada Lovelace",
      postal_code: "94110",
    });
  });

  test.each([
    [{ ...CARD, number: "4242 4242 4242 4241" }, /card number/],
    [{ ...CARD, expYear: "2001" }, /expired/],
    [{ ...CARD, cvc: "12" }, /security code/],
  ])("a card that doesn't check out saves nothing: %j", async (card, words) => {
    const w = await world();
    const error = await captureError(() => saveCard(w, card));
    expect(errorCode(error)).toBe("INVALID_ARGUMENT");
    expect(String((error as { data?: { message?: string } }).data?.message ?? error)).toMatch(words);
    expect(vaultKeys(w)).toHaveLength(0);
  });

  test("has only its own details: no fields, login or AI pin ride along, and a card type needs a card", async () => {
    const w = await world();
    for (const extra of [{ fields: [{ name: "K", perEnv: false, values: { _: "1" } }] }, { password: "fake-password-1" }, { proxy: { host: "api.example.com", style: "bearer", ask: true } }]) {
      expect(errorCode(await captureError(() => saveCard(w, CARD, extra)))).toBe("INVALID_ARGUMENT");
    }
    const token = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
    expect(errorCode(await captureError(() => asUser(w.t, w.seyi).action(api.functions.vault.saveVaultLogin, { token, type: "card", name: "X", site: "" })))).toBe("INVALID_ARGUMENT");
    expect(vaultKeys(w)).toHaveLength(0);
  });

  test("can be renamed and kept to one site, but its details can't be edited", async () => {
    const w = await world();
    await saveCard(w);
    const view = async () => issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "view", entryId: entryIdOf(w) });
    const renamed = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.editVaultEntry, { token: await view(), name: "Team card", site: "shop.example" });
    expect(renamed.changed).toEqual(["name", "site"]);
    const error = await captureError(async () =>
      asUser(w.t, w.seyi).action(api.functions.vaultSettings.editVaultEntry, {
        token: await view(),
        fields: [{ name: "number", perEnv: false, values: { _: "4000056655665556" } }],
      }),
    );
    expect(errorCode(error)).toBe("INVALID_ARGUMENT");
    expect(String((error as { data?: { message?: string } }).data?.message ?? error)).toMatch(/Delete it and save the new card/);
    const [listed] = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
    expect(listed).toMatchObject({ name: "Team card", sites: ["shop.example"], card: { last4: "4242" } });
  });
});
