import { check, env, accessTokenFor, worker } from "./harness.mjs";
import { LiveTicketObject, openTicket, redeemTicket, sealTicket, TICKET_TTL_MS } from "../src/live/ticket.js";
import { resolvePresentedSession } from "../src/http/presentedToken.js";
import { createControlPlane } from "../src/controlPlane.js";
import { SessionRefusal } from "../src/session.js";

/**
 * Live-socket tickets (`src/live/ticket.js`): the app's sockets open on a
 * one-use, one-minute ticket minted over an authenticated POST, never on a
 * token. A ticket is refused, as a bad token is, when it is spent, expired,
 * forged, or for another socket or selector; and a ticket that is refused is
 * never passed over for a token offered beside it.
 *
 * Sabotage (temporary local edits, reverted): making `LiveTicketObject.fetch`
 * answer 200 on every spend fails "a spent ticket is refused"; dropping the
 * `body.e <= now` test fails "an expired ticket is refused"; dropping the
 * `body.p !== socket` test fails "a ticket for the tree socket opens no presence socket".
 */

/** An in-memory Durable Object namespace of `LiveTicketObject`s, one per name. */
function ticketNamespace() {
  const objects = new Map();
  const storageFor = () => {
    const values = new Map();
    let alarm = null;
    return {
      values,
      get alarmAt() { return alarm; },
      async get(key) { return values.get(key); },
      async put(key, value) { values.set(key, value); },
      async setAlarm(at) { alarm = at; },
      async deleteAll() { values.clear(); },
    };
  };
  return {
    objects,
    idFromName: (name) => name,
    get(id) {
      if (!objects.has(id)) objects.set(id, new LiveTicketObject({ storage: storageFor() }));
      const object = objects.get(id);
      return { fetch: (request) => object.fetch(request) };
    },
  };
}

const refused = async (work) => {
  try {
    await work();
    return false;
  } catch (error) {
    return error instanceof SessionRefusal && error.status === 401;
  }
};

