/**
 * A chat's object as this Worker reaches it: every chat lives in the gateway (part C of the runtime simplification,
 * Dev2 approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX; the Worker's SenderInbox class is deleted,
 * 2026-11-25). It is the gateway's `TexChat` of that name, through `TexTexts` at `/texts/chat-call<path>` with the name
 * in `x-inbox-name`; a group's directory entry (`group-key:`) is answered from its own gateway object
 * (`texChat/directory.js`). A gateway that cannot be reached answers 503, and one not bound 501: there is no other copy.
 */

import type { TextsBinding } from "./gatewaySession";

/** The gateway's door for a call to a chat by its name (`packages/tex/gateway/agent/textsArrive.js`). */
export const GATEWAY_CALL_PREFIX = "https://gateway/texts/chat-call";
/** The header a chat's name travels in to the gateway. */
export const INBOX_NAME_HEADER = "x-inbox-name";

export type ChatStub = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
/** What this Worker needs to reach a chat: the gateway's `TexTexts`. */
export type ChatsEnv = { GATEWAY_TEXTS?: TextsBinding };

export function chatInGateway(env: ChatsEnv, name: string): ChatStub {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const binding = env.GATEWAY_TEXTS;
      if (binding === undefined) return new Response(null, { status: 501 });
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set(INBOX_NAME_HEADER, name);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      const there = await binding.fetch(`${GATEWAY_CALL_PREFIX}${url.pathname}${url.search}`, { method: request.method, headers, body }).catch(() => null);
      if (there !== null) return there;
      console.log(JSON.stringify({ event: "chat_in_gateway", outcome: "unreachable" }));
      return new Response(null, { status: 503 });
    },
  };
}

/**
 * The chats as a namespace (`inboxByName`, `objectByName`, `groupMovedTo` are written against one): its every object is
 * the gateway's chat of that name (`chatInGateway`). A name placed as `enam:<name>` is the chat `<name>`. Reached by
 * name only: an address that carries a chat's id goes to `chatByIdInGateway`.
 */
export function chatNamespace(env: ChatsEnv): DurableObjectNamespace {
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
 * names the chat (`packages/tex/gateway/texChat/byId.js`), and the chat answers there. An id it has not indexed is 404.
 */
export async function chatByIdInGateway(env: ChatsEnv, id: string, path: string): Promise<Response> {
  const binding = env.GATEWAY_TEXTS;
  if (binding === undefined) return new Response(null, { status: 404 });
  const there = await binding.fetch(`https://gateway/texts/chat-by-id/${id}${path}`, { method: "GET" }).catch(() => null);
  if (there === null) {
    console.log(JSON.stringify({ event: "chat_by_id", outcome: "unreachable" }));
    return new Response(null, { status: 503 });
  }
  return there.ok ? there : new Response(null, { status: 404 });
}
