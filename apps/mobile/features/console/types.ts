import type { FileBrowser } from "./files/browser";
import type { MapGraph } from "./map/layout";

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
  provider: string;
  bucket: string;
  endpoint: string;
  accessKey: string;
  /** Real, from the connect-time capability probe. */
  conditionalWrite: boolean;
  /** Placeholder until the probe persists what it saw — see placeholderData. */
  objectCount: string;
  paraPresent: boolean;
  versioningOn: boolean;
  lastError?: string;
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
