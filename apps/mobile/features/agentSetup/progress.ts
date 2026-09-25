/**
 * Where somebody got to in a guide, remembered on this device.
 *
 * A device record, for `useSetupWidget`'s reason: which screen a person was
 * on is a fact about a person at a screen, and no control-plane table holds
 * it. Everything the guide can *observe* — signed in, read, wrote — is read
 * fresh every time (`checks.ts`) and never trusted from here; what is kept is
 * only what nothing else can know: the step, the topics picked, when the
 * prompt was copied, and the notes seen so far (the gateway forgets after a
 * few minutes, a slow agent does not).
 *
 * Pure apart from the key, so a record written by an older build, or edited by
 * hand, is a test rather than a crash.
 */

import { BRING_TOPICS, DEFAULT_TOPICS, type BringTopic } from "./bring";
import type { WrittenNote } from "./checks";
import { clampStep, type SetupAgent } from "./guides";

export interface SetupProgress {
  /** Zero-based index into `GUIDE_STEPS[agent]`. */
  step: number;
  topics: BringTopic[];
  /** When "Copy and open" was last pressed; `null` before it ever was. */
  copiedAt: number | null;
  written: WrittenNote[];
  /** Finish was pressed on the last screen. */
  finished: boolean;
}

export const FRESH_PROGRESS: SetupProgress = {
  step: 0,
  topics: [...DEFAULT_TOPICS],
  copiedAt: null,
  written: [],
  finished: false,
};

/**
 * This module's own namespace on the device, current version or not.
 *
 * Sign-out has to take the stale ones too, for `lastPlace`'s reason: a record
 * written by a previous shape still holds the names of somebody's notes.
 */
const NAMESPACE = "context.lc.agent-setup";

/** One record per workspace and agent: a member can set up Claude for two teams. */
export function progressKey(workspaceId: string, agent: SetupAgent): string {
  return `${NAMESPACE}.v1.${workspaceId}.${agent}`;
}

/** Every key this module owns. `ownedKeys` does not reach them. */
export function setupKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => key.startsWith(`${NAMESPACE}.`));
}

/** This version's keys for one workspace. For leaving a context. */
export function setupKeysForWorkspace(
  keys: readonly string[],
  workspaceId: string,
): string[] {
  return setupKeys(keys).filter((key) => key.startsWith(`${NAMESPACE}.v1.${workspaceId}.`));
}

const TOPIC_KEYS = new Set<string>(BRING_TOPICS.map((row) => row.key));

/** Anything unreadable is a fresh start, never an error on somebody's screen. */
export function decodeProgress(agent: SetupAgent, raw: string | null): SetupProgress {
  if (raw === null) return { ...FRESH_PROGRESS, topics: [...FRESH_PROGRESS.topics] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return decodeProgress(agent, null);
  }
  if (typeof value !== "object" || value === null) return decodeProgress(agent, null);
  const record = value as Record<string, unknown>;
  const topics = Array.isArray(record.topics)
    ? (record.topics.filter((key) => typeof key === "string" && TOPIC_KEYS.has(key)) as BringTopic[])
    : [...DEFAULT_TOPICS];
  const written = Array.isArray(record.written)
    ? record.written.flatMap((row): WrittenNote[] => {
        if (typeof row !== "object" || row === null) return [];
        const { path, at } = row as Record<string, unknown>;
        return typeof path === "string" && typeof at === "number" ? [{ path, at }] : [];
      })
    : [];
  return {
    step: clampStep(agent, typeof record.step === "number" ? record.step : 0),
    topics,
    copiedAt: typeof record.copiedAt === "number" ? record.copiedAt : null,
    written,
    finished: record.finished === true,
  };
}

export function encodeProgress(progress: SetupProgress): string {
  return JSON.stringify(progress);
}
