/**
 * The group queue's test world (moved out of `groupInbox.test.ts` whole, so the test stays under its size limit): a
 * stand-in Sendblue, control plane, judge and gateway, with invented numbers.
 */
import { type GroupDeps } from "./groupInbox";
import { type GroupMessage } from "./sendblueGroups";
import type { Fetch } from "./clients";
import type { Decide } from "./groupWorld.testing";

export const LINE = "+15555550199";
export const ADA = "+15555550101";
export const BO = "+15555550102";
export const CY = "+15555550103";
export const GROUP = "11111111-2222-3333-4444-555555555555";

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 2, 0, 0, 0]);
export const PICTURE = { url: "https://cdn.sendblue.example/files/IMG_0001.png", mimeType: "", filename: "IMG_0001.png", size: null };

export const message = (text: string, extra: Partial<GroupMessage> = {}): GroupMessage => ({
  kind: "group-message",
  eventId: `sendblue:h_${text.length}_${extra.messageId ?? "x"}`,
  groupId: GROUP,
  line: LINE,
  from: ADA,
  participants: [ADA, BO, LINE],
  messageId: extra.messageId ?? "h_in",
  text,
  ...extra,
});

export type World = {
  sends: { content?: string; media_url?: string; reply_to?: unknown; from_number: string; group_id: string }[];
  control: Record<string, unknown>[];
  asks: Record<string, unknown>[];
  reactions: number;
  reacted: string[];
  members: (string[] | null)[] | null;
};

export function deps(
  world: World,
  answers: { control?: unknown; agent?: unknown; agentStatus?: number; stream?: string[]; decide?: (body: Decide) => unknown } = {},
): GroupDeps {
  let membersRead = 0;
  let handles = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    // A picture someone sent, on Sendblue's file host: a PNG's first bytes are enough to tell it.
    if (path.startsWith("/files/")) return new Response(PNG, { status: 200 });
    if (path.startsWith("/api/v2/groups/")) {
      if (world.members === null) return new Response("{}", { status: 404 });
      const list = world.members[Math.min(membersRead++, world.members.length - 1)];
      // A `null` entry is that read failing, which is not the same as nobody being there.
      if (list === null) return new Response("{}", { status: 404 });
      return Response.json({ data: { group_id: GROUP, participants: list.map((number) => ({ number })) } });
    }
    if (path.startsWith("/api/v2/messages/")) return Response.json({ group_id: GROUP, is_outbound: true, from_number: LINE, content: "Friday at 6." });
    const body = JSON.parse(String(init.body));
    if (path === "/api/send-group-message") {
      world.sends.push(body);
      return Response.json({ message_handle: `h_out_${++handles}` });
    }
    if (path === "/api/send-reaction") {
      world.reactions++;
      world.reacted.push(body.reaction);
      return Response.json({});
    }
    // The judge (`decide.ts`): a stand-in that answers what names Tex or replies to it (`coverTex`), unless a test says.
    if (path === "/agent-texts/decide") return Response.json((answers.decide ?? coverTex)(body));
    if (path === "/agent/events") return Response.json({ written: body.events.map((event: { id: string }) => event.id) });
    if (path === "/agent-texts/group") {
      world.control.push(body);
      return Response.json(answers.control ?? { status: "ready", slug: "band", intro: false, bound: false, timeZone: "UTC", handle: "ada", minted: true, accessToken: "cat_group" });
    }
    if (path === "/agent") {
      world.asks.push(body);
      if (answers.stream) {
        const lines = [...answers.stream.map((progress) => ({ progress })), { status: 200, body: answers.agent ?? { answer: "The opener." } }];
        return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
      }
      return Response.json(answers.agent ?? { answer: "The opener." }, { status: answers.agentStatus ?? 200 });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://control.example.test",
    workerSecret: "secret",
    gatewayOrigin: "https://gateway.example.test",
    sendblue: { keyId: "id", secret: "key" },
    hostPicture: async (picture) => `https://agent.example.test/media/${picture.name}`,
    now: () => 1_000,
  };
}

/**
 * A stand-in for the one judge here: it answers the waiting lines that name Tex or reply under its text, covering
 * only those, and is silent on the rest. A fake for the plumbing; the real judge has no word rule (`textDecide.cjs`).
 */
export function coverTex(body: Decide) {
  const words = (id: string) => (body.transcript.split("\n").find((line) => line.startsWith(`<${id}>`)) ?? "").replace(/^<[^>]+> (?:\[[^\]]*\] )?[^:]*:/, "");
  const covers = body.candidates.filter((id) => /(?:^|[^\w-])@?tex(?![\w-])|\(replying to You\)/i.test(words(id)));
  return { ok: true, act: covers.length > 0 ? "answer" : "silent", covers, stale: [], movedOn: false, confidence: 0.9 };
}

export const world = (members: (string[] | null)[] | null = [[ADA, BO]]): World => ({ sends: [], control: [], asks: [], reactions: 0, reacted: [], members });
