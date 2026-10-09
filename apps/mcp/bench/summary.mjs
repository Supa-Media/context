/**
 * `pnpm ai summary <result file>`: the part of a result note a person reads
 * first, as Markdown on stdout — the run's summary (answers, errors, routed,
 * retried, fell back, reran and time lines) and the latest scores. The GitHub
 * Action appends it to the run's summary page, so anyone who can open the
 * Actions tab sees the table without downloading the note. Never the answers,
 * and never the key: the key is a file of its own and the summary names no id.
 */

import { readFile } from "node:fs/promises";

/** The text of one `## <heading>` section, up to the next `## `, or "". */
function section(raw, heading, { last = false } = {}) {
  const lines = raw.split("\n");
  const starts = lines
    .map((line, i) => (line.startsWith(`## ${heading}`) ? i : -1))
    .filter((i) => i >= 0);
  if (!starts.length) return "";
  const start = last ? starts.at(-1) : starts[0];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1)
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  return lines.slice(start, end).join("\n").trim();
}

/** The Markdown for a run: its summary and its latest scores, in that order. */
export function summaryMarkdown(raw) {
  const front = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const pick = (key) =>
    front.match(new RegExp(`^${key}: (.*)$`, "m"))?.[1] ?? null;
  const head = [
    pick("job"),
    pick("date"),
    pick("code_commit") ? `commit ${pick("code_commit")}` : null,
    pick("status"),
  ]
    .filter(Boolean)
    .join(", ");
  const scored = section(raw, "Scored by", { last: true });
  const summary = section(raw, "Summary");
  return (
    [head ? `**${head}**` : "", "", scored || "_Not scored yet._", "", summary]
      .filter((part, i, all) => part !== "" || (i > 0 && all[i - 1] !== ""))
      .join("\n")
      .trim() + "\n"
  );
}

export async function summaryCommand(options) {
  if (!options.job) throw new Error("usage: pnpm ai summary <result file>");
  process.stdout.write(summaryMarkdown(await readFile(options.job, "utf8")));
}
