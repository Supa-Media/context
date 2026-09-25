/**
 * The screens the redesigned onboarding flow adds, with mock props for
 * standalone preview.
 *
 * A preview route (`/preview/onboarding/[step]`) reads this map so a
 * reviewer can look at each new screen without a signed-in session, and so
 * regressions on any one show up as a first-class render error rather than
 * a screenshot compared by eye.
 *
 * ## API wiring is deliberately absent here
 *
 * These are the *presentational* halves of the new steps. Each screen takes
 * a props object; the mock preset below fills those with reasonable defaults.
 * Wiring them into `useOnboarding` — where the mutations, subscriptions and
 * state transitions live — happens in the next commit; the point of this file
 * is that the screens exist and are visible on their own before we plumb
 * anything.
 */

import type { ComponentType } from "react";
import type { ClientRow } from "./ConnectionsStep";
import { ConnectionsStep } from "./ConnectionsStep";
import { ForkStep } from "./ForkStep";
import { ClaudeGuideStep } from "./ClaudeGuideStep";
import { ChatGPTGuideStep } from "./ChatGPTGuideStep";
import { BootstrapStep } from "./BootstrapStep";
import { BOOTSTRAP_PROMPT } from "../agents";
import { ToolsLiveStep, type LiveEvent } from "./ToolsLiveStep";
import { PaymentStep } from "./PaymentStep";
import { DryRunStep } from "./DryRunStep";
import { dryRunReport } from "../dryRun";
import { PointAtBucket } from "../steps/PointAtBucket";
import { LayingOutFolders } from "../steps/LayingOutFolders";
import { SetupWidget } from "../../console/setupWidget/SetupWidget";
import { SetupDone } from "../../console/setupWidget/SetupDone";
import { setupView } from "../../console/setupWidget/rules";
import type { ConsoleStorage } from "../../console/types";

export type PreviewKey =
  | "fork"
  | "connections"
  | "claude-guide"
  | "chatgpt-guide"
  | "bootstrap"
  | "tools-live-waiting"
  | "tools-live-connected"
  | "payment"
  | "dry-run"
  | "point-at-bucket"
  | "setup-widget"
  | "setup-done"
  | "laying-out";

const MOCK_CLIENTS: ClientRow[] = [
  { key: "claude-desktop", name: "Claude Desktop", status: "not-connected", hasGuide: true },
  { key: "chatgpt", name: "ChatGPT", status: "not-connected", hasGuide: true },
  { key: "cursor", name: "Cursor", status: "not-connected", hasGuide: false },
  { key: "codex", name: "Codex", status: "not-connected", hasGuide: false },
  { key: "notion-ai", name: "Notion AI", status: "not-connected", hasGuide: false },
];

const MOCK_EVENTS: LiveEvent[] = [
  { id: "1", when: "09:14:02", client: "Claude", action: "read", target: "index.md" },
  { id: "2", when: "09:14:11", client: "Claude", action: "wrote", target: "2-areas/about-me.md" },
  { id: "3", when: "09:14:18", client: "Claude", action: "wrote", target: "1-projects/context-lc.md" },
];

/** A fake bucket, through the real report, so the preview cannot drift from it. */
const MOCK_REPORT = dryRunReport({
  provider: "r2",
  bucket: "notes-live",
  region: "auto",
  capabilities: { conditionalWrite: true },
  scaffoldReason: "empty",
  noteCount: 0,
});

const noop = () => {};
const copied = async () => true;

/** "Start fresh" just landed: our bucket, five folders, no tool yet — 3 of 4. */
const MOCK_SETUP = setupView({
  slug: "seyi",
  storage: {
    connected: true,
    status: "connected",
    provider: "r2",
    conditionalWrite: true,
    updatedAt: 0,
    managed: true,
    scaffoldReason: "created",
  } as ConsoleStorage,
  grants: [],
});

