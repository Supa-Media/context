/**
 * A chat's object as this Worker reaches it now that every chat lives in the gateway (part C of the runtime
 * simplification, Dev2 approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX): the gateway's `TexChat` of that
 * name, through `TexTexts` at `/texts/chat-call<path>` with the name in `x-inbox-name`, the door the Worker's moved
 * objects already passed calls through (`inboxMove.ts` `forward`). A chat still in the Worker is copied in on that
 * call; a group's directory entry (`group-key:`) is answered from the gateway's own copy (`texChat/directory.js`).
 *
 * Without the `GATEWAY_TEXTS` binding (self-hosting without the gateway's entrypoint) it is the Worker's own object,
 * as before.
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
      return await binding.fetch(`${GATEWAY_CALL_PREFIX}${url.pathname}${url.search}`, { method: request.method, headers, body });
    },
  };
}
