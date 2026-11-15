/**
 * The Lab's Run view, ported from the artifact's `renderRun`, `copy`,
 * `keepResults` and `renderResults`: hand the version to a Claude Code
 * session, paste its report back, and keep the results with the version.
 */
import { Fragment, useRef } from "react";
import { AREAS, EXAMINABLE } from "../data/areas";
import { config, diff, runAreas, type Change } from "../engine/diff";
import { emit, forkFromMain, isMain, lab, MAIN, saveVersion, set, toast } from "../engine/state";
import { saveMainResults, useLab } from "../store";
import { PageHead } from "./parts";
import { type ParsedResult, parseReport, promptText, shipsAs } from "./run/runText";
import { runWarnings } from "./run/runWarns";
import { parseReplay } from "../engine/mine";

function toggleArea(k: string) {
  if (isMain()) forkFromMain();
  const s = new Set(runAreas());
  if (s.has(k)) s.delete(k);
  else s.add(k);
  lab.cur.areas = [...s];
  lab.dirty = true;
  emit();
}

/** Copy text; if the clipboard is refused, select the prompt so the person can copy it. */
function copy(text: string, ta: HTMLTextAreaElement | null) {
  const sel = () => {
    ta?.focus();
    ta?.select();
    toast("Selected. Press copy.");
  };
  try {
    navigator.clipboard.writeText(text).then(() => toast("Copied"), sel);
  } catch {
    sel();
  }
}

const howPill = (x: Change) => <span className={x.how === "setup" ? "pill ok" : x.how === "code" ? "pill warn" : "pill"}>{shipsAs(x)}</span>;

