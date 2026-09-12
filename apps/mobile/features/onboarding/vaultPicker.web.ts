import type { PickedVaultFile } from "./vaultImport";
import type { VaultPickResult } from "./vaultPicker";

export async function pickObsidianVault(): Promise<VaultPickResult> {
  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const finish = (result: VaultPickResult) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(result);
    };
    // Chrome restores window focus before it finishes enumerating a selected
    // directory. Inferring cancellation from focus raced the real `change`
    // event and made a successful pick look like nothing happened. File
    // inputs expose a dedicated `cancel` event; use the event that actually
    // names the outcome instead of a timer heuristic.
    input.addEventListener("cancel", () => finish({ kind: "cancelled" }));
    input.addEventListener("change", () => {
      const files: PickedVaultFile[] = Array.from(input.files ?? []).map(
        (file) => ({
          path: file.webkitRelativePath || file.name,
          size: file.size,
          type: file.type,
          read: () => file.arrayBuffer(),
        }),
      );
      finish(
        files.length === 0
          ? { kind: "cancelled" }
          : { kind: "selected", files },
      );
    });
    try {
      input.click();
    } catch {
      finish({ kind: "unavailable" });
    }
  });
}
