/**
 * THE PROXY STEP: a web request made through Context with one vault field
 * added on the way out, so the AI that asked never holds the key
 * (`docs/decisions/texting-assistant/vault.md`, "An AI uses a key without
 * seeing it").
 *
 * The second opener of a sealed secret beside the fill step (`fill.js`), and
 * like it not a tool: `vault_list`'s `fetch` argument calls it. Every rule
 * the value depends on is here, in one place:
 *
 *  - the entry names exactly one https host when it is saved (`meta.proxy`),
 *    and the request must be to that host and nothing beneath or beside it;
 *  - a host anyone can publish under is refused, because a pin to it is a pin
 *    to everyone;
 *  - redirects are never followed, so a 302 cannot carry the key elsewhere;
 *  - the value, and every encoding of it a site might echo, is blanked out of
 *    the answer's headers and body before the model sees either;
 *  - an answer that is not text is never returned, only its size.
 */

import { mayUse, readMeta, readSecret, siteHost } from "./entries.js";
import { fieldValue } from "./fields.js";

export class ProxyRefused extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProxyRefused";
    this.code = code;
  }
}

/** What a blanked-out key reads as. Fixed, so a model can say what happened. */
export const HIDDEN = "[hidden by Context]";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const STYLES = new Set(["bearer", "header", "query"]);
const MAX_BODY = 1_000_000;
const MAX_ANSWER = 200_000;
/** An answer declared larger than this is not read at all, so it never sits in the Worker whole. */
const MAX_READ = 5_000_000;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** Shorter than this, blanking it out of an answer would blank ordinary words too. */
export const MIN_KEY = 12;

/**
 * Hosts under which anyone can publish a page or catch a request. A key
 * pinned to one of these, or to anything beneath one, could be collected by
 * whoever set up the page there. Not the whole public suffix list: the hosts
 * people actually paste into a "send it to" box.
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

export function isSharedHost(host) {
  return SHARED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * The pin an entry was saved with, checked again on every use: `{host, style,
 * name}`, or null when the entry was not saved for the proxy. `style` is how
 * the site wants the key: `bearer` (`Authorization: Bearer <key>`), `header`
 * (a header called `name`), or `query` (a parameter called `name`).
 */
export function proxyPin(meta) {
  const pin = meta?.proxy;
  if (!pin || typeof pin !== "object") return null;
  const host = siteHost(pin.host);
  if (host === null || host !== pin.host || isSharedHost(host)) return null;
  if (!STYLES.has(pin.style)) return null;
  if (pin.style === "header" && !(typeof pin.name === "string" && HEADER_NAME.test(pin.name))) return null;
  if (pin.style === "query" && !(typeof pin.name === "string" && PARAM_NAME.test(pin.name))) return null;
  return { host, style: pin.style, ...(pin.style === "bearer" ? {} : { name: pin.name }) };
}

/** The exact address a request goes to, or a refusal naming why. */
export function requestTarget(raw, pin) {
  let url;
  try {
    url = new URL(typeof raw === "string" ? raw : "");
  } catch {
    throw new ProxyRefused("bad_url", "url must be a full https address.");
  }
  if (url.protocol !== "https:") throw new ProxyRefused("bad_url", "url must be https.");
  if (url.username || url.password) throw new ProxyRefused("bad_url", "url must not carry a username or password.");
  if (url.port && url.port !== "443") throw new ProxyRefused("bad_url", "url must not name a port.");
  if (url.hostname.toLowerCase() !== pin.host) {
    throw new ProxyRefused("wrong_site", `This key only works on ${pin.host}. Context did not send it to ${url.hostname}.`);
  }
  url.hash = "";
  return url;
}

function base64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/**
 * Every way a site might hand the value back: as it is, URL-encoded,
 * JSON-escaped, in hex, and in base64 at each of the three byte alignments it
 * can sit at inside a longer string (`user:key` in a Basic header, a token
 * that embeds it). Only the base64 characters that depend on the value alone
 * are kept, so an echo is caught wherever it starts.
 */
export function echoForms(value) {
  const bytes = new TextEncoder().encode(value);
  const forms = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  forms.add(hex);
  forms.add(hex.toUpperCase());
  for (let lead = 0; lead < 3; lead += 1) {
    const padded = new Uint8Array(lead + bytes.length);
    padded.set(bytes, lead);
    const encoded = base64(padded).replace(/=+$/, "");
    const first = Math.ceil((8 * lead) / 6);
    const last = Math.floor((8 * (lead + bytes.length)) / 6);
    const core = encoded.slice(first, last);
    if (core.length >= 8) {
      forms.add(core);
      forms.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  return [...forms].filter((form) => form.length >= 8).sort((a, b) => b.length - a.length);
}

export function blankOut(text, forms) {
  let out = text;
  for (const form of forms) out = out.split(form).join(HIDDEN);
  return out;
}

const TEXT_TYPE = /^(text\/|application\/(json|xml|x-www-form-urlencoded|[a-z0-9.+-]+\+(json|xml))|application\/javascript)/i;
/** Headers a model may read back. Set-Cookie and the like stay with Context. */
const ANSWER_HEADERS = ["content-type", "content-length", "location", "retry-after", "x-request-id", "request-id", "link"];
/** Headers the AI may not set: the transport's own, and what would carry credentials it does not hold. */
const REFUSED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "cookie", "proxy-authorization"]);

