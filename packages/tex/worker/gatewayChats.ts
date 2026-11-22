/**
 * A chat's object as this Worker reaches it now that every chat lives in the gateway (part C of the runtime
 * simplification, Dev2 approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX): the gateway's `TexChat` of that
 * name, through `TexTexts` at `/texts/chat-call<path>` with the name in `x-inbox-name`, the door the Worker's moved
 * objects already passed calls through (`inboxMove.ts` `forward`). A chat still in the Worker is copied in on that
 * call; a group's directory entry (`group-key:`) is answered from the gateway's own copy (`texChat/directory.js`).
 *
 * Without the `GATEWAY_TEXTS` binding (self-hosting without the gateway's entrypoint) it is the Worker's own object,
 * as before. While the Worker's SenderInbox exists, a gateway that cannot hold the chat (a 501 or 503: its copy was
 * refused, the Worker's object being busy) or cannot be reached leaves the Worker's object answering, as a failed text
 * hand-over does (`handOver.ts`), so a lookup is never lost to a move that has not happened yet.
 */

import type { TextsBinding } from "./gatewaySession";
import { GATEWAY_CALL_PREFIX, INBOX_NAME_HEADER } from "./inboxMove";
import { inboxByName } from "./objectPlace";

export type ChatStub = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

export function chatInGateway(env: { SENDER_INBOX: DurableObjectNamespace; GATEWAY_TEXTS?: TextsBinding }, name: string): ChatStub {
  const binding = env.GATEWAY_TEXTS;
  if (binding === undefined) return inboxByName(env.SENDER_INBOX, name);
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set(INBOX_NAME_HEADER, name);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      const there = await binding.fetch(`${GATEWAY_CALL_PREFIX}${url.pathname}${url.search}`, { method: request.method, headers, body }).catch(() => null);
      if (there !== null && there.status !== 501 && there.status !== 503) return there;
      console.log(JSON.stringify({ event: "chat_in_gateway", outcome: "worker", status: there?.status ?? 0 }));
      return await inboxByName(env.SENDER_INBOX, name).fetch(request.url, { method: request.method, headers: request.headers, body });
    },
  };
}

/**
 * The Worker's `SENDER_INBOX` as its readers should see it now: a namespace whose every object is the gateway's chat of
 * that name (`chatInGateway`), so code written against the namespace (`inboxByName`, `objectByName`) reaches the
 * gateway unchanged. A name placed as `enam:<name>` is the chat `<name>`. Without the `GATEWAY_TEXTS` binding it is the
 * Worker's own namespace (self-hosting). Only reads by name go here: an object reached by its id (`objectById`, a
 * picture's or a page's address) is still the Worker's, which passes the call on.
 */
export function chatNamespace(env: { SENDER_INBOX: DurableObjectNamespace; GATEWAY_TEXTS?: TextsBinding }): DurableObjectNamespace {
  if (env.GATEWAY_TEXTS === undefined) return env.SENDER_INBOX;
  const bare = (name: string) => (name.startsWith("enam:") ? name.slice("enam:".length) : name);
  return {
    idFromName: (name: string) => ({ name, toString: () => "", equals: () => false }),
    idFromString: () => {
      throw new TypeError("a chat in the gateway is reached by name");
    },
    newUniqueId: () => {
      throw new TypeError("a chat in the gateway is reached by name");
    },
    get: (id: { name?: string }) => chatInGateway(env, bare(String(id.name ?? ""))),
    getByName: (name: string) => chatInGateway(env, bare(name)),
    jurisdiction: () => {
      throw new TypeError("a chat in the gateway has no jurisdiction here");
    },
  } as unknown as DurableObjectNamespace;
}

/**
 * A call to a chat by the id its addresses carry (`/media/<id>/<token>`, `/threads/<id>/<token>`): the gateway's index
 * names the chat (`packages/tex/gateway/texChat/byId.js`), and the chat answers there. An id the gateway has not
 * indexed, or a gateway that cannot be reached, is asked of the Worker's object of that id while it exists, which
 * passes a moved chat's call on as before. Without the `GATEWAY_TEXTS` binding it is the Worker's object alone.
 */
export async function chatByIdInGateway(
  env: { SENDER_INBOX: DurableObjectNamespace; GATEWAY_TEXTS?: TextsBinding },
  id: string,
  path: string,
  worker: () => Promise<Response>,
): Promise<Response> {
  const binding = env.GATEWAY_TEXTS;
  if (binding === undefined) return await worker();
  const there = await binding.fetch(`https://gateway/texts/chat-by-id/${id}${path}`, { method: "GET" }).catch(() => null);
  if (there !== null && there.ok) return there;
  console.log(JSON.stringify({ event: "chat_by_id", outcome: "worker", status: there?.status ?? 0 }));
  return await worker();
}
