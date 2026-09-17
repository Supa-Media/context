/**
 * The continuity demo's words, out of the component for the reason the rest of
 * the page's are.
 *
 * `copy.ts` was built so the vocabulary and overclaim rules have something to
 * hold, and it named one file — `Landing.tsx` — where the hazard is the whole
 * landing folder. `ContinuityDemo` is the section a visitor meets **first**,
 * and it carried five sentences and a three-beat transcript that no rule read,
 * including the strongest confidentiality claims on the page: *"the private
 * notes you didn't"*, *"The note moves. The boundary doesn't."*, *"his private
 * notes were never available to me."*
 *
 * Those are non-negotiables #4 and #5 said to somebody who has not signed up
 * yet. A false one would be the visitor deciding to trust us with something on
 * a promise we do not make, and the only thing standing between the page and
 * that was whoever edited it last.
 *
 * Its own file rather than more constants in `copy.ts`: the transcript is a
 * structure, not a line, and `copy.ts`'s completeness test reads that file's
 * exports as strings one by one. Both files feed `LANDING_COPY`, which is what
 * every rule is applied to.
 */

/** The one team-safe decision every card in the demo hands forward. */
export const TEAM_THOUGHT = "Show continuity, not storage.";

/** The section heading: an eyebrow, a title, and the claim under them. */
export const DEMO_EYEBROW = "One thought · three AIs";
export const DEMO_TITLE = "Tell one AI. The others already know.";
export const DEMO_SUB =
  "Context carries the decision to every client and teammate you allowed—not the private notes you didn't.";

/** The line under the three beats, and the sentence that explains it. */
export const DEMO_BOUNDARY_TITLE = "The note moves. The boundary doesn't.";
export const DEMO_BOUNDARY_BODY =
  "ChatGPT and Claude Code can use your full context. Your coworker's Notion AI receives only what you marked for the team.";

/**
 * The three beats, as a transcript.
 *
 * `id` and `mark` are structure and a glyph; everything else is prose a visitor
 * reads word for word, and all of it is spread into `LANDING_COPY`.
 */
export const CONTINUITY_STEPS = [
  {
    id: "chatgpt",
    product: "ChatGPT",
    mark: "C",
    access: "Private access",
    moment: "You tell it once",
    prompt:
      "New thought: the demo should show continuity, not storage. Share that with the Context team.",
    reply:
      "Saved as a team note in the @context-lc workspace. Your own workspace stays private.",
    receipt: "Published to the team workspace · just now",
  },
  {
    id: "claude-code",
    product: "Claude Code",
    mark: ">_",
    access: "Private access",
    moment: "Your next AI picks it up",
    prompt: "Update the landing page with our newest product direction.",
    reply:
      "I found the thought you added in ChatGPT: “Show continuity, not storage.” I’m building the three-AI handoff now.",
    receipt: "Read from @context-lc · no re-explaining",
  },
  {
    id: "teammate",
    product: "Coworker’s Notion AI",
    mark: "N",
    access: "Team access",
    moment: "The right teammate knows too",
    prompt: "What changed in Context’s product direction?",
    reply:
      "Seyi added a team note: make cross-AI continuity the demo. I can use that decision; his private notes were never available to me.",
    receipt: "Shared workspace visible · yours hidden",
  },
] as const;

/** Every sentence this file holds, flattened for the copy rules to check. */
export const DEMO_COPY: readonly string[] = [
  TEAM_THOUGHT,
  DEMO_EYEBROW,
  DEMO_TITLE,
  DEMO_SUB,
  DEMO_BOUNDARY_TITLE,
  DEMO_BOUNDARY_BODY,
  ...CONTINUITY_STEPS.flatMap((step) => [
    step.product,
    step.access,
    step.moment,
    step.prompt,
    step.reply,
    step.receipt,
  ]),
];
