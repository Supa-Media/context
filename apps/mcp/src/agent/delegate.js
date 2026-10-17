/**
 * TEX HANDS A WHOLE SUB-PROJECT TO A STRONGER AGENT (owner, 2026-10-17).
 *
 * "Tex could open them up to do a specific Claude Code or Claude or Claude
 * Design or Codex or ChatGPT ... a whole sub part of a task, tracked in the
 * projects, tracked in context, and it opened up a mailing channel between
 * Tex and that, so the browser doesn't need to be open."
 *
 * `delegate` does the bookkeeping in one call, so none of it is left to the
 * model to remember:
 *
 *   1. A task note in the project's folder (`status: in progress`, `owner:
 *      @maya's Claude Code`, the brief, "done when", and a Result section),
 *      so the job is on the project's board like any other task.
 *   2. A supervisor routine in Tex's own folder,
 *      `tex/routines/every-10-minutes/delegate-<slug>.md`, whose
 *      `supervises:` line names the task note. Its runs are the sub-agent
 *      loop (`supervise.js`): not the person's texting thread, and costing no
 *      model call while the agent is working and nothing is new.
 *   3. A line in `tex/jobs.md`, so the next text knows the job is open.
 *
 * It answers with the address to start the agent at and the one message to
 * send it. That message tells the agent to read the task note through its own
 * Context connector, join the note's mail (`docs/decisions/note-mail.md`),
 * report there and write its result into the note. Once it is sent the
 * browser can close: the channel is the note.
 *
 * Everything is written through the turn's own dispatcher, as the person, so
 * the privacy engine, the activity line and history are those of any write.
 * The model never chooses the routine's path or its `supervises:` line.
 */

import { JOBS_PATH } from "./jobs.js";

export const DELEGATE_TOOL = "delegate";

/** The agents Tex can hand work to, each on the person's own signed-in account. */
export const AGENTS = {
  "claude-code": {
    label: "Claude Code",
    start: "https://claude.ai/code",
    good: "code in a GitHub repo: features, fixes, pull requests",
    how: "If it asks for a repository, pick the one the job is about before you type.",
  },
  codex: {
    label: "Codex",
    start: "https://chatgpt.com/codex",
    good: "code in a GitHub repo, on their ChatGPT plan",
    how: "If it asks for a repository or an environment, pick the one the job is about before you type.",
  },
  claude: {
    label: "Claude",
    start: "https://claude.ai/new",
    good: "writing, research, analysis and long documents",
    how: "",
  },
  "claude-design": {
    label: "Claude Design",
    start: "https://claude.ai/design",
    good: "designs, prototypes, slides and UI",
    how: "",
  },
  chatgpt: {
    label: "ChatGPT",
    start: "https://chatgpt.com/",
    good: "generated images, prose and research on their ChatGPT plan",
    how: "",
  },
};

/** Where supervisors live, and how often they look. */
export const SUPERVISOR_FOLDER = "tex/routines/every-10-minutes";

const MAX_TITLE = 80;
const MAX_BRIEF = 4000;
const MAX_DONE_WHEN = 500;
const SLUG_MAX = 48;
const DEFAULT_DONE = "The brief is done and the result is written in the task note.";
const CONTEXT_NAME = /^@[a-z0-9][a-z0-9-]{0,63}$/;

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

/** A title as a file name: `Fix the login bug!` → `fix-the-login-bug`. */
export function slugFor(title) {
  return String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** A project folder the model named, or null: relative, no `..`, never Tex's or Context's own space. */
export function cleanFolder(value) {
  if (typeof value !== "string") return null;
  const folder = value.trim().replace(/^\/+|\/+$/g, "");
  if (folder === "" || folder.length > 200) return null;
  const parts = folder.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) return null;
  if (parts[0] === "tex" || parts[0] === "routines" || parts[0] === "website") return null;
  return folder;
}

