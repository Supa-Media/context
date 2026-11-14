#!/usr/bin/env node
/**
 * THE WORDS OF EVERY PROMPT MODULE THIS COMMIT CAN BUILD WITHOUT A PERSON'S NOTES (Dev2, 2026-11-14: "once we know
 * the version ... when I click on something, I should be able to walk back. What was the prompt for this version,
 * what were the context modules that were loaded in").
 *
 * A turn logs each model round's prompt as module ids, lengths and fingerprints (`apps/mcp/src/agent/promptManifest.js`)
 * and the commit that ran (`texVersion.js` `code`), never the words. Most of a front-door prompt is built from this
 * repository alone: the stable rules (Tex's prompt words, `texConfig.js`, around `prompt.js`'s lines, for each kind of
 * turn and each switch), and the fixed context and preamble modules. This script runs THIS commit's builders over
 * every such combination and writes their words keyed by fingerprint, so the Lab fetches the file AT the commit a turn
 * ran and shows the exact words, proven by the fingerprint the turn logged. A module built from the person's own notes
 * or the moment (about-me, jobs, calendar, the time) is not here: it holds their words, never kept in the repository.
 *
 *   node scripts/tex-prompt-catalog.mjs           write apps/mobile/features/tex/lab/promptCatalog.generated.json
 *   node scripts/tex-prompt-catalog.mjs --check   exit 1 when the file on disk is stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { systemPromptParts } from "../apps/mcp/src/agent/prompt.js";
import { fingerprint } from "../apps/mcp/src/agent/promptManifest.js";
import { setupPromptFor, moduleTexts, MODULE_KINDS } from "../apps/mcp/src/agent/promptModules.js";
import { TEX_PROMPT_WORDS, texModules } from "../apps/mcp/src/agent/texConfig.js";
import { withArchitecture } from "../apps/mcp/src/agent/texArchitecture.js";
import { TRANSCRIPTS_PROMPT } from "../apps/mcp/src/agent/transcript.js";
import { ATTENTION_PROMPT, CHECK_IN_PROMPT } from "../apps/mcp/src/agent/checkIns.js";
import { PROGRESS_PROMPT } from "../apps/mcp/src/agent/progress.js";
import { DRIVER_PROMPT, PLANNER_PROMPT } from "../apps/mcp/src/agent/modelPlan.js";
import { OPEN_PAGE_TOOL, SEARCH_WEB_TOOL, webPrompt } from "../apps/mcp/src/agent/computer.js";
import { BROWSE_TOOL } from "../apps/mcp/src/agent/browse.js";
import { FILL_LOGIN_TOOL } from "../apps/mcp/src/agent/fillLogin.js";
import { FILL_CARD_TOOL } from "../apps/mcp/src/agent/fillCard.js";
import { TRAVEL_TIME_TOOL } from "../apps/mcp/src/agent/travelTime.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "apps/mobile/features/tex/lab/promptCatalog.generated.json");

/** Every module this commit can build from the repository alone: `{ [fingerprint]: { id, kinds, text } }`. */
export function catalog() {
  const modules = {};
  const add = (id, text, kind) => {
    if (typeof text !== "string" || text === "") return;
    const h = fingerprint(text);
    const row = (modules[h] ??= { id, kinds: [], text });
    if (kind && !row.kinds.includes(kind)) row.kinds.push(kind);
  };
  const prompts = moduleTexts(texModules(), TEX_PROMPT_WORDS);
  for (const kind of MODULE_KINDS) {
    // `runTheModel.js`: the setup's words for this kind of turn, behind the drawing (`texArchitecture.js`).
    const production = withArchitecture(setupPromptFor({ prompts, prompt: prompts.texts }, kind), kind);
    for (const notes of [{ prompt: production }, null]) {
      for (const texting of [true, false]) {
        for (const pictures of [false, true]) {
          for (const edits of [false, true]) {
            const parts = systemPromptParts(null, { texting, pictures, notes, edits });
            // `turnPrompt.js`'s stable id.
            const id = ["stable", texting ? "texting" : "notes", ...(pictures ? ["pictures"] : []), ...(edits ? ["edits"] : []), ...(parts.production ? ["production"] : [])].join("/");
            add(id, parts.stable, notes ? kind : null);
          }
        }
      }
    }
  }
  // What the web tools say, for every set of them a turn can have (`computer.js`).
  const web = [SEARCH_WEB_TOOL, OPEN_PAGE_TOOL, BROWSE_TOOL, TRAVEL_TIME_TOOL, FILL_LOGIN_TOOL, FILL_CARD_TOOL];
  for (let mask = 1; mask < 1 << web.length; mask += 1) add("context/web", webPrompt(new Set(web.filter((_, i) => mask & (1 << i)))));
  add("context/progress", PROGRESS_PROMPT);
  add("context/transcripts", TRANSCRIPTS_PROMPT);
  add("context/checkIns", CHECK_IN_PROMPT);
  add("context/attention", ATTENTION_PROMPT);
  add("preamble/plan", PLANNER_PROMPT.trim());
  add("preamble/plan", DRIVER_PROMPT.trim());
  return Object.fromEntries(Object.entries(modules).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The file: each distinct line once (`lines`), and each module as the lines it is made of, so thirty variants of one
 * ~90K-character prompt cost about one, and a changed rule is a one-line diff. `{ v: 2, lines, modules: { [h]: { id,
 * kinds, n, at } } }`, where the module's text is `at.map((i) => lines[i]).join("\n")`.
 */
export function packed(modules) {
  const lines = [];
  const index = new Map();
  const out = {};
  for (const [h, { id, kinds, text }] of Object.entries(modules)) {
    const at = text.split("\n").map((line) => {
      if (!index.has(line)) index.set(line, lines.push(line) - 1);
      return index.get(line);
    });
    out[h] = { id, kinds, n: text.length, at };
  }
  return { v: 2, lines, modules: out };
}

/** One line per entry, so a diff names the rule that changed. */
function written({ v, lines, modules }) {
  const mods = Object.entries(modules).map(([h, m]) => `    ${JSON.stringify(h)}: ${JSON.stringify(m)}`);
  return `{\n  "v": ${v},\n  "modules": {\n${mods.join(",\n")}\n  },\n  "lines": [\n${lines.map((l) => `    ${JSON.stringify(l)}`).join(",\n")}\n  ]\n}\n`;
}

const built = catalog();
const text = written(packed(built));
// Each module rebuilt from the file must be the module, by its fingerprint.
const back = JSON.parse(text);
for (const [h, m] of Object.entries(back.modules)) {
  const words = m.at.map((i) => back.lines[i]).join("\n");
  if (fingerprint(words) !== h || words !== built[h].text) throw new Error(`tex-prompt-catalog: ${m.id} does not rebuild`);
}
if (process.argv.includes("--check")) {
  const onDisk = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  if (onDisk !== text) {
    console.error(`${path.relative(ROOT, OUT)} is out of date with the prompt builders. Run: node scripts/tex-prompt-catalog.mjs`);
    process.exit(1);
  }
  console.log(`${path.relative(ROOT, OUT)} is up to date (${Object.keys(back.modules).length} modules)`);
} else {
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${Object.keys(back.modules).length} modules, ${text.length} bytes)`);
}
