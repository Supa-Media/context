/**
 * What follows a job's part, asked of the config's Part end node (Dev2, 2026-11-17, "jobs as config", step 6).
 *
 * The rule is one pure function (`packages/shared/src/jobPartEnd.cjs`) behind the gateway's `partEnd` node, whose
 * limits are its config. A part asks the gateway (`/agent/job/part-end`), so the node runs on the runner and is logged
 * like every step. Should that call fail, the same rule runs here on the bundled config's limits: the same answer,
 * never a second set of rules, and never a job left without a next step.
 */

import { post, type Fetch } from "./clients";
import { STEER_TIMEOUT_MS } from "./steer";
import partEndLib from "../../../packages/shared/src/jobPartEnd.cjs";
import { TEX_CONFIG } from "../../../packages/shared/src/texConfig.cjs";
import type { PartEndChoice, PartEndInput } from "../../../packages/shared/src/jobPartEnd.d.cts";

const { decidePartEnd } = partEndLib;

const TO = new Set(["carry", "deliver", "end"]);

/** The bundled config's Part end limits, or none (the rule's defaults) while the node is on the shelf. */
export function bundledLimits(config: { nodes?: { id: string; limits?: unknown }[] } = TEX_CONFIG): unknown {
  return config.nodes?.find((node) => node.id === "partEnd")?.limits ?? null;
}

/** A choice as the gateway answers it, or null for anything else. */
export function choiceOf(value: unknown): PartEndChoice | null {
  if (value === null || typeof value !== "object") return null;
  const choice = value as Partial<PartEndChoice>;
  if (typeof choice.to !== "string" || !TO.has(choice.to) || typeof choice.room !== "boolean" || typeof choice.cause !== "string") return null;
  return choice as PartEndChoice;
}

/** The node's choice for this part: the gateway's, else the same rule here. */
export async function partEndChoice(input: PartEndInput, ask: (input: PartEndInput) => Promise<unknown>): Promise<PartEndChoice> {
  const answered = choiceOf(await ask(input).catch(() => null));
  return answered ?? decidePartEnd(input, bundledLimits() as never);
}

/** Asks the gateway's Part end node (`/agent/job/part-end`) with the job's own token: its answer, or null. */
export async function askPartEnd(gateway: { fetch: Fetch; gatewayOrigin: string }, token: () => Promise<string | null>, jobId: string, input: PartEndInput): Promise<unknown> {
  const held = await token().catch(() => null);
  if (held === null) return null;
  const answered = await post(gateway.fetch, "gateway", `${gateway.gatewayOrigin}/agent/job/part-end`, held, { jobId, input }, STEER_TIMEOUT_MS).catch(() => null);
  return answered?.status === 200 ? answered.json : null;
}
