/**
 * Settings › Vault's calls to the control plane, for `VaultPanel`. A function
 * of the Convex client so the panel itself takes fakes in tests.
 */

import type { ConvexReactClient } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

import type { VaultActions } from "./VaultPanel";

export function liveVaultActions(client: ConvexReactClient, workspaceId: string): VaultActions {
  const id = workspaceId as Id<"workspaces">;
  return {
    list: () => client.action(api.functions.vaultSettings.listVaultEntries, { workspaceId: id }),
    cutOff: (entryId, clientId, by) =>
      client.action(api.functions.vaultSettings.cutOffVaultAI, {
        workspaceId: id,
        entryId,
        ...(clientId === undefined ? {} : { clientId }),
        ...(by === undefined ? {} : { by }),
      }),
    // Async, so a client without queries (the demo, render tests) rejects into the catch rather than throwing.
    choices: async () => client.query(api.functions.vaultPeople.vaultShareChoices, { workspaceId: id }),
    give: (entryId, to, level) => client.action(api.functions.vaultSettings.giveVaultKey, { workspaceId: id, entryId, to, level }),
    takeBack: (entryId, to) => client.action(api.functions.vaultSettings.takeBackVaultKey, { workspaceId: id, entryId, to }),
    moveTargets: async () => client.query(api.functions.vaultMove.vaultMoveTargets, {}),
    move: (entryId, toWorkspaceId) =>
      client.action(api.functions.vaultMove.moveVaultKey, { workspaceId: id, entryId, toWorkspaceId: toWorkspaceId as Id<"workspaces"> }),
    allow: (entryId, clientId) => client.action(api.functions.vaultSettings.allowVaultAI, { workspaceId: id, entryId, clientId }),
    link: async (kind, entryId) => {
      const { token } = await client.action(api.functions.vaultSettings.startVaultLink, {
        workspaceId: id,
        kind,
        ...(entryId === undefined ? {} : { entryId }),
      });
      return token;
    },
    calls: {
      describe: (token) => client.action(api.functions.vault.describeVaultRequest, { token }),
      save: (token, draft) => client.action(api.functions.vault.saveVaultLogin, { token, ...draft }),
      reveal: (token) => client.action(api.functions.vault.revealVaultEntry, { token }),
      edit: (token, edit) => client.action(api.functions.vaultSettings.editVaultEntry, { token, ...edit }),
      remove: (token) => client.action(api.functions.vaultSettings.deleteVaultEntry, { token }),
    },
  };
}
