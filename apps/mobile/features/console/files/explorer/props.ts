import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { FileBrowser } from "../browser";
import type { AccessMember, AccessRow, RemovalRoute } from "../access";
import type { RecipientGroup } from "../recipients";
import type { AudienceContext } from "../../privacy/audience";
import type { TreePick } from "../selection";
import type { ActivityView } from "../../activity/activity";
import type { AgentActivityView } from "../../agents/agentActivity";

/** What `Explorer` is handed. See the component for how each is used. */
export type ExplorerProps = {
  files: FileBrowser;
  /**
   * The workspace row that ends the column — `ContextFootRow`.
   *
   * A slot rather than something this component builds, for the same reason the
   * `vault` slot that used to sit here was one: the row needs the context list,
   * the recently-visited log and the router, none of which this component has
   * or should acquire. `undefined` where there is nowhere to switch to, and the
   * column then ends at the counts line exactly as it did before.
   */
  workspaces?: ReactNode;
  /** Handed straight to the share dialog. See `ExplorerDialogs`. */
  access?: {
    members: readonly AccessMember[];
    groups?: readonly RecipientGroup[];
    /**
     * `kind` travels with the path because a folder and a note go to different
     * actions — the note one refuses anything that is not `.md`, which is the
     * refusal an owner met when this dropped it.
     */
    onShareWithGroup?: (path: string, kind: "file" | "folder", group: string) => void;
    /**
     * What a row in the people list can do about somebody, for one path.
     *
     * A factory rather than a handler, because narrowing a note names the
     * note and this component is rendered once for a tree with many. Returns
     * `undefined` for a caller that can do none of it — see `removalHandler`
     * — and the dialog then draws roles rather than controls.
     */
    removalRouteFor?: (
      path: string,
      /** Decides which visibility mutation the narrow route means. */
      kind: "file" | "folder",
    ) => ((route: RemovalRoute, row: AccessRow) => void) | undefined;
    /** The workspace's slug, for showing the name a new group's label becomes. */
    groupSlug?: string;
    /** Whose context this is, so every audience can be named. */
    audience?: AudienceContext;
    /**
     * Make a group and point this path at it. Owner-only upstream.
     *
     * Answers, so the sheet can show a refusal from the control plane where
     * the person can read it — the notice line sits behind the modal.
     */
    onCreateGroup?: (
      path: string,
      /** Same reason `onShareWithGroup` carries one: it ends in the same call. */
      kind: "file" | "folder",
      label: string,
      userIds: readonly string[],
    ) => Promise<unknown>;
  };
  /** "@seyi" — named in the empty state so it is obvious whose tree this is. */
  contextLabel: string;
  /**
   * "Open in new tab" — opens the note *pinned*, where a plain open leaves a
   * preview tab the next click replaces. Absent where there are no tabs, and
   * `menu.ts` is then the thing that must not offer the item.
   */
  onOpenPinned?: (path: string) => void;
  /**
   * Raised while this region owns a menu or a dialog, so the frame can put the
   * keyboard into `overlay` scope. Without it, ⌘K opens the palette *behind* an
   * open context menu.
   */
  onOverlayChange?: (open: boolean) => void;
  /**
   * The rows picked with ⌘/ctrl-click and shift-click — see `selection.ts`.
   *
   * Held by the caller when it passes these, because the console's keyboard
   * handler sits above this region and a chord like ⌘⇧⌫ has to act on the
   * rows drawn selected rather than on the open note behind them. Without
   * them the tree keeps its own, which is every mount but the console's.
   */
  pick?: TreePick;
  onPickChange?: Dispatch<SetStateAction<TreePick>>;
  /**
   * What has changed in this context, and how much of it this person has seen.
   *
   * Absent on the demo console and on any console with no control plane behind
   * it, and the column then ends at the counts line exactly as it did before —
   * which is the whole shape of this feature: it rewrites one line that is
   * already there and adds a dot to rows that are already drawn.
   */
  activity?: ActivityView;
  /**
   * Which notes agents read or wrote in the last few minutes, from
   * `useAgentActivity`. Absent where there is no gateway, and then the tree
   * draws no agent marks and the foot has no agents line — exactly the
   * column as it was.
   */
  agents?: AgentActivityView;
};
