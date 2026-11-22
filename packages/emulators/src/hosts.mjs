import { SERVICES } from "./services.mjs";

/**
 * Where a request to a real outside API goes instead, when emulators stand in.
 *
 * Returns the emulator URL for `realUrl` under `emulatorsOrigin`, or null when
 * no emulator covers that host or path (the caller then refuses the call
 * rather than reach the real service from a sandbox). Query and hash are kept.
 */
export function emulatedUrl(realUrl, emulatorsOrigin, services = SERVICES) {
  const url = new URL(realUrl);
  if (url.protocol !== "https:") return null;
  const origin = new URL(emulatorsOrigin);
  for (const svc of services) {
    for (const rule of svc.hosts) {
      if (url.hostname !== rule.host || url.port) continue;
      if (!pathStarts(url.pathname, rule.from)) continue;
      const rest = url.pathname.slice(rule.from.length);
      const out = new URL(origin.href);
      out.pathname = `${origin.pathname.replace(/\/$/, "")}/${svc.name}${rule.to}${rest}`;
      out.search = url.search;
      out.hash = url.hash;
      return out.href;
    }
  }
  return null;
}

/** `/token` matches `/token` and `/token?..`, never `/tokens`; a `from` ending in `/` is a prefix. */
function pathStarts(pathname, from) {
  if (from.endsWith("/")) return pathname.startsWith(from) || pathname === from.slice(0, -1);
  return pathname === from;
}

/** Every real host some emulator stands in for. */
export function emulatedHosts(services = SERVICES) {
  return [...new Set(services.flatMap((s) => s.hosts.map((h) => h.host)))];
}
