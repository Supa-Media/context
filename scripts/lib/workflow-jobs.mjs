/**
 * Reading one job, and its steps, out of a workflow file's text, for the CI
 * guards (`check-ci-path-gates.mjs`). Text rather than a YAML parser: the
 * guards run with no install.
 */

/** One top-level job's lines, from its `  name:` key to the next job's. */
export function jobBlock(yaml, job) {
  const start = yaml.search(new RegExp(`^  ${job}:$`, "m"));
  if (start === -1) throw new Error(`Missing job ${job}`);
  const rest = yaml.slice(start);
  const next = rest.slice(rest.indexOf("\n") + 1).search(/^  [A-Za-z0-9_-]+:$/m);
  return next === -1 ? rest : rest.slice(0, rest.indexOf("\n") + 1 + next);
}

/** A job's steps, each from its `      - ` to the next one's. */
export function stepBlocks(job) {
  return job.split(/^      - /m).slice(1).map((step) => `      - ${step}`);
}

/**
 * `Test Gateway units` runs the unit files in slices. Every slice from 1 to N
 * must be in the matrix and run as `INDEX/N`, or files would silently run
 * nowhere (a slice missing) or twice; and the one check named `Test Gateway
 * units` must wait for them all.
 */
export function assertUnitSlices(yaml) {
  const unit = jobBlock(yaml, "unit");
  const shards = /\n\s+shard: \[([\d, ]+)\]/.exec(unit)?.[1].split(",").map((n) => Number(n.trim()));
  if (!shards?.length) throw new Error("mcp.yml:unit has no shard matrix");
  const total = shards.length;
  if (shards.some((n, i) => n !== i + 1)) throw new Error(`mcp.yml:unit shards are ${shards.join(", ")}, not 1 to ${total}`);
  if (!unit.includes(`pnpm test:unit \${{ matrix.shard }}/${total}`)) throw new Error(`mcp.yml:unit does not run slice INDEX/${total}`);
  if (!unit.includes(`(\${{ matrix.shard }}/${total})`)) throw new Error(`mcp.yml:unit's name does not say /${total}`);
  const units = jobBlock(yaml, "units");
  if (!/\n    name: Test Gateway units\n/.test(units) || !/\n    needs: unit\n/.test(units) || !units.includes("always()")) {
    throw new Error("mcp.yml:units is not the one `Test Gateway units` check over every slice");
  }
}

