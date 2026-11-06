/**
 * Live-socket tickets for tests: an in-memory `LIVE_TICKET` namespace and the
 * subprotocol header a socket offers (`src/live/ticket.js`).
 */
import { LiveTicketObject, sealTicket } from "../src/live/ticket.js";

/** An in-memory Durable Object namespace of `LiveTicketObject`s, one per name. */
export function ticketNamespace() {
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


/** The `Sec-WebSocket-Protocol` a socket at `socket` offers, with a fresh ticket for `token`. */
export async function ticketProtocols(env, { token, socket, protocol, slug = null }) {
  const sealed = await sealTicket(env, { token, socket, slug });
  return `${protocol}, context.ticket.${sealed.ticket}`;
}
