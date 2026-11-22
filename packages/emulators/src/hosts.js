import { ROUTES } from "./routes.js";

/**
 * Where a request to a real outside API goes instead, when emulators stand in.
 *
 * Returns the emulator URL for `realUrl` under `emulatorsOrigin`, or null when
 * no emulator covers that host or path (the caller then refuses the call
 * rather than reach the real service from a sandbox). Query and hash are kept.
 */
export function emulatedUrl(realUrl, emulatorsOrigin, services = ROUTES) {
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
export function emulatedHosts(services = ROUTES) {
  return [...new Set(services.flatMap((s) => s.hosts.map((h) => h.host)))];
}

/**
 * A `fetch` that sends every call to a host some emulator covers to the
 * emulators at `emulatorsOrigin` instead, and refuses (a 502 naming the host,
 * never a real call) one whose path no emulator covers. Every other host goes
 * to `realFetch` untouched.
 *
 * The origin must be a preview's own emulators Worker or a local one: anything
 * else throws, so a mistyped setting can never hand Google's traffic, tokens
 * included, to some other server.
 */
export function emulatingFetch(realFetch, emulatorsOrigin, services = ROUTES) {
  const origin = checkedOrigin(emulatorsOrigin);
  const hosts = new Set(emulatedHosts(services));
  return async function fetchThroughEmulators(input, init) {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    if (!hosts.has(url.hostname)) return realFetch(input, init);
    const to = emulatedUrl(url.href, origin, services);
    if (!to) {
      return new Response(JSON.stringify({ error: { code: 502, status: "NO_EMULATOR", message: `No emulator covers ${url.hostname}${url.pathname} yet (packages/emulators).` } }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(request ? new Request(to, request) : to, init);
  };
}

/** `https://context-emulators-pr<N>.<sub>.workers.dev`, or http(s) on localhost / 127.0.0.1. */
export function checkedOrigin(value) {
  const url = new URL(value);
  const local = (url.hostname === "localhost" || url.hostname === "127.0.0.1") && (url.protocol === "http:" || url.protocol === "https:");
  const preview = url.protocol === "https:" && /^context-emulators-pr[1-9][0-9]{0,6}\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) && !url.port;
  if (!(local || preview) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("The emulators origin must be a preview's context-emulators-pr<N> Worker or localhost.");
  }
  return url.origin;
}
