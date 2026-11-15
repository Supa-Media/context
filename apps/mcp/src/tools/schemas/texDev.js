/**
 * `tex_dev` (`../../texDev/tool.js`): developing on Tex, offered only to people who edit `@context-lc`'s AI setup.
 * Part of `baseToolDefinitions` (`../schemas.js`). Like the v2 tools it takes an `action` and an open `args`, so a
 * new action is not a new argument a client's cached copy of this schema would strip; `guide` lists them all.
 */

export function texDevToolDefinitions() {
  return [
    {
      name: "tex_dev",
      title: "Tex developer tools",
      description:
        "Develop on Tex, the texting assistant, in the Tex Architecture Lab: make a named draft of Tex's config " +
        "graph, edit it live while a person edits the same draft in the Lab, see it as a picture, get its live Lab " +
        "link, check and promote it; and probe any of your chats' turns: every step and node in the order it ran, " +
        "with inputs, outputs, thinking, the context it loaded, timing and what failed, and everything the Lab's Replay " +
        "shows: moments, the prompt's words, background jobs; and everything the Lab computes: speed and cost, compare, the run's config. Actions: guide, list, create, get, edit, changes, snapshot, " +
        "link, check, promote, tool_stats, cases, case, chats, turns, turn, entries, moments, prompt, jobs, mine, rename, delete, run_setup, keep_results, revert, sim, compare, config, bench, modules, reference. Start with guide. Nothing " +
        "here changes live Tex: only a promoted draft's pull request does, through CI and the replay gate.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "One of: guide, list, create, get, edit, changes, snapshot, link, check, promote, tool_stats, cases, case, chats, turns, turn, entries, moments, prompt, jobs, mine, rename, delete, run_setup, keep_results, revert, sim, compare, config, bench, modules, reference." },
          args: { type: "object", description: "The action's own arguments; guide lists what each takes." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
