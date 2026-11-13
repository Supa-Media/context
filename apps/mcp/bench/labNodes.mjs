/**
 * WHICH LAB STEP A MODEL CALL BELONGS TO (`stepLog.mjs` writes it on every line; the Tex Architecture Lab keys its
 * steps by these ids: `fd`, `reviewer`, ...).
 *
 * A call does not say which step made it, so it is named from what is sent. A Claude call is named by a phrase copied
 * from its role's system prompt, and a Workers AI call by a question name it asks (the router asks `tier`, the judge
 * asks `moved_on` and `draft_fits`). Each phrase is copied verbatim from its source file, one literal, not built from
 * pieces of a template, and `test/stepLog.test.mjs` finds each one in that file, so a rewrite that drops it fails CI
 * rather than quietly filing the calls under "?".
 *
 * Order matters: the first entry whose phrase is in the call wins, so the more specific roles come first. A background
 * job's turn is the front door's own prompt with the job's paragraph added (`background.js` `jobPrompt`), so it must be
 * named as a job before the front door's line matches it.
 */

/**
 * `{ node, kind, file, phrase }`. `file` is repo-relative. For `kind: "claude"` the phrase is a substring of the system
 * prompt; for `kind: "workers-ai"` it is the name of a question the call asks (its key in `questions`).
 */
export const NODE_SIGNS = Object.freeze([
  // A background job's own turn (`background.js` `jobPrompt`): the front door's prompt plus "you are that job".
  { node: "job", kind: "claude", file: "apps/mcp/src/agent/background.js", phrase: "This turn is a background job you started from their text" },
  // Every texting turn's line about the message (`prompt.js`); production's own prompt stands in only for the identity.
  { node: "fd", kind: "claude", file: "apps/mcp/src/agent/prompt.js", phrase: "This turn is a text message they sent you from their phone." },
  // The advisor's roles (`advisorRoles/*.js`), each its own prompt. Core passes them through `withArchitecture`, so the
  // phrase is in the system text beside the architecture map.
  { node: "planner", kind: "claude", file: "apps/mcp/src/agent/advisorRoles/planner.js", phrase: "You plan work for Tex, a texting assistant" },
  { node: "jobcheck", kind: "claude", file: "apps/mcp/src/agent/advisorRoles/jobCheck.js", phrase: "One of Tex's background jobs has just stopped." },
  { node: "mailadv", kind: "claude", file: "apps/mcp/src/agent/advisorRoles/jobMail.js", phrase: "You are the advisor to one of Tex's background jobs" },
  { node: "advisor", kind: "claude", file: "apps/mcp/src/agent/advisorRoles/chat.js", phrase: "It has paused to ask you for advice." },
  { node: "mail", kind: "claude", file: "apps/mcp/src/agent/mailChecker.js", phrase: "You check one email before a person is asked to approve it." },
  { node: "card", kind: "claude", file: "apps/mcp/src/agent/cardCheck.js", phrase: "You are the eye of Tex, an assistant people text." },
  { node: "reviewer", kind: "claude", file: "apps/mcp/src/agent/replyJudge.js", phrase: "You review a text that Tex, a person's texting assistant, is about to send them." },
  { node: "classifier", kind: "claude", file: "apps/mcp/src/agent/conversationThreads.js", phrase: "You sort a text chat with Tex (an assistant people text) into conversation threads." },
  // Both of selfReview's prompts (scores only, and the full write-up) open with this line.
  { node: "selfreview", kind: "claude", file: "apps/mcp/src/agent/selfReview.js", phrase: "You review one finished conversation between a person and Tex" },
  // `claimCheck.js` makes no model call (it is patterns), so the hand-back judge is the only handback role.
  { node: "handback", kind: "claude", file: "apps/mcp/src/agent/handbackJudge.js", phrase: "You check one text an assistant named Tex is about to send a person." },
  // The texting decision (`textsDecide.js` over `packages/shared/src/textDecide.cjs`): the judge's questions, then its
  // recheck of a drafted reply.
  { node: "decide", kind: "workers-ai", file: "packages/shared/src/textDecide.cjs", phrase: "moved_on" },
  { node: "decide", kind: "workers-ai", file: "packages/shared/src/textDecide.cjs", phrase: "draft_fits" },
  // The router's one question, which tier a text runs on (`router.js`).
  { node: "router", kind: "workers-ai", file: "apps/mcp/src/agent/router.js", phrase: "tier" },
  // Bench-only callers: the person the bench plays (`models.mjs`), and the grader of a replay's answers (`judge.mjs`).
  { node: "bench:person", kind: "claude", file: "apps/mcp/bench/models.mjs", phrase: "You are playing a person texting their notes assistant, in a test." },
  { node: "bench:judge", kind: "claude", file: "apps/mcp/bench/judge.mjs", phrase: "You grade answers from a notes assistant against a checklist." },
]);

/**
 * The system prompt as one string. A string is used as it is; a structured one (the turn's `{ stable, context }`, or
 * the Messages API's blocks) is read through JSON, which leaves every phrase intact because no phrase holds a quote,
 * a backslash or a newline.
 */
function systemOf(request) {
  const system = request?.system;
  if (system === undefined || system === null) return "";
  return typeof system === "string" ? system : JSON.stringify(system);
}

/**
 * The Lab step a call belongs to, or "?" when no sign names it. `kind` is "claude" or "workers-ai"; `request` is what
 * the socket was asked (for Workers AI, `{ model, input: { state, questions } }`).
 */
/** GLM's Workers AI ids (`DEFAULT_BUILTIN_MODEL` in `src/agent/builtin.js`). */
const GLM_PREFIX = "@cf/zai-org/glm";

export function labNodeFor(kind, request) {
  if (kind === "workers-ai") {
    const names = Object.keys(request?.input?.questions ?? {});
    const sign = NODE_SIGNS.find((entry) => entry.kind === "workers-ai" && names.includes(entry.phrase));
    if (sign) return sign.node;
    // GLM asks no typed questions: on Workers AI it is the built-in model a turn falls back to (`builtin.js`).
    return String(request?.model ?? "").startsWith(GLM_PREFIX) ? "fallback" : "?";
  }
  const system = systemOf(request);
  const sign = NODE_SIGNS.find((entry) => entry.kind === "claude" && system.includes(entry.phrase));
  return sign ? sign.node : "?";
}
