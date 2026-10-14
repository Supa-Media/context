import type { FolderListSource } from "../../listBlock/model";
import type { ChipEdit } from "./PropertyChips";

/** What either placement of the chips is handed (`ChipsPlacement.tsx`, `.web.tsx`). */
export interface ChipsPlacementProps {
  /** The element the web editor keeps under the title; null on native. */
  host: HTMLElement | null;
  /** The note's own margin, for native's row over the editor. */
  gutter: number;
  /** A phone's density, which has no hover. */
  compact: boolean;
  text: string;
  path: string;
  now: number;
  edit: ChipEdit | undefined;
  source: FolderListSource | undefined;
  onOther?: () => void;
}