function outgoingHeaders(raw, pin, value) {
  const headers = new Headers();
  if (Array.isArray(raw)) {
    for (const { name, value: text } of raw.slice(0, 40)) {
      if (!HEADER_NAME.test(name) || typeof text !== "string" || text.length > 4000) {
        throw new ProxyRefused("bad_header", `The header ${String(name).slice(0, 64)} cannot be sent.`);
      }
      if (REFUSED_HEADERS.has(name.toLowerCase())) continue;
      headers.set(name, text);
    }
  }
  if (pin.style === "bearer") headers.set("authorization", `Bearer ${value}`);
  if (pin.style === "header") headers.set(pin.name, value);
  return headers;
}

/**
 * Make one request with the entry's field added, and answer what a model may
 * read: `{status, headers, body, hidden}`, with `hidden` true when the answer
 * carried the key and it was blanked out.
 *
 * `allowed` decides whether this AI may use this entry right now
 * (`{allowed: true}` or `{allowed: false, code, message}`), and `fetchImpl`
 * is the outgoing fetch; both are the caller's, so this module decides
 * nothing about who is asking.
 */
export async function proxyFetch(store, request, { allowed, fetchImpl = fetch }) {
  const keys = store?.encryptionKey;
  const workspaceId = store?.actor?.workspaceId;
  const userId = store?.actor?.userId;
  if (!keys || typeof workspaceId !== "string") throw new ProxyRefused("no_key", "This workspace has no vault yet.");
  const meta = await readMeta(store, keys, workspaceId, request?.entry);
  if (meta === null || !mayUse(meta, userId)) throw new ProxyRefused("not_found", "There is no such entry in vault_list.");
  const pin = proxyPin(meta);
  if (pin === null) {
    throw new ProxyRefused("not_pinned", "This entry was not saved for use through Context. The person can turn that on when they save a key.");
  }
  const url = requestTarget(request.url, pin);
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
  if (!METHODS.has(method)) throw new ProxyRefused("bad_method", `method is one of ${[...METHODS].join(", ")}.`);
  const body = request.body === undefined || request.body === null ? undefined : request.body;
  if (body !== undefined && (typeof body !== "string" || body.length > MAX_BODY)) {
    throw new ProxyRefused("bad_body", "body must be text, at most 1 MB.");
  }
  if (body !== undefined && (method === "GET" || method === "HEAD")) throw new ProxyRefused("bad_body", `A ${method} request has no body.`);

  const verdict = await allowed({ entryId: request.entry, meta, pin, method, url });
  if (!verdict?.allowed) throw new ProxyRefused(verdict?.code ?? "not_allowed", verdict?.message ?? "This AI may not use that key.");

  let secret;
  try {
    secret = await readSecret(store, keys, workspaceId, request.entry);
  } catch {
    throw new ProxyRefused("not_found", "There is no such entry in vault_list.");
  }
  const value = fieldValue(secret, request.field, request.env);
  if (typeof value !== "string" || value.length === 0) {
    throw new ProxyRefused("no_field", "That entry has no value for that field and environment.");
  }
  if (value.length < MIN_KEY) throw new ProxyRefused("too_short", "That value is too short to be hidden safely, so Context will not send it.");

  if (pin.style === "query") url.searchParams.set(pin.name, value);
  const headers = outgoingHeaders(request.headers, pin, value);
  let response;
  try {
    response = await fetchImpl(url.toString(), { method, headers, body, redirect: "manual" });
  } catch {
    throw new ProxyRefused("unreachable", `${pin.host} could not be reached.`);
  }

  const forms = echoForms(value);
  let hidden = false;
  const blank = (text) => {
    const out = blankOut(text, forms);
    if (out !== text) hidden = true;
    return out;
  };
  const answerHeaders = {};
  for (const name of ANSWER_HEADERS) {
    const text = response.headers.get(name);
    if (text !== null) answerHeaders[name] = blank(text);
  }
  const type = response.headers.get("content-type") ?? "";
  const declared = Number(response.headers.get("content-length"));
  const tooBig = Number.isFinite(declared) && declared > MAX_READ;
  const bytes = method === "HEAD" || tooBig ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
  let answer;
  if (tooBig) answer = `(an answer of ${declared} bytes, too large to read through Context)`;
  else if (bytes.length === 0) answer = "";
  else if (!TEXT_TYPE.test(type)) answer = `(a ${type || "binary"} answer of ${bytes.length} bytes, not shown)`;
  else {
    const text = blank(new TextDecoder().decode(bytes));
    answer = text.length > MAX_ANSWER ? `${text.slice(0, MAX_ANSWER)}\n(cut off after ${MAX_ANSWER} characters)` : text;
  }
  return { status: response.status, headers: answerHeaders, body: answer, hidden, host: pin.host, path: url.pathname };
}
