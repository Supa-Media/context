/**
 * "Bring over what it knows" — the last setup step, and the connection check.
 *
 * The person picks what to include and copies one prompt. The agent then reads
 * the workspace and writes notes into it, and those reads and writes are what
 * the guide watches for (`checks.ts`), so one paste both fills the workspace
 * and proves the connection works. The prompt always ends with a "Getting
 * started" note, so an agent with nothing in its memory still writes once and
 * the check can still pass.
 *
 * The guardrails are `BOOTSTRAP_PROMPT`'s (`onboarding/agents.ts`): orient
 * first, say where each note goes and wait, write only what is known, never
 * overwrite, never touch index.md or privacy.md. They travel inside the prompt
 * because it reaches an agent we do not control.
 */

export type BringTopic = "work" | "people" | "style" | "personal";

export interface BringTopicRow {
  key: BringTopic;
  label: string;
  sub: string;
  /** How it is named inside the prompt. */
  phrase: string;
  /** Personal life is off unless somebody turns it on. */
  initial: boolean;
}

export const BRING_TOPICS: readonly BringTopicRow[] = [
  { key: "work", label: "Work and projects", sub: "What you're working on and where things stand", phrase: "my work and projects", initial: true },
  { key: "people", label: "People you work with", sub: "Names and roles, never contact details", phrase: "the people I work with (names and roles only)", initial: true },
  { key: "style", label: "How you like to work", sub: "Preferences, tools, writing style", phrase: "how I like to work", initial: true },
  { key: "personal", label: "Personal life", sub: "Off unless you want it", phrase: "my personal life", initial: false },
];

export const DEFAULT_TOPICS: readonly BringTopic[] = BRING_TOPICS.filter((row) => row.initial).map((row) => row.key);

/** The name of the note every run ends with. */
export const GETTING_STARTED = "Getting started";

function list(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases.join("");
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/**
 * The prompt, for one workspace and the topics picked.
 *
 * Names the workspace by handle, because one connection reaches every
 * workspace the person belongs to: a member connecting to a team's workspace
 * would otherwise see the agent write into their personal one.
 */
export function bringPrompt(slug: string, topics: readonly BringTopic[]): string {
  const picked = BRING_TOPICS.filter((row) => topics.includes(row.key)).map((row) => row.phrase);
  const about =
    picked.length === 0
      ? ""
      : ` From what you remember about me, write short notes about ${list(picked)}.`;
  return (
    `Use Context to set up my @${slug} workspace. Call orient first.${about} ` +
    "Tell me which folder each note goes in and wait for my go. Only write what you actually know. " +
    "Don't change notes that already exist, and don't touch index.md or privacy.md. " +
    `Finish with a note called "${GETTING_STARTED}" in the inbox that lists what you saved.`
  );
}
