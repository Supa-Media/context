/**
 * Laying a chosen layout into a bucket, as one step of `verifyStorageBinding`.
 *
 * Split out of `functions/provisioning.ts` because it is the one part of that
 * action that **writes note surface**, and writing note surface has a rule the
 * probe around it does not: it goes through whatever the workspace's readers
 * use.
 *
 * A managed bucket may already be sealed. A workspace is enrolled when its
 * bucket is bound, and a walk over an empty bucket reaches `encrypted` in a
 * single pass — long before anybody picks a layout. A plain `privacy.md`
 * written into that bucket is refused on every read that follows
 * (`ENCRYPTED_UNREADABLE`), and the walk does not come back for it.
 *
 * The probe in the caller keeps the bare store deliberately: it writes and
 * removes its own object under `.context/probes/` with that same store, and
 * nothing reads a probe object through the gateway.
 */

import type { ActionCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { storeForBinding } from "../../../../mcp/src/store/factory.js";
import { managedEncryptionOption } from "../managedEncryptionFns/storeOption";
import { redactSecrets } from "../verification";
import { type CustomFolder, type ScaffoldStore, scaffoldContext } from "../scaffold";

/** The layout somebody chose, as `verifyStorageBinding` receives it. */
export interface StructureChoice {
  template: "para" | "custom";
  folders: CustomFolder[];
  kind?: "personal" | "shared";
}

/** What the caller records on the binding about this attempt. */
export interface ScaffoldStepResult {
  scaffolded: boolean;
  /** One of `ScaffoldState`; the caller owns that type. */
  reason: "existing-context" | "created" | "partial" | "failed" | "not-attempted";
  error?: string;
  missing?: string[];
}

export async function scaffoldStep(
  ctx: ActionCtx,
  options: {
    workspaceId: Id<"workspaces">;
    credential: Parameters<typeof storeForBinding>[0];
    structure: StructureChoice;
    resume: boolean;
    /** Redacted out of anything this returns. */
    secrets: (string | undefined)[];
  },
): Promise<ScaffoldStepResult> {
  let store: ScaffoldStore;
  try {
    store = storeForBinding(options.credential, undefined, {
      probeCapabilities: true,
      managedEncryption: await managedEncryptionOption(ctx, options.workspaceId),
    }) as unknown as ScaffoldStore;
  } catch (error) {
    // A key that will not open is a refusal, never a plain write: the bucket
    // is still connected and the layout can be applied again.
    return {
      scaffolded: false,
      reason: "not-attempted",
      error: redactSecrets(
        String((error as { message?: unknown })?.message ?? error ?? "unknown error"),
        options.secrets,
      ),
    };
  }

  const result = await scaffoldContext(store, {
    structureTemplate: options.structure.template,
    customFolders: options.structure.folders,
    kind: options.structure.kind ?? "personal",
    resume: options.resume,
  });
  return {
    scaffolded: result.scaffolded,
    reason: result.reason,
    ...(result.error ? { error: redactSecrets(result.error, options.secrets) } : {}),
    // Recorded only when we actually tried to write. `existing-context` means
    // the guard refused before the first `get`, so this attempt learned
    // nothing about what the bucket still owes — and clearing the previous
    // attempt's list there would strand a half-written bucket exactly the way
    // issue #22 describes.
    ...(result.reason !== "existing-context" ? { missing: result.missing } : {}),
  };
}
