import { describe, expect, test } from "@jest/globals";
import {
  atHandle,
  openingEnv,
  parseVaultPrefill,
  resolveVaultLinkView,
  vaultLinkHref,
  type Described,
  type Outcome,
  type RevealedEntry,
  type VaultRequest,
} from "../features/vault/vaultLink";

const signedIn = { isLoading: false, isAuthenticated: true };
const signedOut = { isLoading: false, isAuthenticated: false };
const err = (code: string, message?: string) => ({ data: { code, ...(message ? { message } : {}) } });
const idle: Outcome = { kind: "idle" };

const personal = { handle: "ada", name: "Ada", kind: "personal" as const };
const team = { handle: "lab", name: "Lab", kind: "shared" as const };
const addRequest: VaultRequest = { kind: "add", workspace: personal, grantee: null, entry: null, expiresAt: 1 };
const shareRequest: VaultRequest = {
  kind: "share",
  workspace: team,
  grantee: "sayo",
  entry: { type: "login", name: "Netflix", sites: ["netflix.com"], fields: [] },
  expiresAt: 1,
};
const stripe = {
  type: "secret" as const,
  name: "Stripe",
  sites: [],
  fields: [
    { name: "STRIPE_SECRET_KEY", perEnv: true, set: ["staging", "prod"] },
    { name: "Account id", perEnv: false, set: ["_"] },
  ],
};
const viewRequest: VaultRequest = { kind: "view", workspace: personal, grantee: null, entry: stripe, expiresAt: 1 };
const loginDefaults = { type: "login", fields: [], envs: false, env: null };
const shown = (request: VaultRequest): Described => ({ kind: "shown", request });

function view(described: Described, outcome: Outcome = idle, prefill = {}) {
  return resolveVaultLinkView({ token: "tok", auth: signedIn, prefill, described, outcome });
}

