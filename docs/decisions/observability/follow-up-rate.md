# The follow-up fix rate: every pull request says what it follows up (2026-11-27)

Dev2 asked (2026-11-27) how to bring down the bug rate after new features and fixes, and whether it was measured
anywhere. It was not. Tex's stats count people, texts, cost and notes, and tool failures count failed calls, but
nothing counted the pull requests that fix something an earlier one broke or missed. An audit of a week's follow-up
fixes (Nov 20 to 27) found that most of them were one part changed while a part that depended on it was not: a rule
enforced in one place and retold by hand in a prompt, a decision coded twice, a message between two Workers whose
other side was left behind. To tell which fix lowers that rate, the rate has to be counted, split by that kind.

## The rule

- **Every pull request's description carries one `Follows:` line** (`scripts/pr-follows.mjs`):
  `Follows: none`, or `Follows: #N (kind)` when it fixes something pull request #N broke or missed. Several numbers
  may share one kind. The kinds name the hidden link the earlier change did not see: `retold-rule`, `copied-logic`,
  `service-contract`, `shape-assumption`, `lab-vs-live`, `incomplete` and `other` (meanings in the script).
- **Fast repository guards fails a pull request without a readable line.** Editing the description re-runs only the
  guards (`scripts/pr-description.mjs`), never the replay check, which could start the Test Set again. Locally, an
  empty description passes, because precheck runs before the pull request exists.
- **After the merge, `pr-follows-label.yml` labels the pull request** `follow-up:none`, `follow-up:<kind>`, or
  `follow-up:unstated` when the line was missing (a pull request merged before this rule, or a bypass).
  Pull requests the Lab and the bench open themselves (`tex-lab-promote.yml`, `tex-world-heal.yml`) write
  `Follows: none`.
- **The GitHub data source keeps the label as `follow_up`** in `pull-requests.csv` (`apps/mcp/src/data/connect/github.js`).
  It reads the label, which is metadata, and still never a body (data-and-metrics.md). Any team's repository can use
  the same `follow-up:<kind>` convention.
- **The metric lives in the workspace's DevOps area beside Open to live:** follow-ups of all pull requests that
  state one, over a rolling 7 days,
  `count(github/pull-requests.follow_up where follow_up != none) ÷ count(github/pull-requests.follow_up)`, with a
  chart by kind. A pull request with no label has an empty `follow_up` and is in neither count.

## What a simplification would cost

- Inferring follow-ups from titles or "since #" in bodies: in the week measured, 85 of 676 bodies said "since #",
  most of them Lab promotions naming the main they were made from. A guess would move with wording, not bugs.
- Making the line optional: the rate would measure who remembered, not what broke.
- Reading the body in the data source: the source's promise is that no body is read; a label keeps it.

`node scripts/pr-follows.mjs --self-test` and the `follow_up` case in `apps/mcp/test/dataSyncGithub.test.mjs` fail
when the line stops being read or the label stops being kept.
