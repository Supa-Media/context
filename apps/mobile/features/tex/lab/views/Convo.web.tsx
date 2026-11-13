/**
 * The Lab's Conversations view: the artifact's `renderConvo` (`#cvPg`): the
 * picture of who writes a chat (`ConvoDiagram`), the settings a turn is shown
 * with, the tools that may change a chat, which steps write to the record,
 * and what the ledger holds. Settings are written through the engine's
 * `setCv` and `setCvTool`, so the edits make a version and the diff sees them.
 */
import { useEffect, useRef } from "react";
import { cvOf, setCv, setCvTool } from "../engine/modules";
import { focusOn, G, MAIN, edit, node } from "../engine/state";
import { CV_KINDS, CV_TOOLS } from "../data/convo";
import { NODE_INFO } from "../data/graph";
import { useLab } from "../store";
import { PageHead } from "./parts";
import { ConvoDiagram } from "./convoDiagram";
import { inPrompt } from "./convoRows";

/**
 * A settings number input: commits on change (blur, Enter, spinner), not per keystroke, as the artifact's `onchange` does.
 * The label gets no `chg` class: the artifact writes `class="num"` and then a second `class="chg"`, and the HTML parser
 * keeps only the first, so its page never draws the outline (checked in the screenshots, 13 Nov).
 */
function NumField({ f, label, value, step, min, max }: { f: "word" | "threads" | "older" | "days" | "dayChars"; label: string; value: number; step: number; min: number; max: number }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => setCv(f, +el.value);
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, [f, value]);
  return (
    <label className="num">
      <span>{label}</span>
      <input key={value} ref={ref} type="number" data-cv={f} defaultValue={value} step={step} min={min} max={max} />
    </label>
  );
}

export function Convo() {
  useLab();
  const g = G();
  const c = cvOf(g);
  const nodes = g.nodes;
  const noWrite = nodes.filter((n) => !n.log).length;

  return (
    <div data-testid="tex-lab-convo">
      <PageHead
        icon={
          <svg className="i" viewBox="0 0 24 24">
            <path d="M4 5h11v8H8l-4 3z" />
            <path d="M15 9h5v8l-3-2h-6v-2" />
          </svg>
        }
        title="Conversations"
      >
        {""}
      </PageHead>
      <div className="blk" style={{ marginTop: 0 }}>
        <ConvoDiagram c={c} />
      </div>
      <div className="cvgrid">
        <div className="blk">
          <h2>What a turn is shown</h2>
          <div className="nums" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
            <NumField f="word" label="Word for word, hours" value={c.word} step={1} min={0} max={168} />
            <NumField f="threads" label="Threads listed" value={c.threads} step={1} min={0} max={200} />
            <NumField f="older" label="Older history, characters" value={c.older} step={1000} min={0} max={400000} />
            <NumField f="days" label="Day summaries" value={c.days} step={1} min={0} max={365} />
            <NumField f="dayChars" label="Summary characters" value={c.dayChars} step={500} min={0} max={60000} />
          </div>
          <div className="chips" style={{ marginTop: 10 }}>
            <button className="tg" id="cvSlim" aria-pressed={c.slim} onClick={() => setCv("slim", !c.slim)}>
              Tool calls as names only
            </button>
            <button className="tg" id="cvCls" aria-pressed={c.classify === "after"} onClick={() => setCv("classify", c.classify === "after" ? "before" : "after")}>
              Classifier after the reply
            </button>
          </div>
        </div>
        <div className="blk">
          <h2>How Tex changes a chat</h2>
          <div className="cvtools">
            {Object.entries(CV_TOOLS).map(([t, [l, kind, inMain]]) => (
              <button key={t} className="cvtool" data-cvt={t} aria-pressed={c.tools[t]} onClick={() => setCvTool(t, !c.tools[t])}>
                <span className={`cvk ${kind}`}>{kind}</span>
                <span className="nm">{l}</span>
                <code>{t}</code>
                {inMain ? null : <span className="tag">new</span>}
              </button>
            ))}
          </div>
          <p className="hint" style={{ margin: "10px 0 0" }}>
            On main nothing edits a chat: every step only appends, the history file refuses writes, and only the classifier moves threads.
          </p>
        </div>
      </div>
      <div className="blk">
        <h2>Who writes to the record</h2>
        <p className="hint" style={{ margin: "0 0 10px" }}>
          Every step should leave its input, output, time and ok in the chat's record, so a bad answer can be traced from the chat alone. Red ones leave nothing today.
        </p>
        <div className="tbl">
          <table>
            <tbody>
              <tr>
                <th>Step</th>
                <th>Writes</th>
                <th>On this version</th>
              </tr>
              {nodes.map((n) => {
                const lg = NODE_INFO[n.id]?.logs;
                const was = !!node(n.id, MAIN.graph)?.log;
                return (
                  <tr key={n.id}>
                    <td>
                      <button className="lnk" data-cvn={n.id} onClick={() => focusOn(n.id)}>
                        {n.label}
                      </button>
                    </td>
                    <td>{lg ? lg.join(", ") : <span className="lgno">nothing</span>}</td>
                    <td>
                      {n.log ? <span className="lgok">writes</span> : <span className="lgno">writes nothing</span>}
                      {n.log !== was ? (
                        <>
                          {" "}
                          <span className="pill warn">changed</span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex" style={{ marginTop: 10 }}>
          <button
            className="ghost"
            id="cvAllLog"
            onClick={() =>
              edit(() => {
                for (const n of G().nodes) n.log = true;
              })
            }
          >
            Every step writes
          </button>
          <span className="hint">
            {noWrite} of {nodes.length} steps write nothing
          </span>
        </div>
      </div>
      <div className="blk">
        <h2>What the ledger holds</h2>
        <div className="tbl">
          <table>
            <tbody>
              <tr>
                <th>Entry</th>
                <th>Written by</th>
                <th>Holds</th>
                <th>In the prompt</th>
              </tr>
              {CV_KINDS.map(([k, w, hh, sh]) => {
                const cell = inPrompt(k, sh, c.slim);
                return (
                  <tr key={k}>
                    <td>
                      <code>{k}</code>
                    </td>
                    <td>{w}</td>
                    <td>{hh}</td>
                    <td>{cell === "yes" ? <span className="ok">yes</span> : cell === "no" ? <span className="hint">no</span> : cell}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
