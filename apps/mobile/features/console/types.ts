import type { ConsoleFailure } from "./failure";
import type { FileBrowser } from "./files/browser";
import type { ViewerIdentity } from "./identity";
import type { IngestionState } from "./ingestion/settings";
import type { MapGraph } from "./map/layout";
import type { MembersView } from "./members/members";
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
  /**
   * The context that let it in, as "@seyi".
   *
   * Connections is app level, so the list spans every context — and a grant
   * belongs to exactly one of them. Without this on the row, "revoke this
   * client" is a question nobody can answer, and revoking the wrong one is
   * silent.
   */
  context: string;
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
  /**
   * `r2` | `s3` | `b2` | `s3-compatible` | `dropbox`, straight from the row.
   *
   * Read as a value, not matched against a closed union, for the same reason
   * `status` is: a deployment newer than this bundle can send a provider this
   * client has never heard of, and the honest response is to print it rather
   * than to crash or to claim it is something else.
   */
  provider: string;
  /**
   * The four S3 fields, **all optional**, because a Dropbox binding has none
   * of them: there is no bucket, no endpoint, no region, and no access key to
   * mask. `getStorageBinding` returns them as absent, and absent has to stay
   * absent all the way to the screen — a `""` here would draw an empty
   * labelled well, which reads as a field somebody failed to fill in rather
   * than one that does not exist for this backend.
   */
  bucket?: string;
  endpoint?: string;
  region?: string;
  rootPrefix?: string;
  accessKey?: string;
  /** Real, from the connect-time capability probe. */
  conditionalWrite: boolean;
  /**
   * The stored answer to "is the bucket in the host or in the path", or
   * `undefined` when nobody had to answer. Shown only when it was a question.
   */
  forcePathStyle?: boolean;
  /**
   * How many objects the bucket holds, whether it carries a PARA scaffold, and
   * whether versioning is on — each `undefined` when nobody measured it.
   *
   * All three are `undefined` in the live console today and must stay that way
   * until something actually looks: nothing in the control plane counts a
   * bucket, walks it for PARA folders, or reads a bucket's versioning
   * configuration. They used to be shared constants, drawn with a green check
   * mark as facts about the customer's own bucket — "Reachable — 1,284
   * objects" over a bucket holding six — which is #25.
   *
   * Optional rather than defaulted, on purpose: a default is a value, and a
   * value gets drawn. `SettingsPane` renders each row only if its field is
   * present, so "we do not know" costs a row rather than inventing one.
   */
  objectCount?: string;
  paraPresent?: boolean;
  versioningOn?: boolean;
  /**
   * How many notes the last walk of this bucket counted, when it counted them,
   * and whether it reached the end.
   *
   * The one member of this group that something now measures — see
   * `functions/lib/noteCount.ts`. It obeys the same rule as its neighbours:
   * absent means nobody has looked, and a client renders nothing rather than a
   * zero. Absent, too, for anyone who is not the owner: the count includes
   * private notes, and the control plane withholds it accordingly.
   *
   * `noteCountedAt` is separate from `lastVerifiedAt` because a verification
   * can succeed and learn nothing about the contents. Print the count's own
   * date or no date; a count dated from a fresh probe is a quieter way of
   * inventing it.
   */
  noteCount?: number;
  noteCountedAt?: number;
  noteCountTruncated?: boolean;
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
  /**
   * The signed-in person — never the viewed context. The avatar, and the
   * account block at the foot of the rail, render this and nothing else; only
   * the top-left context chip names what is being viewed. See `identity.ts`.
   */
  viewer: ViewerIdentity;
  contexts: ConsoleContext[];
  /**
   * Contexts this person has been invited to and has not answered, or
   * `undefined` while that is still loading.
   *
   * `undefined` is not `[]`: a note link into a context you were invited to
   * must not send you to the map just because the list has not arrived. Absent
   * in the demo, which has no invitations to answer.
   */
  invitations?: ReadonlyArray<{ slug: string; token: string }>;
  selectedContextId: string | null;
  selectContext: (id: string) => void;
  /**
   * Leave a context somebody shared. Absent in the read-only demo, which has
   * no memberships to sever. The server refuses it for owners.
   */
  leaveContext?: (id: string) => Promise<{ left: boolean }>;
  /**
   * Delete the signed-in account: sole-owned contexts and their bindings,
   * memberships, sign-in — everything on the control plane. Notes in the
   * person's own storage stay exactly where they are; we never held them.
   * Absent in the read-only demo. Resolves after local sign-out, so the
   * caller has nothing to route — the auth gate does it.
   */
  deleteAccount?: () => Promise<void>;
  graph: MapGraph;
  stats: ConsoleStat[];
  clients: ConsoleClient[];
  storage: ConsoleStorage | null;
  /** Absent in the demo and for non-owners. See `StorageActions`. */
  storageActions?: StorageActions;
  endpoint: string;
  /**
   * The ingestion alias to display when the backend cannot yet answer for it.
   * Derived from the slug; `ingestion.settings.address` is the real one.
   */
  ingestionAddress: string;
  /**
   * Where forwarded mail lands and who is allowed to send it.
   *
   * Per context, like storage: the alias is issued against a workspace, and
   * the allow-list is the only thing standing between a semi-public address
   * and anyone who learns it.
   */
  ingestion: IngestionState;
  /**
   * The file editor.
   *
   * Real in the console and read-only on the landing page — the Browse pane
   * takes the interface, not either implementation, so the marketing page runs
   * the actual editor without being able to offer a control that would lie.
   */
  files: FileBrowser;
  /**
   * Who can reach the selected context, and the owner-only controls to change
   * it. Its `actions` are absent for anyone who is not the owner, and in the
   * demo — the same rule as `storageActions`, expressed the same way.
   */
  members: MembersView;
  /** True while the first Convex round-trip is outstanding. */
  loading: boolean;
  /**
   * Set when the subscription the console cannot do without came back as an
   * error rather than data.
   *
   * It exists because Convex's `useQuery` re-throws a failed query during
   * render, which unmounted the console to a blank dark page. The live console
   * reads that subscription through `useQueries` instead, so the error is a
   * value the shell can draw. `null` in the demo, which cannot fail.
   */
  failure: ConsoleFailure | null;
}

/** The selected context, or `null` when there is none yet. */
export function selectedContext(data: ConsoleData): ConsoleContext | null {
  if (data.selectedContextId === null) return null;
  return data.contexts.find((c) => c.id === data.selectedContextId) ?? null;
}
