/**
 * THE TOOL SHELF: A FEW TOOLS IN HAND, THE REST BY NAME.
 *
 * Decided by the owner, 2026-10-14, after finding Tex "very stupid": every
 * texted turn was handed about fifty tools, some 19,000 tokens of schema, on
 * every round, and a small model buried in tool descriptions picks badly and
 * slowly. "We only give it the absolute necessity tools ... it should know the
 * names of the tools ... and then it uses tool search to get the actual schema."
 *
 * So a setup may name its core tools:
 *
 *   core_tools: [search_notes, read_note, write_note, read_skill]
 *
 * and a turn is then offered those, each with only the first paragraph of its
 * description, plus `find_tools`. Every other tool the turn holds is on the
 * shelf: its name and first sentence are in the system prompt, and
 * `find_tools` puts its full definition in the tool list from the next round
 * on. A setup with no `core_tools` offers everything, as before.
 *
 * The shelf changes what the model is *told about*, never what it may reach:
 * every shelved tool is already one this turn holds (`turn.js` checks names
 * against the whole list), so a model that calls one by name without loading
 * it first has it loaded and run, exactly as if it had asked.
 */

export const FIND_TOOLS = "find_tools";

/** Most tools one `find_tools` call loads, so a vague query can't load the lot. */
export const MAX_LOADED_PER_CALL = 6;

/** How much of a shelved tool's description the prompt carries. */
const MAX_SUMMARY_CHARS = 110;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const FIND_TOOLS_DEFINITION = {
  name: FIND_TOOLS,
  description:
    "Load more of your tools. The system prompt lists every tool you have that isn't loaded yet, by name. " +
    "Pass names to load those, or a few words (query) describing what you need to do. Loaded tools can be called from your next step.",
  inputSchema: {
    type: "object",
    properties: {
      names: { type: "array", items: { type: "string" }, description: "Tool names from the list, e.g. [\"browse\", \"orient\"]." },
      query: { type: "string", description: "What you need to do, in a few words, when you don't know the name." },
    },
  },
};

/** A setup's `core_tools:` list, or null when it is not a valid one. Absent is `undefined`: no shelf. */
export function readCoreTools(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  return value.every((name) => typeof name === "string" && TOOL_NAME.test(name)) ? [...new Set(value)] : null;
}

/** A description's first paragraph: the core tool's short version. */
export function firstParagraph(description) {
  const text = typeof description === "string" ? description.trim() : "";
  const end = text.search(/\r?\n\s*\r?\n/);
  return end === -1 ? text : text.slice(0, end).trim();
}

/** A description's first sentence, bounded: what the prompt says about a shelved tool. */
export function summaryOf(description) {
  const paragraph = firstParagraph(description).replace(/\s+/g, " ");
  // A sentence ends where the next one starts with a capital: "(e.g. '1-projects')" does not.
  const sentence = /^(.+?[.!?])(?=\s+[A-Z]|$)/.exec(paragraph)?.[1] ?? paragraph;
  return sentence.length > MAX_SUMMARY_CHARS ? `${sentence.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…` : sentence;
}

function words(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  );
}

/**
 * The shelf for one turn.
 *
 * @param {Array<{name: string, description?: string}>} tools every tool the turn holds
 * @param {string[]} core the setup's core tool names; ones the turn doesn't hold are ignored
 */
export function toolShelf(tools, core) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const coreNames = new Set(core.filter((name) => byName.has(name)));
  const loaded = new Set();
  const shelved = () => tools.filter((tool) => !coreNames.has(tool.name) && !loaded.has(tool.name));

  const load = (names) => {
    const added = [];
    for (const name of names) {
      if (byName.has(name) && !coreNames.has(name) && !loaded.has(name)) {
        loaded.add(name);
        added.push(name);
      }
    }
    return added;
  };

  return {
    /** What the model is offered this round. */
    shown() {
      return [
        ...tools
          .filter((tool) => coreNames.has(tool.name))
          .map((tool) => ({ ...tool, description: firstParagraph(tool.description) })),
        ...tools.filter((tool) => loaded.has(tool.name)),
        ...(shelved().length > 0 ? [FIND_TOOLS_DEFINITION] : []),
      ];
    },

    /** Whether `name` is held but not yet offered. */
    isShelved(name) {
      return byName.has(name) && !coreNames.has(name) && !loaded.has(name);
    },

    /** Load one tool the model called by name without asking first. */
    loadOne(name) {
      load([name]);
    },

    /** The system prompt's list of what is on the shelf. */
    prompt() {
      const rest = shelved();
      if (rest.length === 0) return "";
      return [
        "",
        "",
        `More tools you have, not loaded yet. Load any with ${FIND_TOOLS} before you use it, and never say you can't do something one of these does:`,
        ...rest.map((tool) => `- ${tool.name}: ${summaryOf(tool.description)}`),
      ].join("\n");
    },

    /** `find_tools`, as a tool result. */
    call(args) {
      const asked = Array.isArray(args?.names) ? args.names.filter((name) => typeof name === "string") : [];
      let names = asked.filter((name) => byName.has(name));
      const query = typeof args?.query === "string" ? args.query : "";
      if (names.length === 0 && query.trim().length > 0) {
        const wanted = words(query);
        names = shelved()
          .map((tool) => {
            const have = words(`${tool.name.replace(/_/g, " ")} ${firstParagraph(tool.description)}`);
            let score = 0;
            for (const word of wanted) if (have.has(word)) score += 1;
            return { name: tool.name, score };
          })
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.name);
      }
      const added = load(names.slice(0, MAX_LOADED_PER_CALL));
      const ready = names.slice(0, MAX_LOADED_PER_CALL).filter((name) => byName.has(name));
      const unknown = asked.filter((name) => !byName.has(name));
      const lines = [];
      if (ready.length > 0) {
        lines.push(`Loaded: ${ready.join(", ")}. ${added.length < ready.length ? "Some were already loaded. " : ""}Call them now.`);
      } else {
        lines.push("Nothing matched. Pick names from the list of tools in your instructions.");
      }
      if (unknown.length > 0) lines.push(`Not tools you have: ${unknown.slice(0, 6).join(", ")}.`);
      return { content: [{ type: "text", text: lines.join("\n") }], isError: ready.length === 0 };
    },
  };
}
