/**
 * A TEXTED TURN KNOWS THEIR COMPUTERS (Dev, 2026-11-04: "code and heavy
 * computing go to a paired computer").
 *
 * The splitting bench (`bench/ai/tests/splitting.md`, run gh-149) gave every
 * person a paired computer, and in all twelve code answers the turn ran the
 * job in Tex's cloud or handed it to Claude Code on the web (`delegate`),
 * never to the computer: the turn was never told one was there. The tool's
 * `on_computer` said "try it first and the answer says if they have none",
 * and the everyday model never tried.
 *
 * So a chat turn reads the computers it may name beside the history
 * (`machines/forJobs.js` `machinesFor`, one workspace-object read per
 * workspace, started ahead of the model), and when one is there:
 *
 *  - the turn is told, by name, with its tools, and what goes to it;
 *  - `delegate` no longer offers Claude Code or Codex on the web, and a call
 *    naming either is answered with the computer instead, so code has one
 *    road while a computer is paired.
 *
 * With no computer, nothing here changes the turn.
 */

/** The agents `delegate` reaches on the web that a paired computer runs itself. */
export const COMPUTER_AGENTS = new Set(["claude-code", "codex"]);

/** The computers that can take code: Claude Code or Codex on them. */
export function codeComputers(machines) {
  return (Array.isArray(machines) ? machines : []).filter((machine) => (machine?.tools ?? []).some((tool) => tool === "claude" || tool === "codex"));
}

const TOOL_NAMES = { claude: "Claude Code", codex: "Codex" };

/** How one computer is named to the turn: `"Studio Mac" (online; Claude Code, Codex; 3 slots)`. */
function described(machine) {
  const tools = (machine.tools ?? []).map((tool) => TOOL_NAMES[tool] ?? tool).join(", ");
  const slots = Number.isSafeInteger(machine.slots) ? `; ${machine.slots} ${machine.slots === 1 ? "slot" : "slots"}` : "";
  return `"${String(machine.name).replace(/"/g, "'")}" (${machine.online ? "online" : "offline"}; ${tools}${slots})`;
}

/**
 * The turn's line about their computers, or "" with none that takes code.
 * `planning`: the turn also has `plan_big_ask`, which splits a big change there.
 * `own`: the config wires Tex's own computer (`tools -> computer`, `texComputerSandbox.js`), so a cloud job has a
 * Linux computer of its own, and running scripts or crunching data that isn't in their repos goes there instead.
 */
export function computersLine(machines, { planning = false, own = false } = {}) {
  const usable = codeComputers(machines);
  const ownLine = own ? ownComputerLine() : "";
  if (usable.length === 0) return ownLine;
  const first = String(usable[0].name).replace(/"/g, "'");
  return (
    `\n\n${usable.length === 1 ? "They have a computer" : "They have computers"} paired with Tex: ${usable.map(described).join(", ")}. ` +
    "Code and heavy computing always go to it as a background job, send action background with " +
    `on_computer { name: "${first}" } (and repo or folder as they named it): a question about how a codebase works, theirs or a public one on GitHub; ` +
    "finding something in a repo; any change to code, a pull request included; and " +
    (own ? "builds or scripts in their repos or on their files. " : "running scripts, builds or crunching many files. ") +
    "Never Tex's cloud, never delegate, and never open_page on the repo for those, and never ask which repo or which computer: the job finds it. " +
    (planning ? "A big code change with parts that can be built at once is split there with send action plan. " : "") +
    "Everything else stays off it." +
    ownLine
  );
}

/**
 * Tex's own computer, told to a texted turn while the config wires it (Lab test, 2026-11-20: with it wired but
 * untold, the Front door answered "this chat has no computer" and started no job).
 */
function ownComputerLine() {
  return (
    "\n\nTex has a Linux computer of its own for this chat, reached only from a background job in Tex's cloud " +
    "(send action background with no on_computer), whose job calls tex_computer: bash, Python with pandas, Node, sqlite3 and pdftotext, no internet. " +
    "Running a script, computing or checking numbers, crunching data they sent or converting a file go there: start the job, never work it out by hand " +
    "and never say there is no computer."
  );
}

/**
 * `delegate` with a computer paired (`delegate.js` `delegateSession`): Claude
 * Code and Codex leave its list, and a call naming either is sent to the
 * computer. Returns the delegation unchanged when there is no such computer.
 */
export function delegationBeside(delegation, machines) {
  const usable = codeComputers(machines);
  if (delegation === null || usable.length === 0) return delegation;
  const name = String(usable[0].name).replace(/"/g, "'");
  const tools = delegation.tools.map((tool) => {
    const agent = tool?.inputSchema?.properties?.agent;
    if (!Array.isArray(agent?.enum)) return tool;
    return {
      ...tool,
      description: `${tool.description} Code is never delegated while they have a computer paired: it goes to "${name}" as a background job.`,
      inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, agent: { ...agent, enum: agent.enum.filter((key) => !COMPUTER_AGENTS.has(key)) } } },
    };
  });
  return {
    ...delegation,
    tools,
    call: (args) =>
      COMPUTER_AGENTS.has(args?.agent)
        ? Promise.resolve({
            content: [{ type: "text", text: `They have "${name}" paired with Tex, so code runs there: call send action background with on_computer { name: "${name}" } instead, and nothing is delegated.` }],
            isError: true,
          })
        : delegation.call(args),
  };
}
