/**
 * Metric formulas, step two: tokens → a tree of plain objects.
 *
 *   formula := term (("+" | "-") term)*
 *   term    := factor (("*" | "×" | "/" | "÷") factor)*
 *   factor  := NUMBER | agg | "(" formula ")"
 *   agg     := FN "(" colexpr [where] ")"     FN: sum count average median p90 p95 min max
 *            | "count" "(" "distinct" colexpr [where] ")"   each filled value once
 *   colexpr := the same + − × ÷ and brackets, per row, over refs and numbers
 *   ref     := source "/" dataset "." column  |  column
 *   where   := "where" cond ("and" cond)*
 *   cond    := column ("=" | "≠" | "!=") value   value: a bare word or words, a number, or quoted text
 *
 * A column is the sheet's header name, written as words (`lines added`) or in
 * quotes (`"time (ms)"`); `lines_added`, `Lines Added` and `lines added` all
 * name the same header (`columnKey`). A bare column belongs to its
 * aggregate's dataset, or before the aggregate names one, to the formula's
 * last ref (`sum(eval-ci/bench-runs.errors) ÷ sum(requests)`, as drawn). The
 * tree always carries full refs, and one aggregate reads one dataset.
 *
 * Nodes: `{ type: "number", value }`, `{ type: "binary", op, left, right }`
 * (op `+ - * /`), `{ type: "agg", fn, source, dataset, expr, where }` (a
 * `count(distinct …)` carries `distinct: true`, and no other node has the key),
 * `{ type: "ref", source, dataset, column }`, and where conditions
 * `{ column, op: "=" | "!=", value }`.
 *
 * A formula is someone's text run on every reader's data, so it is bounded:
 * 2 KB, 8 aggregates, 32 parts, 16 brackets deep, and `__proto__`,
 * `constructor` and `prototype` are never names. Nothing is evaluated here.
 */

import { lex } from "./lex.js";
import { toText } from "./render.js";

export const FUNCTIONS = Object.freeze(["sum", "count", "average", "median", "p90", "p95", "min", "max"]);
export const MAX_FORMULA_BYTES = 2048;
export const MAX_AGGREGATES = 8;
export const MAX_NODES = 32;
export const MAX_DEPTH = 16;

const FUNCTION_SET = new Set(FUNCTIONS);
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const SHOW = new Map([["+", "+"], ["-", "−"], ["*", "×"], ["/", "÷"], ["!=", "≠"]]);

/** The name a column is matched by: case, underscores and runs of spaces do not matter. */
export function columnKey(name) {
  return String(name ?? "").toLowerCase().replaceAll("_", " ").split(" ").filter(Boolean).join(" ");
}

class Refusal {
  constructor(message, at) {
    this.message = message.charAt(0).toUpperCase() + message.slice(1);
    this.at = at;
  }
}

const isKeyword = (token, word) => token?.type === "word" && token.raw.toLowerCase() === word;
const isOp = (token, value) => token?.type === "op" && token.value === value;
const shown = (token) => (token.type === "op" ? SHOW.get(token.value) ?? token.raw : token.raw);

/**
 * Formula text → `{ ok: true, ast }` or `{ ok: false, error: { message, at } }`. Never throws.
 * @param {unknown} text
 * @returns {{ ok: true, ast: any, error?: undefined } | { ok: false, ast?: undefined, error: { message: string, at: number } }}
 */
export function parseFormula(text) {
  if (typeof text !== "string") return { ok: false, error: { message: "A formula is text.", at: 0 } };
  if (new TextEncoder().encode(text).byteLength > MAX_FORMULA_BYTES) {
    return { ok: false, error: { message: "The formula is over 2 KB; make it shorter.", at: 0 } };
  }
  if (!text.trim()) return { ok: false, error: { message: "Write a formula, like sum(source/dataset.column).", at: 0 } };
  const lexed = lex(text);
  if (!lexed.ok) return lexed;
  try {
    const ast = new Parser(lexed.tokens, text).run();
    // The canonical text is what gets saved, so it has to fit under the same cap and read back.
    if (new TextEncoder().encode(toText(ast)).byteLength > MAX_FORMULA_BYTES) {
      return { ok: false, error: { message: "The formula is over 2 KB; make it shorter.", at: 0 } };
    }
    return { ok: true, ast };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: { message: err.message, at: err.at } };
    return { ok: false, error: { message: "The formula could not be read.", at: 0 } };
  }
}

