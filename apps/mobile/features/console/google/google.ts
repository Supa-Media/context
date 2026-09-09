export const GOOGLE_CALLBACK_PATH = "/connect/google";

export const GOOGLE_REDIRECT_ORIGINS: readonly string[] = Object.freeze([
  "https://context.lc",
  "http://localhost:4601",
]);

const GOOGLE_COMPLETION_PREFIX = "context.googleConnect.";

export function browserOrigin(): string | null {
  const location = (globalThis as { location?: { origin?: unknown } }).location;
  const origin = location?.origin;
  return typeof origin === "string" && origin.length > 0 ? origin : null;
}

export function googleRedirectUri(origin: string | null | undefined): string | null {
  if (typeof origin !== "string") return null;
  if (!GOOGLE_REDIRECT_ORIGINS.includes(origin)) return null;
  return `${origin}${GOOGLE_CALLBACK_PATH}`;
}

export function isGoogleAuthorizeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === "accounts.google.com";
}

export function stateFromGoogleAuthorizeUrl(url: string): string | null {
  if (!isGoogleAuthorizeUrl(url)) return null;
  return new URL(url).searchParams.get("state");
}

function storage(): Storage | null {
  try {
    const globalStore = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (globalStore) return globalStore;
    const browserWindow = (globalThis as { window?: { sessionStorage?: Storage } }).window;
    return browserWindow?.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberGoogleCompletionSecret(state: string, secret: string): boolean {
  const store = storage();
  if (store === null || state.length === 0 || secret.length === 0) return false;
  try {
    store.setItem(`${GOOGLE_COMPLETION_PREFIX}${state}`, secret);
    return true;
  } catch {
    return false;
  }
}

export function takeGoogleCompletionSecret(state: string): string | null {
  const store = storage();
  if (store === null || state.length === 0) return null;
  const key = `${GOOGLE_COMPLETION_PREFIX}${state}`;
  try {
    const value = store.getItem(key);
    store.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

export type GoogleSyncServices = {
  gmail: boolean;
  calendar: boolean;
  chat: boolean;
};

export type GoogleStartState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "failed"; message: string };

export type GoogleCallback =
  | { kind: "ready"; code: string; state: string }
  | { kind: "cancelled" }
  | { kind: "incomplete" };

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

export function parseGoogleCallback(params: {
  code?: string | string[];
  state?: string | string[];
  error?: string | string[];
}): GoogleCallback {
  if (firstParam(params.error) !== null) return { kind: "cancelled" };
  const code = firstParam(params.code);
  const state = firstParam(params.state);
  if (code === null || state === null) return { kind: "incomplete" };
  return { kind: "ready", code, state };
}
