/**
 * The gateway's routes for Tex machines: pairing, claiming, resolving, registering and revoking
 * (`docs/decisions/texting-assistant/machines.md`).
 *
 * Split out of `http.ts`, which registers these routes in one loop over `TEX_MACHINE_GATEWAY_ROUTES`, each built by
 * `gatewayRoute`, so the gateway-secret check runs before anything here. Every plain grant and pairing code arrives
 * verbatim and is hashed here, before it reaches a function; nothing downstream receives the plain value. The
 * refusals are the functions' own codes, mapped to statuses here.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { badRequest, json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { workspaceNotFound } from "../workspaceAuth";
import {
  isValidMachineName,
  isTexMachineOs,
  normalizePairingCode,
  pairingCodeHashInput,
  TEX_MACHINE_PUBLIC_KEY_PATTERN,
} from "../texMachineRules";

/** A run grant's plain token has this prefix, as an access token's does. */
const RUN_TOKEN_PREFIX = "cat_";

/** Longest JSON text the runner's facts may be; stored on the pairing and shown on the approval screen. */
const MAX_FACTS_JSON_LENGTH = 8000;

/** The one refusal whose code is not spelled here: `workspaceAuth.ts` owns it, so the gateway reads it from there. */
const UNKNOWN_WORKSPACE_REFUSAL = workspaceNotFound().data.code;

const REFUSAL_STATUS = new Map<string, number>([
  ["PAIRING_NOT_FOUND", 404],
  ["PAIRING_NOT_APPROVED", 409],
  ["PAIRING_EXPIRED", 410],
  ["PAIRING_ALREADY_CLAIMED", 409],
  ["CODE_TAKEN", 409],
  ["MACHINE_NOT_FOUND", 404],
  ["MACHINE_OWNER_GONE", 403],
  ["MACHINE_GRANT_INVALID", 401],
  ["INSUFFICIENT_ROLE", 403],
  ["MACHINE_RUN_PARENT_INVALID", 401],
  ["BAD_RUN", 400],
  ["CHAT_NOT_FOUND", 404],
  ["TOO_MANY_MACHINES", 409],
  [UNKNOWN_WORKSPACE_REFUSAL, 404],
]);

/** A coded refusal from the functions becomes its status and `{ code }`. Anything else is a real failure: rethrown. */
function refusal(error: unknown): Response {
  const data = error instanceof ConvexError ? (error.data as { code?: unknown }) : null;
  const code = typeof data?.code === "string" ? data.code : undefined;
  const status = code === undefined ? undefined : REFUSAL_STATUS.get(code);
  if (code === undefined || status === undefined) throw error;
  return json({ code }, status);
}

type Handler = (ctx: ActionCtx, body: Record<string, unknown>) => Promise<Response>;

async function startHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const code = stringField(body, "code");
  const normalized = code === null ? null : normalizePairingCode(code);
  const publicKey = stringField(body, "publicKey");
  const name = stringField(body, "name");
  const os = stringField(body, "os");
  const facts = body.facts;
  if (
    normalized === null ||
    publicKey === null ||
    !TEX_MACHINE_PUBLIC_KEY_PATTERN.test(publicKey) ||
    name === null ||
    !isValidMachineName(name) ||
    !isTexMachineOs(os) ||
    typeof facts !== "object" ||
    facts === null ||
    Array.isArray(facts)
  ) {
    return badRequest();
  }
  const factsJson = JSON.stringify(facts);
  if (factsJson.length > MAX_FACTS_JSON_LENGTH) return badRequest();
  try {
    return json(
      await ctx.runMutation(internal.functions.texMachines.startTexMachinePairing, {
        hashedCode: await hashToken(pairingCodeHashInput(normalized)),
        publicKey,
        name,
        os,
        facts: factsJson,
      }),
    );
  } catch (error) {
    return refusal(error);
  }
}

async function readHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const pairingId = stringField(body, "pairingId");
  if (pairingId === null) return badRequest();
  try {
    return json(await ctx.runQuery(internal.functions.texMachines.readTexMachinePairing, { pairingId }));
  } catch (error) {
    return refusal(error);
  }
}

async function claimHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const pairingId = stringField(body, "pairingId");
  const grant = stringField(body, "grant");
  if (pairingId === null || grant === null) return badRequest();
  try {
    return json(
      await ctx.runMutation(internal.functions.texMachines.claimTexMachine, {
        pairingId,
        hashedGrant: await hashToken(grant),
      }),
    );
  } catch (error) {
    return refusal(error);
  }
}

async function resolveHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const grant = stringField(body, "grant");
  if (grant === null) return badRequest();
  try {
    return json(
      await ctx.runMutation(internal.functions.texMachines.resolveTexMachine, {
        hashedGrant: await hashToken(grant),
      }),
    );
  } catch (error) {
    return refusal(error);
  }
}

