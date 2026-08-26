import { useCallback, useState } from "react";
import {
  DEMO_GRAPH,
  DEMO_STATS,
  MCP_ENDPOINT,
  PLACEHOLDER_OBJECT_COUNT,
  PLACEHOLDER_PARA_PRESENT,
  PLACEHOLDER_VERSIONING_ON,
} from "./placeholderData";
import { useDemoFileBrowser } from "./files/useDemoFileBrowser";
import type {
  ConsoleInvitation,
  ConsoleMember,
} from "./members/members";
import type { ConsoleClient, ConsoleContext, ConsoleData } from "./types";

/**
 * The read-only console on the landing page.
 *
 * Every value here is the mockup's, so the product shot on the marketing page
 * is the design as signed off. Panes, tree selection and note opening are live
 * — it is the same components, not a screenshot — but nothing here can act:
 * `revoke` is absent by design and the file browser's `canEdit` is false, so a
 * visitor is never offered a button that would lie.
 */

const DEMO_CONTEXTS: ConsoleContext[] = [
  { id: "seyi", slug: "seyi", displayName: "seyi", role: "owner", kind: "personal", status: "ok" },
  { id: "lk", slug: "lk", displayName: "lk", role: "member", kind: "personal", status: "ok" },
  {
    id: "ign",
    slug: "ignite-2026",
    displayName: "ignite-2026",
    role: "editor",
    kind: "shared",
    status: "warn",
  },
];

const DEMO_CLIENTS: ConsoleClient[] = [
  { id: "c1", name: "Claude Desktop", detail: "Full access · last used 4 minutes ago", status: "ok" },
  { id: "c2", name: "ChatGPT", detail: "Full access · last used 2 hours ago", status: "ok" },
  { id: "c3", name: "Codex CLI", detail: "Full access · last used yesterday", status: "ok" },
  { id: "c4", name: "Notion AI", detail: "Team access only · never used", status: "warn" },
];

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
  const files = useDemoFileBrowser();

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
    storage: {
      connected: true,
      status: "connected",
      provider: "Cloudflare R2",
      bucket: "brain",
      endpoint: "…r2.cloudflarestorage.com",
      region: "auto",
      accessKey: "a1b2…8f3c",
      conditionalWrite: true,
      objectCount: PLACEHOLDER_OBJECT_COUNT,
      paraPresent: PLACEHOLDER_PARA_PRESENT,
      versioningOn: PLACEHOLDER_VERSIONING_ON,
      // Frozen: nothing in the demo ever moves, so nothing can be waiting on it.
      updatedAt: 0,
    },
    // Absent on purpose, like `revoke` on the demo clients: Re-verify, Rotate
    // and Disconnect all act on a real credential, and a demo console must
    // never offer a control that pretends to act.
    storageActions: undefined,
    endpoint: MCP_ENDPOINT,
    ingestionAddress: "seyi@context.lc",
    files,
    // Names, but no controls — `actions` absent exactly like `storageActions`
    // and the clients' `revoke`. A demo console must never offer a button that
    // pretends to act, and inviting somebody is the least reversible of them.
    members: {
      members: DEMO_MEMBERS,
      invitations: demoInvitations(Date.now()),
      actions: undefined,
      loading: false,
    },
    loading: false,
  };
}
