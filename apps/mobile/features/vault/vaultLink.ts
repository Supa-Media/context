/**
 * `/vault/<token>`: the private link Tex texts when it needs a login or a
 * secret.
 *
 * Three kinds of link, one page. An `add` link asks the person to type a login
 * or a secret into a workspace's vault; a `share` link asks them to give one
 * entry to one named member; a `view` link lets them see and copy an entry's
 * values. Every change is the person's own tap on this page: nothing here
 * submits by itself, and the agent that asked never sees a value
 * (`docs/decisions/texting-assistant/vault.md`).
 *
 * Pure so the tests can walk every state without a Convex client.
 */

import { errorCodeOf } from "../consent/state";
import { loginHref } from "../auth/redirect";
import { ENVS, MAX_FIELDS, isEnv, isFieldName, type Env, type RevealedField } from "./vaultFields";

export const VAULT_ROUTE = "/vault";

export type EntryType = "login" | "secret";

/** What the agent suggested on the link's URL. Only ever a starting point. */
export interface VaultPrefill {
  name: string;
  site: string;
  type: EntryType;
  /** Field names to start the form with. */
  fields: string[];
  /** Whether those fields start per environment. On for a secret unless the agent said otherwise. */
  envs: boolean;
  /** A view link's environment to open on. */
  env: Env | null;
}

/** The query keys the agent may set, as strings off the URL. */
export const PREFILL_KEYS = ["type", "name", "site", "fields", "envs", "env"] as const;
export type RawPrefill = Partial<Record<(typeof PREFILL_KEYS)[number], string | null | undefined>>;

/**
 * The agent's prefills, read defensively: anything unknown falls back to the
 * plain default, and field names that could never be saved are dropped.
 */
export function parseVaultPrefill(raw: RawPrefill): VaultPrefill {
  const type: EntryType = raw.type?.trim().toLowerCase() === "secret" ? "secret" : "login";
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const part of (raw.fields ?? "").split(",")) {
    const name = part.trim();
    if (!isFieldName(name) || seen.has(name.toLowerCase()) || fields.length >= MAX_FIELDS) continue;
    seen.add(name.toLowerCase());
    fields.push(name);
  }
  const envsRaw = raw.envs?.trim();
  const envs = envsRaw === "1" ? true : envsRaw === "0" ? false : type === "secret";
  const envRaw = raw.env?.trim().toLowerCase();
  return {
    name: (raw.name ?? "").trim(),
    site: (raw.site ?? "").trim(),
    type,
    fields,
    envs,
    env: isEnv(envRaw) ? envRaw : null,
  };
}

/** `/vault/<token>`, keeping the agent's prefills as given so they survive signing in. */
export function vaultLinkHref(token: string, prefill?: RawPrefill): string {
  const query = new URLSearchParams();
  for (const key of PREFILL_KEYS) {
    const value = prefill?.[key];
    if (typeof value === "string" && value !== "") query.set(key, value);
  }
  const search = query.toString();
  return `${VAULT_ROUTE}/${encodeURIComponent(token)}${search ? `?${search}` : ""}`;
}

export interface VaultWorkspace {
  handle: string;
  name: string;
  kind: "personal" | "shared";
}

/** One field as `describeVaultRequest` names it: never a value, only where one is set. */
export interface FieldSummary {
  name: string;
  perEnv: boolean;
  /** `dev`, `staging`, `prod` for a per-environment field; `_` for a single value. */
  set: string[];
}

export interface VaultEntrySummary {
  type: EntryType;
  name: string;
  sites: string[];
  fields: FieldSummary[];
}

/**
 * `revealVaultEntry`'s answer. Held in the page's memory while it is open and
 * nowhere else: never storage, the URL, a log or an analytics event.
 */
export interface RevealedEntry {
  type: EntryType;
  name: string;
  sites: string[];
  username: string;
  password: string;
  fields: RevealedField[];
}

/** `describeVaultRequest`'s answer. */
export interface VaultRequest {
  kind: "add" | "share" | "view";
  workspace: VaultWorkspace;
  grantee: string | null;
  entry: VaultEntrySummary | null;
  expiresAt: number;
}

export type Described =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "shown"; request: VaultRequest }
  | { kind: "failed"; error: unknown };

/**
 * What happened to the person's tap. `declined` is "Not now", which calls
 * nothing; `revealed` is a view link's Reveal, which spends nothing.
 */
export type Outcome =
  | { kind: "idle" }
  | { kind: "revealed"; entry: RevealedEntry }
  | { kind: "busy" }
  | { kind: "saved"; name: string; site: string; type?: EntryType }
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
      entry: VaultEntrySummary;
      busy: boolean;
      problem: FormProblem | null;
    }
  | {
      kind: "view";
      workspace: VaultWorkspace;
      entry: VaultEntrySummary;
      env: Env;
      revealed: RevealedEntry | null;
      busy: boolean;
      problem: FormProblem | null;
    }
  | { kind: "saved"; name: string; site: string; type: EntryType }
  | { kind: "shared"; name: string; grantee: string | null; type: EntryType }
  | { kind: "declined" }
  | { kind: "dead"; reason: DeadReason; headline: string; detail: string };

export type DeadReason = "expired" | "notYours" | "storage" | "key" | "failed";

export function resolveVaultLinkView(inputs: {
  token: string | null;
  auth: { isLoading: boolean; isAuthenticated: boolean };
  prefill: RawPrefill;
  described: Described;
  outcome: Outcome;
}): VaultLinkView {
  const { token, auth, prefill, described, outcome } = inputs;
  if (auth.isLoading) return { kind: "wait" };
  if (token === null) return dead("expired");
  if (!auth.isAuthenticated) return { kind: "signIn", href: loginHref(vaultLinkHref(token, prefill)) };

  if (outcome.kind === "saved") {
    return { kind: "saved", name: outcome.name, site: outcome.site, type: outcome.type ?? "login" };
  }
  if (outcome.kind === "shared") {
    const type = described.kind === "shown" ? (described.request.entry?.type ?? "login") : "login";
    return { kind: "shared", name: outcome.name, grantee: outcome.grantee, type };
  }
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
  const parsed = parseVaultPrefill(prefill);
  if (request.kind === "view") {
    if (request.entry === null) return dead("expired");
    return {
      kind: "view",
      workspace: request.workspace,
      entry: request.entry,
      env: openingEnv(request.entry, parsed.env),
      revealed: outcome.kind === "revealed" ? outcome.entry : null,
      busy,
      problem,
    };
  }
  return { kind: "add", workspace: request.workspace, prefill: parsed, busy, problem };
}

/**
 * The environment a view page opens on: the agent's when it names one, else
 * the first that any per-environment field has a value in, else dev.
 */
export function openingEnv(entry: VaultEntrySummary, asked: Env | null): Env {
  if (asked !== null) return asked;
  const perEnv = entry.fields.filter((field) => field.perEnv);
  return ENVS.find((env) => perEnv.some((field) => field.set.includes(env))) ?? "dev";
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
    case "VAULT_NO_STORAGE":
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
    detail: "Links last 30 minutes, and saving or sharing uses one up. Ask Tex for a new one.",
  },
  notYours: {
    headline: "This link is for someone else",
    detail: "It was sent to a different account. Sign in as the person who asked for it.",
  },
  storage: {
    headline: "Connect storage first",
    detail: "Logins and secrets are kept in your workspace's own storage, and this workspace has none connected yet.",
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
