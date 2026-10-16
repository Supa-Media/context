/**
 * "Let my AIs use it, never shown the key" on the save page: the one website
 * Context adds the key for, how that site wants it, and whether the person is
 * asked the first time each AI uses it
 * (`docs/decisions/texting-assistant/vault.md`).
 *
 * The page only drafts this. The rules a pin must keep (an exact host, never
 * one anyone can publish under, a header or parameter name that can be sent)
 * are checked where the key is saved and again on every use, by
 * `apps/mcp/src/vault/proxy.js`, so a page that skipped a check here could
 * not store a pin that breaks one.
 */

import { TOP_APIS } from "./apiHostsTop";

export type ProxyStyle = "bearer" | "header" | "query";

/** What `saveVaultLogin` takes as `proxy`. */
export interface ProxyPinDraft {
  host: string;
  style: ProxyStyle;
  name?: string;
  ask: boolean;
}

/** The form's own state for it. `name` is kept per style so switching loses nothing. */
export interface ProxyFormState {
  on: boolean;
  host: string;
  /** Null until the person picks under Advanced: then the guess for the host is used. */
  style: ProxyStyle | null;
  headerName: string;
  paramName: string;
  ask: boolean;
}

export const PROXY_OFF: ProxyFormState = { on: false, host: "", style: null, headerName: "", paramName: "", ask: true };

/**
 * Sites known not to take the key as `Authorization: Bearer`, from the
 * hand-picked API list. Everything else is guessed as a sign-in header, which
 * is what most APIs want; Advanced is there for the rest.
 */
const KNOWN: Record<string, { style: ProxyStyle; name: string }> = Object.fromEntries(
  TOP_APIS.flatMap(([host, , how]) => {
    const [kind, name] = how?.split(":") ?? [];
    return kind === "header" || kind === "query" ? [[host, { style: kind, name }]] : [];
  }),
);

/**
 * Hosts anyone can publish a page under, so a key can't be kept to one site
 * there. The server refuses these (`SHARED_SUFFIXES` in
 * `apps/mcp/src/vault/proxy.js`, kept equal to this by
 * `__tests__/vaultApiHosts.test.ts`); the form says so as soon as one is typed.
 */
const SHARED_SUFFIXES = [
  "workers.dev",
  "pages.dev",
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "glitch.me",
  "repl.co",
  "replit.app",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "trycloudflare.com",
  "loca.lt",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "blogspot.com",
  "wordpress.com",
  "webhook.site",
  "requestbin.com",
  "pipedream.net",
  "beeceptor.com",
  "hookbin.com",
  "requestcatcher.com",
  "mockbin.org",
  "httpbin.org",
  "postb.in",
  "ptsv3.com",
];

export const SHARED_HOST_SUFFIXES: readonly string[] = SHARED_SUFFIXES;

/** Whether anyone can publish under this host, as the gateway's `isSharedHost` decides. */
export function isSharedHost(host: string): boolean {
  return SHARED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** The host a typed website names, the way the server reads it, or "". */
export function typedHost(raw: string): string {
  let text = raw.trim();
  if (text.length === 0) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Why a typed website can't take a key, in the server's words, or null when
 * it can (or nothing is typed yet). Mirrors `siteHost` and `savedPin` in the
 * gateway so the person hears it while typing rather than after Save.
 */
export function hostProblem(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  let url: URL | null = null;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    url = null;
  }
  const host = url?.hostname.toLowerCase() ?? "";
  const usable =
    url !== null &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    !url.username &&
    !url.password &&
    !url.port &&
    host.includes(".") &&
    !/^[0-9.]+$/.test(host) &&
    !host.startsWith("[");
  if (!usable) return "Enter the website the key is for, like api.example.com.";
  if (isSharedHost(host)) {
    return `Anyone can put a page on ${host}, so a key can't be kept to it. Use the site's own address.`;
  }
  return null;
}

/** How the site probably wants the key, with the header or parameter name. */
export function guessStyle(host: string): { style: ProxyStyle; name: string } {
  return KNOWN[host] ?? { style: "bearer", name: "" };
}

/** The style and name in force: the person's pick under Advanced, else the guess. */
export function chosenStyle(state: ProxyFormState): { style: ProxyStyle; name: string; guessed: boolean } {
  const guess = guessStyle(typedHost(state.host));
  if (state.style === null) return { ...guess, guessed: true };
  const typed = state.style === "header" ? state.headerName : state.style === "query" ? state.paramName : "";
  return { style: state.style, name: typed.trim(), guessed: false };
}

/** Pick a style under Advanced: its name starts as the guess's, when the guess is that style. */
export function pickStyle(state: ProxyFormState, style: ProxyStyle): ProxyFormState {
  const guess = guessStyle(typedHost(state.host));
  const from = chosenStyle(state);
  const seed = (current: string, kind: ProxyStyle) =>
    current || (from.style === kind ? from.name : guess.style === kind ? guess.name : "");
  return { ...state, style, headerName: seed(state.headerName, "header"), paramName: seed(state.paramName, "query") };
}

/** How the page says a style, in the person's words. */
export function styleWords(style: ProxyStyle, name: string): string {
  if (style === "bearer") return "sign-in header";
  if (style === "header") return name ? `the ${name} header` : "a named header";
  return name ? `?${name}= in the address` : "in the address";
}

/** Why the switch's part of the form can't be saved yet, said above Save, or null when it can. */
export function proxyProblem(state: ProxyFormState): string | null {
  if (!state.on) return null;
  if (state.host.trim() === "") return "To save, enter the website the key is for.";
  if (hostProblem(state.host) !== null) return "To save, finish the website above.";
  const { style, name } = chosenStyle(state);
  if (style !== "bearer" && name === "") {
    return style === "header" ? "To save, name the header under Advanced." : "To save, name the address part under Advanced.";
  }
  return null;
}

/** What is sent to the server, or undefined when the switch is off. */
export function proxyDraft(state: ProxyFormState): ProxyPinDraft | undefined {
  if (!state.on) return undefined;
  const { style, name } = chosenStyle(state);
  return { host: typedHost(state.host), style, ...(style === "bearer" ? {} : { name }), ask: state.ask };
}
