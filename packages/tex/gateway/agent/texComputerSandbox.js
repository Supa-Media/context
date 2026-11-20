/**
 * TEX'S OWN COMPUTER, from the turn's side (Dev2 picked Cloudflare Sandbox, 2026-11-20;
 * docs/decisions/texting-assistant/computer.md "Tex's own computer").
 *
 * A background job can run a command on a Linux computer of its own and read and write files there, without anyone's
 * laptop: one computer per person, and one per group chat, each a sleeping container behind its own Durable Object
 * (`infra/tex-computer`), reached through the `TEX_COMPUTER` service binding. The turn calls `send` action `computer`;
 * the call goes through the Tex's computer node (`graph/nodes/computer.js`) over the config's `tools -> computer` wire,
 * so every call is logged like any node, and nothing is offered while the config has no such wire.
 *
 * It is the last rung before asking the person (Dev2, 2026-11-20, "Try the cheapest option first"): notes, a connected
 * app, web search and the browser come first, and the tool's description says so. The computer has no internet
 * (`infra/tex-computer/src/index.ts` says why), so a command can never carry what the turn read to an address it chose.
 */

export const TEX_COMPUTER_TOOL = "tex_computer";
export const COMPUTER_OPS = Object.freeze(["run", "read", "write", "list", "stop"]);

export const TEX_COMPUTER_DEFINITION = {
  name: TEX_COMPUTER_TOOL,
  description:
    "Your own Linux computer for this chat: run a shell command (bash) or read, write and list files in its work folder. " +
    "Python 3 (pandas, openpyxl, matplotlib, numpy, bs4), Node 22, sqlite3, jq, git and pdftotext are installed. " +
    "It has no internet: get what you need from their notes, a connected app or the web first, then write it here to work on. " +
    "Use it when the work needs a real computer (crunching a spreadsheet, a script, converting a file), after their notes, a connected app, web search and the browser could not do it. " +
    "Files stay while you work and go after ten idle minutes, so save anything they should keep to their notes.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: [...COMPUTER_OPS], description: "run a command, read or write a file, list a folder, or stop the computer" },
      command: { type: "string", description: "For run: the bash command, run in the work folder." },
      path: { type: "string", description: "For read, write and list: a path inside the work folder, like data/report.csv." },
      content: { type: "string", description: "For write: the file's whole text." },
      timeout_seconds: { type: "number", description: "For run: at most 110; 60 when left out." },
    },
    required: ["op"],
  },
};

const MAX_SHOWN = 12_000;
const cut = (text) => (typeof text === "string" && text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}\n[cut: ${text.length - MAX_SHOWN} more characters]` : text);

/** The node's input from the model's call, or a refusal in words. */
export function computerInput(args, owner) {
  const op = typeof args?.op === "string" ? args.op : "";
  if (!COMPUTER_OPS.includes(op)) return { refused: `op must be one of ${COMPUTER_OPS.join(", ")}` };
  const input = { op, owner };
  if (op === "run") {
    if (typeof args.command !== "string" || args.command.trim() === "") return { refused: "run needs a command" };
    input.command = args.command;
    if (Number.isFinite(args.timeout_seconds)) input.timeoutMs = Math.round(Math.min(Math.max(args.timeout_seconds, 1), 110) * 1000);
  }
  if (op === "read" || op === "write") {
    if (typeof args.path !== "string" || args.path.trim() === "") return { refused: `${op} needs a path` };
    input.path = args.path;
  }
  if (op === "list" && typeof args.path === "string") input.path = args.path;
  if (op === "write") {
    if (typeof args.content !== "string") return { refused: "write needs the file's content" };
    input.content = args.content;
  }
  return { input };
}

/** What the model reads back from one call. */
export function computerWords(out) {
  if (!out || typeof out !== "object") return { isError: true, text: "Your computer did not answer. Try once more shortly." };
  if (out.ok !== true && out.exitCode === undefined) return { isError: true, text: `Your computer refused: ${out.error ?? "it did not answer"}.` };
  const lines = [];
  if (out.woke === true) lines.push("(Your computer was asleep and just started; its files from before are gone.)");
  if (out.exitCode !== undefined || out.timedOut) {
    lines.push(out.timedOut ? "The command ran out of time and was stopped." : `Exit code ${out.exitCode}.`);
    if (out.stdout) lines.push(`stdout:\n${cut(out.stdout)}`);
    if (out.stderr) lines.push(`stderr:\n${cut(out.stderr)}`);
  } else if (typeof out.text === "string") lines.push(cut(out.text));
  else if (out.binary === true) lines.push(`A binary file of ${out.bytes} bytes; run a command to read it.`);
  else if (Array.isArray(out.entries)) lines.push(`${out.folder ?? "."}: ${out.entries.map((e) => (e.type === "folder" ? `${e.name}/` : e.name)).join(", ") || "(empty)"}${out.more ? `, and ${out.more} more` : ""}`);
  else if (out.stopped !== undefined) lines.push(out.stopped ? "Your computer is stopped; its files are gone." : "Your computer was already asleep.");
  else if (Number.isFinite(out.bytes)) lines.push(`Wrote ${out.bytes} bytes.`);
  // A command that ran and failed is an answer the model reads (its exit code and stderr), not a failed call.
  const ran = Number.isFinite(out.exitCode) || out.timedOut === true;
  return { isError: out.ok !== true && !ran, text: lines.join("\n") || "Done." };
}

/**
 * The local tool: `gate(input)` runs the Tex's computer node over the config's wire. `owner` is the chat's computer
 * tag (`browserProviders.js` `browserOwner` / `groupBrowserOwner`), made from ids, never from the model.
 */
export function texComputerTool({ gate, owner }) {
  return {
    tool: TEX_COMPUTER_DEFINITION,
    call: async (args = {}) => {
      const { input, refused } = computerInput(args, owner);
      if (refused) return { isError: true, content: [{ type: "text", text: `Not run: ${refused}.` }] };
      const out = await gate(input).catch((error) => ({ ok: false, error: String(error?.message ?? "the computer step failed").slice(0, 200) }));
      const { isError, text } = computerWords(out);
      return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] };
    },
  };
}