/**
 * Every preview: which component, and a set of mock props good enough to draw
 * the screen at its resting state. The component is typed as an anonymous
 * `ComponentType` so callers do not need to know each screen's prop shape —
 * the props travel with it.
 */
export interface PreviewEntry {
  key: PreviewKey;
  title: string;
  Component: ComponentType<Record<string, unknown>>;
  props: Record<string, unknown>;
}

export const PREVIEWS: readonly PreviewEntry[] = [
  {
    key: "fork",
    title: "A-04 · Fork",
    Component: ForkStep as ComponentType<Record<string, unknown>>,
    props: { offer: { kind: "free", cap: 1000 }, onPickManaged: noop, onPickBYO: noop },
  },
  {
    key: "connections",
    title: "A-10 · Connections (Settings)",
    Component: ConnectionsStep as ComponentType<Record<string, unknown>>,
    props: { clients: MOCK_CLIENTS, onOpenGuide: noop, onSkip: noop },
  },
  {
    key: "claude-guide",
    title: "A-11 · Claude Desktop setup",
    Component: ClaudeGuideStep as ComponentType<Record<string, unknown>>,
    props: { onDone: noop, onBack: noop },
  },
  {
    key: "chatgpt-guide",
    title: "A-10 · ChatGPT setup",
    Component: ChatGPTGuideStep as ComponentType<Record<string, unknown>>,
    props: { onDone: noop, onBack: noop },
  },
  {
    key: "bootstrap",
    title: "A-13 · Bootstrap from AI",
    Component: BootstrapStep as ComponentType<Record<string, unknown>>,
    props: { prompt: BOOTSTRAP_PROMPT, onDone: noop, onSkip: noop },
  },
  {
    key: "tools-live-waiting",
    title: "A-07 · Tools live (waiting)",
    Component: ToolsLiveStep as ComponentType<Record<string, unknown>>,
    props: { state: "waiting", events: [], onContinue: noop },
  },
  {
    key: "tools-live-connected",
    title: "A-07 · Tools live (connected)",
    Component: ToolsLiveStep as ComponentType<Record<string, unknown>>,
    props: { state: "connected", events: MOCK_EVENTS, onContinue: noop },
  },
  {
    key: "payment",
    title: "A-08 · Payment nudge",
    Component: PaymentStep as ComponentType<Record<string, unknown>>,
    props: { used: 1000, cap: 1000, monthly: "$5 / mo", ceiling: "50 GB", onLevelUp: noop, onBringOwn: noop },
  },
  {
    key: "dry-run",
    title: "B1-02 · Dry-run report",
    Component: DryRunStep as ComponentType<Record<string, unknown>>,
    props: { ...MOCK_REPORT, onContinue: noop },
  },
  {
    key: "point-at-bucket",
    title: "B1-01 · Point at what you have",
    Component: PointAtBucket as ComponentType<Record<string, unknown>>,
    props: { connect: async () => ({ status: "unverified" }), onPickFree: noop },
  },
  {
    key: "setup-widget",
    title: "W-07 · Setup widget (in the console)",
    Component: SetupWidget as ComponentType<Record<string, unknown>>,
    props: {
      slug: "seyi",
      view: MOCK_SETUP,
      actions: { onOpenStorage: noop, onOpenTools: noop, onCopyBootstrap: copied, onPutAway: noop },
    },
  },
  {
    key: "setup-done",
    title: "A-09 · You're set up (in the console)",
    Component: SetupDone as ComponentType<Record<string, unknown>>,
    props: { onClose: noop, onNewWorkspace: noop, onCopyBootstrap: copied },
  },
  {
    key: "laying-out",
    title: "Setting up your workspace (after Start fresh)",
    Component: LayingOutFolders as ComponentType<Record<string, unknown>>,
    props: { slug: "seyi", done: false },
  },
];

export function previewFor(key: string | undefined): PreviewEntry | undefined {
  if (key === undefined) return undefined;
  return PREVIEWS.find((preview) => preview.key === key);
}
