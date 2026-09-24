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
import { DryRunStep, type DryRunFinding } from "./DryRunStep";

export type PreviewKey =
  | "fork"
  | "connections"
  | "claude-guide"
  | "chatgpt-guide"
  | "bootstrap"
  | "tools-live-waiting"
  | "tools-live-connected"
  | "payment"
  | "dry-run";

const MOCK_CLIENTS: ClientRow[] = [
  { key: "claude-desktop", name: "Claude Desktop", status: "not-connected", hasGuide: true },
  { key: "chatgpt", name: "ChatGPT", status: "not-connected", hasGuide: true },
  { key: "cursor", name: "Cursor", status: "not-connected", hasGuide: false },
  { key: "codex", name: "Codex", status: "not-connected", hasGuide: false },
  { key: "notion-ai", name: "Notion AI", status: "not-connected", hasGuide: false },
];

const MOCK_EVENTS: LiveEvent[] = [
  { id: "1", when: "09:14:02", client: "Claude Desktop", action: "orient" },
  { id: "2", when: "09:14:04", client: "Claude Desktop", action: "list_folder", target: "areas" },
  { id: "3", when: "09:14:11", client: "Claude Desktop", action: "save_context", target: "areas/about-me.md" },
  { id: "4", when: "09:14:18", client: "Claude Desktop", action: "save_context", target: "projects/context-lc.md" },
];

const MOCK_FINDINGS: DryRunFinding[] = [
  { key: "objects", label: "Objects", value: "0 — bucket is empty", tone: "ok" },
  { key: "vault", label: "Looks like Obsidian?", value: "No — no .obsidian folder", tone: "ok" },
  { key: "manifest", label: "Existing context here?", value: "No — no .context/ prefix", tone: "ok" },
  { key: "write-check", label: "Write test", value: "Skipped — read-only key", tone: "warn" },
  { key: "conditional", label: "Conditional writes", value: "Supported (R2)", tone: "ok" },
];

const noop = () => {};

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
    props: { onPickManaged: noop, onPickBYO: noop, onOpenInvitations: noop },
  },
  {
    key: "connections",
    title: "A-07 · Connections",
    Component: ConnectionsStep as ComponentType<Record<string, unknown>>,
    props: { clients: MOCK_CLIENTS, onOpenGuide: noop, onSkip: noop },
  },
  {
    key: "claude-guide",
    title: "A-08 · Claude Desktop setup",
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
    title: "A-09 · Bootstrap from AI",
    Component: BootstrapStep as ComponentType<Record<string, unknown>>,
    props: { prompt: BOOTSTRAP_PROMPT, onDone: noop, onSkip: noop },
  },
  {
    key: "tools-live-waiting",
    title: "A-11 · Tools live (waiting)",
    Component: ToolsLiveStep as ComponentType<Record<string, unknown>>,
    props: { state: "waiting", events: [], onContinue: noop },
  },
  {
    key: "tools-live-connected",
    title: "A-11 · Tools live (connected)",
    Component: ToolsLiveStep as ComponentType<Record<string, unknown>>,
    props: { state: "connected", events: MOCK_EVENTS, onContinue: noop },
  },
  {
    key: "payment",
    title: "A-12 · Payment nudge",
    Component: PaymentStep as ComponentType<Record<string, unknown>>,
    props: { used: 1000, cap: 1000, monthly: "$5 / mo", onLevelUp: noop, onBringOwn: noop },
  },
  {
    key: "dry-run",
    title: "B1-02 · Dry-run report",
    Component: DryRunStep as ComponentType<Record<string, unknown>>,
    props: {
      bucket: "notes-live",
      region: "auto (R2)",
      findings: MOCK_FINDINGS,
      looksReady: true,
      onContinue: noop,
      onShowFolder: noop,
      onBack: noop,
    },
  },
];

export function previewFor(key: string | undefined): PreviewEntry | undefined {
  if (key === undefined) return undefined;
  return PREVIEWS.find((preview) => preview.key === key);
}
