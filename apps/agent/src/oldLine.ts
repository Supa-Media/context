/**
 * Tex's old number (Dev2's Photon plan, "Old-number switch"): when staff switch the old Sendblue line to `redirect`, a text
 * that arrives on it gets one short reply, "I've moved to <number>", once per chat per day, and no turn. The setting is
 * staff's, in the control plane (`functions/texOldLine.ts`); this reads it. The reply is the gateway's config-graph node
 * `oldLine` (`apps/mcp/src/agent/graph/nodes/oldLine.js`), asked and sent by `oldLineStep.ts`.
 */

import { post, record, ServiceError, type Fetch } from "./clients";
import { archiveSentence } from "./newLine";

export type OldLine = { mode: "off" | "redirect"; number: string | null; archiveOn: string | null };

/** How long a read of the setting is kept in this isolate. Staff's change reaches every chat within a minute. */
export const OLD_LINE_CACHE_MS = 60_000;

const E164 = /^\+[1-9]\d{6,14}$/;
const OFF: OldLine = { mode: "off", number: null, archiveOn: null };

export type OldLineDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  now: () => number;
};

let cached: { at: number; value: OldLine } | null = null;

/** Forget the cached setting (tests, and a Worker that has just been told of a change). */
export function clearOldLineCache(): void {
  cached = null;
}

/** The setting from the control plane, kept for `OLD_LINE_CACHE_MS`. A failed read is thrown and not kept. */
export async function readOldLine(deps: OldLineDeps): Promise<OldLine> {
  const now = deps.now();
  if (cached !== null && now - cached.at < OLD_LINE_CACHE_MS) return cached.value;
  const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/old-line`, deps.workerSecret, {});
  if (status !== 200) throw new ServiceError("control_plane", status);
  const value = parseOldLine(json);
  cached = { at: now, value };
  return value;
}

/** An answer the Worker can act on; anything it cannot read is off, so no reply goes out on a guess. */
export function parseOldLine(json: unknown): OldLine {
  const fields = record(json);
  if (fields.mode !== "redirect") return OFF;
  const number = typeof fields.number === "string" && E164.test(fields.number) ? fields.number : null;
  if (number === null) return OFF;
  const archiveOn = typeof fields.archiveOn === "string" && archiveSentence(fields.archiveOn) !== "" ? fields.archiveOn : null;
  return { mode: "redirect", number, archiveOn };
}