async function registerHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const userId = stringField(body, "userId");
  const workspaceId = stringField(body, "workspaceId");
  const grant = stringField(body, "grant");
  const publicKey = stringField(body, "publicKey");
  const name = stringField(body, "name");
  const os = stringField(body, "os");
  if (
    userId === null ||
    workspaceId === null ||
    grant === null ||
    publicKey === null ||
    !TEX_MACHINE_PUBLIC_KEY_PATTERN.test(publicKey) ||
    name === null ||
    !isValidMachineName(name) ||
    !isTexMachineOs(os)
  ) {
    return badRequest();
  }
  try {
    return json(
      await ctx.runMutation(internal.functions.texMachines.registerTexMachine, {
        userId,
        workspaceId,
        hashedGrant: await hashToken(grant),
        publicKey,
        name,
        os,
      }),
    );
  } catch (error) {
    return refusal(error);
  }
}

async function revokeHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const machineId = stringField(body, "machineId");
  const userId = stringField(body, "userId");
  if (machineId === null || userId === null) return badRequest();
  try {
    return json(await ctx.runMutation(internal.functions.texMachines.revokeTexMachineAs, { machineId, userId }));
  } catch (error) {
    return refusal(error);
  }
}

/**
 * Mint a run grant for one job part. The job presents its own texting token as `parentToken`; it is hashed here, and the
 * plain run token is minted here and returned once.
 */
async function issueRunGrantHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const parentToken = stringField(body, "parentToken");
  const machineId = stringField(body, "machineId");
  const runId = stringField(body, "runId");
  const expiresAt = body.expiresAt;
  if (parentToken === null || machineId === null || runId === null || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return badRequest();
  }
  const accessToken = `${RUN_TOKEN_PREFIX}${randomOpaqueToken(32)}`;
  try {
    const issued = await ctx.runMutation(internal.functions.texMachines.issueTexMachineRunGrant, {
      hashedParentToken: await hashToken(parentToken),
      hashedAccessToken: await hashToken(accessToken),
      machineId,
      runId,
      expiresAt,
    });
    return json({ accessToken, expiresAt: issued.expiresAt });
  } catch (error) {
    return refusal(error);
  }
}

async function revokeRunGrantHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const runId = stringField(body, "runId");
  if (runId === null) return badRequest();
  return json(await ctx.runMutation(internal.functions.texMachines.revokeTexMachineRunGrant, { runId }));
}

async function attachChatHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const userId = stringField(body, "userId");
  const machineId = stringField(body, "machineId");
  const groupKey = stringField(body, "groupKey");
  if (userId === null || machineId === null || groupKey === null) return badRequest();
  try {
    return json(
      await ctx.runMutation(internal.functions.texMachineChats.attachTexMachineToChatAs, { userId, machineId, groupKey }),
    );
  } catch (error) {
    return refusal(error);
  }
}

async function detachChatHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const userId = stringField(body, "userId");
  const machineId = stringField(body, "machineId");
  const groupKey = stringField(body, "groupKey");
  if (userId === null || machineId === null || groupKey === null) return badRequest();
  try {
    return json(
      await ctx.runMutation(internal.functions.texMachineChats.detachTexMachineFromChatAs, { userId, machineId, groupKey }),
    );
  } catch (error) {
    return refusal(error);
  }
}

/** The machines a chat may run jobs on. An unknown chat, or a key that is not well formed, is an empty list. */
async function machinesForChatHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const groupKey = stringField(body, "groupKey");
  if (groupKey === null) return badRequest();
  return json({ machines: await ctx.runQuery(internal.functions.texMachineChats.texMachinesForChat, { groupKey }) });
}

/** A chat's people with their ids, for one of them choosing who may use their computer there; 404 for anyone else. */
async function chatPeopleHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const userId = stringField(body, "userId");
  const groupKey = stringField(body, "groupKey");
  if (userId === null || groupKey === null) return badRequest();
  const people = await ctx.runQuery(internal.functions.texMachineChats.chatPeopleAs, { userId, groupKey });
  return people === null ? json({ code: "CHAT_NOT_FOUND" }, 404) : json({ people });
}

/** The paths http.ts registers, each POST and each behind `gatewayRoute`. */
export const TEX_MACHINE_GATEWAY_ROUTES: ReadonlyArray<readonly [string, Handler]> = [
  ["/gateway/machines/pair/start", startHandler],
  ["/gateway/machines/pair/read", readHandler],
  ["/gateway/machines/pair/claim", claimHandler],
  ["/gateway/machines/resolve", resolveHandler],
  ["/gateway/machines/register", registerHandler],
  ["/gateway/machines/revoke", revokeHandler],
  ["/gateway/machines/run-grant", issueRunGrantHandler],
  ["/gateway/machines/run-grant/revoke", revokeRunGrantHandler],
  ["/gateway/machines/chat/attach", attachChatHandler],
  ["/gateway/machines/chat/detach", detachChatHandler],
  ["/gateway/machines/for-chat", machinesForChatHandler],
  ["/gateway/machines/chat/people", chatPeopleHandler],
];
