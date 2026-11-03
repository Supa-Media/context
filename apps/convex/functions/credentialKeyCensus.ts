/**
 * Which key each sealed envelope this control plane holds was written under,
 * counted, never named (Dev, 2026-11-02: staging's storage credentials stopped
 * opening, `CREDENTIAL_UNAVAILABLE` for every personal workspace).
 *
 * For each sealed column: how many envelopes carry the deployment's current key
 * id, its previous key id, some other id (a key this deployment no longer has),
 * or are malformed, and how many bindings are missing a field their provider
 * needs. It reads only the envelopes' key-id prefix (`lib/crypto.ts`
 * `envelopeKeyId`) and opens nothing: an envelope on the current id that still
 * fails to open was sealed under different key material with the same id.
 *
 * Run by hand from the `Credential key census` workflow. Counts and the key
 * ids' standing only, never a key, an id, a workspace or a value: this
 * repository is public, and so is the job's log. Internal only.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { DEFAULT_KEY_ID, ENCRYPTION_KEY_ID_ENV_VAR, PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR, envelopeKeyId } from "./lib/crypto";

const ROWS = 4000;
const tally = v.object({ current: v.number(), previous: v.number(), other: v.number(), malformed: v.number() });
type Tally = { current: number; previous: number; other: number; malformed: number };

export const run = internalQuery({
  args: {},
  returns: v.object({
    previousKeySet: v.boolean(),
    bindings: v.object({ rows: v.number(), incomplete: v.number(), secret: tally, temporary: tally }),
    dataKeys: v.object({ rows: v.number(), keys: tally }),
    appSecrets: v.object({ rows: v.number(), values: tally }),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const currentId = process.env[ENCRYPTION_KEY_ID_ENV_VAR] ?? DEFAULT_KEY_ID;
    const previousId = process.env[PREVIOUS_ENCRYPTION_KEY_ID_ENV_VAR] || null;
    const empty = (): Tally => ({ current: 0, previous: 0, other: 0, malformed: 0 });
    const count = (into: Tally, envelope: unknown) => {
      if (typeof envelope !== "string") return;
      let id: string;
      try {
        id = envelopeKeyId(envelope);
      } catch {
        into.malformed += 1;
        return;
      }
      if (id === currentId) into.current += 1;
      else if (previousId !== null && id === previousId) into.previous += 1;
      else into.other += 1;
    };
    const bindings = await ctx.db.query("storageBindings").take(ROWS + 1);
    const dataKeys = await ctx.db.query("workspaceDataKeys").take(ROWS + 1);
    const secrets = await ctx.db.query("appSecrets").take(ROWS + 1);
    const secret = empty();
    const temporary = empty();
    let incomplete = 0;
    for (const row of bindings.slice(0, ROWS) as Array<Record<string, unknown>>) {
      if (!row.endpoint || !row.region || !row.bucket || !row.accessKeyId || !row.encryptedSecretAccessKey) incomplete += 1;
      count(secret, row.encryptedSecretAccessKey);
      count(temporary, row.encryptedTemporarySecretAccessKey);
    }
    const keys = empty();
    for (const row of dataKeys.slice(0, ROWS)) count(keys, row.encryptedDataKey);
    const values = empty();
    for (const row of secrets.slice(0, ROWS) as Array<Record<string, unknown>>) count(values, row.encryptedValue);
    return {
      previousKeySet: previousId !== null,
      bindings: { rows: Math.min(bindings.length, ROWS), incomplete, secret, temporary },
      dataKeys: { rows: Math.min(dataKeys.length, ROWS), keys },
      appSecrets: { rows: Math.min(secrets.length, ROWS), values },
      truncated: bindings.length > ROWS || dataKeys.length > ROWS || secrets.length > ROWS,
    };
  },
});