class Parser {
  constructor(tokens, text) {
    this.tokens = tokens;
    this.text = text;
    this.length = text.length;
    this.i = 0;
    this.nodes = 0;
    this.aggregates = 0;
    this.depth = 0;
    this.lastRef = null; // { source, dataset } of the formula's last full ref
    this.agg = null; // the aggregate being read: { source, dataset } once it names one
  }

  peek(k = 0) { return this.tokens[this.i + k]; }
  next() { return this.tokens[this.i++]; }
  here() { return this.peek()?.at ?? this.length; }

  node(value, at) {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw new Refusal(`The formula is too long: it can have at most ${MAX_NODES} parts.`, at);
    return value;
  }

  run() {
    const ast = this.formula(false);
    const extra = this.peek();
    if (extra) throw new Refusal(`expected + − × ÷ or the end of the formula, not "${shown(extra)}".`, extra.at);
    return ast;
  }

  /* Both levels serve the formula and, with `row` true, the per-row expression inside an aggregate. */
  formula(row) {
    let left = this.term(row);
    while (isOp(this.peek(), "+") || isOp(this.peek(), "-")) {
      const op = this.next();
      left = this.node({ type: "binary", op: op.value, left, right: this.term(row, op) }, op.at);
    }
    return left;
  }

  term(row, after) {
    let left = this.factor(row, after);
    while (isOp(this.peek(), "*") || isOp(this.peek(), "/")) {
      const op = this.next();
      left = this.node({ type: "binary", op: op.value, left, right: this.factor(row, op) }, op.at);
    }
    return left;
  }

  factor(row, after) {
    const token = this.peek();
    const lead = after ? `After "${shown(after)}", expected` : "expected";
    if (!token) throw new Refusal(`${lead} a number, ${row ? "a column" : "an aggregate like sum(…)"} or "(".`, this.length);
    if (token.type === "num") {
      const size = Math.abs(token.value);
      if (!Number.isFinite(token.value) || (size !== 0 && (size < 1e-9 || size >= 1e15))) {
        throw new Refusal(`"${token.raw}" is too large or too small a number.`, token.at);
      }
      this.next();
      return this.node({ type: "number", value: token.value }, token.at);
    }
    if (isOp(token, "(")) {
      this.next();
      this.depth += 1;
      if (this.depth > MAX_DEPTH) throw new Refusal(`The formula has too many brackets inside each other (at most ${MAX_DEPTH}).`, token.at);
      const inner = this.formula(row);
      this.expect(")", `expected ")" to close the bracket opened at character ${token.at + 1}`);
      this.depth -= 1;
      return inner;
    }
    if (token.type === "word" && isOp(this.peek(1), "(")) {
      const fn = token.raw.toLowerCase();
      if (!FUNCTION_SET.has(fn)) {
        throw new Refusal(`This uses an unknown function "${token.raw}"; use ${FUNCTIONS.slice(0, -1).join(", ")} or ${FUNCTIONS.at(-1)}.`, token.at);
      }
      if (row) throw new Refusal(`${fn}(…) can't sit inside another aggregate.`, token.at);
      return this.aggregate(fn, token);
    }
    if (row && (token.type === "word" || token.type === "str")) return this.ref();
    if (token.type === "word" || token.type === "str") {
      // Quote what was written, up to the next operator with a space before it.
      let last = token;
      for (let k = this.i + 1; k < this.tokens.length && k < this.i + 12; k += 1) {
        const t = this.tokens[k];
        if (t.type === "op" && t.value !== "." && (t.space || t.value !== "/")) break;
        last = t;
      }
      const what = this.text.slice(token.at, last.end);
      throw new Refusal(`"${what}" needs an aggregate around it, like sum(${what}).`, token.at);
    }
    throw new Refusal(`${lead} a number, ${row ? "a column" : "an aggregate like sum(…)"} or "(", not "${shown(token)}".`, token.at);
  }

  /** `message` is written without its full stop, so the token found can follow it. */
  expect(value, message) {
    const token = this.peek();
    if (!isOp(token, value)) throw new Refusal(token ? `${message}, not "${shown(token)}".` : `${message}.`, token?.at ?? this.length);
    return this.next();
  }

