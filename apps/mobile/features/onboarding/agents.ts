/**
 * The step that decides whether any of the rest mattered.
 *
 * Everything before this produces an empty bucket. A context with nothing in
 * it is a dead product — the pitch is "every tool starts already knowing your
 * projects", and on a bucket with five empty folders that is a promise rather
 * than a fact. But the obvious fix, asking a person to type their life into a
 * text box thirty seconds after signing up, is a worse dead end than the one
 * it replaces.
 *
 * So this step hands over a prompt whose whole job is to make the AI clients
 * they already use fill the context themselves, out of what those clients
 * already know about them. It is the first moment the product is true rather
 * than promised, and it is the reason to connect a second client.
 *
 * ## Why the prompt is here and not in a component
 *
 * Because it is the closest thing this app has to a spec for how a connected
 * client should behave on first contact, and it has to agree with three things
 * that live elsewhere: the tool names the gateway actually exposes, the folder
 * shape the person chose one screen ago, and the house rule that an agent says
 * which folder a note is going in *before* it writes it. A string sitting in
 * JSX drifts from all three silently. Here it can be asserted.
 */

import { PARA_FOLDERS } from "@context/convex/functions/lib/scaffold";

/**
 * The tool a client calls first.
 *
 * Named rather than described, because the prompt tells a client to call it by
 * name and a rename upstream must break something here rather than produce a
 * prompt that quietly asks for a tool that no longer exists.
 */
export const ORIENT_TOOL = "orient";

/**
 * The clients worth naming on screen.
 *
 * Not a capability list and not an endorsement — the endpoint is the same URL
 * for everyone and anything that speaks MCP works. This is here because "any
 * MCP client" means nothing to somebody who has never heard of MCP, and four
 * names they recognise do.
 */
export const KNOWN_CLIENTS = ["Claude", "ChatGPT", "Codex", "Cursor", "Notion AI"] as const;

/** What the seed prompt asks a client to write, in the order it asks. */
interface SeedTask {
  /** Where it lands. `null` for the root manifest. */
  folder: string | null;
  what: string;
}

/**
 * The three things worth having on day one.
 *
 * Deliberately three. A prompt that asks for a complete personal knowledge
 * base produces a wall of confident invention; one that asks for an index, the
 * live projects, and the reusable preferences produces something the person
 * recognises and can correct.
 */
function seedTasks(folders: readonly string[]): SeedTask[] {
  const projects = folders.find((f) => f.startsWith("1-")) ?? folders[0] ?? null;
  const resources = folders.find((f) => f.startsWith("3-")) ?? folders[1] ?? null;
  return [
    { folder: null, what: "who I am and what I'm working on now" },
    {
      folder: projects,
      what: "one note per active project — its goal, its current state, and the decisions still open",
    },
    {
      folder: resources,
      what: "anything reusable — my preferences, my tools, the conventions you've learned working with me",
    },
  ];
}

/**
 * The prompt, for a context with these top-level folders.
 *
 * Takes the folders rather than assuming PARA, because somebody who chose
 * their own shape one screen ago must not be handed a prompt naming folders
 * they declined. `seedPromptFor([])` is a real case — a custom layout can be a
 * single folder, and the prompt still has to make sense.
 *
 * Three sentences of it are load-bearing and should not be trimmed for length:
 *
 *  - **"Tell me which folder each note is going in before you write it."**
 *    This is the house rule from the MCP server's own instructions, and the
 *    folder determines the visibility scope. A prompt that skipped it would be
 *    teaching every client the product ships with to ignore the one
 *    confirmation that stops a private thing landing somewhere shared.
 *  - **"Keep them short and factual."** Without it the first thing in a brand
 *    new context is a thousand words of flattering summary, which is what
 *    people delete and then never come back to.
 *  - **The standing instruction at the end.** The one-off seeding is the demo;
 *    "check Context before answering, write down decisions worth keeping" is
 *    the behaviour that makes the product a habit rather than an import.
 */
export function seedPromptFor(folders: readonly string[]): string {
  const lines: string[] = [
    "I've connected you to my Context — a shared memory you can read and write,",
    "which every other AI tool I use can read too.",
    "",
    `Start by calling \`${ORIENT_TOOL}\` to see how it is laid out. Then, from what you`,
    "already know about me and the work we have done together, write:",
    "",
  ];

  seedTasks(folders).forEach((task, index) => {
    const where = task.folder === null ? "`index.md` at the root" : `\`${task.folder}/\``;
    lines.push(`  ${index + 1}. ${where} — ${task.what}`);
  });

  lines.push(
    "",
    "Tell me which folder each note is going in before you write it.",
    "Keep them short and factual — they are shared context for many tools, not a report.",
    "",
    "From now on: check Context before answering anything about my projects,",
    "and write down decisions worth keeping.",
  );

  return lines.join("\n");
}

/** The prompt for the standard layout, which is what most people will have. */
export function defaultSeedPrompt(): string {
  return seedPromptFor(PARA_FOLDERS);
}

/**
 * What the screen says about the tier, in one sentence.
 *
 * Stated here rather than in the component because it is a claim about what
 * the control plane will do, and it must not drift from it. The consent screen
 * defaults to `team` for everybody, owners included — approving private access
 * is an opt-in — so a first-run screen implying a client sees everything would
 * be describing a product we deliberately do not ship.
 */
export const TIER_NOTE =
  "Each client signs in and gets its own grant, which you can revoke on its own. You choose per client whether it sees team notes or everything — team is the default, including for you.";

/**
 * Why the endpoint is the same string for everybody.
 *
 * People expect a personal URL and reach for the wrong mental model when they
 * do not get one — the recurring question is "is this someone else's?". One
 * sentence, next to the field.
 */
export const ENDPOINT_NOTE =
  "The same URL for everyone. Your client signs in and gets its own grant — nothing in the address identifies you, so it is safe to paste anywhere you configure a tool.";
