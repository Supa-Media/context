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
 * Hosts on which anyone can publish a page or catch a request. A key pinned to
 * one of these exactly could be collected by whoever set up a page there. An
 * address beneath one (`my-app.workers.dev`) is one person's, and a pin is
 * that exact address, typed by the person saving the key, so it is allowed
 * (the owner, 2026-10-16: "the user is writing the domain in so they should
 * be allowed to"). Not the whole public suffix list: the hosts people
 * actually paste into a "send it to" box.
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
  return SHARED_SUFFIXES.includes(host);
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

/**
 * The pin a person asked for on the save page, checked by the same rules every
 * use checks: `{pin}` to store as `meta.proxy`, or `{problem}` in words for
 * the page. `ask` is the "Ask me the first time each AI uses it" switch, on
 * unless the person turned it off.
 */
export function savedPin(raw) {
  if (!raw || typeof raw !== "object") return { problem: "Say which website the key is for." };
  const host = siteHost(raw.host);
  if (host === null) return { problem: "Enter the website the key is for, like api.example.com." };
  if (isSharedHost(host)) {
    return { problem: `Anyone can put a page on ${host}, so a key can't be kept to it. Use the site's own address.` };
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const pin = proxyPin({ proxy: { host, style: raw.style, ...(raw.style === "bearer" ? {} : { name }) } });
  if (pin === null) {
    if (!STYLES.has(raw.style)) return { problem: "Choose how the site wants the key." };
    return { problem: raw.style === "query" ? "Name the address part the key goes in, like api_key." : "Name the header the key goes in, like x-api-key." };
  }
  return { pin: { ...pin, ask: raw.ask !== false } };
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
/**
 * Headers the AI may not set: the transport's own, what would carry
 * credentials it does not hold, and `accept-encoding` — an answer Context
 * cannot decode is an answer it cannot blank the key out of, so the AI does
 * not get to choose the encoding it comes back in.
 */
const REFUSED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "cookie",
  "proxy-authorization",
  "accept-encoding",
]);

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
/**
 * At most `limit` bytes of an answer, or `{over: true}`. A declared
 * `content-length` is the site's word for it and a site need not give one at
 * all, so the cap is applied to what actually arrives: the read stops and the
 * rest is never pulled.
 */
async function readBounded(response, limit) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.length > limit ? { over: true } : { bytes: whole };
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return { over: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { bytes };
}

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
  // An answer still in an encoding Context did not decode cannot be searched
  // for the key, so it is never handed over (`vault.md`, "Blanked from the
  // answer"). `accept-encoding` is refused above, so an honest site sends none.
  const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
  const encoded = encoding !== "" && encoding !== "identity";
  const declared = Number(response.headers.get("content-length"));
  const overDeclared = Number.isFinite(declared) && declared > MAX_READ;
  let tooBig = overDeclared;
  let bytes = new Uint8Array();
  if (method !== "HEAD" && !tooBig) {
    const read = await readBounded(response, MAX_READ);
    if (read.over) tooBig = true;
    else bytes = read.bytes;
  }
  let answer;
  if (tooBig) {
    answer = overDeclared
      ? `(an answer of ${declared} bytes, too large to read through Context)`
      : `(an answer over ${MAX_READ} bytes, too large to read through Context)`;
  }
  else if (bytes.length === 0) answer = "";
  else if (encoded) answer = `(a ${blank(encoding)} answer of ${bytes.length} bytes that Context could not read, not shown)`;
  // Blanked like any other echo: the type is a header the site chose, and it reaches the model.
  else if (!TEXT_TYPE.test(type)) answer = `(a ${blank(type) || "binary"} answer of ${bytes.length} bytes, not shown)`;
  else {
    const text = blank(new TextDecoder().decode(bytes));
    answer = text.length > MAX_ANSWER ? `${text.slice(0, MAX_ANSWER)}\n(cut off after ${MAX_ANSWER} characters)` : text;
  }
  return { status: response.status, headers: answerHeaders, body: answer, hidden, host: pin.host, path: url.pathname };
}
