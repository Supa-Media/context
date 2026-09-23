/**
 * The skills the plugin ships, checked against the Agent Skills format and
 * against the gateway they describe.
 *
 * A skill that names a tool the gateway no longer has is worse than no skill:
 * the agent follows it, calls something that is not there, and the person sees
 * a failure the plugin itself caused. So every tool a skill tells an agent to
 * call is looked up in the gateway's own tool definitions.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}`);
  }
}

const SKILLS = new URL("../skills/", import.meta.url);
const GATEWAY = new URL("../../../apps/mcp/src/index.js", import.meta.url);

/** The tools the skills tell an agent to call, by name. */
const TOOLS_NAMED = ["orient", "search_notes", "read_note", "write_note", "save_context"];

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const pair = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = pair[2];
  }
  return fields;
}

const folders = (await readdir(SKILLS, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
check("the plugin ships the context and context-save skills", folders.includes("context") && folders.includes("context-save"));

const texts = {};
for (const folder of folders) {
  const text = await readFile(join(SKILLS.pathname, folder, "SKILL.md"), "utf8");
  texts[folder] = text;
  const fields = frontmatter(text);
  // Agent Skills: `name` is 1-64 of a-z, 0-9 and hyphen, and must match the
  // folder; `description` is 1-1024 characters.
  check(`${folder}: its name matches its folder`, fields?.name === folder && /^[a-z0-9-]{1,64}$/.test(folder));
  check(
    `${folder}: it has a description an agent can match on`,
    typeof fields?.description === "string" && fields.description.length > 0 && fields.description.length <= 1024
  );
}

const gateway = await readFile(GATEWAY, "utf8");
const allSkills = Object.values(texts).join("\n");
for (const tool of TOOLS_NAMED) {
  check(`the skills name \`${tool}\``, allSkills.includes(`\`${tool}\``));
  check(`...and the gateway still defines \`${tool}\``, gateway.includes(`name: "${tool}",`));
}
check(
  "every skill points a person without the tools at the installer",
  Object.values(texts).every((text) => text.includes("npx -y @supa-media/context install"))
);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
