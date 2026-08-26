import type { FileBrowser } from "./files/browser";
import type { MapGraph } from "./map/layout";
import type { ConnectFormValues } from "./storage/connect";

/**
 * What the console renders.
 *
 * The shell and the four panes take this and nothing else, so the same
 * components serve the live, authenticated console and the read-only demo on
 * the landing page. Anything the backend cannot answer yet arrives here already
 * filled in from `placeholderData.ts`, labelled at the source.
 */

export type StatusTone = "ok" | "warn" | "crit";

/** One entry in the rail's "Contexts" group. */
export interface ConsoleContext {
  id: string;
  /** The addressable name, rendered with its `@`. */
  slug: string;
  displayName: string;
  role: string;
  kind: string;
  status: StatusTone;
}

/** One connected AI client on the Connections pane. */
export interface ConsoleClient {
  id: string;
  name: string;
  /** "Full access · last used 4 minutes ago" */
  detail: string;
  status: StatusTone;
  /** Absent in the demo — a demo console must not offer a Revoke that lies. */
  revoke?: () => void;
}

export interface ConsoleStorage {
  connected: boolean;
  /** `unverified` | `connected` | `error`, straight from the row. */
  status: string;
  provider: string;
  bucket: string;
  endpoint: string;
  region: string;
  rootPrefix?: string;
  accessKey: string;
  /** Real, from the connect-time capability probe. */
  conditionalWrite: boolean;
  /**
   * The stored answer to "is the bucket in the host or in the path", or
   * `undefined` when nobody had to answer. Shown only when it was a question.
   */
  forcePathStyle?: boolean;
  /** Placeholder until the probe persists what it saw — see placeholderData. */
  objectCount: string;
  paraPresent: boolean;
  versioningOn: boolean;
  lastError?: string;
  /**
   * The machine-readable companion to `lastError`, from the closed set in
   * `functions/provisioning.ts`. This is what lets the pane offer the right fix
   * instead of "reconnect storage" — see `storage/errors.ts`.
   */
  errorCode?: string;
  /**
   * When the row last changed. Load-bearing, not decorative: re-verify queues a
   * probe and cannot return its result, so the pane watches this to know the
   * outcome landed. See `storage/reverify.ts`.
   */
  updatedAt: number;
  lastVerifiedAt?: number;
}

/**
 * The things an owner can do to a storage binding.
 *
 * Absent — the whole object, not a disabled flag — in the read-only demo and
 * for anyone who is not the owner of the selected context. A missing action is
 * a control that is never offered; a present one always works. Both
 * `bindStorage` and `reverifyStorage` are owner-only on the backend, so
 * rendering them for an `editor` would mean showing a button whose only
 * possible outcome is a permission error.
 */
export interface StorageActions {
  /** Which context these act on. */
  workspaceId: string;
  /**
   * Queues a probe and returns as soon as it is queued — the outcome arrives on
   * the binding, not here. `storage/reverify.ts` explains why it cannot be
   * otherwise.
   */
  reverify: () => Promise<{ queued: boolean; status: string }>;
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  disconnect: () => Promise<{ disconnected: boolean }>;
}

export interface ConsoleStat {
  value: string;
  label: string;
}

export interface ConsoleData {
  /** True for the read-only demo on the landing page. */
  demo: boolean;
  /** Initial for the avatar in the title bar. */
  avatarInitial: string;
  contexts: ConsoleContext[];
  selectedContextId: string | null;
  selectContext: (id: string) => void;
  graph: MapGraph;
  stats: ConsoleStat[];
  clients: ConsoleClient[];
  storage: ConsoleStorage | null;
  /** Absent in the demo and for non-owners. See `StorageActions`. */
  storageActions?: StorageActions;
  endpoint: string;
  ingestionAddress: string;
  /**
   * The file editor.
   *
   * Real in the console and read-only on the landing page — the Browse pane
   * takes the interface, not either implementation, so the marketing page runs
   * the actual editor without being able to offer a control that would lie.
   */
  files: FileBrowser;
  /** True while the first Convex round-trip is outstanding. */
  loading: boolean;
}

/** The selected context, or `null` when there is none yet. */
export function selectedContext(data: ConsoleData): ConsoleContext | null {
  if (data.selectedContextId === null) return null;
  return data.contexts.find((c) => c.id === data.selectedContextId) ?? null;
}
