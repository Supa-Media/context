import { describe, expect, test } from "@jest/globals";
import {
  atHandle,
  resolveVaultLinkView,
  vaultLinkHref,
  type Described,
  type Outcome,
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
  entry: { name: "Netflix", sites: ["netflix.com"] },
  expiresAt: 1,
};
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
      prefill: { name: "Netflix", site: "netflix.com" },
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
      entry: { name: "Netflix", sites: ["netflix.com"] },
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
    });
    expect(view(shown(shareRequest), { kind: "shared", name: "Netflix", grantee: "sayo" })).toEqual({
      kind: "shared",
      name: "Netflix",
      grantee: "sayo",
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
    expect(view({ kind: "failed", error: err("STORAGE_NOT_CONNECTED") })).toMatchObject({ reason: "storage" });
    expect(view(shown(addRequest), { kind: "failed", error: err("KEY_UNAVAILABLE") })).toMatchObject({ reason: "key" });
    expect(view({ kind: "failed", error: err("SOMETHING_NEW") })).toMatchObject({ reason: "failed" });
    expect(view({ kind: "failed", error: new Error("offline") })).toMatchObject({ reason: "failed" });
  });

  test("a grantee is named by handle, with a plain fallback", () => {
    expect(atHandle("sayo")).toBe("@sayo");
    expect(atHandle(null)).toBe("them");
  });
});
