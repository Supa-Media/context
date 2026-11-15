/**
 * Moving chats to Tex's new number one at a time (Dev2, 2026-11-15; node `moveChat`, `texConfig.json`). Staff flick a
 * chat's switch in the console (Platform → Lines, `apps/convex/functions/texChatMoves.ts`); once a minute this Worker's
 * cron takes the moves asked for and runs each:
 *
 *     control plane /agent-texts/moves: up to five asked moves, and the new number
 *       │
 *       └─▶ a person: that phone's own inbox, which asks the gateway's node for the words and sends them on the chat's
 *           old Sendblue line, once per ask; reported `told`, or `failed` with a code
 *
 *     the person's first text on the new line afterwards: reported `moved`
 *
 * The old line keeps answering as before (Dev2: "support the old sendblue numbers still"). Groups come next. Logs and
 * the step's ledger record carry outcomes and whether a number is set, never the number, the phone or the words.
 */

import { post, record, ServiceError, type Fetch } from "./clients";
import type { TextsBinding } from "./gatewaySession";
import { CHAT_KEY, type InboxStorage, type RememberedChat } from "./inbox";
import { lineFor, lineSeam, type Line, type LineDeps } from "./line";
import { isPhotonChatId } from "./photonLine";
import { isSendblueChat } from "./sendblue";
import { logStep } from "./stepEvents";

/** Which ask this chat was told for, and whether its first text on the new line has been reported. */
export const MOVE_TOLD_KEY = "move:told";

export type MoveKind = "person" | "group";
export type MoveAsk = { kind: MoveKind; key: string; askedAt: number };
export type MoveOutcome =
  | "told"
  | "already_told"
  | "on_new_line"
  | "no_chat"
  | "not_old_line"
  | "no_number"
  | "no_gateway"
  | "node_failed"
  | "send_failed"
  | "unreachable"
  | "group_soon";
type Told = { askedAt: number; at: number; reported?: boolean };

const E164 = /^\+[1-9]\d{6,14}$/;
const GROUP_KEY = /^[0-9a-f]{64}$/;

/** What a move came to, as the control plane keeps it: told, moved (already on the new line) or failed with the code. */
export function reportOf(outcome: MoveOutcome): { status: "told" | "moved" | "failed"; detail?: string } {
  if (outcome === "told") return { status: "told" };
  if (outcome === "already_told") return { status: "told", detail: outcome };
  if (outcome === "on_new_line") return { status: "moved", detail: outcome };
  return { status: "failed", detail: outcome };
}

/** The control plane's answer, read strictly: moves with a well-formed key, and the number only when it is one. */
export function parseDueMoves(json: unknown): { moves: MoveAsk[]; number: string | null; archiveOn: string | null } {
  const fields = record(json);
  const listed = Array.isArray(fields.moves) ? fields.moves : [];
  const moves: MoveAsk[] = [];
  for (const item of listed) {
    const move = record(item);
    const askedAt = move.askedAt;
    if (typeof askedAt !== "number" || !Number.isSafeInteger(askedAt) || typeof move.key !== "string") continue;
    if (move.kind === "person" && E164.test(move.key)) moves.push({ kind: "person", key: move.key, askedAt });
    else if (move.kind === "group" && GROUP_KEY.test(move.key)) moves.push({ kind: "group", key: move.key, askedAt });
  }
  const number = typeof fields.number === "string" && E164.test(fields.number) ? fields.number : null;
  const archiveOn = typeof fields.archiveOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fields.archiveOn) ? fields.archiveOn : null;
  return { moves, number, archiveOn };
}

export type MoveBody = { askedAt: number; number: string | null; archiveOn: string | null };

export type DueMovesDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  /** Move one person, through that phone's own inbox. */
  movePerson: (phone: string, body: MoveBody) => Promise<MoveOutcome>;
  log: (entry: Record<string, unknown>) => void;
};