describe("the vault link", () => {
  test("waits for auth, then sends a signed-out visitor to sign in and back, prefills kept", () => {
    const base = { token: "tok", prefill: { name: "Netflix", site: "netflix.com" }, described: { kind: "idle" as const }, outcome: idle };
    expect(resolveVaultLinkView({ ...base, auth: { isLoading: true, isAuthenticated: false } })).toEqual({ kind: "wait" });
    expect(resolveVaultLinkView({ ...base, auth: signedOut })).toEqual({
      kind: "signIn",
      href: `/login?next=${encodeURIComponent("/vault/tok?name=Netflix&site=netflix.com")}`,
    });
  });

  test("the href encodes the token and leaves out empty prefills", () => {
    expect(vaultLinkHref("a/b")).toBe("/vault/a%2Fb");
    expect(vaultLinkHref("t", { name: "", site: "x.com" })).toBe("/vault/t?site=x.com");
  });

  test("loads while the request is described", () => {
    expect(view({ kind: "idle" }).kind).toBe("loading");
    expect(view({ kind: "loading" }).kind).toBe("loading");
  });

  test("an add link shows the form with the agent's prefills, trimmed", () => {
    expect(view(shown(addRequest), idle, { name: " Netflix ", site: "netflix.com" })).toEqual({
      kind: "add",
      workspace: personal,
      prefill: { name: "Netflix", site: "netflix.com", ...loginDefaults },
      busy: false,
      problem: null,
    });
    expect(view(shown(addRequest))).toMatchObject({ kind: "add", prefill: { name: "", site: "" } });
  });

  test("never moves on by itself: a described link waits for the person's tap", () => {
    expect(view(shown(addRequest)).kind).toBe("add");
    expect(view(shown(shareRequest)).kind).toBe("share");
  });

  test("a share link names the login, the grantee and the workspace", () => {
    expect(view(shown(shareRequest))).toEqual({
      kind: "share",
      workspace: team,
      grantee: "sayo",
      entry: shareRequest.entry,
      busy: false,
      problem: null,
    });
  });

  test("busy while the tap is in flight, then the done states", () => {
    expect(view(shown(addRequest), { kind: "busy" })).toMatchObject({ kind: "add", busy: true });
    expect(view(shown(shareRequest), { kind: "busy" })).toMatchObject({ kind: "share", busy: true });
    expect(view(shown(addRequest), { kind: "saved", name: "Netflix", site: "netflix.com" })).toEqual({
      kind: "saved",
      name: "Netflix",
      site: "netflix.com",
      type: "login",
    });
    expect(view(shown(addRequest), { kind: "saved", name: "Stripe", site: "", type: "secret" })).toMatchObject({ type: "secret" });
    expect(view(shown(shareRequest), { kind: "shared", name: "Netflix", grantee: "sayo" })).toEqual({
      kind: "shared",
      name: "Netflix",
      grantee: "sayo",
      type: "login",
    });
    expect(view(shown(shareRequest), { kind: "declined" })).toEqual({ kind: "declined" });
  });

  test("a refused field stays on the form with the backend's own words", () => {
    const failed: Outcome = { kind: "failed", error: err("INVALID_ARGUMENT", "Enter the site's address, like netflix.com.") };
    expect(view(shown(addRequest), failed)).toMatchObject({
      kind: "add",
      busy: false,
      problem: { headline: "Enter the site's address, like netflix.com." },
    });
  });

  test("a submit that got no answer can be tried again", () => {
    const failed: Outcome = { kind: "failed", error: new Error("socket closed") };
    expect(view(shown(shareRequest), failed)).toMatchObject({ kind: "share", problem: { headline: "That didn't go through." } });
  });

  test("expired, used or missing links say to ask Tex for a new one", () => {
    expect(view({ kind: "failed", error: err("VAULT_LINK_DEAD") })).toMatchObject({ kind: "dead", reason: "expired" });
    expect(view(shown(addRequest), { kind: "failed", error: err("VAULT_LINK_DEAD") })).toMatchObject({ reason: "expired" });
    expect(resolveVaultLinkView({ token: null, auth: signedIn, prefill: {}, described: { kind: "idle" }, outcome: idle })).toMatchObject({
      kind: "dead",
      reason: "expired",
    });
    expect(view(shown({ ...shareRequest, entry: null }))).toMatchObject({ reason: "expired" });
    const expired = view({ kind: "failed", error: err("VAULT_LINK_DEAD") });
    expect(expired.kind === "dead" && expired.detail).toMatch(/Ask Tex for a new one/);
  });

  test("someone else's link says so, and nothing else", () => {
    expect(view({ kind: "failed", error: err("VAULT_LINK_NOT_YOURS") })).toMatchObject({ kind: "dead", reason: "notYours" });
  });

  test("storage and key failures, and anything unknown, end the page", () => {
    expect(view({ kind: "failed", error: err("VAULT_NO_STORAGE") })).toMatchObject({ reason: "storage" });
    // The spelling the vault actions actually throw.
    expect(view(shown(addRequest), { kind: "failed", error: err("VAULT_NO_STORAGE") })).toMatchObject({ reason: "storage" });
    expect(view(shown(addRequest), { kind: "failed", error: err("KEY_UNAVAILABLE") })).toMatchObject({ reason: "key" });
    expect(view({ kind: "failed", error: err("SOMETHING_NEW") })).toMatchObject({ reason: "failed" });
    expect(view({ kind: "failed", error: new Error("offline") })).toMatchObject({ reason: "failed" });
  });

  test("a grantee is named by handle, with a plain fallback", () => {
    expect(atHandle("sayo")).toBe("@sayo");
    expect(atHandle(null)).toBe("them");
  });

  test("a dead link's copy does not claim a view link is spent by a look", () => {
    const expired = view({ kind: "failed", error: err("VAULT_LINK_DEAD") });
    expect(expired.kind === "dead" && expired.detail).not.toMatch(/work once/);
  });
});

