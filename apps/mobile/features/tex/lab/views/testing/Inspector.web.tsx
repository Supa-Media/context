/**
 * The prototype's right panel, on the selected cell only: a node's cell is its expected output on that message
 * (with exactly what the config gives the node there), a message's cell its speaker and words, a Tex row what Tex
 * should have said.
 */
import { useStartRun } from "../runs/Runs.web";
import { useState } from "react";
import { G, lab } from "../../engine/state";
import { labelCount, labelFields, modValue, nodeStars, ranOn, starsIn, wiresIn, type Conversation, type Label, type Message } from "../../engine/sets";
import { change, useSets } from "../../engine/setsStore";
import type { LabNode } from "../../types";
import { MsgFields, SpeakerPick } from "./MsgFields.web";

const NOTES: Record<string, string> = { reviewer: "Its output is the turn report; sentBack is how many times it sent the draft back.", fd: "Its output is the turn report; it is labelled by must and never lines about its draft." };

function Input({ c, i, n }: { c: Conversation; i: number; n: LabNode }) {
  const s = useSets();
  const g = G();
  const m = c.msgs[i];
  const wires = wiresIn(n, m, g);
  return (
    <details className="inbox" open>
      <summary>
        <b>Input</b> <span className="muted small">from texConfig.json on {lab.cur.name}</span>
      </summary>
      <div className="small">
        {n.model}
        {n.effort ? " · effort " + n.effort : ""} · {n.rounds} round{n.rounds === 1 ? "" : "s"}
        {n.timeoutS ? ` · ${n.timeoutS} s limit` : ""}
        {n.on ? null : (
          <>
            {" · "}
            <span className="c-bad">off in config: never runs</span>
          </>
        )}
      </div>
      <div className="cap">Reads, in order</div>
      {n.ctx.length ? (
        n.ctx.map((id, k) => {
          const r = modValue(c, i, id, n, s.convs, g);
          return (
            <div className="inrow" key={id}>
              <span className="mono muted">{k + 1}</span>
              <div>
                <b>{r.name}</b> <span className="mono muted">{id}</span>
                <div className="small">
                  {r.value}
                  {r.plan ? (
                    <>
                      {" · "}
                      <span className="plan">{r.plan}</span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })
      ) : (
        <div className="small muted">None: code, or only what its wires hand it.</div>
      )}
      <div className="cap">Wires in</div>
      {wires.length ? (
        wires.map((w) => (
          <div className="inrow" key={w.from + w.mode}>
            <span className="mono muted">{w.mode}</span>
            <div>
              <b>{w.label}</b> <span className="muted small">when {w.when}</span>
              <div className={"small " + w.cls}>{w.src}</div>
            </div>
          </div>
        ))
      ) : (
        <div className="small muted">No wires in.</div>
      )}
      <div className="cap">Output shape</div>
      <div className="mono small">{(n.outSchema || []).map((f) => f.name).join(", ")}</div>
      {NOTES[n.id] ? <div className="small muted">{NOTES[n.id]}</div> : null}
    </details>
  );
}

function Lines({ c, m, n, k, word, l }: { c: Conversation; m: Message; n: LabNode; k: "must" | "never"; word: string; l: Label }) {
  const list = (l[k] as string[]) || [];
  const [adding, setAdding] = useState(false);
  const put = (next: string[]) => change(c.id, [{ op: "field", msg: m.id, node: n.id, field: k, value: next.filter((x) => x.trim()).length ? next.filter((x) => x.trim()) : null }]);
  return (
    <div className="must" data-k={k}>
      <span className="small" style={{ color: k === "must" ? "var(--ok)" : "var(--bad)" }}>
        {word}
      </span>
      {list.map((t, j) => (
        <div key={j + t}>
          <input defaultValue={t} data-j={j} aria-label={`${word} line`} onBlur={(e) => e.target.value !== t && put(list.map((x, y) => (y === j ? e.target.value : x)))} />
          <button className="btn sm" data-del={j} aria-label="Remove" onClick={() => put(list.filter((_, y) => y !== j))}>
            ×
          </button>
        </div>
      ))}
      {adding ? (
        <div>
          <input autoFocus aria-label={`${word} line`} onBlur={(e) => (setAdding(false), e.target.value.trim() && put([...list, e.target.value]))} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
        </div>
      ) : null}
      <button className="btn sm ghost" data-add={k} style={{ alignSelf: "flex-start" }} onClick={() => setAdding(true)}>
        + {word} line
      </button>
    </div>
  );
}

function LabelForm({ c, m, n }: { c: Conversation; m: Message; n: LabNode }) {
  const runIt = useStartRun("testing");
  const l: Label = m.labels?.[n.id] || {};
  const f = labelFields(n);
  const ran = ranOn(m, n.id);
  const [shown, setShown] = useState<string | null>(null);
  const field = (k: string, v: unknown) => change(c.id, [{ op: "field", msg: m.id, node: n.id, field: k, value: v }]);
  const rec = m.rec?.[n.id] as Record<string, unknown> | undefined;
  return (
    <>
      <div className="cap">Expected output</div>
      <div className="field">
        <span className="small">Should it run here?</span>
        <div className="seg" data-f="run">
          {(
            [
              ["as main", "Don't check"],
              ["must", "Yes, must run"],
              ["must not", "No, must not run"],
            ] as const
          ).map(([v, t]) => (
            <button key={v} className={(l.run || "as main") === v ? "on" : ""} data-v={v} onClick={() => field("run", v === "as main" || l.run === v ? null : v)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      {!ran && !l.run ? <div className="note">{n.label} didn't run on this message on main. Leave it, or pick "Yes, must run" if it should have.</div> : null}
      {l.run === "must not" ? null : (
        <>
          {Object.entries(f.picks).map(([k, opts]) => (
            <div className="field" key={k}>
              <span className="mono">{k}</span>
              <div className="seg" data-f={k}>
                {[...opts, "any"].map((v) => (
                  <button key={v} className={l[k] === v ? "on" : ""} data-v={v} onClick={() => field(k, l[k] === v ? null : v)}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {f.texts.map((k) => (
            <div className="field" key={k}>
              <span className="mono">{k}</span>
              <input className="txtf" data-f={k} key={m.id + k + String(l[k] ?? "")} defaultValue={(l[k] as string) || ""} placeholder="what it should say" onBlur={(e) => e.target.value.trim() !== ((l[k] as string) || "") && field(k, e.target.value.trim() || null)} />
            </div>
          ))}
          {f.lines ? (
            <>
              <Lines c={c} m={m} n={n} k="must" word="Must" l={l} />
              <Lines c={c} m={m} n={n} k="never" word="Never" l={l} />
            </>
          ) : null}
          <button className="btn sm" id="starNode" style={{ alignSelf: "flex-start", ...(l.star ? { color: "var(--star)", borderColor: "var(--star)" } : {}) }} onClick={() => field("star", l.star ? null : true)}>
            {l.star ? "★ Unit test for " + n.label : "☆ Make this a unit test for " + n.label}
          </button>
          <div className="muted small">{l.star ? "Runs on every change: this node, given everything above this message." : "Not a unit test: kept as a label, checked in the nightly sweep."}</div>
        </>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn sm" id="runNode" disabled={!l.star || c.set === "test"} title={c.set === "test" ? "The Test set runs only in the locked eval service" : l.star ? `Runs ${n.label}'s unit tests across the Dev set on GitHub` : "Star it first: a run checks unit tests"} onClick={() => void runIt("node", { nodeId: n.id })}>
          ▶ Run node
        </button>
        <button className="btn sm ghost" id="recNode" title="What main's recorded run of this step gave on this message" onClick={() => setShown(m.id + n.id)}>
          Recorded on main
        </button>
        {Object.keys(l).length ? (
          <button className="btn sm ghost" id="clearLabel" onClick={() => change(c.id, [{ op: "label", msg: m.id, node: n.id, value: null }])}>
            Clear label
          </button>
        ) : null}
      </div>
      <div id="runOut">
        {shown === m.id + n.id ? (
          rec ? (
            <div className="note" style={{ marginTop: 6 }}>
              <b>Main says:</b> {Object.entries(rec).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ")} <span className="muted">(recorded run)</span>{" "}
              <button
                className="btn sm ghost"
                id="useIt"
                onClick={() => {
                  const keep = Object.entries(rec).filter(([k, v]) => (f.picks[k]?.includes(String(v)) || f.texts.includes(k)) && typeof v !== "object");
                  if (keep.length) change(c.id, keep.map(([k, v]) => ({ op: "field" as const, msg: m.id, node: n.id, field: k, value: String(v) })));
                }}
              >
                Use as label
              </button>
            </div>
          ) : (
            <div className="note" style={{ marginTop: 6 }}>
              No recorded run of {n.label} on this message yet: the next recording on main fills it in.
            </div>
          )
        ) : null}
      </div>
    </>
  );
}

function TexReply({ c, m, i }: { c: Conversation; m: Message; i: number }) {
  return (
    <div className="insp">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="cap">Tex reply · message {i + 1}</div>
      </div>
      <div className="muted small">
        Input: the {i} message{i === 1 ? "" : "s"} before it, the members and the date.
      </div>
      <div className="cap">Expected reply</div>
      <textarea id="gold" key={m.id + m.text} aria-label="Expected reply" defaultValue={m.text} onBlur={(e) => e.target.value.trim() !== m.text && change(c.id, [{ op: "edit", msg: m.id, field: "text", value: e.target.value.trim() }])} />
      <div className="muted small">Edit it to what Tex should have said; later rows see it as history. If Tex should stay quiet here, delete this row: no Tex row after a message means quiet.</div>
    </div>
  );
}

export function Inspector({ c }: { c: Conversation | null }) {
  const s = useSets();
  const m = c?.msgs.find((x) => x.id === s.msg);
  let body: React.ReactNode;
  if (!c || !m) {
    body = (
      <div className="insp">
        <div className="cap">Labels</div>
        <div className="note">Click a cell. A node's cell on a person's message is that node's expected output there; star it to make that message × node a unit test. A Tex row is what Tex should have said, kept as history for later rows.</div>
        {c ? (
          <>
            <div className="cap">This chat</div>
            <div>
              ★ {starsIn(c)} unit tests · {c.msgs.reduce((a, x) => a + labelCount(x), 0)} labels · {c.msgs.filter((x) => x.tex).length} Tex replies as context
            </div>
          </>
        ) : null}
        <div className="note">Tex replies are history, not tests. A nightly end-to-end sweep replays whole turns against them and lists misses, so you can find and label the node that caused each one.</div>
      </div>
    );
  } else {
    const i = c.msgs.indexOf(m);
    const n = G().nodes.find((x) => x.id === s.col && s.col !== "who" && s.col !== "text");
    if (m.tex) body = <TexReply c={c} m={m} i={i} />;
    else if (n)
      body = (
        <div className="insp">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div className="cap">
              {n.label} · message {i + 1}
            </div>
            <a className="btn sm" style={{ marginLeft: "auto" }} href={`/lab?node=${encodeURIComponent(n.id)}`} target="_blank" rel="noopener" title={`Opens ${n.label} in the Lab in a new tab: model, effort, prompt modules, input and output shapes`}>
              Node settings ↗
            </a>
          </div>
          <div className="quote">
            <span className="muted small">
              #{i + 1} · {m.who}
            </span>
            <div>{m.text}</div>
          </div>
          <Input c={c} i={i} n={n} />
          <LabelForm c={c} m={m} n={n} />
        </div>
      );
    else {
      const nl = labelCount(m);
      const ns = nodeStars(m);
      body = (
        <div className="insp">
          <div className="cap">Message {i + 1}</div>
          <div className="field">
            <span className="small">Speaker</span>
            <SpeakerPick key={m.id + m.who} c={c} m={m} cls="" id="inWho" />
          </div>
          <div className="field">
            <span className="small">Message</span>
            <div className="inmsg">
              <MsgFields key={m.id + (m.kind || "") + m.text} c={c} m={m} cls="insf" />
            </div>
          </div>
          <div className="muted small">
            Input: the {i} message{i === 1 ? "" : "s"} before it, the members and the date.
          </div>
          <div className="muted small">
            {nl} label{nl === 1 ? "" : "s"} · ★ {ns} unit test{ns === 1 ? "" : "s"} on this message. Click a node's cell to label it.
          </div>
        </div>
      );
    }
  }
  return (
    <div className="panel">
      <div className="scroll" id="insp">
        {body}
      </div>
    </div>
  );
}
