/**
 * The Worker's texting line as calls the gateway can make (`remoteLine.ts`): a chat's send, typing, read, tapback,
 * upload and contact calls, and a group's send, react and member reads, run here with the line keys the Worker
 * holds. The gateway has no line keys, so its chat object reaches the line through `TexRoutines.lineCall` and
 * `TexRoutines.groupLineCall` (`texRoutineDue.ts`) and nothing else.
 *
 * Only the methods named below can be called: anything else, a non-text inbox or chat, or arguments that are not a
 * list is a `TypeError` thrown before any line is touched. A line that ran and failed is an answer, never a throw:
 * `{ ok: false, error }` carries its name, message, and status and service when it has them (`ServiceError`,
 * `clients.ts`), so the gateway can tell a refusal (4xx) from a failure the same way the Worker does.
 */

import { ServiceError } from "./clients";
import { lineFor, type LineDeps, type Picture } from "./line";
import { groupLineFor, type GroupLineDeps } from "./groupLine";
import { appCardConfig } from "./appCards";
import { noteCardDrawer } from "./noteCards";
import { sendblueKeys } from "./sendblue";
import { whapiKeys } from "./whapi";
import { inboxByName } from "./objectPlace";
import type { CountDataset } from "./textCounts";

/** The methods of `Line` the gateway may call (`line.ts`). */
export const LINE_METHODS = ["sendText", "sendMedia", "sendAppCard", "sendCarousel", "uploadPicture", "startTyping", "markRead", "acknowledge", "shareContactCard", "shareProfile"] as const;
/** The methods of `GroupLine` the gateway may call (`groupLine.ts`); the webhook flags are read there by `groupLineFlags`, not by a call. */
export const GROUP_LINE_METHODS = ["sendText", "sendMedia", "react", "readMembers", "readOwnMessage"] as const;

/** Arguments follow the chat id; for `uploadPicture` the picture is the only argument. A group call's place comes first in `args`. */
export type LineCall = { inbox: string; chatId: string; method: string; args: unknown[] };
export type GroupLineCall = { inbox: string; groupId: string; method: string; args: unknown[] };
export type CallError = { name: string; message: string; status: number | null; service: string | null };
export type LineCallResult = { ok: true; value: unknown } | { ok: false; error: CallError };

/** What the Worker's line keys and media hosting need from its bindings. */
export type LineCallEnv = {
  SENDER_INBOX: DurableObjectNamespace;
  LINQ_API_KEY: string;
  CONTROL_PLANE_ORIGIN: string;
  AGENT_WORKER_SECRET: string;
  SENDBLUE_API_KEY_ID?: string;
  SENDBLUE_API_SECRET?: string;
  SENDBLUE_STATUS_URL?: string;
  WHAPI_TOKEN?: string;
  WHAPI_LINE?: string;
  APP_CARDS?: string;
  APP_CARD_EXTENSION_ID?: string;
  APPLE_TEAM_ID?: string;
  APP_STORE_ID?: string;
  TEX_COUNTS?: CountDataset;
};

/** Checks a line call's shape; throws `TypeError` for anything the gateway may not ask. */
export function checkLineCall(call: unknown): LineCall {
  if (typeof call !== "object" || call === null) throw new TypeError("a line call names an inbox, a chat, a method and its arguments");
  const { inbox, chatId, method, args } = call as Record<string, unknown>;
  if (typeof inbox !== "string" || typeof chatId !== "string") throw new TypeError("a line call names its inbox and chat as text");
  if (typeof method !== "string" || !(LINE_METHODS as readonly string[]).includes(method)) throw new TypeError("not a line method");
  if (!Array.isArray(args)) throw new TypeError("a line call's arguments are a list");
  return { inbox, chatId, method, args };
}

/** Checks a group line call's shape; a method's first argument must name this same group, or it is a `TypeError`. */
export function checkGroupLineCall(call: unknown): GroupLineCall {
  if (typeof call !== "object" || call === null) throw new TypeError("a group line call names an inbox, a group, a method and its arguments");
  const { inbox, groupId, method, args } = call as Record<string, unknown>;
  if (typeof inbox !== "string" || typeof groupId !== "string") throw new TypeError("a group line call names its inbox and group as text");
  if (typeof method !== "string" || !(GROUP_LINE_METHODS as readonly string[]).includes(method)) throw new TypeError("not a group line method");
  if (!Array.isArray(args)) throw new TypeError("a group line call's arguments are a list");
  const place = args[0] as { groupId?: unknown } | null | undefined;
  if (typeof place !== "object" || place === null || place.groupId !== groupId) throw new TypeError("a group line call's first argument names its group");
  return { inbox, groupId, method, args };
}

