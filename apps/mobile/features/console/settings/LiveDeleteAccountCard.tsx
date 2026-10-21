import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { ConsoleData } from "../types";
import { DeleteAccountCard, type ErasedWorkspace } from "./DeleteAccountCard";
import { downloadEverything } from "./downloadEverything";

/**
 * `DeleteAccountCard`, told which workspaces deleting erases.
 *
 * The list is the server's (`accountDeletion.deletionPreview`), computed by
 * the same sole-owner check the deletion uses, so what is named here is what
 * goes. Until it arrives the card still says, in general, that storage we run
 * is erased; the list adds the names and each one's download.
 */
export function LiveDeleteAccountCard({
  data,
  deleteAccount,
}: {
  data: ConsoleData;
  deleteAccount: () => Promise<void>;
}) {
  const preview = useQuery(api.functions.accountDeletion.deletionPreview, {});
  const erased: ErasedWorkspace[] = (preview ?? [])
    .filter((workspace) => workspace.managed)
    .map((workspace) => ({
      id: workspace.workspaceId,
      slug: workspace.slug,
      current: workspace.workspaceId === data.selectedContextId,
    }));
  return (
    <DeleteAccountCard
      deleteAccount={deleteAccount}
      erased={erased}
      onDownload={() => downloadEverything(data)}
      onOpen={data.selectContext}
    />
  );
}
