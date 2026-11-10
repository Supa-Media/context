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

export type Decide = { style: string; candidates: string[]; newest: string; running: boolean; transcript: string; line?: string; waitingAsks: string[]; addressed?: true };
export type Answer = { ok: true; act: "silent" | "react" | "answer" | "wait"; covers: string[]; midTurn?: string; stale: string[]; movedOn: boolean; confidence: number; emoji?: string; waitSeconds?: number } | { ok: false; reason: string };

export const answerAll = (body: Decide): Answer => ({ ok: true, act: "answer", covers: body.candidates, stale: [], movedOn: false, confidence: 0.9 });
export const silent = (): Answer => ({ ok: true, act: "silent", covers: [], stale: [], movedOn: false, confidence: 0.9 });
/** Decide answering what looks addressed to Tex (asked beside its turn, `decideBeside`) and silent on everything else. */
export const untaggedSilent = (body: Decide): Answer => (body.addressed ? answerAll(body) : silent());

export function setup(
  groupId: string,
  opts: {
    decide?: (body: Decide) => Answer;
    control?: Record<string, unknown>;
    controlFor?: (body: Record<string, unknown>) => Record<string, unknown> | undefined;
    agent?: (body: Record<string, unknown>) => unknown;
    hold?: boolean;
    /** One list per member read, the last repeated; `null` is that read failing. */
    members?: (string[] | null)[];
    /** What `/agent/cancel` says it did. */
    cancelled?: boolean;
    /** Decide waits for this before it answers (a slow decide). */
    decideWait?: () => Promise<void>;
    /** What `/agent-texts/recheck` answers (`groupRecheck.ts`); absent, the draft fits. */
    recheck?: (body: Record<string, unknown>) => unknown;
  } = {},
) {
  const decided: Decide[] = [];
  const rechecks: Record<string, unknown>[] = [];
  const asks: Record<string, unknown>[] = [];
  const control: Record<string, unknown>[] = [];
  const engagement: Record<string, unknown>[] = [];
  /** Each `/agent-texts/group/style` change, and the group's instructions as the control plane keeps them (`texStyle.ts`): a pick's line is `<id> line.` here. */
  const styles: Record<string, unknown>[] = [];
  let instructions = "";
  let before: string | undefined;
  /** Each `/agent-texts/review-sharing` asked (`reviewSharing.ts`). */
  const sharing: Record<string, unknown>[] = [];
  const events: { conversation: unknown; events: TexEvent[] }[] = [];
  const steers: Record<string, unknown>[] = [];
  const cancels: Record<string, unknown>[] = [];
  const stale: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const reactions: string[] = [];
  /** What each text went under: the answered message's handle, or undefined when it went plain (`groupSay.ts`). */
  const under: (string | undefined)[] = [];
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
    if (path.startsWith("/api/v2/groups/")) {
      const list = members();
      return list === null ? new Response("{}", { status: 404 }) : Response.json({ data: { participants: list.map((number) => ({ number })) } });
    }
    if (path === "/api/send-group-message") {
      texts.push(body.content ?? body.media_url);
      under.push(body.reply_to?.message_handle);
      return Response.json({ message_handle: `h_out_${texts.length}` });
    }
    if (path === "/api/send-reaction") {
      reactions.push(body.reaction);
      return Response.json({});
    }
    // Whapi
    if (parsed.host === "gate.whapi.cloud") {
      if (path.startsWith("/groups/")) {
        const list = members();
        return list === null ? new Response("{}", { status: 404 }) : Response.json({ participants: list.map((phone) => ({ id: `${phone.slice(1)}@s.whatsapp.net` })) });
      }
      if (path.endsWith("/reaction")) {
        reactions.push(body.emoji);
        return Response.json({ success: true });
      }
      if (path.startsWith("/messages/") && init?.method === "POST") { // a GET is the quoted message read, never a send
        texts.push(body.body ?? body.media);
        under.push(body.quoted);
        return Response.json({ sent: true, message: { id: `wa_out_${texts.length}` } });
      }
    }
    if (path === "/agent-texts/decide") {
      decided.push(body);
      // A slow decide is cut off by its own timeout, as a real fetch is (`post`'s AbortSignal).
      await Promise.race([opts.decideWait?.(), new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))]);
      return Response.json((opts.decide ?? answerAll)(body));
    }
    if (path === "/agent-texts/recheck") {
      rechecks.push(body);
      return Response.json(opts.recheck?.(body) ?? { ok: true, fits: true });
    }
    if (path === "/agent-texts/group/style") {
      styles.push(body);
      if (body.undo === true && before === undefined) return Response.json({ ok: false, refused: "nothing_to_undo" });
      const next = body.undo === true ? before! : body.clear === true ? "" : body.pick ? [instructions, `${body.pick} line.`].filter(Boolean).join("\n") : instructions;
      before = body.undo === true ? undefined : instructions;
      instructions = next;
      return Response.json({ ok: true, ...(instructions ? { instructions } : {}) });
    }
    if (path === "/agent-texts/review-sharing") {
      sharing.push(body);
      return Response.json({ status: "ok", sharing: body.share === true, changed: true, team: false, chatShared: false });
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
        ...(instructions ? { instructions } : {}),
      });
    }
    if (path === "/agent/events") {
      events.push(body);
      return Response.json({ written: body.events.map((event: TexEvent) => event.id) });
    }
    // The chat's ledger: what was posted to it (`chatRead.ts`).
    if (path === "/agent/chat") return Response.json({ events: posted().filter((event) => event.chat === body.conversation?.group) });
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
  /** Every event posted to the gateway, once each, in order. */
  function posted(): TexEvent[] {
    const byId = new Map<string, TexEvent>();
    for (const post of events) for (const event of post.events as TexEvent[]) if (!byId.has(event.id)) byId.set(event.id, event);
    return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
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
  return { deps, decided, rechecks, asks, control, engagement, styles, sharing, events, posted, steers, cancels, stale, texts, reactions, under, release, running, message };
}

/** The chat as it was logged: what the gateway took, and this object's outbox, oldest first (`chatRead.ts`). */
export async function chatLog(storage: MemoryStorage, w: { posted: () => TexEvent[] }, groupId: string): Promise<TexEvent[]> {
  const byId = new Map<string, TexEvent>();
  for (const event of [...w.posted().filter((one) => one.chat === groupId), ...(await keptEvents(storage, groupId))]) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The words of each candidate decide was shown at the drain (not mid-turn, nor beside an addressed turn). */
export async function decidedWords(storage: MemoryStorage, w: ReturnType<typeof setup>, groupId: string): Promise<string[]> {
  const byId = new Map((await chatLog(storage, w, groupId)).map((event) => [event.id, event.text ?? ""]));
  return w.decided.filter((body) => !body.running && !body.addressed).flatMap((body) => body.candidates.map((id) => byId.get(id) ?? "?"));
}

