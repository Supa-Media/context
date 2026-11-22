import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SOURCES,
  configProblems,
  parseJsonc,
  previewSection,
  renderConfig,
  stripJsonComments,
} from "./config.mjs";

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const PR = 42;
const SUB = "example-sub";
const opts = { pr: PR, subdomain: SUB };

const real = (id) => {
  const source = SOURCES.find((entry) => entry.id === id);
  return { ...source, text: read(source.source) };
};

/** A rendered copy of a real config, with its preview section as text for the checks. */
const rendered = (id) => {
  const source = real(id);
  const text = renderConfig(source.text, opts);
  return { ...source, text, section: previewSection(text, source.kind) };
};

/**
 * Adds a forbidden thing to a rendered config. TOML: the preview is the last table, so appended lines land in
 * it. JSONC: the change is made on the parsed object and written back as JSON, which is valid JSONC.
 */
function inject(id, change) {
  const config = rendered(id);
  if (config.kind === "toml") {
    const text = `${config.text}\n${change.toml}\n`;
    return previewSection(text, "toml");
  }
  const root = parseJsonc(config.text);
  change.json(root.env.preview);
  return previewSection(JSON.stringify(root), "jsonc");
}

test("the three committed configs render to a clean preview with no problems", () => {
  for (const source of SOURCES) {
    const { text, section } = rendered(source.id);
    assert.doesNotMatch(text, /__PREVIEW__|__WORKERS_DEV__/, `${source.id} left a placeholder`);
    assert.ok(section.length > 0, `${source.id} has an env.preview section`);
    assert.deepEqual(configProblems(section, { pr: PR, deny: [] }), [], `${source.id} should be clean`);
  }
});

test("the rendered preview names its own pull request and workers.dev host, and never a production name", () => {
  const mcp = rendered("mcp").section;
  assert.match(mcp, /name = "context-mcp-pr42"/);
  assert.match(mcp, /https:\/\/context-router-pr42\.example-sub\.workers\.dev/);
  assert.doesNotMatch(mcp, /context-mcp-staging|context-agent-staging/);
  const agent = JSON.parse(rendered("agent").section);
  assert.equal(agent.name, "context-agent-pr42");
  assert.deepEqual(agent.services.map((s) => s.service), ["context-mcp-pr42"]);
  assert.equal(agent.vars.SIMULATOR, "on");
  assert.equal(agent.vars.APP_CARDS, "off");
  assert.equal(agent.workflows, undefined, "the texting Worker makes no Workflow since 2026-11-22");
  const router = JSON.parse(rendered("router").section);
  assert.deepEqual(router.services.map((s) => s.service), ["context-agent-pr42", "context-agent-pr42"]);
});

