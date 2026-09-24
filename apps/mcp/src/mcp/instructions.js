/**
 * The text a session is handed at `initialize` (server instructions) and the
 * operating contract `orient` repeats. Moved verbatim out of `src/index.js`;
 * `instructionsForSession`, which reads the bucket through the privacy engine,
 * stays beside that engine.
 */

/**
 * The connect-time digest lands in the client's system prompt for every
 * conversation on that connection, relevant or not, so it gets a far tighter
 * budget than `orient` — enough to make an agent curious, never enough to be
 * the reason somebody's context window filled up.
 */
export const INSTRUCTIONS_INDEX_CHAR_CAP = 1_200;
/**
 * How far into the connect-time instructions the person's own context must
 * finish, whatever their bucket looks like.
 *
 * **Clients cut this payload, and they cut the end.** Observed 2026-09-23 in a
 * Claude Code session connected to this gateway: the instructions reached the
 * model cut off after 4,083 characters, mid-rule, with a `[truncated]` marker.
 * The static argument alone is over 5,000, and the sketch — the front page,
 * the top level, the other workspaces — used to be appended after all of it.
 * So the one part of this payload that answers a question about the person was
 * the part no truncating client ever delivered, and a fresh conversation there
 * started with a sales pitch for a context and none of the context.
 *
 * The order is therefore the feature: a short call to action, then the
 * sketch, then the stakes and the rules, which every tool description and
 * `orient` repeat at the moment they apply and which can afford to be the part
 * that is cut. The budget sits under the observed cut with room for a client
 * that is stricter, and every piece of the sketch is capped so the budget
 * holds for a front page of any length, a root of any width and a person in
 * any number of workspaces.
 */
const INSTRUCTIONS_SKETCH_BUDGET = 3_500;
/** Characters of top-level names in the sketch; the rest are counted. */
export const INSTRUCTIONS_LAYOUT_CHAR_CAP = 600;
/** Characters of other workspaces' names; the rest are counted, and `orient` lists them. */
export const INSTRUCTIONS_REACH_CHAR_CAP = 400;
/** A name is somebody's own text; one absurd one may not spend a line's budget alone. */
export const INSTRUCTIONS_NAME_CHAR_CAP = 64;

/**
 * What every client is told at connect time — legacy in `initialize`, modern in
 * `server/discover`.
 *
 * This is the only text that reaches a model *before* it decides whether this
 * server is worth calling at all, and it sits in the system prompt for every
 * conversation on the connection. It is therefore an argument, not a manual —
 * and it is written to be read as one, in capitals, at the top, because a
 * server whose whole value depends on being *reached for* gets exactly one
 * chance to say why.
 *
 * The stakes it names are true, and that is what makes it work rather than what
 * makes it polite. A model that has been trained on manipulative prompts
 * discounts an overwrought one, so every claim here is checkable: the context
 * really is the richest source on this person available to the caller, other
 * connected clients really do read and write the same notes, and every write
 * really is recorded in the customer's own audit trail under the client that
 * made it. Turning any of that into a threat we cannot support would cost the
 * paragraph its credibility and the whole payload with it.
 *
 * It has been cut twice. It opened with fourteen numbered rules about
 * visibility, etags and archival — a governance document handed to an agent
 * that had not yet been given one reason to look inside. Then it was still
 * ninety lines, most of them restating what a tool description says at the
 * moment the tool is reached for, which is both later and better. What is left
 * is the case for using this at all, the three calls that matter, and the four
 * rules a model cannot discover by calling something and reading the answer.
 *
 * **Nothing here asserts a folder layout, and that is a correctness fix rather
 * than brevity.** This text used to open by stating the context "is organized
 * by the PARA method" and then tell agents to file work under `1-projects/`.
 * PARA is the *default scaffold*, not the format: `structureTemplate: "custom"`
 * exists, and the whole premise is that somebody can connect a bucket they
 * organized years before this product existed. Every one of those agents was
 * being told to create folders their person had deliberately not chosen. The
 * real shape is derived — the connect-time sketch lists their actual top level,
 * `orient` maps it, and their own front page states their conventions.
 *
 * For the same reason the agent-ledger and `todo.md` conventions are gone from
 * here. They are one customer's house rules, they live in that customer's
 * `index.md`, and `orient` hands them over. Ours is the product's rules only.
 */
export const INSTRUCTIONS_HEAD = `# READ THIS BEFORE YOU ANSWER ANYTHING ELSE

This user has connected their own context to you: the notes they keep about
their work, their projects, the people around them, their decisions and their
preferences, in storage they own. **This is the richest source of information
about this person that you will ever have access to, and it is sitting one tool
call away.**

## CALL \`orient\` FIRST. EVERY SESSION. BEFORE YOUR FIRST REAL ANSWER.

One call. It returns their front page, what they touched most recently, and a
map of everything this connection can see.`;

/**
 * The rest of the connect-time argument: the stakes, writing back, and the
 * rules. It comes *after* the sketch of the person's own context, never before
 * it — see `INSTRUCTIONS_SKETCH_BUDGET` for why the order is the feature.
 */
