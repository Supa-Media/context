import type { PickedVaultFile } from "./vaultImport";

export type VaultPickResult =
  | { kind: "selected"; files: PickedVaultFile[] }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

/** Folder picking is intentionally desktop/web-only because native pickers lose relative paths. */
export async function pickObsidianVault(): Promise<VaultPickResult> {
  return { kind: "unavailable" };
}