test("the preview section of each config is the section from its first env.preview line, and nothing after it", () => {
  const mcp = previewSection(read("apps/mcp/wrangler.toml"), "toml");
  assert.match(mcp, /^\[env\.preview\]$/m);
  assert.doesNotMatch(mcp, /\[env\.staging/);
  assert.equal(mcp.split("\n")[0], "[env.preview]");
  assert.equal(previewSection("a = 1\n[env.staging]\nb = 2\n", "toml"), "");
  assert.equal(previewSection('{"env":{"staging":{}}}', "jsonc"), "");
});

test("JSONC stripping keeps slashes inside strings and removes comments outside them", () => {
  const text = '{\n  // a comment with "quotes"\n  "url": "https://example.test/a//b", /* block */ "n": 1,\n}\n';
  assert.deepEqual(parseJsonc(text), { url: "https://example.test/a//b", n: 1 });
  assert.equal(stripJsonComments('"a/*b*/c" // gone').trim(), '"a/*b*/c"');
});

test("a production host in the preview is a problem", () => {
  const leaks = [
    { toml: '[env.preview.leak]\nORIGIN = "https://mcp.context.lc"', json: (p) => { p.vars.ORIGIN = "https://mcp.context.lc"; } },
    { toml: '[env.preview.leak]\nORIGIN = "https://tex.lc"', json: (p) => { p.vars.ORIGIN = "https://tex.lc"; } },
    { toml: '[env.preview.leak]\nORIGIN = "https://tex-staging.context.lc"', json: (p) => { p.vars.ORIGIN = "https://tex-staging.context.lc"; } },
  ];
  for (const leak of leaks) {
    assert.ok(configProblems(inject("mcp", { toml: leak.toml, json: leak.json }), { pr: PR }).length > 0);
    assert.ok(configProblems(inject("agent", { toml: leak.toml, json: leak.json }), { pr: PR }).length > 0);
  }
});

test("a service binding to a Worker that is not the preview's own or an allowed shared one is a problem", () => {
  const change = {
    toml: '[[env.preview.services]]\nbinding = "X"\nservice = "context-mcp"',
    json: (p) => p.services.push({ binding: "X", service: "context-mcp" }),
  };
  assert.ok(configProblems(inject("mcp", change), { pr: PR }).length > 0);
  assert.ok(configProblems(inject("agent", change), { pr: PR }).length > 0);
  assert.ok(configProblems(inject("router", change), { pr: PR }).length > 0);
  const staging = {
    toml: '[[env.preview.services]]\nbinding = "X"\nservice = "context-agent-staging"',
    json: (p) => p.services.push({ binding: "X", service: "context-agent-staging" }),
  };
  assert.ok(configProblems(inject("mcp", staging), { pr: PR }).length > 0);
  assert.ok(configProblems(inject("router", staging), { pr: PR }).length > 0);
});

test("a vectorize, d1 or r2 binding in the preview is a problem", () => {
  const vectorize = {
    toml: '[[env.preview.vectorize]]\nbinding = "V"\nindex_name = "pr42-index"',
    json: (p) => { p.vectorize = [{ binding: "V", index_name: "pr42-index" }]; },
  };
  assert.ok(configProblems(inject("mcp", vectorize), { pr: PR }).length > 0);
  assert.ok(configProblems(inject("agent", vectorize), { pr: PR }).length > 0);
  const d1 = {
    toml: '[[env.preview.d1_databases]]\nbinding = "D"',
    json: (p) => { p.d1_databases = [{ binding: "D" }]; },
  };
  assert.ok(configProblems(inject("mcp", d1), { pr: PR }).length > 0);
  const r2 = {
    toml: '[[env.preview.r2_buckets]]\nbinding = "R"',
    json: (p) => { p.r2_buckets = [{ binding: "R" }]; },
  };
  assert.ok(configProblems(inject("agent", r2), { pr: PR }).length > 0);
});

test("an Analytics Engine dataset without a _preview suffix is a problem", () => {
  const change = {
    toml: '[[env.preview.analytics_engine_datasets]]\nbinding = "Y"\ndataset = "tex_timing"',
    json: (p) => p.analytics_engine_datasets.push({ binding: "Y", dataset: "tex_timing" }),
  };
  assert.ok(configProblems(inject("mcp", change), { pr: PR }).length > 0);
  assert.ok(configProblems(inject("agent", change), { pr: PR }).length > 0);
  const staging = {
    toml: '[[env.preview.analytics_engine_datasets]]\nbinding = "Y"\ndataset = "tex_timing_staging"',
    json: (p) => p.analytics_engine_datasets.push({ binding: "Y", dataset: "tex_timing_staging" }),
  };
  assert.ok(configProblems(inject("mcp", staging), { pr: PR }).length > 0);
});

/** A preview Workflow binding, for the naming guard: the texting Worker binds none since 2026-11-22. */
const workflow = (name) => ({ name, binding: "GROUP_TURN", class_name: "GroupTurnWorkflow" });

test("a workflow name that does not end with the preview name is a problem", () => {
  const change = { toml: "", json: (p) => { p.workflows = [workflow("group-turn")]; } };
  assert.ok(configProblems(inject("agent", change), { pr: PR }).length > 0);
  const other = { toml: "", json: (p) => { p.workflows = [workflow("group-turn-pr7")]; } };
  assert.ok(configProblems(inject("agent", other), { pr: PR }).length > 0);
});

test("a PHOTON binding in the preview is a problem", () => {
  const change = {
    toml: '[[env.preview.services]]\nbinding = "PHOTON"\nservice = "context-agent-pr42"',
    json: (p) => p.services.push({ binding: "PHOTON", service: "context-agent-pr42" }),
  };
  const problems = configProblems(inject("mcp", change), { pr: PR });
  assert.ok(problems.some((problem) => problem.includes("PHOTON")));
  assert.ok(configProblems(inject("agent", change), { pr: PR }).some((problem) => problem.includes("PHOTON")));
});

test("a deny-list identifier in the preview is a problem, and the identifier is not printed", () => {
  const change = { toml: '[env.preview.leak]\nNAME = "prod-deployment-xyz"', json: (p) => { p.vars.NAME = "prod-deployment-xyz"; } };
  const section = inject("mcp", change);
  const problems = configProblems(section, { pr: PR, deny: ["prod-deployment-xyz"] });
  assert.ok(problems.length > 0);
  assert.ok(problems.every((problem) => !problem.includes("prod-deployment-xyz")));
  assert.deepEqual(configProblems(section, { pr: PR, deny: [] }).filter((p) => p.includes("PREVIEW_DENY")), []);
});

test("a leftover placeholder is a problem", () => {
  const unrendered = previewSection(read("apps/mcp/wrangler.toml"), "toml");
  assert.ok(configProblems(unrendered, { pr: PR }).some((problem) => problem.includes("placeholder")));
  const leaked = inject("mcp", { toml: '[env.preview.leak]\nNAME = "__WORKERS_DEV__"', json: (p) => { p.vars.NAME = "__WORKERS_DEV__"; } });
  assert.ok(configProblems(leaked, { pr: PR }).length > 0);
});

test("an empty or missing preview section is a problem", () => {
  assert.ok(configProblems("", { pr: PR }).length > 0);
});

test("renderConfig rejects a malformed pull request number or subdomain, without printing the subdomain", () => {
  const text = read("apps/mcp/wrangler.toml");
  for (const pr of [0, "0", "01", "abc", -1, "1.5", 12345678]) {
    assert.throws(() => renderConfig(text, { pr, subdomain: SUB }), /--pr/);
  }
  for (const subdomain of ["Bad_Sub", "-lead", "trail-", "", "a".repeat(64), "has space"]) {
    assert.throws(
      () => renderConfig(text, { pr: PR, subdomain }),
      (error) => {
        assert.match(error.message, /subdomain/);
        if (subdomain !== "") assert.ok(!error.message.includes(subdomain), "the error must not print the subdomain");
        return true;
      },
    );
  }
  assert.doesNotThrow(() => renderConfig(text, { pr: PR, subdomain: "a".repeat(63) }));
});

test("a preview Workflow named for its own pull request is not a problem", () => {
  const section = inject("agent", { toml: "", json: (p) => { p.workflows = [workflow(`group-turn-pr${PR}`)]; } });
  assert.equal(configProblems(section, { pr: PR }).some((problem) => problem.includes("workflow name")), false);
});

test("a preview Workflow named as the staging or production Workflow is a problem", () => {
  for (const name of ["group-turn", "job-run", "group-turn-staging", "job-run-staging"]) {
    const section = inject("agent", { toml: "", json: (p) => { p.workflows = [workflow(name)]; } });
    assert.ok(
      configProblems(section, { pr: PR }).some((problem) => problem.includes("workflow name")),
      `${name} must be flagged`,
    );
  }
});
