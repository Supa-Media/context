import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { turnPrompt } from "../src/agent/turnPrompt.js";
import { moduleTexts, setupPromptFor, MODULE_KINDS } from "../src/agent/promptModules.js";
import { TEX_PROMPT_WORDS, texModules } from "../src/agent/texConfig.js";
import { withArchitecture } from "../src/agent/texArchitecture.js";

/*
  Replay walks a turn back to its prompt by the fingerprints it logged (`promptManifest.js`), looking them up in the
  catalogue at the turn's commit (`scripts/tex-prompt-catalog.mjs`). Every module a real turn's builder makes from the
  repository alone must be in this commit's catalogue under the same id, or Replay shows a size where the words were.
*/
const CATALOG = JSON.parse(readFileSync(new URL("../../mobile/features/tex/lab/promptCatalog.generated.json", import.meta.url), "utf8"));
const REPO_BUILT = /^(stable\/|context\/(web|progress|transcripts|checkIns|attention)$|preamble\/plan$)/;

test("every module a turn builds from the repository is in the prompt catalogue, by its fingerprint", () => {
  const prompts = moduleTexts(texModules(), TEX_PROMPT_WORDS);
  let seen = 0;
  for (const kind of MODULE_KINDS) {
    const notes = { prompt: withArchitecture(setupPromptFor({ prompts, prompt: prompts.texts }, kind), kind) };
    for (const pictures of [false, true]) {
      for (const tools of [[], [{ name: "write_note" }]]) {
        const p = turnPrompt(null, "anthropic/claude-haiku-5-5", {
          texting: true, pictures, notes, tools, history: [], observe: true, webNames: new Set(["search_web", "open_page", "browse"]),
          threadNote: "", turnNote: "", progress: { prompt: null }, aboutMe: "# About\nmade up", jobs: null, workspaces: null, localNow: null,
          plan: { think: "anthropic/claude-haiku-5-5" }, nudge: "",
        });
        for (const m of p.prompt.modules) {
          if (!REPO_BUILT.test(m.id)) {
            assert.equal(CATALOG.modules[m.h], undefined, `${m.id} is built from the person's words and must never be in the catalogue`);
            continue;
          }
          assert.equal(CATALOG.modules[m.h]?.id, m.id, `${m.id} (${kind}) is not in the catalogue: run node scripts/tex-prompt-catalog.mjs`);
          seen += 1;
        }
      }
    }
  }
  assert.ok(seen >= 24);
});
