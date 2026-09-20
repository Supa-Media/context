import { useState } from "react";
import type { ConsolePlugin } from "./plugins";
import type { RuntimeView } from "./runtime";

/**
 * Start and stop, with the two pieces of state a press needs and nothing else.
 *
 * Extracted when the plugins panel grew a second place to press Start: the row
 * became the quick control and `PluginRuntimeCard` stayed the detailed one, and
 * two copies of "await the action, and say something useful if it throws" is
 * two copies of the sentence a person reads when their plugin will not start.
 *
 * **The failure wording is the reason this is shared rather than duplicated.**
 * Both sentences answer the only question somebody has when a plugin refuses —
 * whether their notes are all right — and the answer is structural: a plugin
 * that did not start did nothing, because it has no access outside its sandbox.
 * A second copy is a second chance to drop that clause to save a line.
 */
export function usePluginPower(plugin: ConsolePlugin, view: RuntimeView) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const fingerprint = plugin.bundleFingerprint;

  async function act(action: "start" | "stop"): Promise<void> {
    if (fingerprint === null || view.actions === undefined) return;
    setBusy(true);
    setFailure(null);
    try {
      await view.actions[action](plugin.id, fingerprint);
    } catch (error) {
      const data = (error as { data?: { message?: unknown } } | null)?.data;
      setFailure(
        typeof data?.message === "string"
          ? data.message
          : action === "start"
            ? "The plugin did not start. Its access and your notes are unchanged."
            : "The plugin could not be stopped here. Revoke its access to stop it immediately.",
      );
    } finally {
      setBusy(false);
    }
  }

  return { busy, failure, act };
}
