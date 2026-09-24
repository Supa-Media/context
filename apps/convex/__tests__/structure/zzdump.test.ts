import { test } from "vitest";
import { writeFileSync } from "node:fs";
import { analyze as oldAnalyze, realModules as oldReal } from "./oldAnalyzer.scratch";

const OUT = "/tmp/claude-0/-home-user/541721b1-af35-585f-9614-4ece5c2e142e/scratchpad";

type Result = {
  violations: { node: string; reason: string }[];
  decryptCapable: Set<string>;
  edges: Map<string, string[]>;
  schedules: Map<string, string[]>;
};

function dump(result: Result, nodes: string[]): string {
  const lines: string[] = [];
  for (const node of [...nodes].sort()) {
    const calls = [...new Set(result.edges.get(node) ?? [])].sort();
    const schedules = [...new Set(result.schedules.get(node) ?? [])].sort();
    lines.push(
      `${node}\n  decrypt: ${result.decryptCapable.has(node)}\n  calls: ${calls.join(", ")}\n  schedules: ${schedules.join(", ")}`,
    );
  }
  lines.push("VIOLATIONS");
  for (const v of result.violations) lines.push(`  ${v.node} ${v.reason}`);
  return lines.join("\n") + "\n";
}

test("dump", async () => {
  const modules = oldReal();
  const nodes = modules.flatMap((m) =>
    Object.keys(m.exports).map((n) => `${m.reference}.${n}`),
  );
  writeFileSync(`${OUT}/edges-${process.env.DUMP_TAG ?? "x"}.txt`, dump(oldAnalyze(modules) as Result, nodes));
  if (process.env.DUMP_NEW) {
    const fx = await import("./fixtures");
    writeFileSync(`${OUT}/edges-new.txt`, dump(fx.analyze(fx.realModules()) as unknown as Result, nodes));
  }
});
