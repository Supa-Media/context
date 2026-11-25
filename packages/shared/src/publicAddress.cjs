"use strict";

/**
 * Whether an address someone typed is a public https one, and whether an
 * address DNS answered is a public one. Shared by the gateway's fetch-from-URL
 * data source (`apps/mcp/src/data/fetch/url.js`) and the control plane's bot
 * webhooks (`apps/convex/functions/botHooks.ts`): both call an address a
 * person wrote, so both assume it is hostile and refuse anything that would
 * reach a private network.
 */

/** A public https address, or null. */
function publicHttps(raw) {
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
function isPrivateAddress(ip) {
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

module.exports = { publicHttps, isPrivateAddress };
