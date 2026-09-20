/**
 * The model account a context spends, as decidable facts rather than JSX.
 *
 * `features/console/capabilities.ts` records the rule this file exists for in
 * one line: *every guard expressed inside a component in this app was held by
 * nothing.* Whether a key is shaped like a key, who may connect one, and what
 * the settings row says about it are each decided here, where a test reaches
 * them, and `ModelPanel` renders what they return.
 *
 * ## What is being connected, said accurately
 *
 * This takes an **API key** from the person's own Anthropic or OpenAI account,
 * and their account is billed for what the agent does. That is the whole of it,
 * and the copy below says so plainly — because the neighbouring claim is easy
 * to make and wrong.
 *
 * The wrong version, which an earlier draft of this feature's mocks carried:
 * *"a Claude or ChatGPT subscription cannot be used by a third-party app."*
 * Both halves are false. OpenAI ships **Sign in with ChatGPT**, an official way
 * for a third-party app to draw on somebody's ChatGPT plan; and Anthropic's
 * June 15 notice says in as many words that it is *pausing* the change it had
 * announced, so the Claude Agent SDK, `claude -p` and third-party app usage
 * still draw from a subscription's limits. Neither is what this screen
 * connects today, and neither is impossible. So the copy states what this does
 * and does not editorialise about what it does not do yet.
 */

/** The providers this build can spend. Mirrors the control plane's closed set. */
export const MODEL_PROVIDERS = [
  {
    name: "anthropic",
    label: "Anthropic",
    /** What the model is, in the words somebody would recognise. */
    models: "Claude",
    /** Where the key comes from, so nobody has to search for it. */
    console: "console.anthropic.com",
  },
  {
    name: "openai",
    label: "OpenAI",
    models: "GPT",
    console: "platform.openai.com",
  },
] as const;

export type ModelProviderName = (typeof MODEL_PROVIDERS)[number]["name"];

/** One connected account, as `listProviders` answers. */
export interface ModelConnection {
  provider: string;
  /** Eight hex of the key's SHA-256 — never a fragment of the key itself. */
  fingerprint: string;
  connectedAt: number;
}

/**
 * The longest key these providers issue, with room to spare.
 *
 * The same bound `apps/convex/functions/providers.ts` enforces, restated here
 * so the refusal happens before a key leaves the device rather than after.
 * **The backend's copy is the control and this is the courtesy** — the same
 * division `toolsForSession` keeps with `callToolForSession`, and the reason a
 * drift between the two is a worse message rather than a hole.
 */
export const MAX_KEY_LENGTH = 512;

/**
 * Why this cannot be a key, or `null`.
 *
 * Checks the *shape* and never the prefix. Matching `sk-ant-` here would refuse
 * a key whose prefix changed and produce a support ticket blaming us for
 * somebody else's rename, which is the argument the backend's own
 * `assertUsableKey` makes; this mirrors it rather than inventing a stricter
 * rule the server would then accept.
 *
 * Every sentence describes the shape and **never quotes the value**. A message
 * reading `expected a key, got sk-ant-…` is #661 written into a settings
 * screen, where it lands in a screenshot somebody pastes into a support thread.
 */
export function keyProblem(value: string): string | null {
  if (value.length === 0) return "Paste your key.";
  if (value.length > MAX_KEY_LENGTH) {
    return "That is longer than any key these providers issue.";
  }
  if (value.trim() !== value || /\s/.test(value)) {
    return "A key has no spaces or line breaks in it. Check what was pasted.";
  }
  return null;
}

/** Whether this draft may be sent. */
export function canConnectKey(value: string): boolean {
  return keyProblem(value) === null;
}

/**
 * Who may connect or disconnect a model account.
 *
 * `editor` and above, matching `connectProvider`'s own
 * `requireWorkspaceRole(..., "editor")`. A `member` of somebody else's context
 * is shown what is connected and no control, rather than a button whose only
 * outcome is a permission error — `MeetingsDestination`'s "absent rather than
 * disabled" rule, applied to a credential.
 */
export function canChangeModel(role: string | undefined): boolean {
  return role === "owner" || role === "editor";
}

/** The connection for one provider, or `null`. */
export function connectionFor(
  connections: readonly ModelConnection[] | undefined,
  name: string,
): ModelConnection | null {
  if (connections === undefined) return null;
  return connections.find((entry) => entry.provider === name) ?? null;
}
