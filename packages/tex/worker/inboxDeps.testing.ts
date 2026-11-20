/** The texting inbox tests' message and deps: a fake line, control plane and gateway (`inbox.test.ts`, `inboxLost.test.ts`). */
import type { InboxDeps } from "./inbox";
import type { Message } from "./reply";
import type { Fetch } from "./clients";

export const msg = (eventId: string, text = "hi"): Message => ({
  kind: "message",
  eventId,
  chatId: "chat_1",
  from: "+15555550100",
  messageId: `m_${eventId}`,
  text,
});

export type Sent = { text: string; idempotency: string };

export function deps(opts: {
  linqStatus?: () => number;
  sent?: Sent[];
  asks?: string[];
  /** Every `/agent` body, whole. */
  bodies?: Record<string, unknown>[];
  now?: number;
  unlinked?: boolean;
  events?: string[];
  typingStatus?: number;
  cards?: string[];
  /** Holds the contact card's request until it resolves: work after a reply that is slow. */
  cardGate?: Promise<unknown>;
  cardStatus?: number;
  readStatus?: number;
  progress?: string[];
  /** The status the stream's last line carries after its progress lines. */
  streamStatus?: () => number;
  agentStatus?: () => number;
  sessionStatus?: () => number;
  setup?: unknown;
  agentMs?: number;
  /** Holds the read receipt and the bubble until it resolves: a slow Sendblue. */
  presenceGate?: Promise<unknown>;
}): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    if (path.endsWith("/typing")) {
      // Slower than the answer, as Linq can be, so a bubble that is not
      // awaited would land after the reply and hang in the chat.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await opts.presenceGate;
      opts.events?.push("typing");
      return new Response(null, { status: opts.typingStatus ?? 204 });
    }
    if (path.endsWith("/read")) {
      await opts.presenceGate;
      opts.events?.push("read");
      return new Response("{}", { status: opts.readStatus ?? 200 });
    }
    if (path.endsWith("/share_contact_card")) {
      opts.cards?.push(path);
      await opts.cardGate;
      return new Response("{}", { status: opts.cardStatus ?? 200 });
    }
    if (path === "/agent-texts/session") {
      const status = opts.sessionStatus?.() ?? 200;
      if (status !== 200) return Response.json({}, { status });
      return Response.json(opts.unlinked ? { status: "unlinked" } : { status: "linked", accessToken: "t" });
    }
    // A phone nobody may set up by text (`setup.ts`) gets the sign-in link.
    if (path === "/agent-texts/setup") return Response.json(opts.setup ?? { status: "not_eligible" });
    if (path === "/agent-texts/invite") {
      return Response.json({ status: "issued", url: "https://app.example/texts/abc123" });
    }
    if (path === "/agent") {
      if (opts.presenceGate) opts.events?.push("ask"); // only where a test watches the order against a slow Sendblue
      opts.asks?.push(body.question);
      opts.bodies?.push(body);
      if (opts.agentMs) await new Promise((resolve) => setTimeout(resolve, opts.agentMs));
      const status = opts.agentStatus?.() ?? 200;
      if (status !== 200) return Response.json({ error: "model_unavailable" }, { status });
      if (opts.progress) {
        const last = opts.streamStatus?.() ?? 200;
        const lines = [...opts.progress.map((progress) => ({ progress })), last === 200 ? { status: 200, body: { answer: `answer to ${body.question}` } } : { status: last, body: { error: "model_unavailable" } }];
        return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      return Response.json({ answer: `answer to ${body.question}` });
    }
    if (path.endsWith("/messages")) {
      const status = opts.linqStatus?.() ?? 200;
      if (status < 300) opts.sent?.push({ text: body.message.parts[0].value, idempotency: body.message.idempotency_key });
      opts.events?.push("send");
      return new Response("{}", { status });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    linqApiKey: "k",
    now: () => opts.now ?? 1_000,
  };
}
