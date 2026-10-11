/**
 * TASK SKILLS: HOW-TOS THE ASSISTANT READS BEFORE IT DOES A JOB.
 *
 * Decided by the owner, 2026-10-11: some tasks the texting assistant must
 * always get right (connect ChatGPT or Claude to Context, save a login in the
 * vault, use its browser), and a model told only "you have a browser" does not
 * do them. A skill is one plain note per task, written and tested like the
 * setup it belongs to: `ai/production/skills/<name>.md` in the pinned
 * `@context-lc` workspace, read through the caller's own reach exactly as the
 * setup is (`production.js`), so promoting a better how-to is editing a note.
 *
 * The setup names its skills, each with one line saying when it applies:
 *
 *   skills:
 *     connect-chatgpt: someone wants ChatGPT to use Context, or asks if it does
 *
 * Those lines go in the `read_skill` tool's description, so every turn knows
 * what exists for no extra read; a skill's body is read only when the model
 * asks for it. A name the setup did not list is refused, so the tool can read
 * nothing but the files named here, under the one folder.
 */

export const READ_SKILL_TOOL = "read_skill";
export const SKILLS_FOLDER = "ai/production/skills";
export const MAX_SKILLS = 20;

const SKILL_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_WHEN_CHARS = 300;
const MAX_SKILL_CHARS = 20_000;
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * A setup's `skills:` section as `[{ name, when }]`, or `null` when it is not
 * a valid one. `undefined` (no section) is an empty list.
 */
export function readSkillList(section) {
  if (section === undefined) return [];
  if (typeof section !== "object" || section === null || Array.isArray(section)) return null;
  const entries = Object.entries(section);
  if (entries.length > MAX_SKILLS) return null;
  const skills = [];
  for (const [name, when] of entries) {
    if (!SKILL_NAME.test(name)) return null;
    if (typeof when !== "string" || when.trim().length === 0 || when.length > MAX_WHEN_CHARS) return null;
    skills.push({ name, when: when.trim() });
  }
  return skills;
}

/** The path a listed skill is read from. */
export const skillPath = (name) => `${SKILLS_FOLDER}/${name}.md`;

/** A skill note's body: front matter dropped, capped. */
export function skillBody(raw) {
  if (typeof raw !== "string") return null;
  const body = raw.replace(FRONT_MATTER, "").trim();
  if (body.length === 0) return null;
  return body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS)}\n[cut]` : body;
}

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

/**
 * The `read_skill` tool for one turn, or `null` when the setup lists none.
 * `read(path)` returns the note's body (`skillBody`) or `null`. `onRead` is
 * told each body the model was given, so the turn's web tools can treat its
 * addresses and words as vouched for (`computer.js` `vouch`).
 *
 * @param {Array<{name: string, when: string}>} skills
 * @param {(path: string) => Promise<string | null>} read
 */
export function skillSession(skills, read, { onRead = null } = {}) {
  if (!Array.isArray(skills) || skills.length === 0) return null;
  const names = new Set(skills.map((skill) => skill.name));
  const definition = {
    name: READ_SKILL_TOOL,
    description:
      "Step-by-step instructions for jobs people ask you to do. When a message is about one of these, read its skill first and follow it: " +
      skills.map((skill) => `${skill.name} (${skill.when})`).join("; ") +
      ".",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", enum: [...names], description: "The skill to read." } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
  return {
    tools: [definition],
    has: (name) => name === READ_SKILL_TOOL,
    async call(args) {
      const name = typeof args?.name === "string" ? args.name : "";
      if (!names.has(name)) return text(`There is no skill called "${name.slice(0, 48)}". The skills are: ${[...names].join(", ")}.`, true);
      let body = null;
      try {
        body = await read(skillPath(name));
      } catch {
        body = null;
      }
      if (body === null) return text("That skill can't be read right now. Do the task as well as you can without it.", true);
      if (typeof onRead === "function") onRead(body);
      return text(body);
    },
  };
}

/** `callTool` with `read_skill` answered here, never sent to the MCP. */
export function withSkills(skills, callTool) {
  if (skills === null) return callTool;
  return (name, args) => (skills.has(name) ? skills.call(args) : callTool(name, args));
}