/** One line, so a chat box's Enter sends it whole. */
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const read = (callTool, path, context) => callTool("read_note", { path, ...(context ? { context } : {}) });
const bodyOf = (result) => {
  const raw = result?.content?.[0]?.text;
  if (result?.isError === true || typeof raw !== "string") return null;
  const split = raw.indexOf("\n\n");
  return {
    etag: /^etag: (.+)$/m.exec(split === -1 ? raw : raw.slice(0, split))?.[1] ?? null,
    body: split === -1 ? "" : raw.slice(split + 2),
  };
};

/** `@ws/path`, the way a person, the supervisor and the agent all name the note. */
export const taskRef = (context, path) => `${context}/${path}`;

/**
 * The message the agent is sent. One line: a chat box sends on Enter. It
 * names the note with its workspace, because the agent's connector may open
 * on a different default workspace.
 */
export function agentMessage({ agent, handle, title, brief, doneWhen, context, path }) {
  const where = `{ id: "${path}", context: "${context}" }`;
  const name = agent;
  return oneLine(
    [
      `Hi, I'm Tex, ${handle}'s assistant in Context. ${handle} asked me to hand you this job: ${title}.`,
      brief,
      doneWhen ? `It's done when: ${doneWhen}` : "",
      "Context is connected to you as a connector (MCP); use it for all of this, and if you can't reach it, say so and stop.",
      `(1) Read the task note: fetch ${where}. It has the brief, and it is where your result goes.`,
      `(2) Join its mail: write { path: "${path}", context: "${context}", action: "mail", args: { join: "${name}" } }, and pass the mailbox id it gives you on every Context call after that.`,
      '(3) Mail me (to "everyone") your plan in one line, then one line at each milestone, and any question only ' +
        `${handle} can answer. I read the mail every 10 minutes and answer there. Check yours as the join answer says, and keep working: don't wait on me unless you're blocked.`,
      '(4) When it is done: write what you made into the note\'s "## Result" section (links to pull requests, files or chats), set status: done in its front matter, and mail me "done:" with one line.',
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function taskNote({ title, brief, doneWhen, owner, delegatedBy, agent, supervisor, now }) {
  return [
    "---",
    "status: in progress",
    `owner: ${owner}`,
    `delegated-by: ${delegatedBy}`,
    `delegated: ${new Date(now).toISOString()}`,
    `runs-on: ${AGENTS[agent].label} (${AGENTS[agent].start})`,
    `supervisor: ${supervisor}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Handed to ${AGENTS[agent].label} by Tex. ${AGENTS[agent].label} reports in this note's mail, and Tex checks on it every 10 minutes.`,
    "",
    "## Brief",
    "",
    brief,
    "",
    "## Done when",
    "",
    doneWhen,
    "",
    "## Result",
    "",
    "Not yet.",
    "",
  ].join("\n");
}

function supervisorNote({ ref, agent, title, handle }) {
  return [
    "---",
    `supervises: ${ref}`,
    `agent: ${agent}`,
    "send: text",
    "---",
    "",
    `Keep ${AGENTS[agent].label} on track with "${title}" for ${handle}, through the task note's mail, and text them the result.`,
    "Tex stops this by itself once the task note says done. Delete this note to stop supervising sooner.",
    "",
  ].join("\n");
}

/** Add the job's line to `tex/jobs.md`. Best effort: the task note and its supervisor are what matter. */
async function addJobLine(callTool, line) {
  try {
    const current = bodyOf(await read(callTool, JOBS_PATH, null));
    const content = current === null ? `${line}\n` : `${current.body.replace(/\s*$/, "")}\n${line}\n`;
    await callTool("write_note", { path: JOBS_PATH, content, ...(current?.etag ? { expected_etag: current.etag } : {}) });
  } catch {
    // See above.
  }
}

/** The agent's mail name, read back off a task note's `owner:` line (`@maya's Claude Code`). */
function agentFromOwner(owner) {
  const label = /'s (.+)$/.exec(String(owner ?? ""))?.[1]?.trim();
  return Object.keys(AGENTS).find((key) => AGENTS[key].label === label) ?? null;
}

const field = (body, key) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(body)?.[1]?.trim() ?? "";
const section = (body, heading) => {
  const match = new RegExp(`^## ${heading}\\n+([\\s\\S]*?)(?=\\n## |$)`, "m").exec(body);
  return match ? match[1].trim() : "";
};

/**
 * The `delegate` tool for one texted turn.
 *
 * @param {(name: string, args: object) => Promise<object>} callTool the turn's dispatcher, as the person
 * @param {{ handle: string, home: string, now?: () => number, vouch?: (url: string, message: string) => void, browser?: boolean }} options
 *   `handle` names the person (`@maya`), `home` is the workspace a call with no context reaches,
 *   `vouch` lets the turn's browser open the start address and type the message, `browser` says whether there is one
 */
export function delegateSession(callTool, { handle, home, now = Date.now, vouch = null, browser = true, trusted = () => true }) {
  const definition = {
    name: DELEGATE_TOOL,
    description:
      "Hand a whole sub-project to a stronger agent they already use, on their own signed-in account: " +
      Object.entries(AGENTS)
        .map(([key, agent]) => `${key} (${agent.good})`)
        .join("; ") +
      ". Use it when a job is too big to finish yourself in a few steps. It writes the task note on the project's board, " +
      "opens a mail channel on it, and starts a supervisor that checks on the agent every 10 minutes, keeps it on track " +
      "and texts them the result. Then start the agent the way its answer says. Pass again: <task note> to get the message " +
      "for one you already handed off (after a sign-in, say).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: Object.keys(AGENTS), description: "Who does the work." },
        title: { type: "string", description: "The job in a few words." },
        brief: { type: "string", description: "Everything the agent needs: what to do, where (repo, folder, links), constraints." },
        done_when: { type: "string", description: "How you'll both know it's finished." },
        folder: { type: "string", description: "The project folder the task note goes in, beside that project's notes, e.g. 1-projects/launch." },
        context: { type: "string", description: 'The workspace that project is in, as "@name". Leave out for their own.' },
        again: { type: "string", description: "A task note you already handed off, as @name/path.md: its message again, nothing written." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  };

  /*
    The message is the model's words. It is vouched for (typable on the
    agent's own site without open web) only when this call wrote it, in a turn
    that has read nothing from outside, so no page or other agent's mail can
    have chosen them (`docs/decisions/privacy-and-sharing/agent-egress.md`).
    `again` rebuilds a message from a note anyone with write access may have
    edited, so it never vouches.
  */
  function startLine(agent, message, { fresh = false } = {}) {
    const how = AGENTS[agent].how ? ` ${AGENTS[agent].how}` : "";
    if (fresh && typeof vouch === "function" && trusted() === true) vouch(AGENTS[agent].start, message);
    if (!browser) {
      return `You have no browser on this deployment, so text them the address ${AGENTS[agent].start} and the message below to paste and send themselves.\n\n${message}`;
    }
    return [
      `Now start it: browse to ${AGENTS[agent].start}. If it asks to sign in, sign in yourself as you would on any site.${how}`,
      "Type this message into the chat box exactly as it is, press Enter, then read the page to check it was sent:",
      message,
      "Then write the page's address into the task note's runs-on: line (read the note, change that line, write it back), " +
        `and text them in a few words that ${AGENTS[agent].label} is on it and you'll text when it's done.`,
    ].join("\n\n");
  }

  async function again(ref) {
    const match = /^(@[a-z0-9][a-z0-9-]{0,63})\/(.+\.md)$/.exec(String(ref ?? "").trim());
    if (!match) return text('again takes the task note as "@name/path.md".', true);
    const [, context, path] = match;
    const note = bodyOf(await read(callTool, path, context));
    if (note === null) return text(`There's no task note at ${ref} you can read.`, true);
    const agent = agentFromOwner(field(note.body, "owner"));
    if (agent === null || !field(note.body, "supervisor")) return text(`${ref} isn't a job you handed off.`, true);
    const title = /^# (.+)$/m.exec(note.body)?.[1]?.trim() ?? path;
    const message = agentMessage({
      agent,
      handle,
      title,
      brief: section(note.body, "Brief"),
      doneWhen: section(note.body, "Done when"),
      context,
      path,
    });
    return text(`${ref} is handed to ${AGENTS[agent].label} and supervised.\n\n${startLine(agent, message)}`);
  }

  async function call(args) {
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (given.again !== undefined) return await again(given.again);
    const agent = typeof given.agent === "string" && Object.hasOwn(AGENTS, given.agent) ? given.agent : null;
    if (agent === null) return text(`agent must be one of: ${Object.keys(AGENTS).join(", ")}.`, true);
    const title = oneLine(given.title).slice(0, MAX_TITLE);
    const slug = slugFor(title);
    if (!slug) return text("Give the job a title of a few words.", true);
    const brief = String(given.brief ?? "").trim();
    if (brief.length < 20) return text("Write the agent a real brief: what to do, where, and anything it must not do.", true);
    if (brief.length > MAX_BRIEF) return text(`Keep the brief under ${MAX_BRIEF} characters; link to notes for the rest.`, true);
    const doneWhen = oneLine(given.done_when).slice(0, MAX_DONE_WHEN) || DEFAULT_DONE;
    const folder = cleanFolder(given.folder);
    if (folder === null) return text("folder must be the project folder the task belongs in, like 1-projects/launch.", true);
    if (given.context !== undefined && (typeof given.context !== "string" || !CONTEXT_NAME.test(given.context))) {
      return text('context must be a workspace name like "@team".', true);
    }
    const context = given.context ?? home;
    const elsewhere = context === home ? null : context;
    const path = `${folder}/${slug}.md`;
    const supervisor = `${SUPERVISOR_FOLDER}/delegate-${slug}.md`;
    const ref = taskRef(context, path);

    // Never over someone's note, and never a second supervisor on one name.
    if (bodyOf(await read(callTool, path, elsewhere)) !== null) {
      return text(`There's already a note at ${ref}. Pick another title, or pass again: "${ref}" if it's this job.`, true);
    }
    if (bodyOf(await read(callTool, supervisor, null)) !== null) {
      return text(`A job called "${title}" is already being supervised. Pick another title.`, true);
    }

    const owner = `${handle}'s ${AGENTS[agent].label}`;
    const wrote = await callTool("write_note", {
      path,
      content: taskNote({ title, brief, doneWhen, owner, delegatedBy: `${handle}'s Tex`, agent, supervisor, now: now() }),
      ...(elsewhere ? { context: elsewhere } : {}),
    });
    if (wrote?.isError === true) {
      return text(`Couldn't write the task note at ${ref}: ${wrote?.content?.[0]?.text ?? "refused"}`, true);
    }
    const supervised = await callTool("write_note", { path: supervisor, content: supervisorNote({ ref, agent, title, handle }) });
    if (supervised?.isError === true) {
      return text(
        `The task note is at ${ref}, but the supervisor couldn't be set up (${supervised?.content?.[0]?.text ?? "refused"}). Don't start the agent; tell them it didn't work.`,
        true,
      );
    }
    await addJobLine(callTool, `- [${title}](${ref})`);

    const message = agentMessage({ agent, handle, title, brief, doneWhen, context, path });
    return text(
      [
        `Handed off in Context: the task note is ${ref} (in progress, owner ${owner}), with a mail channel on it, ` +
          `and a supervisor (${supervisor}) checks on it every 10 minutes and texts them the result.`,
        startLine(agent, message, { fresh: true }),
      ].join("\n\n"),
    );
  }

  return { tools: [definition], has: (name) => name === DELEGATE_TOOL, call };
}

/** `callTool` with `delegate` answered here, never sent to the MCP. */
export function withDelegate(delegation, callTool) {
  if (delegation === null) return callTool;
  return (name, args) => (delegation.has(name) ? delegation.call(args) : callTool(name, args));
}
