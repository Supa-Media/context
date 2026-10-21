/**
 * The pure half of a connector's round trip (`docs/decisions/connectors.md`):
 * the link page's copy, the callback's parameters, the completion secret's key
 * and the words each outcome gets. Kept free of React and Convex so every rule
 * here has a test; the screens only draw what these return.
 */

import { isProviderId, type ProviderId } from "@context/convex/functions/lib/providers/ids";
import { firstParam } from "../invite/invite";

/** The app page a connect link opens, and the callback's prefix. */
export const CONNECT_ROUTE = "/connect";

export const EXPIRED_LINK_MESSAGE = "This link has expired or was already used. Ask Tex for a new one.";

const FALLBACK_FAILURE = "This connection did not finish. Try the link again from Tex.";

/** `/connect/<provider>/<token>`, the page Tex sends a person to. */
export function connectHref(provider: string, token: string): string {
  return `${CONNECT_ROUTE}/${provider}/${encodeURIComponent(token)}`;
}

/** A route's provider, or null when it is not one this app knows. */
export function providerParam(value: string | string[] | undefined): ProviderId | null {
  const raw = firstParam(value);
  return raw !== null && isProviderId(raw) ? raw : null;
}

/* ------------------------------------------------- completion secret -- */

/** The part of `sessionStorage` the secret needs: enough for a test to pass a plain object. */
export interface CompletionStore {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

/**
 * Kept per provider, in the browser that pressed Continue. The consent screen
 * leaves this tab and comes back to it, so `sessionStorage` is the place that
 * survives the trip without reaching the server.
 */
export function completionKey(provider: ProviderId): string {
  return `context.connect.${provider}.completion`;
}

/** The browser's session storage, or null where there is none. */
export function browserCompletionStore(): CompletionStore | null {
  try {
    const globalStore = (globalThis as { sessionStorage?: CompletionStore }).sessionStorage;
    if (globalStore) return globalStore;
    const browserWindow = (globalThis as { window?: { sessionStorage?: CompletionStore } }).window;
    return browserWindow?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberCompletionSecret(provider: ProviderId, secret: string, store: CompletionStore | null): boolean {
  if (store === null || secret.length === 0) return false;
  try {
    store.setItem(completionKey(provider), secret);
    return true;
  } catch {
    return false;
  }
}

/** Reads the secret and removes it: a callback gets one chance at it. */
export function takeCompletionSecret(provider: ProviderId, store: CompletionStore | null): string | null {
  if (store === null) return null;
  const key = completionKey(provider);
  try {
    const value = store.getItem(key);
    store.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------- callback -- */

export type ConnectCallback =
  | { kind: "ready"; code: string; state: string }
  | { kind: "denied" }
  | { kind: "incomplete" };

/** `?error=` wins: a provider that refused sends no code, whatever else it sent. */
export function parseConnectCallback(params: {
  code?: string | string[];
  state?: string | string[];
  error?: string | string[];
}): ConnectCallback {
  if (firstParam(params.error) !== null) return { kind: "denied" };
  const code = firstParam(params.code);
  const state = firstParam(params.state);
  if (code === null || state === null) return { kind: "incomplete" };
  return { kind: "ready", code, state };
}

export type CallbackOutcome =
  | { kind: "connected"; teamName: string }
  | { kind: "denied" }
  | { kind: "missing-secret" }
  | { kind: "failed"; message: string };

export interface CallbackMessage {
  headline: string;
  body: string;
}

export function callbackMessage(outcome: CallbackOutcome): CallbackMessage {
  switch (outcome.kind) {
    case "connected":
      return { headline: `${outcome.teamName} is connected.`, body: "Go back to your texts with Tex." };
    case "denied":
      return { headline: "Not connected", body: "You didn't allow it, so nothing was connected." };
    case "missing-secret":
      return {
        headline: "Could not finish connecting",
        body: "Open the link from Tex again in this same browser.",
      };
    case "failed":
      return { headline: "Could not finish connecting", body: outcome.message };
  }
}

/** The server's own words when it sent some, else a plain fallback. */
export function failureMessage(error: unknown): string {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null && "message" in data) {
    const message = (data as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return FALLBACK_FAILURE;
}

/* ----------------------------------------------------------- link page -- */

export interface ConnectLinkCopy {
  title: string;
  line: string;
  /** "Already connected: Acme, Lab", or null when nothing is. */
  already: string | null;
  /** "Slack isn't set up on Context yet.", or null when the provider is set up. */
  unavailableLine: string | null;
  /** The primary button, or null when there is nothing to press. */
  button: string | null;
}

export function connectLinkCopy(info: {
  providerName: string;
  connectedTeams: readonly string[];
  available: boolean;
}): ConnectLinkCopy {
  const name = info.providerName;
  return {
    title: `Connect ${name} to Tex`,
    line: `Tex will be able to read and act in ${name} as you. Anything it posts or changes waits for your yes.`,
    already: info.connectedTeams.length === 0 ? null : `Already connected: ${info.connectedTeams.join(", ")}`,
    unavailableLine: info.available ? null : `${name} isn't set up on Context yet.`,
    button: info.available ? `Continue to ${name}` : null,
  };
}

/** Whether a consent address is an https one. The provider's own host is the server's to name. */
export function isConsentUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
