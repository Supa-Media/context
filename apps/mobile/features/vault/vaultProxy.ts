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
 * Sites known not to take the key as `Authorization: Bearer`. Everything else
 * is guessed as a sign-in header, which is what most APIs want; Advanced is
 * there for the rest.
 */
const KNOWN: Record<string, { style: ProxyStyle; name: string }> = {
  "api.anthropic.com": { style: "header", name: "x-api-key" },
  "api.elevenlabs.io": { style: "header", name: "xi-api-key" },
  "api.search.brave.com": { style: "header", name: "X-Subscription-Token" },
  "generativelanguage.googleapis.com": { style: "header", name: "x-goog-api-key" },
  "maps.googleapis.com": { style: "query", name: "key" },
  "api.pagespeedonline.googleapis.com": { style: "query", name: "key" },
};

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

/** Why the switch's part of the form can't be saved yet, or null when it can. */
export function proxyProblem(state: ProxyFormState): string | null {
  if (!state.on) return null;
  if (typedHost(state.host) === "") return "Enter the website the key is for.";
  const { style, name } = chosenStyle(state);
  if (style !== "bearer" && name === "") return style === "header" ? "Name the header." : "Name the address part.";
  return null;
}

/** What is sent to the server, or undefined when the switch is off. */
export function proxyDraft(state: ProxyFormState): ProxyPinDraft | undefined {
  if (!state.on) return undefined;
  const { style, name } = chosenStyle(state);
  return { host: state.host.trim(), style, ...(style === "bearer" ? {} : { name }), ask: state.ask };
}
