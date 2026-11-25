/**
 * A formula tree back to words: `toText`, the canonical text a metric note
 * keeps (it parses back to the same tree), and `plainReading`, the one line
 * under the chips that lets a person check what the formula does.
 */

import { lex } from "./lex.js";
import { parseEvery } from "./windows.js";

const SIGN = new Map([["+", "+"], ["-", "−"], ["*", "×"], ["/", "÷"]]);
const PRECEDENCE = new Map([["+", 1], ["-", 1], ["*", 2], ["/", 2]]);
const KEYWORDS = new Set(["where", "and"]);
const READ_AS = new Map([
  ["sum", "sum of"], ["count", "count of"], ["average", "average of"], ["median", "median of"],
  ["p95", "95th percentile of"], ["min", "minimum of"], ["max", "maximum of"],
]);

/** Words that lex back as themselves, or quoted. A first word that is a number is quoted where it would read as one. */
function words(text, { numberFirst }) {
  const lexed = lex(text);
  const plain =
    lexed.ok &&
    lexed.tokens.length > 0 &&
    lexed.tokens.every((t, i) => t.type === "word" || (t.type === "num" && (numberFirst || i > 0))) &&
    lexed.tokens.map((t) => t.raw).join(" ") === text &&
    !lexed.tokens.some((t) => KEYWORDS.has(t.raw.toLowerCase()));
  if (plain) return text;
  return text.includes('"') ? `'${text}'` : `"${text}"`;
}

/** Digits that read back as the same number; String() would write a large or tiny one with an exponent. */
function numberText(value) {
  const text = String(value);
  return text.includes("e") ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : text;
}

function binary(node, render) {
  const p = PRECEDENCE.get(node.op);
  const side = (child, right) => {
    const text = render(child);
    if (child.type !== "binary") return text;
    const q = PRECEDENCE.get(child.op);
    return q < p || (right && q === p) ? `(${text})` : text;
  };
  return `${side(node.left, false)} ${SIGN.get(node.op)} ${side(node.right, true)}`;
}

/** The per-row expression, the aggregate's first ref written in full and the rest as bare columns. */
function rowText(node, state) {
  if (node.type === "number") return numberText(node.value);
  if (node.type === "ref") {
    if (state.full) return words(node.column, { numberFirst: false });
    state.full = true;
    // After an all-digit dataset, a column starting with a digit would lex into one number (`a/1.2`).
    const digits = [...node.dataset].every((c) => c >= "0" && c <= "9");
    return `${node.source}/${node.dataset}.${words(node.column, { numberFirst: !digits })}`;
  }
  return binary(node, (child) => rowText(child, state));
}

function whereText(where, read) {
  if (!where?.length) return "";
  const conds = where.map((c) => {
    const op = c.op === "=" ? (read ? "is" : "=") : read ? "is not" : "≠";
    const value = read ? c.value : c.value === "" ? '""' : words(c.value, { numberFirst: true });
    return `${read ? c.column : words(c.column, { numberFirst: false })} ${op} ${value}`;
  });
  return ` where ${conds.join(" and ")}`;
}

/** The formula's canonical text. */
export function toText(ast) {
  const render = (node) => {
    if (node.type === "number") return numberText(node.value);
    if (node.type === "agg") return `${node.fn}(${rowText(node.expr, { full: false })}${whereText(node.where, false)})`;
    return binary(node, render);
  };
  return render(ast);
}

function readRow(node) {
  if (node.type === "number") return numberText(node.value);
  if (node.type === "ref") return node.column;
  return binary(node, readRow);
}

/** "Sum of usd in stripe/revenue ÷ sum of usd in cloudflare/ai-spend, each month". */
export function plainReading(ast, every) {
  const render = (node) => {
    if (node.type === "number") return numberText(node.value);
    if (node.type === "agg") return `${READ_AS.get(node.fn)} ${readRow(node.expr)} in ${node.source}/${node.dataset}${whereText(node.where, true)}`;
    return binary(node, render);
  };
  const text = render(ast);
  const period = parseEvery(every);
  const when = !period ? ""
    : period.unit === "days" ? `, over the last ${period.days} ${period.days === 1 ? "day" : "days"}`
    : period.unit === "hours" ? (period.hours === 1 ? ", each hour" : `, every ${period.hours} hours`)
    : `, each ${period.unit}`;
  return text.charAt(0).toUpperCase() + text.slice(1) + when;
}
