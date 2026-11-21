/**
 * "Try a search" on the Search page (Dev2, 2026-11-21): a query run against main and against the draft open in the Lab,
 * side by side, so a change to search's steps or settings shows what it does to the ranking before it is saved or
 * promoted. The gateway runs the search (`op: "search"` on the test chat's route); this is only its answer drawn: each
 * column's ranked hits, a marker on the draft's hits that moved against main, and each step's time.
 *
 * A second Search while one runs takes the view: the first answer, when it comes back, is dropped.
 */
import { useRef, useState } from "react";
import { callSandboxRoute, drawnDraft } from "../../engine/sandbox";
import { isMain, lab } from "../../engine/state";
import { rankMoves, type RankHit, type RankMove } from "../../data/searchSettings";
import { LAB_CSS_SEARCH } from "../../labCssSearch";

type StepTime = { node: string; ms: number; ok: boolean; notes?: number };
type Side = { hits: RankHit[]; searched: string[]; steps: StepTime[] };
type Answer = { query: string; main: Side; draft: Side | "same" | null; changed: string[] };
type TryState = { status: "idle" } | { status: "running" } | { status: "done"; answer: Answer } | { status: "error"; text: string };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The gateway's answer as the panel reads it; a shape it does not know is an error, not a blank result. */
export function parseAnswer(b: Record<string, unknown>): Answer | { error: string } {
  if (typeof b.error === "string" && b.error) return { error: b.error };
  const side = (v: unknown): Side | null => {
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const hits = Array.isArray(o.hits)
      ? o.hits.map((h) => {
          const x = (h ?? {}) as Record<string, unknown>;
          return { key: str(x.key), title: str(x.title) || str(x.key), ...(x.meaningOnly ? { meaningOnly: true } : {}) };
        })
      : [];
    const steps = Array.isArray(o.steps) ? o.steps.map((s) => ({ node: str((s as Record<string, unknown>)?.node), ms: num((s as Record<string, unknown>)?.ms), ok: (s as Record<string, unknown>)?.ok !== false, ...(typeof (s as Record<string, unknown>)?.notes === "number" ? { notes: (s as Record<string, unknown>).notes as number } : {}) })) : [];
    return { hits, searched: Array.isArray(o.searched) ? o.searched.map(str) : [], steps };
  };
  const main = side(b.main);
  if (!main) return { error: "The search answered without a main result." };
  const draft = b.draft === "same" ? "same" : side(b.draft);
  return { query: str(b.query), main, draft, changed: Array.isArray(b.changed) ? b.changed.map(str) : [] };
}

/** The mark a draft row gets when its rank moved against main; none when it kept its rank. */
function moveMark(m: RankMove) {
  if (m.move === "up") return { glyph: "▲", text: `up from #${m.was}` };
  if (m.move === "down") return { glyph: "▼", text: `down from #${m.was}` };
  if (m.move === "new") return { glyph: "+", text: "not on main" };
  return null;
}

function Column({ title, side, moves }: { title: string; side: Side; moves?: RankMove[] }) {
  const rows: Array<RankHit & { rank: number; mark: ReturnType<typeof moveMark> }> = moves
    ? moves.map((m) => ({ ...m, mark: moveMark(m) }))
    : side.hits.map((h, i) => ({ ...h, rank: i + 1, mark: null }));
  return (
    <section className="trys-col" data-col={title.toLowerCase()}>
      <h4>
        {title} <span className="trys-count">{side.searched.length ? `searched ${side.searched.join(", ")}` : ""}</span>
      </h4>
      {rows.length ? (
        <ol className="trys-hits">
          {rows.map((r) => (
            <li key={r.key} data-key={r.key} data-move={r.mark ? (r.mark.glyph === "+" ? "new" : r.mark.glyph === "▲" ? "up" : "down") : undefined}>
              <span className="trys-rank">{r.rank}</span>
              <span className="trys-name">
                <span className="trys-title">
                  {r.title}
                  {r.meaningOnly ? <span className="trys-tag">meaning only</span> : null}
                </span>
                <span className="trys-key">{r.key}</span>
              </span>
              {r.mark ? (
                <span className="trys-mark" title={r.mark.text}>
                  {r.mark.glyph} {r.mark.text}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="trys-empty">No hits.</p>
      )}
      <div className="trys-steps">
        {side.steps.map((s, i) => (
          <span key={i} className={s.ok ? undefined : "bad"}>{`${s.node}${s.notes === undefined ? "" : ` · ${s.notes} notes`} ${Math.round(s.ms)} ms${s.ok ? "" : " (failed)"}`}</span>
        ))}
      </div>
    </section>
  );
}

export function TrySearch() {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<TryState>({ status: "idle" });
  // Each Search gets a number; an answer that is not the latest is dropped, so the newest query takes the view.
  const latest = useRef(0);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    const mine = ++latest.current;
    setState({ status: "running" });
    // The draft as drawn when it has unsaved edits (the same rule the test chat follows); main needs no version at all.
    const body: Record<string, unknown> = { query: q };
    if (!isMain()) {
      body.versionId = lab.cur.id;
      const graph = drawnDraft(lab.cur.id);
      if (graph !== null) body.graph = graph;
    }
    try {
      const parsed = parseAnswer(await callSandboxRoute("search", body));
      if (mine !== latest.current) return;
      setState("error" in parsed ? { status: "error", text: parsed.error } : { status: "done", answer: parsed });
    } catch (e) {
      if (mine !== latest.current) return;
      setState({ status: "error", text: e instanceof Error ? e.message : "The search hit a problem. Try again." });
    }
  };

  const answer = state.status === "done" ? state.answer : null;
  // "same" is the draft's answer being main's own: its column is main's hits again, so every rank reads as kept.
  const draft: Side | null = answer ? (answer.draft === "same" ? answer.main : answer.draft) : null;
  const moves = answer && draft ? rankMoves(answer.main.hits, draft.hits) : undefined;

  return (
    <div className={"trys" + (open ? " open" : "")} id="trySearch" role="region" aria-label="Try a search">
      <style>{LAB_CSS_SEARCH}</style>
      <div className="trys-bar">
        <button className="trys-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          Try a search
        </button>
        {open ? (
          <form
            className="trys-form"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input type="search" id="trysQuery" value={query} placeholder="A question, as a user would ask it" onChange={(e) => setQuery(e.target.value)} aria-label="Query" />
            <button type="submit" id="trysGo" className="primary" disabled={!query.trim()}>
              {state.status === "running" ? <span className="trys-spin" aria-hidden="true" /> : null}
              {state.status === "running" ? "Searching…" : "Search"}
            </button>
          </form>
        ) : null}
      </div>
      {open && state.status === "error" ? <p className="trys-error" role="alert">{state.text}</p> : null}
      {open && answer ? (
        <div className="trys-body">
          <div className="trys-cols">
            <Column title="Main" side={answer.main} />
            {draft ? (
              <Column title="Draft" side={draft} moves={moves} />
            ) : (
              <p className="trys-note">No unsaved draft: this is main&apos;s answer.</p>
            )}
          </div>
          {draft && answer.changed.length ? <p className="trys-note">{`Changed: ${answer.changed.join(", ")}`}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
