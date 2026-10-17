import { useConvex } from "convex/react";
import { ShareDialog } from "../ShareDialog";
import type { ShareDialogProps } from "./props";
import { useShareGrants } from "./useShareGrants";

type Props = Omit<ShareDialogProps, "grants"> & { workspaceId: string | null };

/**
 * The share dialog with the note's own list, live (`useShareGrants`). Its own component so the subscription is
 * made only while the dialog is open. With no Convex client above it (a render outside the app's provider), it is
 * the dialog as it was before lists existed, rather than a crash.
 */
export function LiveShareDialog(props: Props) {
  const convex = useConvex() as unknown;
  if (convex === undefined || convex === null) {
    const { workspaceId: _workspaceId, ...rest } = props;
    return <ShareDialog {...rest} />;
  }
  return <WithGrants {...props} />;
}

function WithGrants({ workspaceId, ...props }: Props) {
  const grants = useShareGrants(workspaceId, props.path);
  return <ShareDialog {...props} grants={grants} />;
}
