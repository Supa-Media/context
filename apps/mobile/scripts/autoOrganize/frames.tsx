import type { ReactElement } from "react";
import type { ActivityEntry } from "../../features/console/activity/activity";
import { PremiumBody } from "../../features/console/settings/panels/PremiumPanel";
import type { PremiumStatus, PremiumView } from "../../features/console/settings/panels/premium";
import type { ToastSpec } from "../../features/design/components/Toast";
import { ORGANIZER_ACTOR, offerAction, offerToast } from "../../features/organizer/copy";
import { usePremiumOrganizerSlots } from "../../features/organizer/PremiumParts";
import type { OrganizerStatus, OrganizerSuggestion } from "../../features/organizer/types";
import type { OrganizerView } from "../../features/organizer/useOrganizer";
import { NOW } from "./workspace";

/**
 * The built auto-organize, frame by frame, for comparison with the approved
 * artboards. Each frame names the organizer state it is drawn in; everything
 * on screen is the app's own components reading it.
 */

export interface ShotFrame {
  id: string;
  at?: { pathname: string; note?: string; settings?: string };
  settings?: Record<string, () => ReactElement>;
  organizer?: (density: "phone" | "desktop") => OrganizerFixture;
  activity?: boolean;
  activityOpen?: boolean;
  /** Pointer resting on this suggestion's row (desktop). */
  hover?: string;
  prepare?: (ctx: FrameCtx) => Promise<void> | void;
  assert?: string[];
  sizes?: ReadonlyArray<"phone" | "desktop">;
  schemes?: ReadonlyArray<"light" | "dark">;
  scroll?: boolean;
}

export interface FrameCtx {
  density: "phone" | "desktop";
  settle: () => Promise<void>;
  press: (node: Element | null) => void;
}

export interface OrganizerFixture {
  status: OrganizerStatus;
  reviewOpen?: boolean;
  toasts?: ToastSpec[];
}

/** A still view of auto-organize, in the frame's state. Nothing on it does anything. */
export function fixtureView(fixture: OrganizerFixture, list: OrganizerSuggestion[]): OrganizerView {
  const noop = () => {};
  return {
    state: { kind: "ready", status: fixture.status },
    status: fixture.status,
    slug: "seyi",
    suggestions: { list, loading: false, failed: false, busy: new Set() },
    loadSuggestions: noop,
    reviewOpen: fixture.reviewOpen === true,
    openReview: noop,
    closeReview: noop,
    resolve: noop,
    setEnabled: noop,
    setAutopilot: noop,
    acknowledgeNotice: noop,
    sweepNow: noop,
    openSettings: noop,
    toasts: fixture.toasts ?? [],
    dismissToast: noop,
    undoFor: (entry) => (entry.by === ORGANIZER_ACTOR ? noop : undefined),
  };
}

const BASE_PREMIUM: PremiumStatus = {
  status: "none",
  selected: { managedStorage: false, fastSearch: false },
  active: { managedStorage: false, fastSearch: false },
  canManage: true,
  configured: true,
  priceCents: 500,
  currency: "usd",
  interval: "month",
  ceilingBytes: 50_000_000_000,
  storageIsManaged: false,
} as PremiumStatus;

function premiumView(over: Partial<PremiumStatus>): PremiumView {
  return {
    status: { ...BASE_PREMIUM, ...over },
    loading: false,
    session: null,
    choose: async () => {},
    upgrade: async () => {},
    manageBilling: async () => {},
  } as PremiumView;
}

const FREE_CHOSEN = premiumView({ selected: { managedStorage: false, fastSearch: true } });
const ACTIVE = premiumView({
  status: "active",
  selected: { managedStorage: false, fastSearch: true },
  active: { managedStorage: false, fastSearch: true },
  hasStripeCustomer: true,
  currentPeriodEnd: Math.floor(Date.UTC(2026, 9, 26) / 1000),
  notes: 450,
} as Partial<PremiumStatus>);

/** The real panel body, with auto-organize's slots from the real hook. */
function PremiumFrame({ view, returned }: { view: PremiumView; returned: "done" | null }) {
  const autoOrganize = usePremiumOrganizerSlots(returned);
  return <PremiumBody view={view} section="premium" returned={returned} autoOrganize={autoOrganize} />;
}

export const STATUS: OrganizerStatus = {
  available: true,
  isOwner: true,
  on: true,
  noticeNeeded: false,
  startsAt: null,
  sweep: null,
  pending: 11,
  autopilot: { done: false, archive: false, file: false },
};

export const SUGGESTIONS: OrganizerSuggestion[] = [
  { id: "incident", kind: "done", path: "1-projects/client-intake-publishing-incident/overview.md", title: "Client intake publishing incident", reason: "Its fix merged 2 days ago" },
  { id: "decomp", kind: "done", path: "1-projects/code-decomposition/overview.md", title: "Code decomposition", reason: "Every step is ticked off" },
  { id: "members", kind: "done", path: "1-projects/website-folder/members-only-pages.md", title: "Members-only pages", reason: "Shipped with the website, Sep 23" },
  { id: "handoff", kind: "done", path: "1-projects/custom-domains/cloudflare-handoff.md", title: "Cloudflare handoff", reason: "Sayo ticked the last step Thursday" },
  ...(
    [
      ["timeline", "intake-incident-timeline", "Client intake publishing incident"],
      ["saas", "cloudflare-saas-hostname-notes", "Custom domains"],
      ["dns", "sayo-dns-questions", "Custom domains"],
      ["meeting", "meeting-2026-09-25-website-review", "Website folder"],
      ["fleet", "fleet-shutdown-checklist", "Deprecate the agent fleet"],
      ["memo", "voice-memo-2026-09-24", "Project views"],
      ["permit", "fwd-bandshell-permit", "Public Worship"],
    ] as const
  ).map(([id, title, target]) => ({
    id,
    kind: "file" as const,
    path: `0-inbox/${title}.md`,
    title,
    reason: "",
    target: { path: `1-projects/${target}`, title: target },
  })),
];

