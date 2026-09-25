import { parseListBody } from "./parseBlock.js";

/** Public-page work stays bounded even when an author pastes many fences. */
export const MAX_EVALUATED_LIST_BLOCKS = 20;

/**
 * Replace each list fence with rows already narrowed by the caller.
 *
 * `evaluate` owns visibility and storage. This module owns only fence spans and
 * presentation, so it can never widen the notes the caller chose to provide.
 */
export async function renderEvaluatedListBlocks(markdown, evaluate) {
  const blocks = listFenceSpans(String(markdown ?? ""));
  if (blocks.length === 0) return String(markdown ?? "");

  const replacements = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (index >= MAX_EVALUATED_LIST_BLOCKS) {
      replacements.push({
        ...block,
        text: listError("too many folder lists on one page"),
      });
      continue;
    }
    const parsed = parseListBody(block.body);
    if (parsed.error) {
      replacements.push({ ...block, text: listError(parsed.error) });
      continue;
    }
    try {
      const selection = await evaluate(parsed.config, { line: block.line });
      replacements.push({
        ...block,
        text: renderSelection(parsed.config, selection),
      });
    } catch {
      // Storage failures and refusals are deliberately indistinguishable in a
      // public document, and neither may leave a stale set of rows behind.
      replacements.push({
        ...block,
        text: listError("this list is unavailable"),
      });
    }
  }

  let out = "";
  let cursor = 0;
  for (const replacement of replacements) {
    out += markdown.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  return out + markdown.slice(cursor);
}

function listError(message) {
  return `> Folder list error: ${tableText(message)}`;
}

function renderSelection(config, selection) {
  const rows = Array.isArray(selection?.rows) ? selection.rows : [];
  if (rows.length === 0) return "*No notes to show.*";
  const columns = ["Note", ...config.show];
  const lines = [
    `| ${columns.map(tableText).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    const title = tableText(row.title);
    const href = safeHref(row.href);
    const note = href === null ? title : `[${linkLabel(title)}](${href})`;
    const values = config.show.map((key) => {
      const value = row.values?.find((item) => item.key === key)?.value ?? null;
      return displayValue(key, value);
    });
    lines.push(`| ${[note, ...values].join(" | ")} |`);
  }
  // Never print `selection.total`: the caller may have deliberately withheld
  // rows, and a public page must not become a count oracle.
  if (selection?.truncated === true)
    lines.push("", "*More notes are available.*");
  return lines.join("\n");
}

function displayValue(key, value) {
  if (value === null || value === undefined) return "";
  if (
    key === "updated" &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return new Date(value).toISOString().slice(0, 10);
  }
  return tableText(Array.isArray(value) ? value.join(", ") : value);
}

function tableText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function linkLabel(value) {
  return value.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function safeHref(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  // Callers produce these locators, but keep rendering fail-closed if that
  // contract regresses: no controls, whitespace, target terminators or script
  // schemes can enter generated Markdown.
  if (/[\u0000-\u0020\u007f()|\\]/.test(raw)) return null;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function listFenceSpans(markdown) {
  const lines = markdown.match(/[^\n]*(?:\n|$)/g) ?? [];
  const blocks = [];
  let offset = 0;
  let fence = null;
  let isList = false;
  let start = 0;
  let openedAt = 0;
  let body = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === "" && index === lines.length - 1) break;
    const line = raw.replace(/\n$/, "").replace(/\r$/, "");
    if (fence === null) {
      const opener = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`~]*)\s*$/.exec(line);
      if (opener) {
        fence = opener[2];
        isList = opener[3].toLowerCase() === "list";
        start = offset;
        openedAt = index + 1;
        body = [];
      }
    } else {
      const closer = /^(\s{0,3})(`{3,}|~{3,})\s*$/.exec(line);
      if (
        closer &&
        closer[2][0] === fence[0] &&
        closer[2].length >= fence.length
      ) {
        if (isList) {
          blocks.push({
            start,
            end: offset + line.length,
            line: openedAt,
            body: body.join("\n"),
          });
        }
        fence = null;
        isList = false;
      } else if (isList) {
        body.push(line);
      }
    }
    offset += raw.length;
  }
  if (fence !== null && isList) {
    blocks.push({
      start,
      end: markdown.length,
      line: openedAt,
      body: body.join("\n"),
    });
  }
  return blocks;
}
