import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useAgentActivity } from "../console/agents/useAgentActivity";
import { MCP_ENDPOINT } from "../console/placeholderData";
import { writeClipboard } from "../design/clipboard";
import type { GrantFacts } from "../onboarding/tools";
import { bringPrompt, type BringTopic } from "./bring";
import { mergeWritten } from "./checks";
import { AGENT_LINKS, GUIDE_STEPS, type SetupAgent } from "./guides";
import { bringView, openingStep, signinState, stepKey, tileState } from "./guideState";
import { useSetupProgress } from "./useSetupProgress";
import { BringStep } from "./ui/BringStep";
import { ConnectStep } from "./ui/ConnectSteps";

/** How often the last step asks what the agent did, while somebody watches. */
const WATCH_POLL_MS = 5_000;
/** How often the waiting screens re-read the clock for "three minutes since". */
const TICK_MS = 5_000;

/**
 * `?connect=claude` — the guide, over the workspace it connects.
 *
 * Owns the moving parts and nothing on screen: saved progress, the live
 * grants, the activity it watches on the last step, and the clock. What each
 * screen says is `ui/`; when the guide moves on by itself is `guideState.ts`.
 */
export function AgentSetupOverlay({
  workspaceId,
  slug,
  agent,
  onClose,
  onSwitchAgent,
  onOpenNote,
}: {
  workspaceId: string;
  slug: string;
  agent: SetupAgent;
  onClose: () => void;
  onSwitchAgent: (agent: SetupAgent) => void;
  onOpenNote?: (path: string) => void;
}) {
  const grants = useQuery(api.functions.grants.listGrants, {
    workspaceId: workspaceId as Id<"workspaces">,
  }) as GrantFacts[] | undefined;
  const [progress, update] = useSetupProgress(workspaceId, agent);
  const other: SetupAgent = agent === "claude" ? "chatgpt" : "claude";
  const [otherProgress] = useSetupProgress(workspaceId, other);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<boolean | null>(null);
  const signinOpenedAt = useRef<number | null>(null);
  const opened = useRef(false);

  const step = progress?.step ?? 0;
  const key = stepKey(agent, step);
  const watching = key === "bring" && progress?.copiedAt != null;
  const activity = useAgentActivity(watching ? workspaceId : null, MCP_ENDPOINT, WATCH_POLL_MS);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Once per opening: skip what an agent already signed in has done.
  useEffect(() => {
    if (opened.current || progress === undefined || grants === undefined) return;
    opened.current = true;
    const start = openingStep(agent, progress, grants);
    if (start !== progress.step || progress.finished) {
      update((current) => ({ ...current, step: start, finished: false }));
    }
  }, [agent, grants, progress, update]);

  if (key === "signin" && signinOpenedAt.current === null) signinOpenedAt.current = now;
  if (key !== "signin") signinOpenedAt.current = null;
  const signin = signinState(agent, grants, signinOpenedAt.current ?? now, now);

  // Signing in is the one step that finishes somewhere else.
  useEffect(() => {
    if (key === "signin" && signin === "done") update((current) => ({ ...current, step: current.step + 1 }));
  }, [key, signin, update]);

  const view = useMemo(
    () =>
      progress === undefined
        ? null
        : bringView({ agent, progress, grants, activity, now }),
    [activity, agent, grants, now, progress],
  );

  // Keep what has been seen: the gateway only remembers a few minutes.
  useEffect(() => {
    if (view === null || view.kind === "pick" || progress === undefined) return;
    if (view.written.length > progress.written.length) {
      update((current) => ({ ...current, written: mergeWritten(current.written, view.written) }));
    }
  }, [progress, update, view]);

  const topics = progress?.topics ?? [];
  const prompt = bringPrompt(slug, topics);

  const copyAndOpen = useCallback(() => {
    // Both started inside the press: a browser grants the clipboard, and a new
    // tab, only to the gesture itself.
    const copy = writeClipboard(prompt);
    void Linking.openURL(AGENT_LINKS[agent].chat).catch(() => {});
    void copy.then(setCopied);
    update((current) => ({ ...current, copiedAt: Date.now(), written: [] }));
  }, [agent, prompt, update]);

  const copyAgain = useCallback(() => {
    void writeClipboard(prompt).then(setCopied);
    update((current) => ({ ...current, copiedAt: Date.now() }));
  }, [prompt, update]);

  if (progress === undefined || view === null) return null;

  const next = () =>
    update((current) => ({ ...current, step: Math.min(current.step + 1, GUIDE_STEPS[agent].length - 1) }));
  const back = () => update((current) => ({ ...current, step: Math.max(current.step - 1, 0) }));
  const common = { agent, slug, step, onBack: back, onNext: next, onClose, onSwitchAgent: () => onSwitchAgent(other) };

  if (key !== "bring") return <ConnectStep {...common} signin={signin} />;

  const otherConnected = tileState(other, otherProgress, grants).kind === "connected";
  return (
    <BringStep
      agent={agent}
      slug={slug}
      view={view}
      prompt={prompt}
      copied={copied}
      topics={topics}
      onToggleTopic={(topic: BringTopic) =>
        update((current) => ({
          ...current,
          topics: current.topics.includes(topic)
            ? current.topics.filter((key) => key !== topic)
            : [...current.topics, topic],
        }))
      }
      onCopyAndOpen={copyAndOpen}
      onCopyAgain={copyAgain}
      // Back from watching is back to the choices, not a step: the prompt changes with them.
      onBack={() =>
        view.kind === "live" ? update((current) => ({ ...current, copiedAt: null, written: [] })) : back()
      }
      onClose={onClose}
      onFinish={() => {
        update((current) => ({ ...current, finished: true }));
        onClose();
      }}
      onOpenNote={onOpenNote}
      onOtherAgent={
        otherConnected
          ? undefined
          : () => {
              update((current) => ({ ...current, finished: true }));
              onSwitchAgent(other);
            }
      }
      onRunAgain={() => update((current) => ({ ...current, copiedAt: null, written: [] }))}
    />
  );
}
