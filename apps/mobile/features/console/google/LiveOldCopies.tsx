import { useEffect } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { OldCopiesPage, OldCopiesRow } from "./OldCopies";

/**
 * The Old copies row or page, read from the server (`oldCopies.summary`):
 * nothing for anyone but the owner, nothing once the owner has answered, and
 * nothing in the read-only demo, which never renders this.
 */
export function LiveOldCopies(props: Parameters<typeof ReadOldCopies>[0]) {
  // No client above it (a screen drawn from fixtures): there is nothing to ask, so nothing is drawn.
  return useConvex() === undefined ? null : <ReadOldCopies {...props} />;
}

function ReadOldCopies({
  workspaceId,
  open,
  onOpen,
  onClose,
}: {
  workspaceId: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const id = workspaceId as Id<"workspaces">;
  const summary = useQuery(api.functions.oldCopies.summary, { workspaceId: id });
  const keep = useMutation(api.functions.oldCopies.keepCopies);
  const remove = useMutation(api.functions.oldCopies.deleteCopies);
  // Kept or deleted while open: there is nothing left to answer, so back to Mail and calendar.
  const gone = open && summary === null;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (summary === undefined || summary === null) return null;
  if (!open) return <OldCopiesRow summary={summary} onOpen={onOpen} />;
  return (
    <OldCopiesPage
      summary={summary}
      onBack={onClose}
      onKeep={async () => {
        await keep({ workspaceId: id });
        onClose();
      }}
      onDelete={async () => {
        await remove({ workspaceId: id });
      }}
    />
  );
}