/** One minute's moves: each run in turn and reported. A control plane that cannot be reached is logged and tried next minute. */
export async function runDueMoves(deps: DueMovesDeps): Promise<void> {
  if (!deps.controlPlaneOrigin) return;
  let due;
  try {
    const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/moves`, deps.workerSecret, {});
    if (status !== 200) throw new ServiceError("control_plane", status);
    due = parseDueMoves(json);
  } catch {
    deps.log({ event: "chat_move", outcome: "unreachable" });
    return;
  }
  for (const move of due.moves) {
    let outcome: MoveOutcome;
    if (move.kind === "group") outcome = "group_soon";
    else {
      try {
        outcome = await deps.movePerson(move.key, { askedAt: move.askedAt, number: due.number, archiveOn: due.archiveOn });
      } catch {
        outcome = "unreachable";
      }
    }
    const report = reportOf(outcome);
    let noted = "unsent";
    try {
      const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/move-report`, deps.workerSecret, { kind: move.kind, key: move.key, askedAt: move.askedAt, ...report });
      noted = status === 200 ? String(record(json).outcome ?? "unknown") : `status_${status}`;
    } catch {
      noted = "unreachable";
    }
    deps.log({ event: "chat_move", kind: move.kind, outcome, report: noted });
  }
}

// ── The person's inbox ────────────────────────────────────────────────────

export type MovePersonDeps = LineDeps & { texts?: TextsBinding; remoteLine?: (chatId: string) => Line; now: () => number };

/** Text this person the new number on their old-line chat, once per ask, and log the step (`moveChat`) to the chat's ledger. */
export async function movePerson(storage: InboxStorage, body: MoveBody, deps: MovePersonDeps): Promise<MoveOutcome> {
  const started = Date.now();
  const seen = { kind: "person", number: body.number !== null, archiveOn: body.archiveOn !== null };
  const chat = await storage.get<RememberedChat>(CHAT_KEY);
  const chatId = chat && typeof chat.chatId === "string" && chat.channel !== "simulator" ? chat.chatId : "";
  const done = async (outcome: MoveOutcome, textChars?: number): Promise<MoveOutcome> => {
    const ok = outcome === "told" || outcome === "already_told" || outcome === "on_new_line";
    if (chatId !== "") {
      await logStep(storage, chatId, {
        name: "moveChat",
        ok,
        ms: Date.now() - started,
        input: seen,
        output: { outcome, ...(textChars !== undefined ? { textChars } : {}) },
        ...(ok ? {} : { cause: outcome }),
      }, deps.now());
    }
    return outcome;
  };
  if (chatId === "") return await done("no_chat");
  if (isPhotonChatId(chatId)) return await done("on_new_line");
  if (!isSendblueChat(chatId)) return await done("not_old_line");
  if ((await storage.get<Told>(MOVE_TOLD_KEY))?.askedAt === body.askedAt) return await done("already_told");
  if (deps.texts === undefined) return await done("no_gateway");
  let output: { to?: unknown; text?: unknown };
  try {
    const response = await deps.texts.fetch("https://gateway/texts/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "person", ...(body.number !== null ? { number: body.number } : {}), ...(body.archiveOn !== null ? { archiveOn: body.archiveOn } : {}) }),
    });
    if (!response.ok) return await done("node_failed");
    output = (await response.json()) as typeof output;
  } catch {
    return await done("node_failed");
  }
  if (output.to !== "person" || typeof output.text !== "string" || output.text === "") return await done("no_number");
  // Noted before the send, so a retried cron does not text the same ask twice.
  await storage.put<Told>(MOVE_TOLD_KEY, { askedAt: body.askedAt, at: deps.now() });
  try {
    await lineFor(lineSeam(deps), chatId).sendText(chatId, output.text, `move:${chatId}:${body.askedAt}`);
  } catch {
    await storage.delete(MOVE_TOLD_KEY);
    return await done("send_failed", output.text.length);
  }
  return await done("told", output.text.length);
}

export type MovedDeps = { fetch: Fetch; controlPlaneOrigin: string; workerSecret: string };

/**
 * A text that just arrived on the new line: when this person was told to move and it has not been reported yet, the
 * control plane hears they moved. Never throws; a failed report is tried again on their next text.
 */
export async function noteMoved(storage: InboxStorage, phone: string, chatId: string, deps: MovedDeps): Promise<void> {
  if (!isPhotonChatId(chatId) || !E164.test(phone) || !deps.controlPlaneOrigin) return;
  const told = await storage.get<Told>(MOVE_TOLD_KEY);
  if (told === undefined || told.reported === true) return;
  try {
    const { status } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/move-report`, deps.workerSecret, { kind: "person", key: phone, status: "moved" });
    if (status !== 200) throw new ServiceError("control_plane", status);
    await storage.put<Told>(MOVE_TOLD_KEY, { ...told, reported: true });
    console.log(JSON.stringify({ event: "chat_move", kind: "person", outcome: "moved" }));
  } catch {
    console.log(JSON.stringify({ event: "chat_move", kind: "person", outcome: "moved", report: "unreachable" }));
  }
}
