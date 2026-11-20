/**
 * A Tex store ticket the control plane already opened, kept until that ticket's
 * own expiry (`functions/texStoreTickets.ts`). The door asks Convex on a miss
 * and again once the ticket is inside `TICKET_CACHE_MARGIN_MS` of expiry, so a
 * gateway clock a few seconds behind the control plane does not keep a ticket
 * Convex would already refuse.
 *
 * A live ticket is not revoked before it expires: mint deletes only expired
 * rows. Remembering one until that expiry is the same answer Convex would
 * give, and a ticket Convex does not know is never remembered.
 *
 * The key is the ticket's sha256, never the ticket. The value is the workspace
 * id and the owners Convex returned. The map is this isolate's. The Workers
 * cache, when this runtime has one, shares that answer with the other isolates
 * in this data center, which is where one copy's door calls land.
 */

/** Re-ask Convex this long before the ticket's own expiry. */
export const TICKET_CACHE_MARGIN_MS = 5_000;
/** How many open tickets one isolate remembers. The coldest is dropped past this. */
const MAX = 2_000;

/** @type {Map<string, {workspaceId: string, owners: string[], expiresAt: number}>} */
const memory = new Map();

export function forgetTickets() {
  memory.clear();
}

function fresh(row, now) {
  return !!row && typeof row.expiresAt === "number" && now < row.expiresAt - TICKET_CACHE_MARGIN_MS;
}

/** The open this isolate already holds, or null. */
export function rememberedTicket(hash, now) {
  const row = memory.get(hash);
  if (!fresh(row, now)) {
    if (row) memory.delete(hash);
    return null;
  }
  memory.delete(hash);
  memory.set(hash, row);
  return { workspaceId: row.workspaceId, owners: row.owners };
}

/** Remember `opened` until its expiry. A miss, or a ticket already inside the margin, is not kept. */
export function rememberTicket(hash, opened, now) {
  if (!opened || typeof opened.workspaceId !== "string" || !Array.isArray(opened.owners)) return;
  if (!fresh(opened, now)) return;
  memory.set(hash, { workspaceId: opened.workspaceId, owners: [...opened.owners], expiresAt: opened.expiresAt });
  while (memory.size > MAX) {
    const oldest = memory.keys().next().value;
    memory.delete(oldest);
  }
}

function cacheRequest(hash) {
  return new Request(`https://ticket-cache.context.internal/tex-store/${hash}`);
}

function sharedCache() {
  const caches = globalThis.caches;
  const cache = caches && caches.default;
  return cache && typeof cache.match === "function" && typeof cache.put === "function" ? cache : null;
}

/** This isolate's memory, then the data center's cache. */
export async function rememberedTicketShared(hash, now) {
  const local = rememberedTicket(hash, now);
  if (local) return local;
  const cache = sharedCache();
  if (cache === null) return null;
  let hit;
  try {
    hit = await cache.match(cacheRequest(hash));
  } catch {
    return null;
  }
  if (!hit) return null;
  let body;
  try {
    body = await hit.json();
  } catch {
    return null;
  }
  if (!fresh(body, now) || typeof body.workspaceId !== "string" || !Array.isArray(body.owners)) return null;
  rememberTicket(hash, body, now);
  return { workspaceId: body.workspaceId, owners: body.owners };
}

/** Keep `opened` here and, where the runtime has one, in the data center cache. */
export async function rememberTicketShared(hash, opened, now) {
  rememberTicket(hash, opened, now);
  const cache = sharedCache();
  if (cache === null || !fresh(opened, now)) return;
  const seconds = Math.max(1, Math.floor((opened.expiresAt - TICKET_CACHE_MARGIN_MS - now) / 1000));
  try {
    await cache.put(
      cacheRequest(hash),
      new Response(JSON.stringify({ workspaceId: opened.workspaceId, owners: opened.owners, expiresAt: opened.expiresAt }), {
        headers: { "Cache-Control": `max-age=${seconds}` },
      }),
    );
  } catch {
    // The isolate map still holds it.
  }
}
