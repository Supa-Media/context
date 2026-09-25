import { Linking } from "react-native";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { CLAUDE_CUSTOM_INSTRUCTION } from "../../onboarding/agents";
import { AGENT_LINKS, AGENT_NAMES, GUIDE_STEPS, STICK_FIELD, type SetupAgent, type StepKey } from "../guides";
import type { SigninState } from "../guideState";
import { StepIllustration } from "./Illustrations";
import { BackLink, GuideButton, GuideFrame } from "./GuideFrame";
import { B, Checks, CopyRow, Gap, Heading, Link, MenuPath, P, PromptBox } from "./parts";

export interface StepProps {
  agent: SetupAgent;
  slug: string;
  step: number;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
  /** Leave this guide for the other agent's — the free-plan way out of ChatGPT's. */
  onSwitchAgent: () => void;
}

function open(url: string) {
  void Linking.openURL(url).catch(() => {});
}

/**
 * Steps one to four: getting Context into the other app, signing in, and the
 * standing instruction that makes it stick. The words are the approved
 * artboards' (setup-flow brief, revision 3); every menu path is the other
 * product's own label, because that is what somebody is looking for.
 */
export function ConnectStep(props: StepProps & { signin: SigninState }) {
  const { agent, slug, step, onBack, onNext, onClose } = props;
  const key: StepKey = GUIDE_STEPS[agent][step]!;
  const of = GUIDE_STEPS[agent].length;
  const name = AGENT_NAMES[agent];
  const content = body(key, props);
  return (
    <GuideFrame
      agentName={name}
      slug={slug}
      count={[step + 1, of]}
      picture={<StepIllustration agent={agent} step={key} slug={slug} />}
      onClose={onClose}
      footLeft={step > 0 ? <BackLink onPress={onBack} /> : null}
      footRight={
        content.next === null ? null : (
          <GuideButton label={content.next} onPress={onNext} testID="agent-setup-next" />
        )
      }
    >
      {content.node}
    </GuideFrame>
  );
}

function body(key: StepKey, { agent, slug, signin, onSwitchAgent }: StepProps & { signin: SigninState }) {
  const link = AGENT_LINKS[agent];
  switch (key) {
    case "open":
      return {
        next: "I'm there",
        node: (
          <>
            <Heading>Open Claude's settings</Heading>
            <P>
              In Claude, go to <MenuPath parts={["Settings", "Connectors"]} />. The desktop app and claude.ai share
              one setup, and the phone app picks it up too.
            </P>
            <P>On a phone, use claude.ai in your browser for this part.</P>
            <P>
              <Link label={`${link.label} ↗`} onPress={() => open(link.settings)} testID="agent-setup-open-link" />
            </P>
          </>
        ),
      };
    case "add":
      return {
        next: "I've added it",
        node: (
          <>
            <Heading>Add Context</Heading>
            <P>
              Press <B>Add custom connector</B>, fill in these two boxes, then press <B>Add</B>.
            </P>
            <CopyRow label="Name" value="Context" />
            <CopyRow label="Remote MCP server URL" value={MCP_ENDPOINT} testID="agent-setup-copy-url" />
            <P small>Same address for everyone. You'll sign in next.</P>
            <P small>
              On a Team or Enterprise plan and don't see the button? An admin has to allow custom connectors first.
            </P>
          </>
        ),
      };
    case "devmode":
      return {
        next: "It's on",
        node: (
          <>
            <Heading>Turn on developer mode</Heading>
            <P>
              On a computer, open chatgpt.com and go to{" "}
              <MenuPath parts={["Settings", "Apps", "Advanced settings"]} />. Switch on <B>Developer mode</B>.
            </P>
            <P>It only lets ChatGPT use apps you add yourself. Nothing else changes.</P>
            <P small>
              Needs ChatGPT Plus, Pro, Business, Enterprise or Edu. That's your ChatGPT plan; there's nothing to buy
              from us. On ChatGPT's free plan? <Link label="Set up Claude instead" onPress={onSwitchAgent} />, which
              works on its free plan.
            </P>
            <P>
              <Link label={`${link.label} ↗`} onPress={() => open(link.settings)} testID="agent-setup-open-link" />
            </P>
          </>
        ),
      };
    case "create":
      return {
        next: "I've created it",
        node: (
          <>
            <Heading>Add Context as an app</Heading>
            <P>
              Still in <MenuPath parts={["Settings", "Apps"]} />, press <B>Create app</B> and fill it in.
            </P>
            <CopyRow label="Name" value="Context" />
            <CopyRow label="MCP server URL" value={MCP_ENDPOINT} testID="agent-setup-copy-url" />
            <P small>
              Set <B>Authentication</B> to <B>OAuth</B>, tick the box that says you understand, then press{" "}
              <B>Create</B>. ChatGPT opens the Context sign-in next.
            </P>
          </>
        ),
      };
    case "signin":
      return {
        // Nothing to press: the grant arriving moves the page on.
        next: null,
        node: (
          <>
            <Heading>Sign in and approve</Heading>
            <P>
              {agent === "claude" ? (
                <>
                  Press <B>Connect</B> next to Context in Claude. A Context window opens.
                </>
              ) : (
                <>After you press Create, ChatGPT opens a Context window.</>
              )}{" "}
              Check it says <B>@{slug}</B>, then press <B>Approve</B>.
            </P>
            <Checks
              testID="agent-setup-signin"
              items={[
                signin === "slow"
                  ? {
                      tone: "warn",
                      title: `${AGENT_NAMES[agent]} hasn't signed in yet`,
                      sub: "The window may have been closed, or Deny pressed.",
                    }
                  : { tone: "wait", title: "Waiting for you to approve…", sub: "This page moves on by itself." },
              ]}
            />
            <Gap />
            <P small>
              {agent === "claude"
                ? "No window? Allow pop-ups for claude.ai and press Connect again. Signed in to the wrong Context account? Sign out in the window first."
                : "No window? In Settings › Apps, open Context and press Connect."}
            </P>
          </>
        ),
      };
    case "stick": {
      const field = STICK_FIELD[agent];
      return {
        next: "It's saved",
        node: (
          <>
            <Heading>Make it stick</Heading>
            <P>
              {agent === "claude"
                ? "This tells Claude to check Context in every chat and save what it learns, without you asking each time."
                : "This tells ChatGPT to check Context and save what it learns whenever Context is switched on, without you asking."}
            </P>
            <P>
              In <MenuPath parts={field.path} />, paste this into <B>{field.field}</B> and save.
            </P>
            <PromptBox
              text={CLAUDE_CUSTOM_INSTRUCTION}
              note="Paste it word for word."
              copyLabel="Copy the instruction"
              testID="agent-setup-copy-instruction"
            />
            <Gap />
            <P small>
              {agent === "claude"
                ? "Already have preferences there? Add this on a new line below them."
                : "ChatGPT only uses Context in chats where you switch it on: + › More › Developer mode › Context."}
            </P>
          </>
        ),
      };
    }
    case "bring":
      throw new Error("The bring step is drawn by BringStep");
  }
}
