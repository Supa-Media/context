/**
 * The guide's screens with mock props, for `/preview/onboarding/<key>` — so
 * each state can be looked at, and photographed, without an agent actually
 * connecting. Every state here is a `BringView` or a step the real overlay
 * reaches; nothing is drawn that the guide cannot show.
 */

import type { ComponentType } from "react";
import { bringPrompt, DEFAULT_TOPICS } from "./bring";
import type { WrittenNote } from "./checks";
import type { BringView } from "./guideState";
import type { SetupAgent } from "./guides";
import { BringStep } from "./ui/BringStep";
import { ConnectStep } from "./ui/ConnectSteps";

const noop = () => {};
const NOTES: WrittenNote[] = [
  "1-projects/context-lc.md",
  "1-projects/public-worship.md",
  "2-areas/people/olumide.md",
  "2-areas/how-i-work.md",
  "3-resources/tools.md",
  "0-inbox/getting-started.md",
].map((path, index) => ({ path, at: index }));

function connect(agent: SetupAgent, step: number, signin: "waiting" | "slow" = "waiting") {
  return {
    Component: ConnectStep as unknown as ComponentType<Record<string, unknown>>,
    props: { agent, slug: "seyi", step, signin, onBack: noop, onNext: noop, onClose: noop, onSwitchAgent: noop },
  };
}

function bring(agent: SetupAgent, view: BringView) {
  return {
    Component: BringStep as unknown as ComponentType<Record<string, unknown>>,
    props: {
      agent,
      slug: "seyi",
      view,
      prompt: bringPrompt("seyi", DEFAULT_TOPICS),
      copied: true,
      topics: DEFAULT_TOPICS,
      onToggleTopic: noop,
      onCopyAndOpen: noop,
      onCopyAgain: noop,
      onBack: noop,
      onClose: noop,
      onFinish: noop,
      onOpenNote: noop,
      onOtherAgent: noop,
      onRunAgain: noop,
    },
  };
}

const live = (state: Extract<BringView, { kind: "live" }>["state"], reads: number, written: WrittenNote[]): BringView => ({
  kind: "live",
  state,
  signedIn: true,
  reads,
  written,
});

export const AGENT_SETUP_PREVIEWS = {
  "guide-claude-open": { title: "Guide · Claude 1 · Open settings", ...connect("claude", 0) },
  "guide-claude-add": { title: "Guide · Claude 2 · Add Context", ...connect("claude", 1) },
  "guide-claude-signin": { title: "Guide · Claude 3 · Sign in (waiting)", ...connect("claude", 2) },
  "guide-claude-signin-slow": { title: "Guide · Claude 3 · Sign in (slow)", ...connect("claude", 2, "slow") },
  "guide-claude-allow": { title: "Guide · Claude 4 · Always allow", ...connect("claude", 3) },
  "guide-claude-stick": { title: "Guide · Claude 5 · Make it stick", ...connect("claude", 4) },
  "guide-claude-bring": { title: "Guide · Claude 6 · Bring over", ...bring("claude", { kind: "pick" }) },
  "guide-claude-bring-live": {
    title: "Guide · Claude 6 · Notes arriving",
    ...bring("claude", live({ kind: "writing" }, 4, NOTES.slice(0, 2))),
  },
  "guide-claude-no-write": {
    title: "Guide · Claude 6 · Stalled, nothing written",
    ...bring("claude", live({ kind: "stalled-no-write" }, 3, [])),
  },
  "guide-claude-nothing": {
    title: "Guide · Claude 6 · Stalled, nothing at all",
    ...bring("claude", live({ kind: "stalled-nothing" }, 0, [])),
  },
  "guide-claude-done": { title: "Guide · Claude · Done", ...bring("claude", { kind: "done", written: NOTES }) },
  "guide-claude-little": {
    title: "Guide · Claude · Little to bring",
    ...bring("claude", { kind: "little", written: NOTES.slice(-1) }),
  },
  "guide-chatgpt-devmode": { title: "Guide · ChatGPT 1 · Developer mode", ...connect("chatgpt", 0) },
  "guide-chatgpt-create": { title: "Guide · ChatGPT 2 · Create the app", ...connect("chatgpt", 1) },
  "guide-chatgpt-signin": { title: "Guide · ChatGPT 3 · Sign in", ...connect("chatgpt", 2) },
  "guide-chatgpt-stick": { title: "Guide · ChatGPT 4 · Make it stick", ...connect("chatgpt", 3) },
  "guide-chatgpt-bring": { title: "Guide · ChatGPT 5 · Bring over", ...bring("chatgpt", { kind: "pick" }) },
  "guide-chatgpt-denied": {
    title: "Guide · ChatGPT 5 · Nothing written",
    ...bring("chatgpt", live({ kind: "stalled-no-write" }, 2, [])),
  },
} as const;

export type AgentSetupPreviewKey = keyof typeof AGENT_SETUP_PREVIEWS;