/** The sweep's preview reads the first two projects and the second inbox note, as drawn. */
export const SWEEP_SUGGESTIONS = [SUGGESTIONS[0], SUGGESTIONS[1], SUGGESTIONS[5], ...SUGGESTIONS.slice(2, 5)];

export const ORGANIZER_ACTIVITY: ActivityEntry[] = [
  {
    at: new Date(NOW - 40 * 60 * 1000).toISOString(),
    kind: "revised",
    paths: ["1-projects/code-decomposition/overview.md"],
    n: 1,
    vis: "team",
    by: ORGANIZER_ACTOR,
    via: null,
    note: "Every step is ticked off",
  },
  {
    at: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
    kind: "revised",
    paths: ["1-projects/client-intake-publishing-incident/overview.md"],
    n: 1,
    vis: "team",
    by: ORGANIZER_ACTOR,
    via: null,
    note: "Its fix merged 2 days ago",
  },
  {
    at: new Date(NOW - 5 * 60 * 60 * 1000).toISOString(),
    kind: "revised",
    paths: ["1-projects/project-views/overview.md"],
    n: 1,
    vis: "team",
    by: "@seyi",
    via: "Claude",
    note: "slice 2 notes",
  },
  {
    at: new Date(NOW - 26 * 60 * 60 * 1000).toISOString(),
    kind: "added",
    paths: ["1-projects/custom-domains/cloudflare-handoff.md"],
    n: 1,
    vis: "team",
    by: "@sayo",
    via: null,
    note: null,
  },
];

const settingsAt = { pathname: "/console/@seyi", settings: "premium" };
const listAt = { pathname: "/console/@seyi", note: "1-projects/README.md" };
const openRoot: ShotFrame["prepare"] = async ({ density, settle, press }) => {
  if (density !== "phone") return;
  press(document.querySelector('[data-testid="nav-context-seyi"]'));
  await settle();
};

const sweepRunning = { state: "running" as const, startedAt: NOW - 60_000, finishedAt: null, read: 212, total: 450, found: { done: 0, archive: 0, file: 0 } };
const sweepDone = { ...sweepRunning, state: "done" as const, finishedAt: NOW, read: 450, found: { done: 4, archive: 0, file: 7 } };

export const FRAMES: ReadonlyArray<ShotFrame> = [
  {
    id: "01-upgrade",
    at: settingsAt,
    settings: { premium: () => <PremiumFrame view={FREE_CHOSEN} returned={null} /> },
    organizer: () => ({ status: { ...STATUS, available: false, pending: 0 } }),
    assert: ["Auto-organize", "turn it off anytime"],
    scroll: true,
  },
  {
    id: "02a-sweep-running",
    at: settingsAt,
    settings: { premium: () => <PremiumFrame view={ACTIVE} returned="done" /> },
    organizer: () => ({ status: { ...STATUS, sweep: sweepRunning, pending: 0 } }),
    assert: ["Tidying up @seyi", "212 of 450 notes"],
  },
  {
    id: "02b-sweep-found",
    at: settingsAt,
    settings: { premium: () => <PremiumFrame view={ACTIVE} returned="done" /> },
    organizer: () => ({ status: { ...STATUS, sweep: sweepDone } }),
    assert: ["Found 4 projects that look done and 7 inbox notes to file", "Looks done. Its fix merged 2 days ago"],
    schemes: ["light", "dark"],
  },
  {
    id: "04-review-list",
    at: listAt,
    organizer: () => ({ status: STATUS, reviewOpen: true }),
    hover: "incident",
    assert: ["File in Custom domains?", "Mark done?"],
    schemes: ["light", "dark"],
  },
  {
    id: "04b-phone-entry",
    at: listAt,
    organizer: () => ({ status: STATUS }),
    prepare: openRoot,
    assert: ["11 suggestions to look over"],
    sizes: ["phone"],
  },
  {
    id: "05a-offer-automatic",
    at: listAt,
    organizer: () => ({
      status: STATUS,
      toasts: [{ id: "organizer-1", message: offerToast("done"), action: { label: offerAction, run: () => {} } }],
    }),
    assert: ["Do this automatically from now on?"],
  },
  {
    id: "05b-activity-organizer",
    at: listAt,
    organizer: () => ({ status: { ...STATUS, pending: 0 } }),
    activity: true,
    activityOpen: true,
    prepare: async ({ density, settle, press }) => {
      if (density !== "phone") return;
      press(document.querySelector('[data-testid="nav-context-seyi"]'));
      await settle();
      press(document.querySelector('[aria-label="activity"]'));
      await settle();
    },
    assert: ["Context organizer marked"],
  },
  {
    id: "06-settings-switch",
    at: settingsAt,
    settings: { premium: () => <PremiumFrame view={ACTIVE} returned={null} /> },
    organizer: () => ({ status: { ...STATUS, autopilot: { done: true, archive: false, file: false } } }),
    assert: ["Without asking"],
    scroll: true,
  },
  {
    id: "07-existing-premium-notice",
    at: listAt,
    organizer: () => ({ status: { ...STATUS, noticeNeeded: true, pending: 0 } }),
    prepare: openRoot,
    assert: ["Premium now includes auto-organize"],
  },
];
