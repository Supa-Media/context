import type { ReactNode } from "react";
import { AGENT_NAMES, GUIDE_STEPS, type SetupAgent } from "../guides";
import type { BringView } from "../guideState";
import type { BringTopic } from "../bring";
import type { CheckItem } from "./parts";
import { StepIllustration } from "./Illustrations";
import { BackLink, GuideButton, GuideFrame, QuietLink } from "./GuideFrame";
import { B, Checks, Gap, Heading, MenuPath, P, PromptBox, Reveal, Tips, TopicPicker, WrittenList } from "./parts";

/**
 * The last step: bring over what the agent knows, and watch it arrive.
 *
 * Four faces of one screen — pick what to include; the notes landing, with
 * the checks ticking as the agent reads and writes; stalled, with what to try;
 * and finished, with every note it wrote. The waiting faces have no primary
 * button: the checks are the thing to watch, and the page moves on by itself.
 */
export function BringStep({
  agent,
  slug,
  view,
  prompt,
  copied,
  topics,
  onToggleTopic,
  onCopyAndOpen,
  onCopyAgain,
  onBack,
  onClose,
  onFinish,
  onOpenNote,
  onOtherAgent,
  onRunAgain,
}: {
  agent: SetupAgent;
  slug: string;
  view: BringView;
  prompt: string;
  /** What the last copy said: `false` shows the prompt to copy by hand. */
  copied: boolean | null;
  topics: readonly BringTopic[];
  onToggleTopic: (topic: BringTopic) => void;
  onCopyAndOpen: () => void;
  onCopyAgain: () => void;
  onBack: () => void;
  onClose: () => void;
  onFinish: () => void;
  onOpenNote?: (path: string) => void;
  /** "Connect ChatGPT too", when the other one is not connected yet. */
  onOtherAgent?: () => void;
  onRunAgain: () => void;
}) {
  const name = AGENT_NAMES[agent];
  const of = GUIDE_STEPS[agent].length;
  const picture = <StepIllustration agent={agent} step="bring" slug={slug} />;
  const frame = (children: ReactNode, footLeft: ReactNode, footRight: ReactNode, counted = true) => (
    <GuideFrame
      agentName={name}
      slug={slug}
      count={counted ? [of, of] : undefined}
      picture={counted ? picture : undefined}
      onClose={onClose}
      footLeft={footLeft}
      footRight={footRight}
    >
      {children}
    </GuideFrame>
  );
  const copyFailed =
    copied === false ? (
      <>
        <Gap />
        <P small>Couldn't copy it for you. Select the prompt below and copy it by hand.</P>
        <PromptBox text={prompt} copyLabel="Copy the prompt" />
      </>
    ) : null;

  if (view.kind === "pick") {
    return frame(
      <>
        <Heading>{`Bring over what ${name} knows`}</Heading>
        <P>
          {name} turns what it remembers from your past chats into notes here. Pick what to include, then paste the
          prompt into a new chat{agent === "chatgpt" ? " with Context switched on" : ""}.
        </P>
        <TopicPicker topics={topics} onToggle={onToggleTopic} />
        <Reveal label="See the prompt" testID="agent-setup-see-prompt">
          <PromptBox text={prompt} copyLabel="Copy the prompt" />
        </Reveal>
        <Gap />
        <P small>
          {agent === "claude"
            ? "Claude says where each note will go and waits for your go. This also checks the connection works."
            : "ChatGPT asks before each note. This also checks the connection works."}
        </P>
      </>,
      <BackLink onPress={onBack} />,
      <GuideButton label={`Copy and open ${name}`} onPress={onCopyAndOpen} testID="agent-setup-copy-open" />,
    );
  }

  if (view.kind === "done" || view.kind === "little") {
    const little = view.kind === "little";
    const count = view.written.length;
    return frame(
      <>
        <Heading>{little ? `${name} is connected` : `${name} is set up`}</Heading>
        {little ? (
          <P>It wrote its Getting started note, but it didn't have much else to bring over yet.</P>
        ) : (
          <P>
            It wrote {count === 1 ? "1 note" : `${count} notes`}, and every new {name} chat will now check @{slug}{" "}
            first. Read the notes, fix anything that's off, or delete what you don't want. Nothing you already had was
            changed.
          </P>
        )}
        <WrittenList notes={view.written} onOpen={onOpenNote} testID="agent-setup-written" />
        {little ? (
          <>
            <Gap />
            {agent === "claude" ? (
              <P>
                That usually means Claude's memory is off. Turn on{" "}
                <MenuPath parts={["Settings", "Capabilities", "Memory"]} />, or tell Claude about your work in any chat.
                With Make it stick in place, it saves what matters here as you go.
              </P>
            ) : (
              <P>
                ChatGPT only remembers past chats when <MenuPath parts={["Settings", "Personalization", "Memory"]} />{" "}
                is on, and chats in developer mode may not use memory. Tell it about your work in a chat with Context
                on, and it saves what matters here as you go.
              </P>
            )}
          </>
        ) : null}
      </>,
      little ? (
        <QuietLink label="Run the prompt again" onPress={onRunAgain} testID="agent-setup-run-again" />
      ) : onOtherAgent ? (
        <QuietLink
          label={`Connect ${agent === "claude" ? "ChatGPT" : "Claude"} too`}
          onPress={onOtherAgent}
          testID="agent-setup-other"
        />
      ) : null,
      <GuideButton label="Finish" onPress={onFinish} testID="agent-setup-finish" />,
      false,
    );
  }

  // Live: the prompt is out, and the page is watching.
  const { state, signedIn, reads, written } = view;
  const signedInRow: CheckItem = signedIn
    ? { tone: "ok", title: `Signed in to @${slug}` }
    : { tone: "bad", title: `${name} isn't signed in to @${slug}`, sub: "Go back a step and connect it again." };
  const readRow: CheckItem =
    state.kind === "stalled-nothing"
      ? { tone: "warn", title: `Nothing from ${name} yet`, sub: "Three minutes since you copied the prompt." }
      : reads > 0 || written.length > 0
        ? { tone: "ok", title: "Read your notes" }
        : { tone: "wait", title: `Waiting for ${name}…`, sub: "Notes appear here as it writes them." };
  const writeRow: CheckItem =
    written.length > 0
      ? {
          tone: "wait",
          title: "Writing notes…",
          sub: `${written.length} so far. ${agent === "claude" ? "Claude" : "ChatGPT"} may be waiting for your go on the rest.`,
        }
      : state.kind === "stalled-no-write"
        ? agent === "claude"
          ? { tone: "warn", title: "Nothing written yet", sub: "Claude is probably waiting for your go, or for you to press Allow." }
          : { tone: "bad", title: "ChatGPT hasn't written anything", sub: "If Deny was pressed, send the prompt again and press Confirm this time." }
        : { tone: "todo", title: "Write notes" };
  const stalled = state.kind === "stalled-nothing" || state.kind === "stalled-no-write";

  return frame(
    <>
      <Heading>{`Bring over what ${name} knows`}</Heading>
      <P>
        {agent === "claude" ? (
          <>
            The prompt is copied. Paste it into a new Claude chat and press <B>Allow</B> when Claude asks to use
            Context. Notes appear here as it writes them.
          </>
        ) : (
          <>
            Open a new chat, switch Context on (<B>+</B> › <B>More</B> › <B>Developer mode</B> › <B>Context</B>) and
            paste the prompt. ChatGPT asks before each note. Press <B>Confirm</B>.
          </>
        )}
      </P>
      <Checks items={[signedInRow, readRow, writeRow]} testID="agent-setup-bring" />
      {written.length > 0 ? (
        <>
          <Gap />
          <WrittenList notes={written} onOpen={onOpenNote} testID="agent-setup-written" />
        </>
      ) : null}
      {stalled ? <Tips items={tipsFor(agent, state.kind)} /> : null}
      {copyFailed}
    </>,
    <BackLink onPress={onBack} />,
    <>
      {stalled ? <QuietLink label="Do this later" onPress={onClose} testID="agent-setup-later" /> : null}
      <GuideButton label="Copy the prompt again" quiet onPress={onCopyAgain} testID="agent-setup-copy-again" />
    </>,
  );
}

function tipsFor(agent: SetupAgent, kind: "stalled-nothing" | "stalled-no-write"): ReactNode[] {
  const connectorsOn =
    agent === "claude" ? (
      <>
        Check Context is on: <B>+</B> under the message box, then <B>Connectors</B>.
      </>
    ) : (
      <>
        Check Context is on: <B>+</B> › <B>More</B> › <B>Developer mode</B> › <B>Context</B>.
      </>
    );
  if (kind === "stalled-no-write") {
    return [
      agent === "claude" ? (
        <>
          In the chat, reply <B>Go ahead</B> or press <B>Allow</B>.
        </>
      ) : (
        <>
          In the chat, reply <B>Go ahead</B> and press <B>Confirm</B> on each note.
        </>
      ),
      connectorsOn,
      "Paste the prompt again in a new chat.",
    ];
  }
  return [
    <>
      Start a <B>new</B> chat. Chats opened before you connected don't see Context.
    </>,
    connectorsOn,
    "Using the phone app? Close it fully and open it again.",
  ];
}
