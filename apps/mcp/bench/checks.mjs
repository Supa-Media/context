/**
 * CHECKS A RUN CAN PROVE WITHOUT A JUDGE.
 *
 * A golden task (`tests/tasks.md`) is judged on what was done, not only on
 * what was said: Tex either opened ChatGPT's plugins page and typed Context's
 * address into it, or it did not, and a model asked whether it did can be
 * talked round by an answer that says so. These lines are read from the
 * answer's own record (the tools it called, what the scripted browser did,
 * `sites.mjs`) and graded here; the judge never sees them.
 *
 *   - must call: read_skill          a tool call that did not fail
 *   - must not call: vault_add_link
 *   - must reach: chatgpt.com/plugins  a page opened or read (a prefix)
 *   - must hand off: chatgpt.com     a handoff while on that site
 *   - must type: https://mcp.context.lc/mcp   typed into any box
 *   - must choose: Read-only tools: Always allow   an option picked in a list
 *   - must set: connected chatgpt    a flag a scripted button set
 *   - must publish: website          a site publish that went through (`siteStub.mjs`)
 *   - must connect: mayaruns.com     a domain connected to the workspace's site
 *
 * Each also takes `must not`. A verdict is a "must" or "must not" line like
 * the judge's, so a failed check fails its question, and on a task, the gate.
 */

const CHECK = /^- (must|must not) (call|reach|hand off|type|choose|set|publish|connect):\s*(.+)$/;

/** A check line, or null when the line is not one. */
export function readCheck(line) {
  const m = line.trim().match(CHECK);
  if (!m) return null;
  return { kind: m[1], what: m[2], value: m[3].trim(), line: `${m[2]} ${m[3].trim()}` };
}

const called = (tools, name) => tools.some((label) => label === name || label === `${name} (held for OK)`);

/** Whether the answer did what the check names. */
function happened(check, answer) {
  const events = answer.browser ?? [];
  const value = check.value.toLowerCase();
  switch (check.what) {
    case "call":
      return called(answer.tools ?? [], check.value);
    case "reach":
      return events.some((event) => /^(open|read) /.test(event) && event.slice(5).toLowerCase().startsWith(value));
    case "hand off":
      return events.some((event) => event.toLowerCase() === `handoff ${value}`);
    case "type":
      return events.some((event) => event.startsWith("type ") && event.toLowerCase().includes(`"${value}`));
    case "choose":
      return events.some((event) => event.startsWith("select ") && event.toLowerCase().endsWith(`"${value}"`));
    case "set":
      return events.some((event) => event.toLowerCase() === `set ${value}`);
    case "publish":
      return events.includes("publish");
    case "connect":
      return events.some((event) => event.toLowerCase() === `connect ${value}`);
    default:
      return false;
  }
}

/** The question's checks graded on one answer, as verdicts. */
export function checkVerdicts(question, answer) {
  return (question.checks ?? []).map((check) => {
    const did = happened(check, answer);
    return {
      kind: check.kind,
      line: check.line,
      pass: check.kind === "must" ? did : !did,
      reason: `checked from the run's record: ${did ? "it did" : "it did not"}`,
    };
  });
}
