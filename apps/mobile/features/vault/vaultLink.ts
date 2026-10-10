/**
 * `/vault/<token>`: the private link Tex texts when it needs a login.
 *
 * Two kinds of link, one page. An `add` link asks the person to type a login
 * into a workspace's vault; a `share` link asks them to give one login to one
 * named member. Either way the change is the person's own tap on this page:
 * nothing here submits by itself, and the agent that asked never sees the
 * password (`docs/decisions/texting-assistant/vault.md`).
 *
 * Pure so the tests can walk every state without a Convex client.
 */

import { errorCodeOf } from "../consent/state";
import { loginHref } from "../auth/redirect";

export const VAULT_ROUTE = "/vault";

/** What the agent suggested on the link's URL. Only ever a starting point. */
export interface VaultPrefill {
  name: string;
  site: string;
}

/** `/vault/<token>`, keeping the agent's prefills so they survive signing in. */
export function vaultLinkHref(token: string, prefill?: Partial<VaultPrefill>): string {
  const query = new URLSearchParams();
  if (prefill?.name) query.set("name", prefill.name);
  if (prefill?.site) query.set("site", prefill.site);
  const search = query.toString();
  return `${VAULT_ROUTE}/${encodeURIComponent(token)}${search ? `?${search}` : ""}`;
}

export interface VaultWorkspace {
  handle: string;
  name: string;
  kind: "personal" | "shared";
}

/** `describeVaultRequest`'s answer. */
export interface VaultRequest {
  kind: "add" | "share";
  workspace: VaultWorkspace;
  grantee: string | null;
  entry: { name: string; sites: string[] } | null;
  expiresAt: number;
}

export type Described =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "shown"; request: VaultRequest }
  | { kind: "failed"; error: unknown };

/** What happened to the person's tap. `declined` is "Not now", which calls nothing. */
export type Outcome =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "saved"; name: string; site: string }
  | { kind: "shared"; name: string; grantee: string | null }
  | { kind: "declined" }
  | { kind: "failed"; error: unknown };

/** A problem the person can fix on the same form. */
export interface FormProblem {
  headline: string;
  next?: string;
}

export type VaultLinkView =
  | { kind: "wait" }
  | { kind: "signIn"; href: string }
  | { kind: "loading" }
  | { kind: "add"; workspace: VaultWorkspace; prefill: VaultPrefill; busy: boolean; problem: FormProblem | null }
  | {
      kind: "share";
      workspace: VaultWorkspace;
      grantee: string | null;
      entry: { name: string; sites: string[] };
      busy: boolean;
      problem: FormProblem | null;
    }
  | { kind: "saved"; name: string; site: string }
  | { kind: "shared"; name: string; grantee: string | null }
  | { kind: "declined" }
  | { kind: "dead"; reason: DeadReason; headline: string; detail: string };

export type DeadReason = "expired" | "notYours" | "storage" | "key" | "failed";

export function resolveVaultLinkView(inputs: {
  token: string | null;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  prefill: Partial<VaultPrefill>;
  described: Described;
  outcome: Outcome;
}): VaultLinkView {
  const { token, auth, prefill, described, outcome } = inputs;
  if (auth.isLoading) return { kind: "wait" };
  if (token === null) return dead("expired");
  if (!auth.isAuthenticated) return { kind: "signIn", href: loginHref(vaultLinkHref(token, prefill)) };

  if (outcome.kind === "saved") return { kind: "saved", name: outcome.name, site: outcome.site };
  if (outcome.kind === "shared") return { kind: "shared", name: outcome.name, grantee: outcome.grantee };
  if (outcome.kind === "declined") return { kind: "declined" };

  if (described.kind === "idle" || described.kind === "loading") return { kind: "loading" };
  if (described.kind === "failed") return deadFor(described.error);

  const request = described.request;
  const busy = outcome.kind === "busy";
  let problem: FormProblem | null = null;
  if (outcome.kind === "failed") {
    const fixable = fixableProblem(outcome.error);
    if (fixable === null) return deadFor(outcome.error);
    problem = fixable;
  }

  if (request.kind === "share") {
    if (request.entry === null) return dead("expired");
    return { kind: "share", workspace: request.workspace, grantee: request.grantee, entry: request.entry, busy, problem };
  }
  return {
    kind: "add",
    workspace: request.workspace,
    prefill: { name: (prefill.name ?? "").trim(), site: (prefill.site ?? "").trim() },
    busy,
    problem,
  };
}

/** `@sayo`, or a plain fallback when the backend could not name them. */
export function atHandle(handle: string | null): string {
  return handle === null ? "them" : `@${handle}`;
}

/** The backend's own copy for a field it refused, else null. */
export function errorMessageOf(error: unknown): string | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "message" in data) {
    const message = (data as { message: unknown }).message;
    return typeof message === "string" && message.length > 0 ? message : null;
  }
  return null;
}

/**
 * A submit failure that leaves the link usable: a field the backend refused,
 * or no answer at all (offline, a dropped socket). Everything with a code
 * other than INVALID_ARGUMENT ends the page.
 */
function fixableProblem(error: unknown): FormProblem | null {
  const code = errorCodeOf(error);
  if (code === "INVALID_ARGUMENT") {
    return { headline: errorMessageOf(error) ?? "Check the details and try again." };
  }
  if (code === undefined) {
    return { headline: "That didn't go through.", next: "Check your connection and try again." };
  }
  return null;
}

function deadFor(error: unknown): VaultLinkView {
  switch (errorCodeOf(error)) {
    case "VAULT_LINK_DEAD":
      return dead("expired");
    case "VAULT_LINK_NOT_YOURS":
      return dead("notYours");
    case "STORAGE_NOT_CONNECTED":
      return dead("storage");
    case "KEY_UNAVAILABLE":
      return dead("key");
    default:
      return dead("failed");
  }
}

const DEAD_COPY: Record<DeadReason, { headline: string; detail: string }> = {
  expired: {
    headline: "This link has expired",
    detail: "Links work once, for 30 minutes. Ask Tex for a new one.",
  },
  notYours: {
    headline: "This link is for someone else",
    detail: "It was sent to a different account. Sign in as the person who asked for it.",
  },
  storage: {
    headline: "Connect storage first",
    detail: "Logins are kept in your workspace's own storage, and this workspace has none connected yet.",
  },
  key: {
    headline: "Your vault can't be opened right now",
    detail: "Nothing changed. Wait a few minutes, then ask Tex for a new link.",
  },
  failed: {
    headline: "Something went wrong",
    detail: "That didn't work on our side. Reload this page to try again.",
  },
};

function dead(reason: DeadReason): VaultLinkView {
  return { kind: "dead", reason, ...DEAD_COPY[reason] };
}
