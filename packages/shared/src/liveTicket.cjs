/**
 * Live-socket tickets, both sides (`apps/mcp/src/live/ticket.js` mints and
 * spends them). The app's sockets never carry an access token: the app trades
 * its token, in an `Authorization` header, for a one-use ticket that opens one
 * socket within a minute, and offers that ticket as a subprotocol.
 */

/** Where a ticket is minted: under `/presence`, beside the sockets it opens. */
const LIVE_TICKET_PATH = "/presence/ticket";
/** The subprotocol a socket offers its ticket in: `context.ticket.<ticket>`. */
const TICKET_PROTOCOL_PREFIX = "context.ticket.";

/** The subprotocols a socket offers: its protocol, and the ticket. */
function ticketProtocols(protocol, ticket) {
  return [protocol, `${TICKET_PROTOCOL_PREFIX}${ticket}`];
}

/**
 * A ticket for the socket at `socket` (its gateway path), minted with `token`.
 * Rejects on any refusal or failure, which every caller treats as a failed
 * connect: retried after a back-off, with a fresh token when it was refused.
 */
async function fetchLiveTicket({ gatewayOrigin, token, socket, fetch: fetchImpl }) {
  const run = fetchImpl ?? globalThis.fetch;
  const response = await run(new URL(LIVE_TICKET_PATH, gatewayOrigin).toString(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ socket }),
  });
  if (!response.ok) {
    const error = new Error(`live ticket refused (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  if (!body || typeof body.ticket !== "string" || !body.ticket) throw new Error("live ticket missing");
  return body.ticket;
}

module.exports = { LIVE_TICKET_PATH, TICKET_PROTOCOL_PREFIX, ticketProtocols, fetchLiveTicket };
