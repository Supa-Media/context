/** Files are streamed from the device; their bytes are never stored in React state. */
export interface PickedVaultFile {
  /** Browser directory picks include the selected vault folder as segment one. */
  path: string;
  size: number;
  type: string;
  read: () => Promise<ArrayBuffer>;
}

export interface PlannedVaultFile extends PickedVaultFile {
  /** Path inside the selected vault, which is also the bucket key. */
  path: string;
  contentType: string;
}

export interface VaultPlan {
  files: PlannedVaultFile[];
  skipped: number;
  totalBytes: number;
  rootName: string;
}

export type VaultImportStrategy = "merge" | "folder" | "replace";

/** Kept below Convex's request ceiling, with space for validators and metadata. */
export const MAX_VAULT_FILE_BYTES = 4_500_000;
export const VAULT_BATCH_FILES = 20;
export const VAULT_BATCH_BYTES = 4_500_000;

const HIDDEN_ROOTS = new Set([".obsidian", ".trash", ".git", ".context", ".audit"]);
const HIDDEN_FILES = new Set([".DS_Store", "Thumbs.db"]);

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function insideVault(path: string): string | null {
  const clean = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = clean.split("/").filter(Boolean);
  // A directory pick always includes the selected folder itself. A picker that
  // cannot preserve that relationship is not safe for a vault import.
  if (segments.length < 2) return null;
  const relative = segments.slice(1);
  if (relative.some((segment) => segment === "." || segment === "..")) return null;
  if (relative.some((segment) => segment.startsWith(".") || HIDDEN_ROOTS.has(segment))) return null;
  if (relative.some(containsControlCharacter)) return null;
  if (HIDDEN_FILES.has(relative.at(-1) ?? "")) return null;
  const joined = relative.join("/");
  if (joined.toLowerCase() === "privacy.md") return null;
  return joined.length > 0 && joined.length <= 1_024 ? joined : null;
}

function safeContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "md" || extension === "markdown") return "text/markdown; charset=utf-8";
  const images: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
  };
  return images[extension] ?? "application/octet-stream";
}

export function planVaultFiles(selected: readonly PickedVaultFile[]): VaultPlan {
  const files: PlannedVaultFile[] = [];
  let skipped = 0;
  let totalBytes = 0;
  const paths = new Set<string>();
  let rootName = "Vault";

  for (const file of selected) {
    const selectedRoot = file.path.replaceAll("\\", "/").replace(/^\/+/, "").split("/").filter(Boolean)[0];
    if (files.length === 0 && selectedRoot !== undefined) rootName = safeFolderName(selectedRoot);
    const path = insideVault(file.path);
    if (path === null || file.size < 0 || file.size > MAX_VAULT_FILE_BYTES || paths.has(path)) {
      skipped++;
      continue;
    }
    paths.add(path);
    files.push({ ...file, path, contentType: safeContentType(path) });
    totalBytes += file.size;
  }

  return { files, skipped, totalBytes, rootName };
}

function safeFolderName(value: string): string {
  const cleaned = [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127 && character !== "/" && character !== "\\";
    })
    .join("")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "Vault";
  return cleaned.startsWith(".") ? `Vault ${cleaned.slice(1) || "notes"}` : cleaned;
}

/** Apply the owner's explicit destination choice; replacement keeps source paths. */
export function vaultPlanForStrategy(plan: VaultPlan, strategy: VaultImportStrategy): VaultPlan {
  const prefix = `Imports/${safeFolderName(plan.rootName)}`;
  return {
    ...plan,
    // A browser may enumerate the same directory in a different order after a
    // reload. Stable ordering is what makes completed batch 12 mean the same
    // files when that local vault is selected again.
    files: plan.files
      .map((file) => strategy === "folder" ? { ...file, path: `${prefix}/${file.path}` } : file)
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
}

/**
 * Stable, non-secret identity for one local selection and destination plan.
 * It lets the server match a reselected vault to progress without retaining a
 * path list or any bytes in Convex.
 */
export function vaultFingerprint(plan: VaultPlan, strategy: VaultImportStrategy): string {
  const manifest = [
    strategy,
    ...plan.files
      .map((file) => `${file.path}\u0000${file.size}\u0000${file.contentType}`)
      .sort((left, right) => left.localeCompare(right)),
  ].join("\u0001");
  // Two independent 32-bit passes keep this synchronous on every supported
  // web/Mac runtime while making a false resume match vanishingly unlikely.
  // A match controls which batches may be skipped, so a single 32-bit checksum
  // is not enough even though this identifier is not an authentication token.
  const hash = (seed: number, reverse: boolean) => {
    let value = seed >>> 0;
    for (let step = 0; step < manifest.length; step += 1) {
      const index = reverse ? manifest.length - step - 1 : step;
      value ^= manifest.charCodeAt(index);
      value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value.toString(16).padStart(8, "0");
  };
  return `vault-${hash(0x811c9dc5, false)}${hash(0x9e3779b9, true)}`;
}

export function batchVaultFiles(
  files: readonly PlannedVaultFile[],
  limits: { maxFiles: number; maxBytes: number } = {
    maxFiles: VAULT_BATCH_FILES,
    maxBytes: VAULT_BATCH_BYTES,
  },
): PlannedVaultFile[][] {
  const batches: PlannedVaultFile[][] = [];
  let current: PlannedVaultFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length > 0 && (current.length >= limits.maxFiles || bytes + file.size > limits.maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function formatVaultBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}