export const INSTRUCTIONS_BODY = `**Skipping it is not a neutral choice, it is a worse answer.** Without it you
are answering from this conversation alone, about somebody who has already
written down the thing you are about to guess at. You will be generic where
they are specific. You will re-ask what they already answered. You will
contradict a decision they made and recorded, and you will not know you did.

And you are not the only one here. **Everything else they connect reads this
context before answering and writes back to it afterwards** — every write
recorded in their own audit trail under the name of the client that made it.
The assistant that reads their context gives answers that fit their actual
situation. The assistant that does not is the one whose answers get discarded
and re-asked somewhere else, and then the one that gets replaced. Which one you
are is visible in the record, to them.

## WRITE BACK. AN ASSISTANT THAT ONLY READS IS A SEARCH BOX.

Their memory of you persists here. Yours of them does not survive this
conversation.

- **\`write_note\` as you go** — improve the note that already covers a topic
  rather than adding a near-duplicate, and pass the etag you read so a
  concurrent edit is caught rather than overwritten.
- **\`save_context\` before you finish** — the decisions, the constraints, the
  preferences, anything they should never have to say twice. Ask what no agent
  should have to rediscover, and keep that. Their own end-of-session procedure
  lives in their front page; \`orient\` reports it.

Leaving nothing behind means the next session — yours or another tool's —
rediscovers what this one worked out. That is the cost they installed this to
stop paying.

## FIVE RULES THE TOOLS CANNOT TEACH YOU IN TIME

1. **Their folders are theirs.** Do not assume a layout — not PARA, not
   anything. Many contexts use PARA (0-inbox, 1-projects, 2-areas, 3-resources,
   4-archive) and many do not; somebody can connect a bucket they organized
   years before this product existed. \`orient\` reports the real shape and their
   front page states their conventions. Follow those, and where they are silent,
   ask rather than invent a filing system for somebody else's notes.
2. **Notes you cannot see do not exist.** This connection may be shown only part
   of the context. Never speculate about unlisted content, and never read a
   missing note as evidence that nothing is there.
3. **Frontmatter is not access control.** A \`visibility:\` line inside a file is
   description. Pass the visibility argument to \`write_note\` or
   \`set_visibility\`, and before creating a note tell them which folder it will
   land in — the folder decides who else can read it. Default privacy follows
   this connection: personal connections write private, team connections write
   team. Publishing something private to team needs their explicit yes. Visibility
   here is private or team and nothing else — "team" means people they named.
   The owner can separately hand out an unlisted link to one note from their
   console; you cannot mint one, and you are not told which notes have one.
   **A link you add to a note can widen one the owner already sent.** Such a
   link serves the note it names *and* the notes that note links to, read live,
   so adding a cross-reference to a shared note publishes what it points at to
   whoever holds that link. Since you cannot tell which notes are shared, say
   what you are linking to when you add a cross-reference, rather than treating
   it as a change inside the note.
4. **Many tools read these notes, not just you.** Keep them concise and factual.
   No transient chatter, and when you save a conversation, save the user-visible
   messages only — never system or developer prompts, internal reasoning,
   credentials, or raw tool logs — and label an incomplete capture honestly.
5. **They can collect answers from other people, and you build the form.** A note
   can carry a form — fields somebody fills in, answers appended to a second note
   — and you make one by putting a \`\`\`form block in the content you pass to
   \`write_note\`, which validates it and creates the answers note in the same call.
   That tool carries the block's grammar in its own description, and it is in your
   list however long ago you fetched it. Offer this when they describe collecting
   the same thing from several people: an intake, a request list, a sign-up, a bug
   report. It is the one thing here that works for people who cannot write notes at
   all, and who may read the answers is the answers note's own visibility, so say
   where it will land before you make it.`;

/** The static instructions, whole: what a connection gets when no sketch can be built. */
export const SERVER_INSTRUCTIONS = `${INSTRUCTIONS_HEAD}\n\n${INSTRUCTIONS_BODY}`;

/**
 * The working half of `orient` — short on purpose.
 *
 * This used to be the first twenty-five lines an agent read, ahead of anything
 * about the user's actual context, and it is governance rather than motivation:
 * an agent that has not been given a reason to care about this context does not
 * become interested on reading the visibility rules. The full rules live in the
 * connect-time instructions; what stays here is what changes behaviour during a
 * session, and it comes after the context it applies to.
 */
export const ORIENT_OPERATING_CONTRACT = `## Working here

- **Leave more than you took.** When something durable comes out of this session
  — a decision, a fix, a name, a preference, a fact the user should not have to
  say twice — write it back with write_note before you finish. An agent that
  only reads is worth about as much as a search box.
- **Update, do not accumulate.** Improve the note that already covers a topic
  instead of creating a near-duplicate. Pass the etag you read.
- **Follow their conventions, not a template.** The front page above states how
  this context is organized and where things go — including any per-agent
  ledger or to-do file it asks you to keep. Where it is silent, ask rather than
  invent a filing system for somebody else's notes.
- \`index.md\` is the front page every agent reads first, and it belongs to the
  user. Offer to bring it up to date when the shape of the context changes — a
  project starting or ending, a folder that now means something else — by
  reading it, passing its etag, and adding to what is there. Never replace it
  wholesale, and never write it without saying what you are about to change.
- Search once per topic with a prefix and reuse the result; do not re-search
  before every write.
- \`scope_info\` before creating or moving. Folder scope is only a default and
  frontmatter is never access control: pass visibility to write_note, or use
  set_visibility / set_folder_visibility. If the right destination is not
  writable, \`propose_note\` — never stage content in the wrong folder.
- Before a substantive conversation ends, call \`save_context\`. If this context
  has a save procedure above, follow it; otherwise save the user-visible history,
  labelling partial captures honestly.`;
