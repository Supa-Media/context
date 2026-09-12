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
}

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

  for (const file of selected) {
    const path = insideVault(file.path);
    if (path === null || file.size < 0 || file.size > MAX_VAULT_FILE_BYTES || paths.has(path)) {
      skipped++;
      continue;
    }
    paths.add(path);
    files.push({ ...file, path, contentType: safeContentType(path) });
    totalBytes += file.size;
  }

  return { files, skipped, totalBytes };
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
