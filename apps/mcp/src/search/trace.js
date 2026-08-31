/**
 * What one search actually spent, and where.
 *
 * The search that prompted this took **40 to 60 seconds** against a live
 * 7,961-note context, and every explanation offered for it was a reading of
 * the code rather than a measurement. That is the gap this closes: a static
 * diagnosis names the suspects, and only a timing says which one the caller
 * waited on. The project this belongs to (`context-lc-search-performance`)
 * asks for exactly that first — "instrument one production search and use its
 * phase timings to confirm the static diagnosis" — before anything is
 * rearchitected on the strength of a guess.
 *
 * ## What it measures, and what it cannot
 *
 * **`Date.now()` in a Worker does not advance during computation.** Cloudflare
 * freezes the clock between I/O operations, deliberately, as a timing-attack
 * defence: it moves when a subrequest resolves and not otherwise. So every
 * span here is **wall clock spent waiting on storage**, and a phase that is
 * pure CPU — parsing shards, scoring, cutting snippets — reads `0`.
 *
 * That is stated rather than glossed because a reader who takes these numbers
 * for a full profile would draw the wrong conclusion twice: they would read a
 * `0` as "free" and they would find the phases not adding up to `total`. What
 * the numbers are good for is the thing the diagnosis is actually about —
 * **how many round trips a search serializes** — which is the one cost this
 * code decides and the network multiplies. CPU time is measured on the
 * fixtures instead, where the clock is real, and the shard-parse cost that
 * shows up there is recorded beside the I/O numbers rather than inside them.
 *
 * ## What it may never carry
 *
 * A log line is not a tool result, but it is still a place customer data can
 * end up, and this one describes a search over somebody's private notes. So it
 * carries identifiers and counts and nothing else: **never the query, never a
 * note path, never a snippet, never a term, never a credential.** A query
 * string is the most tempting field here and the one most obviously theirs.
 *
 * Counts of the whole index (docs, shards, pending) are operator-facing
 * bookkeeping and are safe *here* precisely because they never travel back to
 * a caller — the same numbers are withheld from a team-scope answer, where
 * subtracting them from what is visible is an existence oracle for the private
 * half of a bucket.
 */

/**
 * A trace for one search: named spans, plus fields the caller fills in.
 *
 * @param {() => number} [clock] injectable so a test can drive spans without
 *   depending on how a runtime's clock behaves; nothing in production passes it
 */
export function createSearchTrace(clock = Date.now) {
  const now = typeof clock === "function" ? clock : Date.now;
  const started = now();
  const ms = {};
  const fields = {};

  return {
    /**
     * Start a span. The returned function ends it and may be called once;
     * calling it twice would double-count a phase, which is the quiet way a
     * timing starts lying.
     */
    span(name) {
      const from = now();
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        ms[name] = (ms[name] || 0) + Math.max(0, now() - from);
      };
    },
    /** Record a fact about this search. Identifiers and counts only. */
    set(name, value) {
      if (value !== undefined) fields[name] = value;
    },
    /** The line an operator reads. `total` is always last-measured, never a sum. */
    toJSON() {
      return { event: "search", ...fields, ms: { ...ms, total: Math.max(0, now() - started) } };
    },
  };
}

/**
 * Emit one trace line.
 *
 * `console.log` because this Worker logs nowhere else and a Worker's log
 * stream is where an operator already looks; one JSON object per line because
 * a dashboard has to be able to parse it without a regex. Wrapped, because a
 * failed log must never be how a search fails: this is instrumentation, and
 * instrumentation that can take down the thing it measures is worse than none.
 */
export function logSearchTrace(trace) {
  try {
    console.log(JSON.stringify(trace.toJSON()));
  } catch {
    // A field that will not serialize is a bug in the caller, not a reason to
    // fail somebody's search.
  }
}
