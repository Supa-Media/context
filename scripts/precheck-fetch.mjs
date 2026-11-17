/**
 * A `git fetch` of `$BASE_SHA` that is not only that fetch must fail
 * `assertGuards`, and precheck must leave the line in place. Replacing it
 * with `:` drops the chained command. Widening `isShallowBaseFetch` back to
 * "any git fetch that mentions $BASE_SHA" does that replacement, so this fails.
 */

const CHAINED_FETCH = 'git fetch --depth=1 origin "$BASE_SHA" && node scripts/x.mjs';

function passingGuardWorkflow(extraRuns) {
  const lines = [
    "jobs:",
    "  guards:",
    "    steps:",
    "      - run: node --version",
    "      - run: node scripts/tex-diagram-check.mjs",
    "      - run: node scripts/check-tex-change-has-case.mjs",
    "      - run: node scripts/check-speed-budget.mjs",
    "      - run: node scripts/public-privacy.test.mjs",
    "      - run: node scripts/check-secrets-allowlist.mjs",
  ];
  for (const run of extraRuns) lines.push(`      - run: ${run}`);
  return lines.join("\n");
}

export function assertChainedBaseFetchRefused(assertGuards, scriptsToRun) {
  const repro = ["jobs:", "  g:", "    steps:", "      - run: node --version", "      - run: |", `          ${CHAINED_FETCH}`].join("\n");
  const ran = scriptsToRun(repro);
  if (ran.length !== 1 || ran[0] !== CHAINED_FETCH) {
    throw new Error(`a chained fetch was rewritten (${JSON.stringify(ran)}); the command after it must stay`);
  }
  assertGuards(passingGuardWorkflow([]));
  const chained = [
    CHAINED_FETCH,
    'git fetch --depth=1 origin "$BASE_SHA"; node scripts/x.mjs',
    'git fetch --depth=1 origin "$BASE_SHA" || node scripts/x.mjs',
    'git fetch --depth=1 origin "$BASE_SHA" | node scripts/x.mjs',
    'git fetch --depth=1 origin "$BASE_SHA" node scripts/x.mjs',
  ];
  for (const line of chained) {
    let message = "";
    try {
      assertGuards(passingGuardWorkflow([line]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message.includes("not only that fetch") || !message.includes(line)) {
      throw new Error(`a git fetch of $BASE_SHA chained with another command passed assertGuards: ${line}`);
    }
    const kept = scriptsToRun(passingGuardWorkflow([line])).join("\n");
    if (!kept.includes("node scripts/x.mjs")) throw new Error(`a chained command was dropped: ${line}`);
  }
  const embedded = 'cd /tmp && git fetch --depth=1 origin "$BASE_SHA"';
  let embeddedMessage = "";
  try {
    assertGuards(passingGuardWorkflow([embedded]));
  } catch (error) {
    embeddedMessage = error instanceof Error ? error.message : String(error);
  }
  if (!embeddedMessage.includes("not only that fetch") || !embeddedMessage.includes(embedded)) {
    throw new Error("a git fetch of $BASE_SHA buried in another command passed assertGuards");
  }
}
