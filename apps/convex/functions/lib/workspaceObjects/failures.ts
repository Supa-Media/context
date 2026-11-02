/**
 * Why a workspace-objects backfill or parity step failed, said safely, and
 * the retry for passing storage failures. These logs are public (a GitHub
 * Actions job prints them), and a storage error's message can quote a key,
 * which is somebody's note name: only closed words, codes and code locations
 * leave here.
 */

import type { BodyStore } from "./bodies";

export function failureOf(error: unknown): { error: string; code?: string; reason: string; at?: string; shape?: string } {
  const name = error instanceof Error ? error.name : "unknown";
  const data = (error as { data?: unknown } | null)?.data;
  const code = (data !== null && typeof data === "object" ? (data as { code?: unknown }).code : undefined) ?? (error as { code?: unknown } | null)?.code;
  const reason = reasonOf(error);
  const at = whereOf(error);
  const shape = (error as { keyShape?: unknown } | null)?.keyShape;
  return {
    error: name,
    ...(typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? { code } : {}),
    reason,
    ...(at ? { at } : {}),
    ...(typeof shape === "string" && /^[a-z0-9_<>=/-]{1,64}$/.test(shape) ? { shape } : {}),
  };
}

/** The first frames of a stack as `function@file:line`: names from this repository's code, never a message or data. */
export function whereOf(error: unknown): string | undefined {
  const stack = (error as { stack?: unknown } | null)?.stack;
  if (typeof stack !== "string") return undefined;
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const frame = /^\s*at (?:(?:async )?([A-Za-z_$][\w$.<>]{0,60}) )?\(?(?:.*[\\/])?([\w.-]{1,60}\.[cm]?[jt]s):(\d{1,6})(?::\d+)?\)?$/.exec(line);
    if (frame) frames.push(`${frame[1] ?? "?"}@${frame[2]}:${frame[3]}`);
    if (frames.length === 3) break;
  }
  return frames.length > 0 ? frames.join(" < ") : undefined;
}

/**
 * A closed, key-free word for why a step failed. A storage error's message can
 * quote a key (somebody's note name) and this log is public, so the message is
 * matched against known shapes and only the fixed word, operation and status
 * are kept; anything unknown is `other`.
 */
export function reasonOf(error: unknown): string {
  const message = typeof (error as { message?: unknown } | null)?.message === "string" ? (error as { message: string }).message : "";
  const failed = /^S3 ([A-Z]+) .* failed with (\d{3})/.exec(message);
  if (failed) return `storage_${failed[1]!.toLowerCase()}_${failed[2]}`;
  const capped = /^S3 ([A-Z]+) response exceeds \d+ bytes/.exec(message);
  if (capped) return `storage_${capped[1]!.toLowerCase()}_too_large`;
  if (message.startsWith("logical-delete prefix listing made no progress")) return "listing_no_progress";
  if (message.startsWith("logical-delete prefix listing exceeded")) return "listing_too_long";
  if (message.startsWith("unsafe storage key")) return "unsafe_key";
  if (message.startsWith("unsafe storage prefix")) return "unsafe_prefix";
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "ManagedEncryptionError") return "sealed";
  if (name === "TypeError") {
    // "error sending request for url (…)" is how the Convex runtime's own fetch reports a dropped connection.
    if (/fetch|network|connection|socket|reset|abort|internal error|disconnect|sending request/i.test(message)) return "network";
    // A code fault: the property or function it tripped on is a name from this repository, never data.
    const read = /^Cannot read propert(?:y|ies) of (undefined|null) \(reading '([A-Za-z_$][\w$]{0,40})'\)/.exec(message);
    if (read) return `type_error_${read[1]}_${read[2]}`;
    const call = /^([A-Za-z_$][\w$.]{0,60}) is not a function/.exec(message);
    if (call) return `type_error_not_function_${call[1]}`;
    const words = messageWords(message);
    return words.length > 0 ? `type_error_${words.join("_")}` : "type_error";
  }
  if (/timed? ?out|timeout/i.test(message)) return "timeout";
  if (/too many|rate/i.test(message)) return "rate_limited";
  return "other";
}

/** Failures worth asking again: the bucket busy or briefly unreachable, never a refusal. */
export const passing = (error: unknown): boolean => /^storage_[a-z]+_(429|5\d\d)$|^network$|^timeout$/.test(reasonOf(error));

/** `store` whose reads and listings are asked up to three times over a passing failure. Writes are not. */
export function withRetries(store: BodyStore, wait: (ms: number) => Promise<void>): BodyStore {
  const again = async <T>(work: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= 2 || !passing(error)) throw error;
        await wait(1000 * 3 ** attempt);
      }
    }
  };
  return {
    get: (key) => again(() => store.get(key)),
    ...(typeof store.head === "function" ? { head: (key: string) => again(() => store.head!(key)) } : {}),
    list: (options) => again(() => store.list(options)),
    put: (key, value, options) => store.put(key, value, options),
    delete: (key, options) => store.delete(key, options),
  };
}

/**
 * The words of an unrecognised error message that come from a fixed list, in
 * the order they appear: enough to tell a bad header from a bad body or URL,
 * and nothing a key or a note could put there.
 */
const MESSAGE_WORDS = new Set([
  "argument", "body", "buffer", "byte", "bytestring", "character", "characters", "circular", "clone", "construct",
  "convert", "cyclic", "empty", "header", "headers", "illegal", "invalid", "large", "length", "limit", "locked",
  "long", "method", "name", "null", "read", "request", "response", "serialize", "size", "stream", "string", "too",
  "undefined", "url", "used", "utf", "value",
]);

export function messageWords(message: string): string[] {
  const seen: string[] = [];
  for (const word of message.toLowerCase().split(/[^a-z]+/)) {
    if (MESSAGE_WORDS.has(word) && !seen.includes(word)) seen.push(word);
    if (seen.length === 6) break;
  }
  return seen;
}
