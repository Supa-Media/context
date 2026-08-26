import { useCallback, useState } from "react";
import { DEMO_GRAPH, DEMO_INGESTION, DEMO_STATS, MCP_ENDPOINT } from "./placeholderData";
import { useDemoFileBrowser } from "./files/useDemoFileBrowser";
import { ingestionAvailabilityFor } from "./ingestion/settings";
import type { ConsoleInvitation, ConsoleMember } from "./members/members";
import type {
  ConsoleClient,
  ConsoleContext,
  ConsoleData,
  ConsoleStorage,
} from "./types";

/**
 * The read-only console on the landing page.
 *
 * Every value here is the mockup's, so the product shot on the marketing page
 * is the design as signed off. Navigation, tree selection and note opening are
 * live — it is the same components, not a screenshot — but nothing here can
 * act: `revoke` is absent by design, the file browser's `canEdit` is false,
 * and `ingestion.save` is missing, so a visitor is never offered a button that
 * would lie.
 *
 * The three contexts are genuinely different, because the point of showing
 * three is that they are not the same thing: one you own, one you are a guest
 * in, and one that belongs to an organisation. Their trees, their storage and
 * their ingestion rules all change with the selection — see
 * `placeholderData.ts`.
 */

const DEMO_CONTEXTS: ConsoleContext[] = [
  { id: "seyi", slug: "seyi", displayName: "seyi", role: "owner", kind: "personal", status: "ok" },
  { id: "lk", slug: "lk", displayName: "lk", role: "member", kind: "personal", status: "ok" },
  {
    id: "pw",
    slug: "public-worship",
    displayName: "Public Worship",
    role: "editor",
    kind: "shared",
    status: "warn",
  },
];

/**
 * Every grant, not the selected context's.
 *
 * Connections is app level now, and a grant is issued against one context —
 * so each row has to say which, or "revoke this one" is a question you cannot
 * answer. It is the same placement the constellation draws: a client hangs off
 * whichever context let it in.
 */
const DEMO_CLIENTS: ConsoleClient[] = [
  {
    id: "c1",
    name: "Claude Desktop",
    context: "@seyi",
    detail: "Full access · last used 4 minutes ago",
    status: "ok",
  },
  {
    id: "c2",
    name: "ChatGPT",
    context: "@seyi",
    detail: "Full access · last used 2 hours ago",
    status: "ok",
  },
  {
    id: "c3",
    name: "Codex CLI",
    context: "@seyi",
    detail: "Full access · last used yesterday",
    status: "ok",
  },
  {
    id: "c4",
    name: "Notion AI",
    context: "@lk",
    detail: "Team access only · never used",
    status: "warn",
  },
];

/**
 * One binding per context, because a binding *is* per context — two of these
 * point at different buckets on purpose, which is the whole reason storage
 * moved out of the app-level rail and into a context's settings.
 *
 * `objectCount`, `paraPresent` and `versioningOn` are literals here and are
 * optional on `ConsoleStorage`, so the demo is the only place they are ever
 * filled in. The signed-in console leaves them undefined and draws no row —
 * they were shared constants once, and the live pane imported them, which is
 * how a real bucket holding six objects came to report 1,284 (#25).
 */
