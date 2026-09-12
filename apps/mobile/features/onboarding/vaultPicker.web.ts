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
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(result);
    };
    const onFocus = () => {
      window.setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) finish({ kind: "cancelled" });
      }, 300);
    };
    window.addEventListener("focus", onFocus);
    input.addEventListener("change", () => {
      const files: PickedVaultFile[] = Array.from(input.files ?? []).map((file) => ({
        path: file.webkitRelativePath || file.name,
        size: file.size,
        type: file.type,
        read: () => file.arrayBuffer(),
      }));
      finish(files.length === 0 ? { kind: "cancelled" } : { kind: "selected", files });
    });
    input.click();
  });
}
