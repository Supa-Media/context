/**
 * A test's stand-in for the gateway's `TexTexts` binding, answered by the test's own fake chat objects. Every chat lives
 * in the gateway (the Worker's SenderInbox class is deleted, 2026-11-25), so a test of the Worker's routes reaches its
 * fakes the way the Worker reaches the gateway: a hand-over (`/texts/arrive`, as `agent/textsArrive.js` answers it), a
 * call by name (`/texts/chat-call<path>`), by id (`/texts/chat-by-id/<id><path>`) and a job's (`/texts/job-call<path>`).
 *
 * The objects are read from `env.SENDER_INBOX` on every call, so a test that swaps it mid-way is followed.
 */

import type { TextsBinding } from "./gatewaySession";
import { inboxByName, objectById } from "./objectPlace";
import { isArrival } from "../gateway/texChat/arrival.js";

/** Where the chat object answers each kind of hand-over (`packages/tex/gateway/texChat.js` `ARRIVAL_PATHS`). */
const ARRIVAL_PATHS: Record<string, string> = { one: "/accept", react: "/react", group: "/group-accept", members: "/group-members-changed", edit: "/edit", joined: "/group-joined" };

export function gatewayOver(env: { SENDER_INBOX?: unknown }): TextsBinding {
  const objects = () => env.SENDER_INBOX as DurableObjectNamespace;
  const byName = (name: string) => inboxByName(objects(), name);
  return {
    async fetch(input: string, init: RequestInit = {}): Promise<Response> {
      const url = new URL(input);
      const name = new Headers(init.headers).get("x-inbox-name") ?? "";
      if (url.pathname === "/texts/arrive") {
        const body = JSON.parse(String(init.body)) as { kind: string; inbox: string; message: unknown; origin?: string };
        // The gateway's own shape check, so a body it would refuse is refused here too (a members change once sent
        // `message: null`, which the gateway answered 400 and the Worker 503, holding Photon's line behind it).
        if (!isArrival(body)) return Response.json({ error: "bad_body" }, { status: 400 });
        const origin = (body.kind === "one" || body.kind === "group") && typeof body.origin === "string" ? `?origin=${encodeURIComponent(body.origin)}` : "";
        const sent = body.kind === "members" ? { method: "POST" } : { method: "POST", body: JSON.stringify(body.message) };
        const answer = await byName(body.inbox).fetch(`https://inbox${ARRIVAL_PATHS[body.kind]}${origin}`, sent);
        const outcome = answer.ok ? ((await answer.json().catch(() => ({}))) as { outcome?: unknown }).outcome : undefined;
        return Response.json({ outcome: typeof outcome === "string" ? outcome : answer.ok ? "queued" : "failed" }, { status: answer.ok ? 200 : 503 });
      }
      for (const prefix of ["/texts/chat-call", "/texts/job-call"]) {
        if (url.pathname.startsWith(`${prefix}/`)) {
          const headers = new Headers(init.headers);
          headers.delete("x-inbox-name");
          // The fakes read a body as text, as the chat object's routes do.
          const body = init.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : init.body;
          return await byName(name).fetch(`https://inbox${url.pathname.slice(prefix.length)}${url.search}`, { ...init, headers, body });
        }
      }
      const byId = /^\/texts\/chat-by-id\/([0-9a-f]{64})(\/.*)$/.exec(url.pathname);
      if (byId !== null) {
        // An id the fakes do not hold is one the gateway never indexed: 404, as `texChat/byId.js` answers.
        const stub = objectById(objects(), byId[1]!);
        return stub === null ? Response.json({ error: "not_found" }, { status: 404 }) : await stub.fetch(`https://inbox${byId[2]}`);
      }
      return new Response(null, { status: 404 });
    },
  };
}

/** `env` with `GATEWAY_TEXTS` answered by its own `SENDER_INBOX` fakes, unless the test set one of its own. */
export function withGateway<T extends { SENDER_INBOX?: unknown; GATEWAY_TEXTS?: TextsBinding }>(env: T): T {
  if (env.GATEWAY_TEXTS === undefined) env.GATEWAY_TEXTS = gatewayOver(env);
  return env;
}