export function Run() {
  useLab();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const resRef = useRef<HTMLTextAreaElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  const d = diff();
  const chosen = runAreas();
  const c = config();

  const warns = runWarnings(d, chosen);

  async function keepResults() {
    const txt = (resRef.current?.value ?? "").trim();
    if (!txt) {
      toast("Paste the report first");
      return;
    }
    // A replay's Then-and-Now is the person's own chat: it stays in this tab (`lab.myNow`) and is never saved with the
    // version, which every staff member reads (`functions/texLab.ts`). Only the rest of the report is kept.
    const replay = parseReplay(txt);
    if (replay.length) lab.myNow = { ...lab.myNow, ...Object.fromEntries(replay.map((x) => [x.id, x])) };
    const kept = replay.length ? txt.slice(0, txt.indexOf("## Lab replay")).trim() : txt;
    if (replay.length && !kept) {
      toast("Replay shown under Your texts");
      emit();
      return;
    }
    const r = parseReport(kept);
    r.link = (linkRef.current?.value ?? "").trim();
    r.by = lab.myId;
    if (!Object.keys(r.areas).length && !replay.length) toast("No “**area:** practice x/y” lines found; kept the text");
    if (isMain()) {
      MAIN.results.push(r);
      lab.cur.results = MAIN.results;
      await saveMainResults();
      emit();
    } else {
      lab.cur.results = lab.cur.results || [];
      lab.cur.results.push(r);
      await saveVersion();
    }
  }

  return (
    <>
      <PageHead icon={<svg className="i" viewBox="0 0 24 24"><path d="M7 5l11 7-11 7z" /></svg>} title="Run">
        Hand <b>{lab.cur.name}</b> to a Claude Code session on the subscription. It builds a branch, runs the examiner on the areas below, and gives back a report and a step log. No API credits.
      </PageHead>

      <div className="blk" style={{ borderTop: "none", paddingTop: 0 }}>
        <h2>Changes from main</h2>
        {d.length ? (
          <div className="tbl">
            <table>
              <tbody>
                <tr>
                  <th>Step</th>
                  <th>Change</th>
                  <th>Ships as</th>
                </tr>
                {d.map((x, i) => {
                  const mod = x.mod;
                  return (
                    <tr key={i}>
                      <td>{x.label}</td>
                      <td>
                        {x.what}
                        {x.from !== undefined ? (
                          <>
                            {": "}
                            <span style={{ color: "var(--dim)" }}>{String(x.from)}</span>
                            {" → "}
                          </>
                        ) : (
                          " "
                        )}
                        {String(typeof x.to === "string" ? x.to : JSON.stringify(x.to))}
                      </td>
                      <td>
                        {howPill(x)}
                        {mod ? (
                          <>
                            {" "}
                            <button className="lnk" data-wd={mod} onClick={() => set({ viewer: { kind: "diff", key: mod } })}>
                              View
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="hint">Same as main. A run now is a baseline.</p>
        )}
      </div>

      <div className="blk">
        <h2>Areas to run</h2>
        <div className="tabsrow">
          {Object.entries(AREAS).map(([k, v]) => (
            <button key={k} data-ra={k} aria-pressed={chosen.includes(k) ? "true" : "false"} onClick={() => toggleArea(k)}>
              {v}
              {EXAMINABLE.has(k) ? "" : " · credits"}
            </button>
          ))}
        </div>
        {warns.map((w) => (
          <div className="callout" key={w} style={{ marginTop: 8 }}>
            {w}
          </div>
        ))}
      </div>

      <div className="blk">
        <h2>The prompt</h2>
        <textarea className="code" id="promptOut" rows={12} readOnly ref={promptRef} value={promptText(c)} />
        <div className="flex" style={{ marginTop: 8 }}>
          <button
            className="primary"
            id="copyPrompt"
            onClick={() => copy(promptRef.current?.value ?? promptText(c), promptRef.current)}
          >
            Copy the prompt
          </button>
          <button className="ghost" id="copyJson" onClick={() => copy(JSON.stringify(c, null, 2), promptRef.current)}>
            Copy config JSON
          </button>
        </div>
      </div>

      <div className="blk">
        <h2>Results</h2>
        <textarea
          className="code"
          id="resIn"
          rows={5}
          ref={resRef}
          placeholder={"## Tex replay: ✅ nothing regressed\n**core:** practice 17/19 right, held-out 9/10 right; spent about $0.00."}
        />
        <div className="flex" style={{ marginTop: 8 }}>
          <input className="search" id="resLink" placeholder="Run link" aria-label="Run link" style={{ maxWidth: "none" }} ref={linkRef} />
          <button className="primary" id="resBtn" onClick={() => keepResults()}>
            Keep these results
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          <Results />
        </div>
      </div>
    </>
  );
}

/** The version's kept results, newest first (the artifact's `renderResults`). */
export function Results() {
  useLab();
  const rs = ((lab.cur.results || []) as ParsedResult[]).slice().reverse();
  if (!rs.length) return <p className="hint">No results on this version yet.</p>;
  return (
    <div className="tbl">
      <table>
        <tbody>
          <tr>
            <th>When</th>
            <th>Verdict</th>
            <th>Areas</th>
            <th></th>
          </tr>
          {rs.map((r, i) => {
            const lines = Object.entries(r.areas).map(
              ([a, v]) => `${AREAS[a] || a} ${v.practice[0]}/${v.practice[1]} · held-out ${v.held[0]}/${v.held[1]}`,
            );
            return (
              <tr key={i}>
                <td>{new Date(r.at).toLocaleString()}</td>
                <td>
                  {r.pass == null ? (
                    <span className="pill">unread</span>
                  ) : r.pass ? (
                    <span className="pill ok">nothing regressed</span>
                  ) : (
                    <span className="pill bad">{r.regressed ?? "some"} regressed</span>
                  )}
                </td>
                <td>
                  {lines.length ? (
                    lines.map((l, j) => (
                      <Fragment key={j}>
                        {j > 0 ? <br /> : null}
                        {l}
                      </Fragment>
                    ))
                  ) : (
                    <span className="hint">see text</span>
                  )}
                </td>
                <td>
                  {/^https:\/\//.test(r.link || "") ? (
                    <a href={r.link} target="_blank" rel="noopener" style={{ color: "var(--accent)" }}>
                      Open
                    </a>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
