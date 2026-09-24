import type { DrawFn } from "./primitives";
import type { IconName } from "./names";
import { navigationIcons } from "./navigation";
import { filesIcons } from "./files";
import { editorIcons } from "./editor";
import { statusIcons } from "./status";
import { brandIcons } from "./brand";

export { ICON_NAMES, type IconName } from "./names";
export type { DrawFn } from "./primitives";

/**
 * Every icon's drawing, composed from the semantic families above.
 *
 * A `Record<IconName, DrawFn>` rather than a `switch`: TypeScript refuses this
 * object literal unless every key of `IconName` is present, so a name added to
 * `ICON_NAMES` and not to one of the family maps below is still a compile
 * error — the same guarantee the original `switch` with no `default` and a
 * written return type gave, checked here by the object's own required keys
 * instead.
 */
export const drawIcon: Record<IconName, DrawFn> = {
  ...navigationIcons,
  ...filesIcons,
  ...editorIcons,
  ...statusIcons,
  ...brandIcons,
};