export async function runLiveTicketChecks() {
  const token = accessTokenFor("priv-token");
  const ticketEnv = { ...env, LIVE_TICKET: ticketNamespace() };

  /* ---------------------------- sealing ---------------------------- */
  const sealed = await sealTicket(ticketEnv, { token, socket: "/presence", slug: null });
  check("a ticket is minted", typeof sealed?.ticket === "string" && sealed.ticket.startsWith("t1."));
  check("the token never shows in the ticket", !sealed.ticket.includes(token));
  check("a ticket is a valid subprotocol token", /^[A-Za-z0-9._~-]+$/.test(sealed.ticket));
  check("a ticket expires within a minute", sealed.expiresAt - Date.now() <= TICKET_TTL_MS);
  check("a ticket opens for its own socket", (await openTicket(ticketEnv, sealed.ticket, { socket: "/presence", slug: null }))?.token === token);
  check("a ticket for presence opens no tree socket", (await openTicket(ticketEnv, sealed.ticket, { socket: "/presence/tree", slug: null })) === null);
  check("a ticket for no selector opens under none other", (await openTicket(ticketEnv, sealed.ticket, { socket: "/presence", slug: "someone" })) === null);
  check("an expired ticket does not open", (await openTicket(ticketEnv, sealed.ticket, { socket: "/presence", slug: null }, sealed.expiresAt)) === null);
  const flipped = sealed.ticket.slice(0, -2) + (sealed.ticket.at(-2) === "A" ? "B" : "A") + sealed.ticket.at(-1);
  check("a tampered ticket does not open", (await openTicket(ticketEnv, flipped, { socket: "/presence", slug: null })) === null);
  check("a ticket sealed under another secret does not open", (await openTicket({ ...ticketEnv, GATEWAY_SECRET: "another-secret-entirely-0000" }, sealed.ticket, { socket: "/presence", slug: null })) === null);
  check("no secret, no ticket", (await sealTicket({}, { token, socket: "/presence", slug: null })) === null);

  /* ----------------------------- spending ---------------------------- */
  const controlPlane = createControlPlane(ticketEnv);
  const session = await redeemTicket(ticketEnv, sealed.ticket, { socket: "/presence", slug: null, controlPlane });
  check("a fresh ticket opens the token's own session", typeof session?.workspaceId === "string");
  check("a spent ticket is refused", await refused(() => redeemTicket(ticketEnv, sealed.ticket, { socket: "/presence", slug: null, controlPlane })));
  const spentObject = [...ticketEnv.LIVE_TICKET.objects.values()][0];
  check("the spent mark is set to be deleted", Number.isFinite(spentObject.state.storage.alarmAt));
  await spentObject.alarm();
  check("and the alarm deletes it", spentObject.state.storage.values.size === 0);

  const late = await sealTicket(ticketEnv, { token, socket: "/presence", slug: null }, Date.now() - TICKET_TTL_MS - 1);
  check("an expired ticket is refused", await refused(() => redeemTicket(ticketEnv, late.ticket, { socket: "/presence", slug: null, controlPlane })));
  check("an expired ticket spends nothing", ticketEnv.LIVE_TICKET.objects.size === 1);

  const forTree = await sealTicket(ticketEnv, { token, socket: "/presence/tree", slug: null });
  check(
    "a ticket for the tree socket opens no presence socket",
    await refused(() => redeemTicket(ticketEnv, forTree.ticket, { socket: "/presence", slug: null, controlPlane })),
  );

  const revoked = await sealTicket(ticketEnv, { token: "not-a-live-token-0000000000", socket: "/presence", slug: null });
  check("a ticket is only as good as the token inside it", await refused(() => redeemTicket(ticketEnv, revoked.ticket, { socket: "/presence", slug: null, controlPlane })));

  const noObjects = await sealTicket(ticketEnv, { token, socket: "/presence", slug: null });
  check("without the ticket objects a ticket spends nowhere and opens nothing", await refused(() => redeemTicket({ ...ticketEnv, LIVE_TICKET: undefined }, noObjects.ticket, { socket: "/presence", slug: null, controlPlane })));

  /* --------------------- the socket's subprotocols --------------------- */
  const socketRequest = (protocols) => new Request("https://x/presence", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocols } });
  const fresh = await sealTicket(ticketEnv, { token, socket: "/presence", slug: null });
  const viaSocket = await resolvePresentedSession(socketRequest(`context.presence, context.ticket.${fresh.ticket}`), { pathToken: null, path: "/presence", slug: null, controlPlane, env: ticketEnv });
  check("a socket offering a ticket is answered by it", typeof viaSocket?.workspaceId === "string");
  check(
    "a refused ticket is not passed over for a token offered beside it",
    await refused(() => resolvePresentedSession(socketRequest(`context.presence, context.ticket.${fresh.ticket}, context.token.${token}`), { pathToken: null, path: "/presence", slug: null, controlPlane, env: ticketEnv })),
  );

  /* ------------------------------ minting ------------------------------ */
  const mint = (headers, body) =>
    worker.fetch(new Request("https://x/presence/ticket", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), ticketEnv, { waitUntil() {} });
  const minted = await mint({ Authorization: `Bearer ${token}` }, { socket: "/presence/tree" });
  const mintedBody = await minted.json();
  check("POST /presence/ticket mints a ticket for a live token", minted.status === 200 && typeof mintedBody.ticket === "string");
  check("for the socket it named", (await openTicket(ticketEnv, mintedBody.ticket, { socket: "/presence/tree", slug: null })) !== null);
  check("no token, no ticket", (await mint({}, { socket: "/presence" })).status === 401);
  check("a bad token, no ticket", (await mint({ Authorization: "Bearer not-a-live-token-0000000000" }, { socket: "/presence" })).status === 401);
  check("an oversized body mints nothing", (await mint({ Authorization: `Bearer ${token}` }, { socket: "/presence", pad: "x".repeat(2048) })).status === 413);
  check("a ticket only for the app's sockets", (await mint({ Authorization: `Bearer ${token}` }, { socket: "/mcp" })).status === 400);
  const viaPath = await worker.fetch(new Request(`https://x/t/${token}/presence/ticket`, { method: "POST", body: JSON.stringify({ socket: "/presence" }) }), ticketEnv, { waitUntil() {} });
  check("a token in the URL mints nothing", viaPath.status === 400);
  check("a GET mints nothing", (await worker.fetch(new Request("https://x/presence/ticket", { headers: { Authorization: `Bearer ${token}` } }), ticketEnv, { waitUntil() {} })).status === 405);
  check("a deployment without the ticket objects says so", (await worker.fetch(new Request("https://x/presence/ticket", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ socket: "/presence" }) }), env, { waitUntil() {} })).status === 501);
}