function failure(error: unknown): CallError {
  if (error instanceof ServiceError) return { name: error.name, message: error.message, status: error.status, service: error.service };
  if (error instanceof Error) {
    const status = (error as { status?: unknown }).status;
    return { name: error.name, message: error.message, status: typeof status === "number" ? status : null, service: null };
  }
  return { name: "Error", message: String(error), status: null, service: null };
}

const absent = (what: string, method: string): LineCallResult => ({ ok: false, error: { name: "Absent", message: `this ${what} has no ${method}`, status: null, service: null } });

/** Runs one checked call on a chat's line, as the Worker's own chat object would (`line.ts`). Never throws for a line error. */
export async function runLineCall(deps: LineDeps, call: LineCall): Promise<LineCallResult> {
  try {
    const line = lineFor(deps, call.chatId);
    if (call.method === "uploadPicture") return { ok: true, value: await line.uploadPicture(call.args[0] as Picture) };
    const found = (line as unknown as Record<string, unknown>)[call.method];
    // A line without the method (sendAppCard on Linq, sendCarousel where there are none): refused by name, as a 4xx.
    if (typeof found !== "function") return absent("line", call.method);
    return { ok: true, value: await (found as (...a: unknown[]) => unknown).call(line, call.chatId, ...call.args) };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

/** Runs one checked call on a group's line, as the Worker's own group queue would (`groupLine.ts`). Never throws for a line error. */
export async function runGroupLineCall(deps: GroupLineDeps, call: GroupLineCall): Promise<LineCallResult> {
  try {
    const line = groupLineFor(deps, call.groupId);
    const found = (line as unknown as Record<string, unknown>)[call.method];
    if (typeof found !== "function") return absent("group line", call.method);
    return { ok: true, value: await (found as (...a: unknown[]) => unknown).call(line, ...call.args) };
  } catch (error) {
    return { ok: false, error: failure(error) };
  }
}

/** A picture hosted by the chat's own object, at the address its line sends (`chatObject.ts` `/host-picture`). */
async function hostPictureAt(env: LineCallEnv, inbox: string, picture: Picture): Promise<string> {
  const response = await inboxByName(env.SENDER_INBOX, inbox).fetch("https://inbox/host-picture", { method: "POST", body: JSON.stringify(picture) });
  if (!response.ok) throw new Error("the chat's inbox did not host the picture");
  const { url } = (await response.json()) as { url?: unknown };
  if (typeof url !== "string") throw new Error("the chat's inbox did not host the picture");
  return url;
}

function sharedDeps(env: LineCallEnv, inbox: string) {
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    sendblue: sendblueKeys(env.SENDBLUE_API_KEY_ID, env.SENDBLUE_API_SECRET, env.SENDBLUE_STATUS_URL),
    whapi: whapiKeys(env.WHAPI_TOKEN, env.WHAPI_LINE),
    hostPicture: (picture: Picture) => hostPictureAt(env, inbox, picture),
    noteCardPicture: noteCardDrawer((input, init) => fetch(input, init), env.CONTROL_PLANE_ORIGIN, env.AGENT_WORKER_SECRET),
    textCounts: env.TEX_COUNTS,
  };
}

/** The deps of the Worker's chat line, as `chatObject.ts` `deps()` and `inbox.ts` `lineDeps()` build them. */
export function lineCallDeps(env: LineCallEnv, inbox: string): LineDeps {
  return { ...sharedDeps(env, inbox), linqApiKey: env.LINQ_API_KEY, appCard: appCardConfig(env) };
}

/** The deps of the Worker's group line, as `groupInbox.ts` builds them. */
export function groupLineCallDeps(env: LineCallEnv, inbox: string): GroupLineDeps {
  return sharedDeps(env, inbox);
}
