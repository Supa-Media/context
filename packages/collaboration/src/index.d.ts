export interface StoredObject {
  etag: string;
  text(): Promise<string>;
}

export interface ContextStore {
  capabilities?: {
    conditionalWrite?: boolean;
    conditionalCreate?: boolean;
    conditionalDelete?: boolean;
  };
  get(path: string): Promise<StoredObject | null>;
  put(
    path: string,
    value: string | Uint8Array | ArrayBuffer,
    options?: { onlyIf?: { etagMatches?: string; absent?: boolean } },
  ): Promise<{ etag: string } | null>;
  delete?(path: string, options?: { onlyIf?: { etagMatches?: string } }): Promise<void | null>;
  /** The note id of the live row at `path`, in a keyed workspace (`notes-by-id.md`); absent elsewhere. */
  noteIdAt?(path: string): Promise<string | null>;
  list?(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; etag?: string }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

export interface DocumentResult {
  documentId: string;
  /** Base64 encoding of the raw Yjs update for the complete document state. */
  update: string;
  text: string;
  etag: string;
  /** Provider object version corresponding to this acknowledged text. */
  rawEtag: string;
  /** False means the update is durably retained but waiting for Yjs dependencies. */
  applied?: boolean;
  pendingDependencies?: boolean;
}

export interface CommitUpdateInput {
  documentId: string;
  update: string;
}

export interface ReplaceTextInput {
  documentId?: string;
  expectedEtag: string;
  text: string;
}

export interface SealDocumentInput {
  /** Exact collaboration revision etag being sealed. */
  expectedEtag: string;
  /** The complete encrypted Markdown envelope; plaintext is never accepted. */
  text: string;
  documentId?: string;
}

export interface SealDocumentResult {
  documentId: string;
  generation: string;
  sealed: true;
  etag: string;
}

export interface MoveResult extends DocumentResult {
  from: string;
  to: string;
}

export interface TombstoneResult {
  documentId: string;
  generation: string;
  deleted: true;
}

export interface LifecycleOptions {
  expectedEtag?: string;
  permanent?: boolean;
  /** Internal file operations only: admit the existing .context/trash layout. */
  internalTrash?: boolean;
}

export class CollaborationError extends Error {
  readonly code: string;
}

export function supported(store: ContextStore | unknown): boolean;
export function eligible(path: string, text?: string): boolean;
export function readDocument(store: ContextStore, path: string): Promise<DocumentResult>;
export function commitUpdate(store: ContextStore, path: string, input: CommitUpdateInput): Promise<DocumentResult>;
export function replaceText(store: ContextStore, path: string, input: ReplaceTextInput): Promise<DocumentResult>;
export function sealDocument(store: ContextStore, path: string, input: SealDocumentInput): Promise<SealDocumentResult>;
export function moveDocument(store: ContextStore, from: string, to: string, options?: LifecycleOptions): Promise<MoveResult>;
export function tombstoneDocument(store: ContextStore, path: string, options?: LifecycleOptions): Promise<TombstoneResult>;
export function restoreDocument(store: ContextStore, path: string, options?: LifecycleOptions): Promise<DocumentResult>;

/** What a keyed rename did: the document it carried, or why it did nothing. */
export interface RenameResult {
  renamed: boolean;
  reason?: "no_document" | "already" | "not_active";
  documentId?: string;
  generation?: string;
}

/**
 * Carry a note's collaboration heads and state from `from` to `to` after its
 * row moved in a keyed workspace. Reads and writes no Markdown. With
 * `internalTrash`, either end may be a trash location, for a row trash or restore.
 */
export function renameDocument(
  store: ContextStore,
  from: string,
  to: string,
  options?: { internalTrash?: boolean },
): Promise<RenameResult>;

/**
 * Erase the collaboration history of the note whose trash name is `path`, when
 * the trash is emptied in a keyed workspace: its document state, revisions,
 * journals and the head at `path`. Reads and writes no Markdown.
 */
export function eraseDocument(store: ContextStore, path: string): Promise<{ erased: boolean; documentId?: string }>;
