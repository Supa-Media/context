/**
 * The access rows a test's control plane holds, read back the way the gateway judges them.
 *
 * Access lives on the tree's rows at the control plane, not in a `privacy.md` in the bucket. The control plane
 * stub keeps a row's change in its own record (`setAccess` writes back there, not into the bucket), so a test
 * that reads the bucket's file sees the seed and none of the gateway's changes. These helpers rebuild the rows:
 * the rules the test seeded, with every `setAccess` the gateway sent that workspace applied in order.
 */

import { effectiveVisibility, parsePrivacyManifest, PrivacyOverrides } from "../src/privacy/engine.js";

/**
 * The rules one workspace holds now. `manifest` is the rules text the test seeded for it (the rows before any
 * change), or empty for a workspace seeded with none.
 *
 * A refused `setAccess` is replayed too: the stub records the call, not its answer. A test that needs a refused
 * change to leave the rows alone must check the answer itself.
 */
export function rowsFor(controlPlane, workspaceId, manifest) {
  const seeded = manifest ? parsePrivacyManifest(manifest) : { rules: [], overrides: new PrivacyOverrides() };
  let rules = seeded.rules.map((rule) => ({ ...rule }));
  const overrides = new PrivacyOverrides();
  for (const [path, visibility] of seeded.overrides) overrides.set(path, visibility);
  for (const entry of controlPlane.calls) {
    const body = entry.body ?? {};
    if (entry.path !== "/gateway/privacy" || body.op !== "setAccess" || body.expectedWorkspaceId !== workspaceId) continue;
    if (body.kind === "folder") {
      rules = rules.filter((rule) => rule.prefix !== body.path);
      if (body.base !== "inherit") rules.push({ prefix: body.path, vis: body.base });
    } else if (body.base === "inherit") {
      overrides.delete(body.path);
    } else {
      overrides.set(body.path, body.base);
    }
  }
  return { rules, overrides };
}

/** Whether a path reads as team now, by the rows the gateway would judge it by. */
export function teamNow(controlPlane, workspaceId, manifest, path) {
  const { rules, overrides } = rowsFor(controlPlane, workspaceId, manifest);
  return effectiveVisibility(path, rules, overrides) === "team";
}
