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
        "link, check and promote it; run it on the Dev set on GitHub, on main's code or a pull request's, and read the runs; and probe any of your chats' turns: every step and node in the order it ran, " +
        "with inputs, outputs, thinking, the context it loaded, timing and what failed, and everything the Lab's Replay " +
        "shows: moments, the prompt's words, background jobs; and everything the Lab computes: speed and cost, compare, the run's config; " +
        "and the Lab's Evals (public benchmarks run on GitHub: LongMemEval as an AI client's memory, and the Search suite, which asks whether search puts the right note first, embeddings only); and the Testing tab's Training and Dev conversations (list, read, edit messages and labels per message × node, star unit tests, move between sets, add pictures to messages, read a chat's change history and put a revision back, import one of your real chats rewritten, promote; never the Test Set). Actions: guide, list, create, get, edit, changes, snapshot, " +
        "link, check, promote, run, runs, failures, run_remove, evals, eval_run, eval_remove, code, tool_stats, node_stats, cases, case, chats, turns, turn, entries, failed_searches, moments, prompt, jobs, mine, rename, delete, run_setup, keep_results, revert, sim, compare, config, bench, modules, reference, steps, marks, put_back, search, search_bench, sets, set_get, set_fields, set_edit, set_move, set_create, set_import, set_delete, set_restore, set_history, set_back, set_ratio, set_promote. Start with guide. Nothing " +
        "here changes live Tex: only a promoted draft's pull request does, through CI and the replay gate.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "One of: guide, list, create, get, edit, changes, snapshot, link, check, promote, run, runs, failures, run_remove, evals, eval_run, eval_remove, code, tool_stats, node_stats, cases, case, chats, turns, turn, entries, failed_searches, moments, prompt, jobs, mine, rename, delete, run_setup, keep_results, revert, sim, compare, config, bench, modules, reference, steps, marks, put_back, search, search_bench, sets, set_get, set_fields, set_edit, set_move, set_create, set_import, set_delete, set_restore, set_history, set_back, set_ratio, set_promote, test_chat (was sandbox)." },
          args: { type: "object", description: "The action's own arguments; guide lists what each takes." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