const DEMO_STORAGE: Record<string, ConsoleStorage> = {
  seyi: {
    connected: true,
    status: "connected",
    provider: "Cloudflare R2",
    bucket: "brain",
    endpoint: "…r2.cloudflarestorage.com",
    region: "auto",
    accessKey: "a1b2…8f3c",
    conditionalWrite: true,
    objectCount: "1,284",
    paraPresent: true,
    versioningOn: false,
    // Frozen: nothing in the demo ever moves, so nothing can be waiting on it.
    updatedAt: 0,
  },
  lk: {
    connected: true,
    status: "connected",
    provider: "Cloudflare R2",
    bucket: "lk-brain",
    endpoint: "…r2.cloudflarestorage.com",
    region: "auto",
    accessKey: "7d4e…1a09",
    conditionalWrite: true,
    objectCount: "216",
    paraPresent: true,
    versioningOn: true,
    updatedAt: 0,
  },
  pw: {
    // Amber in the rail, "Not verified" on the pill, and the two agree —
    // a shared context whose binding nobody has re-checked since it was made.
    connected: false,
    status: "unverified",
    provider: "Amazon S3",
    bucket: "public-worship-brain",
    endpoint: "s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    accessKey: "AKIA…4Q2M",
    conditionalWrite: true,
    objectCount: "428",
    paraPresent: true,
    versioningOn: true,
    updatedAt: 0,
  },
};
const DEMO_MEMBERS: ConsoleMember[] = [
  {
    userId: "m1",
    role: "owner",
    name: "Seyi",
    email: "seyi@example.com",
    joinedAt: 0,
    isMe: true,
  },
  { userId: "m2", role: "editor", name: "LK", email: "lk@example.com", joinedAt: 1, isMe: false },
  {
    userId: "m3",
    role: "member",
    name: "Ade",
    email: "ade@example.com",
    joinedAt: 2,
    isMe: false,
  },
];

/**
 * One outstanding invitation, dated relative to now.
 *
 * Unlike the storage row's frozen `updatedAt`, this one has to move with the
 * clock: the row renders "expires in N days", and a fixed timestamp would read
 * "expired" to every visitor after the first week.
 */
function demoInvitations(now: number): ConsoleInvitation[] {
  return [
    {
      invitationId: "i1",
      invitee: "@tomi",
      role: "editor",
      expiresAt: now + 6 * 24 * 60 * 60 * 1000,
    },
  ];
}

export function useDemoConsoleData(): ConsoleData {
  const [selectedContextId, setSelectedContextId] = useState<string>("seyi");
  const selectContext = useCallback((id: string) => setSelectedContextId(id), []);
  const files = useDemoFileBrowser(selectedContextId);
  const selected = DEMO_CONTEXTS.find((context) => context.id === selectedContextId) ?? null;

  // The demo has to obey the same rule the product does: only a personal
  // context receives email, so `@public-worship` shows the explanation rather
  // than an address it would never receive mail at. A marketing console that
  // teaches the wrong model is worse than one that shows less.
  const availability = ingestionAvailabilityFor(selected?.kind);
  const ingestionSettings =
    availability === "available" ? (DEMO_INGESTION[selectedContextId] ?? null) : null;

  return {
    demo: true,
    avatarInitial: "S",
    contexts: DEMO_CONTEXTS,
    selectedContextId,
    selectContext,
    graph: DEMO_GRAPH,
    stats: [
      { value: DEMO_STATS.contexts, label: "contexts reachable" },
      { value: DEMO_STATS.clients, label: "AI clients connected" },
      { value: DEMO_STATS.notes, label: "notes across all" },
      { value: DEMO_STATS.bytes, label: "in your own bucket" },
    ],
    clients: DEMO_CLIENTS,
    storage: DEMO_STORAGE[selectedContextId] ?? null,
    // Absent on purpose, like `revoke` on the demo clients: Re-verify, Rotate
    // and Disconnect all act on a real credential, and a demo console must
    // never offer a control that pretends to act.
    storageActions: undefined,
    endpoint: MCP_ENDPOINT,
    ingestionAddress: ingestionSettings?.address ?? `${selected?.slug ?? "you"}@context.lc`,
    ingestion: {
      settings: ingestionSettings,
      loading: false,
      availability,
      // Same reason as `storageActions`. The rules are shown in full and
      // cannot be changed from a page nobody has signed in to.
      save: undefined,
    },
    files,
    // Names, but no controls — `actions` absent exactly like `storageActions`
    // and the clients' `revoke`. A demo console must never offer a button that
    // pretends to act, and inviting somebody is the least reversible of them.
    members: {
      members: DEMO_MEMBERS,
      invitations: demoInvitations(Date.now()),
      actions: undefined,
      loading: false,
      failure: null,
    },
    loading: false,
    // Nothing here is fetched, so nothing here can fail: the landing page's
    // console is data, not a subscription.
    failure: null,
  };
}
