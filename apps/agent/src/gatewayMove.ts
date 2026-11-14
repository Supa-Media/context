/**
 * The gateway move of a texting chat's inbox (step 3 of the intake move, `docs/architecture/tex.md`).
 *
 * The gateway's chat object runs the same `arrive()` as the placed inbox did (`inboxMove.ts`), and asks this Worker
 * over RPC (`TexRoutines.chatMove`): `out` marks the inbox moved to the gateway and answers its entries, digest and
 * alarm, `back` takes it back. The inbox's placed object is the one asked, by its placed name, without the name header
 * the old-inbox move refuses (`inboxMove.ts` `serveMoveOut`).
 *
 * A job's object and a group's directory entry never move: they are not chats.
 */

import { chatDirectoryName } from "./groupRoutines";
import { GATEWAY, OLD_NAME, placedName } from "./inboxMove";
import { objectByName } from "./objectPlace";

export type ChatMoveCall = { inbox: string; op: "out" | "back" };
export type ChatMoveAnswer = { status: number; body: unknown };

/** The name prefixes of objects that never move: a background job's, and a group's directory entry. */
const NEVER_MOVES = ["job:", chatDirectoryName("")];

/** A move call, checked; rejects a name that is not an inbox's, one that never moves, or an unknown op (`TypeError`). */
export function readChatMove(call: unknown): ChatMoveCall {
  if (typeof call !== "object" || call === null) throw new TypeError("a move names an inbox and an op");
  const { inbox, op } = call as { inbox?: unknown; op?: unknown };
  if (typeof inbox !== "string" || !OLD_NAME.test(inbox)) throw new TypeError("an inbox name is 1 to 512 characters, no NUL");
  if (NEVER_MOVES.some((prefix) => inbox.startsWith(prefix))) throw new TypeError("this kind of object never moves");
  if (op !== "out" && op !== "back") throw new TypeError("a move is out or back");
  return { inbox, op };
}

/** Runs one move call on the inbox's placed object; answers its status and parsed JSON body (`null` when none). */
export async function chatMove(namespace: DurableObjectNamespace, call: unknown): Promise<ChatMoveAnswer> {
  const { inbox, op } = readChatMove(call);
  const stub = objectByName(namespace, placedName(inbox));
  const response =
    op === "out"
      ? await stub.fetch("https://inbox/__move_out", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: inbox, to: GATEWAY }) })
      : await stub.fetch("https://inbox/__move_back", { method: "POST" });
  return { status: response.status, body: await parseBody(response) };
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
