/** The `list_plugins` tool. Moved verbatim out of `src/index.js`. */

import { inventoryPlugins } from "./inventory.js";
import { renderPluginReport } from "./report.js";
import { resolveContextPlugins } from "./enablement.js";
import { toolText } from "../tools/results.js";

/**
 * What the Obsidian plugins in this bucket would do here.
 *
 * Deliberately takes nothing but the store. `.obsidian/` sits outside the
 * privacy manifest's reach — it is not notes, so `canSee` has nothing to say
 * about it — and the safe shape for a read there is one that cannot be aimed:
 * every key comes from a listing of a fixed prefix, never from an argument. A
 * variant of this tool that accepted a path would be a way to read around the
 * privacy engine wearing a helpful name.
 *
 * Read-only in the strong sense: nothing here writes, and `.obsidian/` is never
 * written by the gateway at all. It belongs to the client the customer actually
 * uses, and tidying somebody else's program's state is how a "compatible"
 * gateway breaks the thing it was compatible with.
 */
export async function toolListPlugins(store) {
  // Both halves of one question. The Context plugins come from a catalogue and
  // one small settings object; the vault's come from reading bundles. Asked
  // together because "what plugins does this context have" is one question, and
  // answering only the second half is what this tool used to do.
  const [report, context] = await Promise.all([
    inventoryPlugins(store),
    resolveContextPlugins(store),
  ]);
  return toolText(renderPluginReport(report, context.plugins));
}
