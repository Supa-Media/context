/**
 * Fetch from a URL: a source that reads one public address on its schedule
 * and keeps what it answers as a dataset sheet (stage G of
 * `docs/decisions/data-and-metrics.md`). The address is written by an editor,
 * so everything here assumes it is hostile.
 *
 * - **https only, on a public name**: no user or password, the default port,
 *   no IP literal, no single-label or local name (the same lock as
 *   `packages/tex/worker/pagePicture.ts` and the site reader).
 * - **The name must resolve only to public addresses**, asked over DNS over
 *   HTTPS before the fetch: one private, loopback, link-local, shared,
 *   documentation or multicast answer refuses it. The Workers runtime also
 *   refuses private addresses itself; this is the check we can test.
 * - **No redirects.** A 3xx is refused, so a public name cannot hand the
 *   fetch on to one that was never checked.
 * - **Bounded**: at most `MAX_FETCH_BYTES`, `FETCH_TIMEOUT_MS`, and the
 *   sheet's own row bound. Nothing is sent but an agent name and what is
 *   accepted: no cookie, no key, no credential.
 * - **What it reads**: CSV (a sheet's own header, `name:type`), or JSON that
 *   is an array of flat objects. Every value becomes a cell, which an agent
 *   reads as a quotation, never as an instruction.
 */

import { MAX_SHEET_BYTES, MAX_SHEET_ROWS, cellText, dateMs, parseSheet } from "../../sheets/csv.js";

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_FETCH_BYTES = MAX_SHEET_BYTES;
export const MAX_FETCH_COLUMNS = 64;
export const FETCH_USER_AGENT = "ContextDataSource/1.0 (+https://context.lc)";
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

/** A public https address, or null. */
export function publicHttps(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return null;
  if (/(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa|intranet|lan|corp)$/.test(host)) return null;
  return url;
}

const V4_PRIVATE = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4Number(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

function v4Private(ip) {
  const n = v4Number(ip);
  if (n === null) return true;
  return V4_PRIVATE.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)));
}

/** An IPv6 address as eight 16-bit groups, or null. */
function v6Groups(ip) {
  let text = ip.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const n = v4Number(tail[1]);
    if (n === null) return null;
    text = `${text.slice(0, -tail[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - back.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill("0"), ...back];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** Whether an address answered by DNS is anything but a public one. Anything unreadable counts as private. */
export function isPrivateAddress(ip) {
  const text = String(ip ?? "").trim();
  if (text.includes(":")) {
    const g = v6Groups(text);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return v4Private(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // mapped / compatible v4
    }
    if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    if (g[0] === 0x2002) return true; // 6to4 wraps a v4 address it would be checked as
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
    return false;
  }
  return v4Private(text);
}

/** Asks Cloudflare's DNS over HTTPS for A and AAAA; → the addresses, or null when it could not be asked. */
export function dohResolver(fetcher = fetch) {
  return async (host) => {
    const out = [];
    for (const type of ["A", "AAAA"]) {
      const res = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" } });
      if (!res.ok) return null;
      const body = await res.json();
      for (const answer of Array.isArray(body?.Answer) ? body.Answer : []) {
        if (answer?.type === 1 || answer?.type === 28) out.push(String(answer.data));
      }
    }
    return out;
  };
}

async function readUpTo(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

function columnName(raw) {
  const name = String(raw ?? "").trim();
  if (name === "" || RESERVED.has(name.toLowerCase()) || name.length > 100) return null;
  return name;
}

/** A JSON array of flat objects as a sheet; a column's type is `number` or `date` when every filled cell is one. */
export function jsonSheet(value) {
  if (!Array.isArray(value)) return { ok: false, refused: "the answer is JSON but not a list of rows" };
  if (value.length > MAX_SHEET_ROWS) return { ok: false, refused: `the answer has over ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows` };
  const names = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, refused: "every row in the answer must be an object" };
    for (const key of Object.keys(item)) {
      const name = columnName(key);
      if (name === null) return { ok: false, refused: `the answer has a column that can't be a name` };
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      names.push(name);
      if (names.length > MAX_FETCH_COLUMNS) return { ok: false, refused: `the answer has over ${MAX_FETCH_COLUMNS} columns` };
    }
  }
  const rows = value.map((item) => {
    const row = Object.create(null);
    for (const name of names) {
      const cell = Object.hasOwn(item, name) ? item[name] : "";
      row[name] = cell !== null && typeof cell === "object" ? JSON.stringify(cell) : cellText(cell ?? "");
    }
    return row;
  });
  const columns = names.map((name) => {
    const filled = rows.map((r) => r[name].trim()).filter((c) => c !== "");
    const type = !filled.length ? "text"
      : filled.every((c) => /^-?\d+(\.\d+)?$/.test(c)) ? "number"
      : filled.every((c) => Number.isFinite(dateMs(c))) ? "date" : "text";
    return { name, type };
  });
  return { ok: true, sheet: { columns, rows } };
}

/**
 * Read one address. → `{ ok: true, sheet }` or `{ ok: false, refused }`, a
 * plain sentence that never repeats what the address answered.
 * `fetcher` and `resolve` are injected so the refusals can be tested.
 */
export async function fetchDataset(raw, { fetcher = fetch, resolve = dohResolver(), timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_FETCH_BYTES } = {}) {
  const url = publicHttps(raw);
  if (!url) return { ok: false, refused: "the address must be https on a public name, with no port, login or IP address" };
  let addresses;
  try {
    addresses = await resolve(url.hostname);
  } catch {
    addresses = null;
  }
  if (!Array.isArray(addresses) || !addresses.length) return { ok: false, refused: `${url.hostname} could not be looked up` };
  if (addresses.some(isPrivateAddress)) return { ok: false, refused: `${url.hostname} points at a private address` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetcher(url.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": FETCH_USER_AGENT, accept: "text/csv, application/json;q=0.9" },
      });
    } catch {
      return { ok: false, refused: controller.signal.aborted ? `${url.hostname} took over ${timeoutMs / 1000} seconds` : `${url.hostname} could not be reached` };
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { ok: false, refused: `${url.hostname} redirects; give the address it ends at` };
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      return { ok: false, refused: `${url.hostname} answered ${response.status}` };
    }
    let text;
    try {
      text = await readUpTo(response, maxBytes);
    } catch {
      return { ok: false, refused: controller.signal.aborted ? `${url.hostname} took over ${timeoutMs / 1000} seconds` : `${url.hostname} stopped answering` };
    }
    if (text === null) return { ok: false, refused: `${url.hostname} answered over ${Math.round(maxBytes / 1024 / 1024)} MB` };
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    const trimmed = text.trimStart();
    if (type.includes("json") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return { ok: false, refused: `${url.hostname} answered JSON that could not be read` };
      }
      return jsonSheet(value);
    }
    const sheet = parseSheet(text);
    if (sheet.tooLarge) return { ok: false, refused: `${url.hostname} answered a sheet past the size a sheet can hold` };
    if (!sheet.columns.length) return { ok: false, refused: `${url.hostname} answered nothing that reads as a sheet` };
    if (sheet.columns.length > MAX_FETCH_COLUMNS) return { ok: false, refused: `the answer has over ${MAX_FETCH_COLUMNS} columns` };
    if (sheet.columns.some((c) => columnName(c.name) === null)) return { ok: false, refused: "the answer has a column that can't be a name" };
    return { ok: true, sheet: { columns: sheet.columns, rows: sheet.rows } };
  } finally {
    clearTimeout(timer);
  }
}
