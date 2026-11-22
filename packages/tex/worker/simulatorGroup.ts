/**
 * The texts simulator's group mode: a browser makes a simulated group of 2 to 8
 * 555-01XX numbers and speaks in it as any of them. A group's message enters
 * the same group queue a real group text does (`acceptGroup`, `groupInbox.ts`),
 * marked `channel: "simulator"`, and Tex's replies to it are written to the
 * group object's log by `simulatedGroupLine` (`simulatedGroup.ts`), never sent.
 *
 *     browser ──/texts-simulator/api/group/send──▶ this Worker ──▶ the group's object
 *                                                                   │ acceptGroup, alarm,
 *                                                                   ▼ answerGroup (groupLineFor → log)
 *     browser ◀──/texts-simulator/api/group/thread── the object's simulator log
 *
 * The first browser to use a group claims it with its key, as a 1:1 number is
 * claimed (`simulator.ts`). The group's id is minted here (`sim-group-` and 32
 * hex digits) unless the browser already has one.
 */

import type { TextsBinding } from "./gatewaySession";
import { cut } from "./inbound";
import { groupInboxName } from "./groupInbox";
import type { GroupMessage } from "./sendblueGroups";
import { inboxByName } from "./objectPlace";
import { chatNamespace } from "./gatewayChats";
import type { InboxStorage } from "./inbox";
import { claim, clear, record, SIMULATED_PHONE, thread } from "./simulatorLog";
import { isSimulatedGroup, mintSimGroupId, SIM_GROUP_ID, SIM_GROUP_LINE, SIM_MEMBERS_KEY, simMembersOk } from "./simulatedGroup";

export const SIM_GROUP_PATH = "/api/group";
const MAX_REQUEST_BYTES = 16 * 1024;
const KEY_PATTERN = /^[0-9a-f]{32,128}$/;

export type SimGroupAction = "send" | "thread" | "clear";
export type SimGroupBody = { keyHash: string; groupId: string; phone: string; members: string[]; text: string };

/**
 * The group object's side: its claim, its log and its queue. `accept` is the group's own intake (`acceptGroup`), so the
 * message is decided exactly as a real group text is.
 */
export async function simulatedGroupInbox(
  storage: InboxStorage,
  action: string,
  body: SimGroupBody,
  now: number,
  accept: (message: GroupMessage) => Promise<string>,
): Promise<Response> {
  if (!SIM_GROUP_ID.test(body.groupId)) return new Response(null, { status: 400 });
  if (!(await claim(storage, body.keyHash))) return new Response(null, { status: 409 });
  if (action === "thread") {
    return Response.json({ ...(await thread(storage, now, "gpending:")), members: (await storage.get<string[]>(SIM_MEMBERS_KEY)) ?? [] });
  }
  if (action === "clear") {
    await clear(storage);
    return Response.json({ ok: true });
  }
  if (action !== "send") return new Response(null, { status: 404 });
  if (!simMembersOk(body.phone, body.members)) return new Response(null, { status: 400 });

  await storage.put(SIM_MEMBERS_KEY, body.members);
  await record(storage, "out", body.text, now, { from: body.phone });
  const id = crypto.randomUUID();
  const outcome = await accept({
    kind: "group-message",
    eventId: `sim_${id}`,
    groupId: body.groupId,
    line: SIM_GROUP_LINE,
    from: body.phone,
    participants: body.members,
    messageId: id,
    text: body.text,
    channel: "simulator",
  });
  return Response.json({ outcome }, { status: outcome === "full" ? 429 : 200 });
}

/** Read a request body as JSON, or null when it is too big or not an object. */
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) return null;
  try {
    const body: unknown = JSON.parse(raw);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The Worker's side of `/texts-simulator/api/group/*`. The caller has checked the simulator is on and the key's shape;
 * this checks every id, number and member before the group object sees anything.
 */
export async function handleSimulatorGroup(request: Request, env: { SENDER_INBOX: DurableObjectNamespace; GATEWAY_TEXTS?: TextsBinding }, path: string, keyHash: string, url: URL): Promise<Response> {
  const action = ({ "/api/group/send": "send", "/api/group/thread": "thread", "/api/group/clear": "clear" } as Record<string, SimGroupAction>)[path];
  if (action === undefined) return new Response(null, { status: 404 });
  if (request.method !== (action === "thread" ? "GET" : "POST")) return new Response(null, { status: 405 });

  let groupId: string | null;
  let phone = "";
  let members: string[] = [];
  let text = "";
  if (action === "thread") {
    groupId = url.searchParams.get("group");
  } else {
    const body = await readJson(request);
    if (body === null) return new Response(null, { status: 400 });
    groupId = typeof body.groupId === "string" ? body.groupId : null;
    if (action === "send") {
      phone = typeof body.phone === "string" ? body.phone : "";
      if (!SIMULATED_PHONE.test(phone)) return new Response(null, { status: 400 });
      if (!simMembersOk(phone, body.members)) return new Response(null, { status: 400 });
      members = body.members;
      text = typeof body.text === "string" ? cut(body.text.trim()) : "";
      if (text === "") return new Response(null, { status: 400 });
      groupId ??= mintSimGroupId();
    }
  }
  if (groupId === null || !SIM_GROUP_ID.test(groupId) || !isSimulatedGroup(groupId)) return new Response(null, { status: 400 });

  const payload: SimGroupBody = { keyHash, groupId, phone, members, text };
  const there = await inboxByName(chatNamespace(env), groupInboxName(groupId)).fetch(`https://inbox/sim-group/${action}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!there.ok) return there;
  return Response.json({ ...((await there.json()) as object), group: groupId });
}
