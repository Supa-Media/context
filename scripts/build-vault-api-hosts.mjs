#!/usr/bin/env node
/**
 * Vendor the list of API websites the vault's save form suggests as a person
 * types where a key may be sent.
 *
 *     NODE_USE_ENV_PROXY=1 node scripts/build-vault-api-hosts.mjs   (behind a proxy)
 *     node scripts/build-vault-api-hosts.mjs
 *
 * The source is the APIs.guru OpenAPI directory (CC0), read from its published
 * `gh-pages` branch: the list of every API, then the top of each API's
 * preferred spec, where its server address is (`servers[0].url`, or Swagger
 * 2's `host`). Only the first bytes of each spec are fetched; an address that
 * sits deeper, or has a `{placeholder}` in it, is left out rather than guessed.
 *
 * Hand-picked APIs live in `apiHostsTop.ts`, rank first, and are left out of
 * this file so each host is listed once. Hosts the server would refuse to pin
 * a key to (anyone can publish under them, `apps/mcp/src/vault/proxy.js`) and
 * hosts that are not on the internet are dropped here too, so a suggestion is
 * never one Save turns down.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://raw.githubusercontent.com/APIs-guru/openapi-directory/gh-pages/v2";
const HEAD_BYTES = 80_000;
const PARALLEL = 16;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const vault = join(root, "apps", "mobile", "features", "vault");
const out = join(vault, "apiHosts.generated.ts");

/** The suffixes `proxy.js` refuses, read from its source so the two never drift. */
function sharedSuffixes() {
  const source = readFileSync(join(root, "apps", "mcp", "src", "vault", "proxy.js"), "utf8");
  const block = source.match(/const SHARED_SUFFIXES = \[([\s\S]*?)\];/);
  if (!block) throw new Error("SHARED_SUFFIXES not found in proxy.js");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function topHosts() {
  const source = readFileSync(join(vault, "apiHostsTop.ts"), "utf8");
  return new Set([...source.matchAll(/^\s*\["([^"]+)",/gm)].map((m) => m[1]));
}

/** The API's own host from the top of its spec, or null. */
export function specHost(text) {
  const servers = text.match(/"servers"\s*:\s*\[\s*\{[^\]]*?"url"\s*:\s*"([^"]+)"/s);
  if (servers) {
    const url = servers[1];
    if (!/^https?:\/\//i.test(url)) return null;
    const host = url.replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
    return host.includes("{") ? null : host.split(":")[0].toLowerCase();
  }
  const swagger = text.match(/\n\s*"host"\s*:\s*"([^"]+)"/);
  return swagger && !swagger[1].includes("{") ? swagger[1].split(":")[0].toLowerCase() : null;
}

/** Whether a host is one a key could be pinned to and a person would type. */
export function keepHost(host, shared) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return false;
  if (/^[0-9.]+$/.test(host)) return false;
  if (/(^|\.)(localhost|local|test|example|internal|invalid|lan)$/.test(host)) return false;
  if (/(^|\.)example\.(com|org|net)$/.test(host)) return false;
  if (/\.convex\.(cloud|site)$/.test(host)) return false;
  // A placeholder for the person's own account, or a vendor's demo server.
  if (/(^|[.-])(your|yourdomain|accountname|demo|mock|sandbox-demo)([.-]|$)/.test(host)) return false;
  return !shared.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** A title fit to show: printable ASCII, no trailing version, at most 60 characters. */
export function cleanTitle(title) {
  const plain = String(title)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/\s+v?\d+(\.\d+)*$/i, "")
    .trim();
  if (/https?:|www\./i.test(plain)) return "";
  return plain.length > 60 ? `${plain.slice(0, 57).trimEnd()}...` : plain;
}

async function head(url) {
  const response = await fetch(url, { headers: { range: `bytes=0-${HEAD_BYTES - 1}` } });
  if (!response.ok) return "";
  return (await response.text()).slice(0, HEAD_BYTES);
}

async function main() {
  const listText = await (await fetch(`${BASE}/list.json`)).text();
  const sha = createHash("sha256").update(listText).digest("hex");
  const list = JSON.parse(listText);
  const shared = sharedSuffixes();
  const top = topHosts();
  const jobs = Object.entries(list).map(([key, api]) => {
    const version = api.versions[api.preferred];
    const name = version.openapiVer?.startsWith("3") ? "openapi.json" : "swagger.json";
    const path = key.includes(":") ? key.replace(":", "/") : key;
    return { key, title: version.info?.title ?? key, url: `${BASE}/specs/${path}/${api.preferred}/${name}` };
  });
  const found = new Map();
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const host = specHost(await head(job.url).catch(() => ""));
      if (host === null || !keepHost(host, shared) || top.has(host)) continue;
      const title = cleanTitle(job.title) || host;
      const known = found.get(host);
      if (known === undefined || title.length < known.length) found.set(host, title);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const rows = [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = rows.map(([host, title]) => `${host}|${title.replace(/\|/g, "/")}`).join("\n");
  writeFileSync(
    out,
    `/**
 * Generated by scripts/build-vault-api-hosts.mjs: do not edit by hand.
 * ${rows.length} API websites from the APIs.guru OpenAPI directory (CC0),
 * list.json sha256 ${sha}.
 * One "host|title" per line; hand-picked APIs are in apiHostsTop.ts.
 */

export const DIRECTORY_APIS = \`${body.replace(/[`\\$]/g, "")}\`;
`,
  );
  console.log(`wrote ${rows.length} hosts to ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