describe("the agent's prefills", () => {
  test("a secret link starts per environment unless the agent says otherwise", () => {
    expect(parseVaultPrefill({ type: "secret", name: " Stripe ", fields: "STRIPE_KEY, WEBHOOK_SECRET" })).toEqual({
      name: "Stripe",
      site: "",
      type: "secret",
      fields: ["STRIPE_KEY", "WEBHOOK_SECRET"],
      envs: true,
      env: null,
    });
    expect(parseVaultPrefill({ type: "secret", envs: "0" }).envs).toBe(false);
    expect(parseVaultPrefill({ type: "SECRET" }).type).toBe("secret");
  });

  test("a login link's fields start single-valued, and per environment only when asked", () => {
    expect(parseVaultPrefill({ fields: "PIN" })).toMatchObject({ type: "login", fields: ["PIN"], envs: false });
    expect(parseVaultPrefill({ fields: "PIN", envs: "1" }).envs).toBe(true);
  });

  test("anything unknown falls back, and unsaveable or repeated names are dropped", () => {
    expect(parseVaultPrefill({ type: "card", env: "qa", envs: "yes" })).toEqual({
      name: "",
      site: "",
      type: "login",
      fields: [],
      envs: false,
      env: null,
    });
    expect(parseVaultPrefill({ fields: "A,,a, B ,<script>,-x,C" }).fields).toEqual(["A", "B", "C"]);
    expect(parseVaultPrefill({ fields: Array.from({ length: 40 }, (_, i) => `K${i}`).join(",") }).fields).toHaveLength(30);
    expect(parseVaultPrefill({ env: "PROD" }).env).toBe("prod");
  });

  test("every prefill survives signing in, as the agent wrote it", () => {
    const raw = { type: "secret", name: "Stripe", site: "dashboard.stripe.com", fields: "A,B", envs: "1", env: "prod" };
    const href = vaultLinkHref("tok", raw);
    expect(href).toBe("/vault/tok?type=secret&name=Stripe&site=dashboard.stripe.com&fields=A%2CB&envs=1&env=prod");
    const back = Object.fromEntries(new URL(href, "https://x.test").searchParams);
    expect(parseVaultPrefill(back)).toEqual(parseVaultPrefill(raw));
    expect(resolveVaultLinkView({ token: "tok", auth: signedOut, prefill: raw, described: { kind: "idle" }, outcome: idle })).toEqual({
      kind: "signIn",
      href: `/login?next=${encodeURIComponent(href)}`,
    });
  });
});

describe("a view link", () => {
  const revealed: RevealedEntry = {
    type: "secret",
    name: "Stripe",
    sites: [],
    username: "",
    password: "",
    fields: [{ name: "STRIPE_SECRET_KEY", perEnv: true, values: { prod: "sk_test_fake_prod" } }],
  };

  test("names the entry and its fields, with no values until Reveal", () => {
    expect(view(shown(viewRequest))).toEqual({
      kind: "view",
      workspace: personal,
      entry: stripe,
      env: "staging",
      revealed: null,
      busy: false,
      problem: null,
    });
  });

  test("opens on the agent's environment, else the first with a value, else dev", () => {
    expect(view(shown(viewRequest), idle, { env: "prod" })).toMatchObject({ env: "prod" });
    expect(openingEnv(stripe, null)).toBe("staging");
    expect(openingEnv({ ...stripe, fields: [{ name: "A", perEnv: false, set: ["_"] }] }, null)).toBe("dev");
  });

  test("Reveal is busy, then holds the answer; nothing spends the link", () => {
    expect(view(shown(viewRequest), { kind: "busy" })).toMatchObject({ kind: "view", busy: true, revealed: null });
    expect(view(shown(viewRequest), { kind: "revealed", entry: revealed })).toMatchObject({ kind: "view", busy: false, revealed });
  });

  test("a Reveal with no answer can be tried again; an expired one ends the page", () => {
    expect(view(shown(viewRequest), { kind: "failed", error: new Error("offline") })).toMatchObject({
      kind: "view",
      problem: { headline: "That didn't go through." },
    });
    expect(view(shown(viewRequest), { kind: "failed", error: err("VAULT_LINK_DEAD") })).toMatchObject({ kind: "dead", reason: "expired" });
    expect(view(shown(viewRequest), { kind: "failed", error: err("VAULT_LINK_NOT_YOURS") })).toMatchObject({ reason: "notYours" });
  });

  test("a view link whose entry is gone is expired", () => {
    expect(view(shown({ ...viewRequest, entry: null }))).toMatchObject({ kind: "dead", reason: "expired" });
  });
});
