/**
 * `start_background_job`, as the texted turn is shown it (`background.js`
 * answers it). Kept apart so the session's logic stays readable.
 */

export const START_JOB_TOOL = "start_background_job";

export const TOOL = {
  name: START_JOB_TOOL,
  description:
    "Hand a long task to a background job, so you stay free for their other texts and several things run at once: research " +
    "across many sources, a multi-step task on a site, anything that takes more than a handful of tool calls. The job runs on its " +
    "own with the same access as you, writes the result where it belongs and reports back to you when done: you decide what they get. Never for a quick " +
    "answer or a single note you can write now, and never for something already in the background list. When one fact only they " +
    "know would change what the job does (do they want to cook, or have it catered? which city?), ask that one question first and " +
    "start the job on their answer; anything you can find or safely assume goes in the brief instead. " +
    "A big ask whose parts can go side by side runs in parallel by default: write one task note per part in the project's folder " +
    "(what it does, done when), then start one job per part in this same turn, up to the free slots, each with mail naming the project's " +
    "overview note and a short name for its part. Each job joins that note's mail, so they ask and tell each other at once, and you follow them there.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A few words naming the job, as they would: \"Competitor research for Tex\"." },
      brief: {
        type: "string",
        description: "Your plan for it: what to find or do, which workspace and folder, what to write and where, anything they said that matters.",
      },
      done_when: {
        type: "string",
        description:
          "What finished looks like, in one line, with every figure they asked for: \"a note comparing five competitors in @supa projects/tex/\", " +
          "\"three caterers with the full cost per person, sides and drinks included\".",
      },
      mail: {
        type: "object",
        description:
          "For one part of a split ask: the project note whose mail every part's job joins (path, and context \"@name\" when it is in another workspace), " +
          "and this job's short name there (\"pricing\", \"research\").",
        properties: {
          path: { type: "string" },
          context: { type: "string" },
          name: { type: "string" },
        },
        required: ["path", "name"],
      },
      on_computer: {
        type: "object",
        description:
          "Run it on one of their own paired computers (in a group chat, one lent to the chat) instead of the cloud, with Claude Code or Codex signed in to its owner's plan: " +
          "always for what a computer with Claude Code or Codex is good at: code (a question about how a codebase works, theirs or a public one on GitHub; finding something in a repo; a change to their code), and heavy computing (running scripts, crunching big data or many files, builds, long analysis); never the cloud for those when they have a computer, so try it first and the answer says if they have none. Also anything that needs their machine. name: the computer as they call it (left out when they have one); " +
          "tool: claude or codex; folder and repo: where on it, when they said. Runs up to four hours, checked every fifteen minutes.",
        properties: {
          name: { type: "string" },
          tool: { type: "string", enum: ["claude", "codex"] },
          folder: { type: "string" },
          repo: { type: "string" },
        },
      },
      quiet: {
        type: "boolean",
        description:
          "True when they asked not to hear from you until it's done (\"don't come back to me until you're done\"): nothing is texted now, only its result.",
      },
    },
    required: ["title", "brief"],
  },
};
