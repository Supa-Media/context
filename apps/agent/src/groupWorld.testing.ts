/** A group chat and its fakes (Sendblue, Whapi, decide, the control plane, the gateway) for the group tests. */

import type { GroupDeps } from "./groupInbox";
import type { GroupMessage } from "./sendblueGroups";
import type { MemoryStorage } from "./memoryStorage.testing";
import { keptEvents, type TexEvent } from "./events";
import { whapiGroupId } from "./whapi";
import type { Fetch } from "./clients";

export const LINE = "+15555550199";
export const ADA = "+15555550101";
export const BO = "+15555550102";
export const CY = "+15555550103";
const JID = "120363012345678901@g.us";
export const LINES = [
  { name: "iMessage (Sendblue)", groupId: "11111111-2222-3333-4444-555555555555" },
  { name: "WhatsApp (Whapi)", groupId: whapiGroupId(JID) },
];

export type Decide = { style: string; candidates: string[]; newest: string; running: boolean; transcript: string; line?: string; waitingAsks: string[] };
export type Answer = { ok: true; act: "silent" | "react" | "answer"; covers: string[]; midTurn?: string; stale: string[]; movedOn: boolean; confidence: number } | { ok: false; reason: string };

export const answerAll = (body: Decide): Answer => ({ ok: true, act: "answer", covers: body.candidates, stale: [], movedOn: false, confidence: 0.9 });
export const silent = (): Answer => ({ ok: true, act: "silent", covers: [], stale: [], movedOn: false, confidence: 0.9 });

export function setup(
  groupId: string,
  opts: {
    decide?: (body: Decide) => Answer;
    control?: Record<string, unknown>;
    controlFor?: (body: Record<string, unknown>) => Record<string, unknown> | undefined;
    agent?: (body: Record<string, unknown>) => unknown;
    hold?: boolean;
    members?: string[][];
    /** What `/agent/cancel` says it did. */
    cancelled?: boolean;
    /** Decide waits for this before it answers (a slow decide). */
    decideWait?: () => Promise<void>;
  } = {},
) {
  const decided: Decide[] = [];
  const asks: Record<string, unknown>[] = [];
  const control: Record<string, unknown>[] = [];
  const engagement: Record<string, unknown>[] = [];
  const events: { conversation: unknown; events: TexEvent[] }[] = [];
  const steers: Record<string, unknown>[] = [];
  const cancels: Record<string, unknown>[] = [];
  const stale: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const reactions: string[] = [];
  let reads = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = () => {};
  const running = new Promise<void>((resolve) => (started = resolve));
  const members = () => (opts.members ?? [[ADA, BO]])[Math.min(reads++, (opts.members ?? [[ADA, BO]]).length - 1)];
  const handleOf = (phone: unknown) => (phone === ADA ? "ada" : phone === BO ? "bo" : "cy");
  const fetcher = (async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    // Sendblue
    if (path.startsWith("/api/v2/groups/")) return Response.json({ data: { participants: members().map((number) => ({ number })) } });
    if (path === "/api/send-group-message") {
      texts.push(body.content ?? body.media_url);
      return Response.json({ message_handle: `h_out_${texts.length}` });
    }
    if (path === "/api/send-reaction") {
      reactions.push(body.reaction);
      return Response.json({});
    }
    // Whapi
    if (parsed.host === "gate.whapi.cloud") {
      if (path.startsWith("/groups/")) return Response.json({ participants: members().map((phone) => ({ id: `${phone.slice(1)}@s.whatsapp.net` })) });
      if (path.endsWith("/reaction")) {
        reactions.push(body.emoji);
        return Response.json({ success: true });
      }
      if (path.startsWith("/messages/")) {
        texts.push(body.body ?? body.media);
        return Response.json({ sent: true, message: { id: `wa_out_${texts.length}` } });
      }
    }
    if (path === "/agent-texts/decide") {
      decided.push(body);
      await opts.decideWait?.();
      return Response.json((opts.decide ?? answerAll)(body));
    }
    if (path === "/agent-texts/group/engagement") {
      engagement.push(body);
      return Response.json({ ok: true });
    }
    if (path === "/agent-texts/group") {
      control.push(body);
      const only = opts.controlFor?.(body);
      if (only) return Response.json(only);
      return Response.json({
        status: "ready",
        slug: "band",
        intro: false,
        timeZone: "UTC",
        handle: handleOf(body.sender),
        accessToken: "cat_group",
        names: [
          { phone: ADA, handle: "ada" },
          { phone: BO, handle: "bo" },
        ],
        ...(opts.control ?? {}),
        // Chosen once a member chose, as the control plane's row says.
        ...(engagement.length > 0 ? { engagementChosen: true } : {}),
      });
    }
    if (path === "/agent/events") {
      events.push(body);
      return Response.json({ written: body.events.map((event: TexEvent) => event.id) });
    }
    if (path === "/agent/steer") {
      steers.push(body);
      return Response.json({ queued: true });
    }
    if (path === "/agent/cancel") {
      cancels.push(body);
      return Response.json({ cancelled: opts.cancelled ?? true });
    }
    if (path === "/agent/stale") {
      stale.push(body);
      return Response.json({ disarmed: body.asks.length });
    }
    if (path === "/agent") {
      asks.push(body);
      if (opts.hold && asks.length === 1) {
        started();
        await held;
      }
      const took = steers.filter((steer) => steer.turn === body.turn);
      return Response.json(opts.agent?.(body) ?? { answer: `answer to ${body.question}`, ...(took.length > 0 ? { steered: took.map((steer) => steer.id) } : {}) });
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as Fetch;
  const deps: GroupDeps = {
    fetch: fetcher,
    controlPlaneOrigin: "https://control.example.test",
    workerSecret: "secret",
    gatewayOrigin: "https://gateway.example.test",
    sendblue: { keyId: "id", secret: "key" },
    whapi: { token: "wt", line: LINE },
    hostPicture: async (picture) => `https://agent.example.test/media/${picture.name}`,
    now: () => 1_000,
  };
  let n = 0;
  const message = (text: string, extra: Partial<GroupMessage> = {}): GroupMessage => ({
    kind: "group-message",
    eventId: `ev_${++n}`,
    groupId,
    line: LINE,
    from: ADA,
    participants: [ADA, BO, LINE],
    messageId: `in_${n}`,
    text,
    ...extra,
  });
  return { deps, decided, asks, control, engagement, events, steers, cancels, stale, texts, reactions, release, running, message };
}

/** The words of each candidate decide was shown at the drain (not mid-turn). */
export async function decidedWords(storage: MemoryStorage, w: ReturnType<typeof setup>, groupId: string): Promise<string[]> {
  const byId = new Map((await keptEvents(storage, groupId)).map((event) => [event.id, event.text ?? ""]));
  return w.decided.filter((body) => !body.running).flatMap((body) => body.candidates.map((id) => byId.get(id) ?? "?"));
}

