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
 * So the bootstrap step hands over a prompt whose whole job is to make the AI
 * clients they already use fill the context themselves, out of what those
 * clients already know about them. It is the first moment the product is true
 * rather than promised, and it is the reason to connect a second client.
 * (It replaced a folder-aware "seed prompt" on the old tools step, which the
 * Connections step superseded; its guardrails moved onto `BOOTSTRAP_PROMPT`
 * and are asserted in `onboardingAgents.test.ts`.)
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

/**
 * The tool a client calls first.
 *
 * Named rather than described, because the prompt tells a client to call it by
 * name and a rename upstream must break something here rather than produce a
 * prompt that quietly asks for a tool that no longer exists.
 */
export const ORIENT_TOOL = "orient";

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
  "You choose per client whether it sees team notes or everything. Team is the default, including for you, and you can revoke any client on its own from Connections.";

/**
 * Why the endpoint is the same string for everybody.
 *
 * People expect a personal URL and reach for the wrong mental model when they
 * do not get one — the recurring question is "is this someone else's?". One
 * sentence, next to the field.
 *
 * This is also the only place the per-client grant is explained. `TIER_NOTE`
 * used to open with the same clause in different words, forty pixels below;
 * two paraphrases of one promise on one screen read as two promises.
 */
export const ENDPOINT_NOTE =
  "The same URL for everyone. Your client signs in and gets its own grant — nothing in the address identifies you, so it is safe to paste anywhere you configure a tool.";

/**
 * The bootstrap prompt — for the second half of "point your AI at it".
 *
 * `seedPromptFor` writes the *first* prompt the person copies: it tells a
 * connected client the folder shape and the house rules ("call `orient`, tell
 * me which folder each note is going in, wait for me"), then asks it to write
 * three specific notes. That is the plumbing check.
 *
 * This is the follow-up: the same client, now that it can write, is asked to
 * carry across everything it already knows about the person from its own past
 * conversations. The one-liner rather than the folder-by-folder script,
 * because the client's own memory decides what belongs where. The
 * house-rule sentence at the tail — orient, announce, wait, keep short, do
 * not touch `index.md` or `privacy.md` — is the SAME set of guardrails
 * `seedPromptFor` states, restated here for exactly the same reason: this
 * prompt reaches a client we do not control, so what we care about must
 * arrive with the prompt itself.
 *
 * Kept here rather than in the screen file for the same reason
 * `seedPromptFor` is here: the folder rules and the "do not touch these two
 * files" rule are product claims, and drifting them across a JSX literal is
 * how the last prompt started asking a client to write to `index.md`.
 */
export const BOOTSTRAP_PROMPT =
  "Using everything you know about me, write notes and structure folders in the Context MCP so that the projects, areas, resources etc persist across all of my AI apps. Be sure to follow the conventions of Context — call `orient` first, tell me which folder each note is going in, wait for my go before writing, keep notes short and factual, and never touch index.md or privacy.md.";

/**
 * The standing instruction — the sentence that makes an AI client use
 * Context every conversation, not just the one it was set up in.
 *
 * A live-fire product claim rather than copy, and the reason a first-run
 * screen for a specific client exists at all. Pasting an MCP URL turns
 * `orient` and `save_context` into tools that can be called; pasting this
 * into the client's own custom instruction is what makes the client *use*
 * them without being asked. Without it, the endpoint is a lookup facility
 * that has to be invoked; with it, the endpoint is a memory the client
 * consults on its own.
 *
 * Every guide screen (Claude, ChatGPT, anything future) hands over the same
 * string. Kept here for the reason `TIER_NOTE` and `ENDPOINT_NOTE` are: a
 * paraphrase in a second screen would state the same commitment in different
 * words and drift.
 */
export const CLAUDE_CUSTOM_INSTRUCTION =
  "Always orient using the Context MCP (call orient) before answering anything about me or my work, and save what you learn with save_context before you finish. Always leave the context in a better state than you found it, updating the information there — this is the memory that will persist.";
