#!/usr/bin/env node
// Writes apps/mobile/features/tex/lab/labData.generated.ts: the Tex Architecture
// Lab's bench cases (CASES), its Tex prompt texts (MODTEXT) and its workspace
// fixtures (WS), all read from files in this repo.
//
//   node scripts/tex-lab-data.mjs           write the file
//   node scripts/tex-lab-data.mjs --check   exit 1 if the file on disk is stale
//
// Node built-ins only. Paths resolve from the repo root.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "apps/mobile/features/tex/lab/labData.generated.ts");
const require = createRequire(import.meta.url);

const abs = (rel) => path.join(ROOT, rel);
const readText = (rel) => fs.readFileSync(abs(rel), "utf8");
const readJsonList = (rel) => {
  const j = JSON.parse(readText(rel));
  return Array.isArray(j) ? j : j.cases;
};
const listSorted = (rel) => fs.readdirSync(abs(rel)).sort();

// Trim whitespace runs and cut to n characters, with an ellipsis when cut.
const cut = (s, n = 220) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// "Name: words" lines become {from, text}; anything else is all text.
const said = (line) => {
  const m = /^(@?[\w .'-]{1,24}?):\s([\s\S]*)$/.exec(String(line));
  return m
    ? { from: m[1].replace(/^@/, ""), text: cut(m[2], 200) }
    : { from: "", text: cut(line, 200) };
};

const toolNames = (d) =>
  (d || []).map((x) => (Array.isArray(x) ? x[0] : x?.tool || x?.name || "")).filter(Boolean);

function buildCases() {
  const out = [];

  for (const c of readJsonList("apps/mcp/bench/respond/cases.json")) {
    out.push({
      area: "respond",
      id: c.id,
      chat: c.chat,
      lines: (c.lines || []).map(said),
      msg: said(c.text),
      setting: c.setting,
      must: !!c.must,
      ask: cut(c.text),
      expect: c.want === "hush" ? "Stay quiet (or only react)" : "Reply",
    });
  }

  for (const f of listSorted("apps/mcp/bench/review")) {
    if (!f.endsWith(".json")) continue;
    for (const c of readJsonList("apps/mcp/bench/review/" + f)) {
      out.push({
        area: "review",
        id: c.id,
        group: f.replace(".json", "").replace(/_/g, " "),
        earlier: (c.earlier || []).map(([w, t]) => ({ from: w === "person" ? "" : w, text: cut(t, 160) })),
        did: toolNames(c.did),
        ask: cut(c.q),
        reply: cut(c.reply, 240),
        expect: c.fault ? "Send it back" : "Let it go",
      });
    }
  }

  for (const c of readJsonList("apps/mcp/bench/job-tasks/cases.json")) {
    out.push({
      area: "jobs",
      id: c.id,
      kind: c.kind,
      as: c.as,
      today: c.today,
      title: c.job?.title,
      ask: cut(c.text),
      expect: cut(c.job?.doneWhen),
    });
  }

  const advisor = (f) => readJsonList(`apps/mcp/bench/advisor/${f}.json`);
  for (const c of advisor("chat")) {
    out.push({
      area: "advisor-chat",
      id: c.id,
      about: cut(c.about, 140),
      did: toolNames(c.did),
      ask: cut(c.q),
      expect: cut(c.expect || c.want),
    });
  }
  for (const c of advisor("job-check")) {
    out.push({
      area: "advisor-job-check",
      id: c.id,
      title: cut(c.job?.title || c.job?.brief, 120),
      did: toolNames(c.did),
      reply: cut(c.answer, 200),
      ask: cut(c.job?.brief || c.job?.title),
      expect: cut(c.want),
    });
  }
  for (const c of advisor("planner")) {
    out.push({ area: "advisor-planner", id: c.id, ask: cut(c.q), expect: cut(c.want) });
  }
  for (const c of advisor("job-mail")) {
    out.push({
      area: "advisor-job-mail",
      id: c.id,
      title: cut(c.job?.title || c.job?.brief, 120),
      from: cut(c.from, 60),
      ask: cut(c.question || c.note),
      expect: cut(c.expect),
    });
  }

  // Each "## N. Title" section of core.md: a question line, a note line, then
  // "- must:" / "- must not:" bullets. A section runs to the next "## " heading
  // or to the end of the file.
  const md = readText("apps/mcp/bench/ai/tests/core.md");
  for (const m of md.matchAll(/^## (\d+)\. (.+)\n\n([^\n]*)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)) {
    const musts = [...m[4].matchAll(/^- must: (.+)$/gm)].map((x) => cut(x[1], 160));
    const nots = [...m[4].matchAll(/^- must not: (.+)$/gm)].map((x) => cut(x[1], 160));
    out.push({
      area: "core",
      id: "q" + m[1],
      as: "Maya",
      note: cut(m[3], 140),
      musts,
      nots,
      ask: cut(m[2]),
      expect: cut(musts.join("; ") || m[3]),
    });
  }

  for (const f of listSorted("apps/mcp/test/replay/cases")) {
    if (!f.endsWith(".mjs")) continue;
    const t = readText("apps/mcp/test/replay/cases/" + f);
    const field = (k) => {
      const m = new RegExp(k + ':\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(t);
      return m ? m[1] : "";
    };
    const id = field("id") || f.replace(".mjs", "");
    out.push({
      area: "pipeline",
      id,
      path: field("path") || "five simple turns",
      ask: cut(field("incident") || "Speed budgets: model calls and reads on the five simple turns stay within speed-budget.json.", 260),
      expect: cut(field("cause") || "No turn makes more calls or reads than its budget.", 200),
    });
  }

  return out;
}

async function buildModText() {
  const { TEX_MAP } = await import(pathToFileURL(abs("apps/mcp/src/agent/texArchitecture.generated.js")).href);
  const { CAPABILITY_LIST } = await import(pathToFileURL(abs("apps/mcp/src/agent/capabilities.js")).href);
  const { EXAMPLES_TEXT } = require(abs("packages/shared/src/textDecide.cjs"));
  const about = readText("apps/mcp/bench/ai/workspaces/maya/tex/about-me.md");
  return { map: TEX_MAP, caps: CAPABILITY_LIST, examples: EXAMPLES_TEXT, about };
}

function buildWs() {
  const base = abs("apps/mcp/bench/ai/workspaces");
  const out = {};
  for (const w of ["maya", "fashion-brand", "band"]) {
    const files = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) files[path.relative(path.join(base, w), p)] = fs.readFileSync(p, "utf8");
      }
    };
    walk(path.join(base, w));
    out[w] = Object.fromEntries(Object.entries(files).sort());
  }
  return out;
}

const cases = buildCases();
const modtext = await buildModText();
const ws = buildWs();

const content =
  [
    "// Generated by scripts/tex-lab-data.mjs from the bench's own cases and fixtures. Do not edit; run `node scripts/tex-lab-data.mjs`.",
    'import type { LabCase } from "./types";',
    `export const CASES: LabCase[] = ${JSON.stringify(cases)};`,
    `export const MODTEXT: Record<string, string> = ${JSON.stringify(modtext)};`,
    `export const WS: Record<string, Record<string, string>> = ${JSON.stringify(ws)};`,
  ].join("\n") + "\n";

const by = {};
for (const c of cases) by[c.area] = (by[c.area] || 0) + 1;
const counts = `CASES ${cases.length} ${JSON.stringify(by)}; MODTEXT ${Object.keys(modtext).join(",")}; WS ${Object.keys(ws).map((k) => `${k}:${Object.keys(ws[k]).length}`).join(" ")}`;

if (process.argv.includes("--check")) {
  const onDisk = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  if (onDisk !== content) {
    console.error(`${path.relative(ROOT, OUT)} is out of date with the repo's bench files. Run: node scripts/tex-lab-data.mjs`);
    process.exit(1);
  }
  console.log(`${path.relative(ROOT, OUT)} is up to date (${counts})`);
} else {
  fs.writeFileSync(OUT, content);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${counts})`);
}