  aggregate(fn, token) {
    this.aggregates += 1;
    if (this.aggregates > MAX_AGGREGATES) throw new Refusal(`A formula can have at most ${MAX_AGGREGATES} aggregates.`, token.at);
    const node = this.node({ type: "agg", fn, source: "", dataset: "", expr: null, where: [] }, token.at);
    this.next(); // the function's name
    this.next(); // "("
    this.agg = { source: "", dataset: "" };
    // `distinct` before a column, never a column of that name: `count(a/b.distinct)` and `count(distinct/x.y)` stay plain.
    const lead = this.peek();
    const after = this.peek(1);
    if (isKeyword(lead, "distinct") && after && (after.type === "word" || after.type === "num" || after.type === "str")) {
      if (fn !== "count") throw new Refusal(`distinct works only with count, as in count(distinct source/dataset.column).`, lead.at);
      this.next();
      node.distinct = true;
    }
    if (isOp(this.peek(), ")") || !this.peek()) {
      throw new Refusal(`${fn} needs a column, like ${fn}(source/dataset.column).`, this.here());
    }
    node.expr = this.formula(true);
    if (!this.agg.source) throw new Refusal(`${fn} needs a column, like ${fn}(source/dataset.column).`, token.at);
    node.source = this.agg.source;
    node.dataset = this.agg.dataset;
    if (isKeyword(this.peek(), "where")) {
      this.next();
      node.where.push(this.condition());
      while (isKeyword(this.peek(), "and")) {
        this.next();
        node.where.push(this.condition());
      }
    }
    this.expect(")", `expected ")" to close ${fn}(`);
    this.agg = null;
    return node;
  }

  /** A column written as words (stopping at `where`, and in a condition at `and`) or in quotes. */
  columnName(stopAtAnd) {
    const first = this.peek();
    if (first?.type === "str") {
      this.next();
      return { name: first.value, at: first.at };
    }
    const words = [];
    while (this.peek() && (this.peek().type === "word" || this.peek().type === "num") && !isKeyword(this.peek(), "where") && !(stopAtAnd && isKeyword(this.peek(), "and"))) {
      words.push(this.next().raw);
    }
    return { name: words.join(" "), at: first?.at ?? this.length };
  }

  checkName(name, at, what) {
    if (RESERVED.has(name.trim().toLowerCase())) throw new Refusal(`"${name}" can't be used as a name.`, at);
    if (!columnKey(name)) throw new Refusal(`"${name}" isn't a ${what} name.`, at);
  }

  ref() {
    const t = this.tokens;
    const i = this.i;
    const isName = (token) => token && (token.type === "word" || token.type === "num");
    // source/dataset.column, written together: `a / b` is a division, `a/b.c` a reference.
    const full = t[i].type === "word" && isOp(t[i + 1], "/") && !t[i + 1].space && isName(t[i + 2]) && !t[i + 2].space && isOp(t[i + 3], ".") && !t[i + 3].space;
    let source;
    let dataset;
    const at = t[i].at;
    if (full) {
      source = t[i].raw;
      dataset = t[i + 2].raw;
      this.checkName(source, t[i].at, "source");
      this.checkName(dataset, t[i + 2].at, "dataset");
      this.i += 4;
    }
    const column = this.columnName(false);
    if (!column.name && !full) throw new Refusal("expected a column.", column.at);
    if (!column.name) throw new Refusal(`After "${source}/${dataset}.", name a column.`, column.at);
    this.checkName(column.name, column.at, "column");
    if (!full) {
      const home = this.agg.source ? this.agg : this.lastRef;
      if (!home) throw new Refusal(`Name the dataset first: source/dataset.${column.name}.`, at);
      source = home.source;
      dataset = home.dataset;
    }
    if (!this.agg.source) this.agg = { source, dataset };
    else if (this.agg.source !== source || this.agg.dataset !== dataset) {
      throw new Refusal(`One aggregate reads one dataset; put ${source}/${dataset} in an aggregate of its own.`, at);
    }
    this.lastRef = { source, dataset };
    return this.node({ type: "ref", source, dataset, column: column.name }, at);
  }

  condition() {
    const column = this.columnName(false);
    if (!column.name) throw new Refusal(`After "where", name a column.`, column.at);
    this.checkName(column.name, column.at, "column");
    const op = this.peek();
    if (!isOp(op, "=") && !isOp(op, "!=")) {
      throw new Refusal(op ? `expected = or ≠ after ${column.name}, not "${shown(op)}".` : `expected = or ≠ after ${column.name}.`, op?.at ?? this.length);
    }
    this.next();
    const first = this.peek();
    let value;
    if (first?.type === "str") {
      this.next();
      value = first.value;
    } else {
      value = this.columnName(true).name;
      if (!value) throw new Refusal(`After "${column.name} ${SHOW.get(op.value) ?? op.value}", give a value.`, first?.at ?? this.length);
    }
    return this.node({ column: column.name, op: op.value, value }, column.at);
  }
}
