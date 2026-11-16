/**
 * The details panel, simplified (Dev2, 2026-11-16, approved mockup https://claude.ai/artifact/PUjJ7Vd6tX6BJj7vkEir1T):
 * open only while a step's cell is picked. It shows the message, what the step should give there (should it run,
 * its picks, its lines), the unit-test star, and, folded away, exactly what the config hands the step there.
 */
import { useState } from "react";
import { G, lab } from "../../engine/state";
import { labelFields, modValue, ranOn, wiresIn, type Conversation, type Label, type Message } from "../../engine/sets";
import { change, setUi, useSets } from "../../engine/setsStore";
import type { LabNode } from "../../types";
import { Close } from "./Menu.web";

const NOTES: Record<string, string> = { reviewer: "Its output is the turn report; sentBack is how many times it sent the draft back.", fd: "Its output is the turn report; it is labelled by must and never lines about its draft." };

function Reads({ c, i, n }: { c: Conversation; i: number; n: LabNode }) {
  const s = useSets();
  const g = G();
  const m = c.msgs[i];
  const wires = wiresIn(n, m, g);
  const l: Label = m.labels?.[n.id] || {};
  const f = labelFields(n);
  const rec = m.rec?.[n.id] as Record<string, unknown> | undefined;
  return (
    <details className="inbox" id="reads">
      <summary>What {n.label} reads here</summary>
      <div className="in">
      <div className="small muted">from texConfig.json on {lab.cur.name}</div>
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
      <div className="cap">Main gave</div>
      {rec ? (
        <div className="small" id="recNode">
          {Object.entries(rec).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ")} <span className="muted">(recorded run)</span>{" "}
          <button
            className="btn sm ghost"
            id="useIt"
            onClick={() => {
              const keep = Object.entries(rec).filter(([k, v]) => (f.picks[k]?.includes(String(v)) || f.texts.includes(k)) && typeof v !== "object" && l[k] !== String(v));
              if (keep.length) change(c.id, keep.map(([k, v]) => ({ op: "field" as const, msg: m.id, node: n.id, field: k, value: String(v) })));
            }}
          >
            Use as label
          </button>
        </div>
      ) : (
        <div className="small muted">No recorded run of {n.label} on this message yet.</div>
      )}
      <a href={`/lab?node=${encodeURIComponent(n.id)}`} target="_blank" rel="noopener" id="nodeLink">
        Open {n.label} in the Lab ↗
      </a>
      </div>
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
  const l: Label = m.labels?.[n.id] || {};
  const f = labelFields(n);
  const ran = ranOn(m, n.id);
  const field = (k: string, v: unknown) => change(c.id, [{ op: "field", msg: m.id, node: n.id, field: k, value: v }]);
  return (
    <>
      <div className="ts-cap">Expected</div>
      <div className="ts-row">
        <label>Runs?</label>
        <div className="seg2" data-f="run">
          {(
            [
              ["as main", "Any"],
              ["must", "Must"],
              ["must not", "Must not"],
            ] as const
          ).map(([v, t]) => (
            <button key={v} aria-pressed={(l.run || "as main") === v} data-v={v} title={v === "as main" ? "Don't check whether it runs" : v === "must" ? "It must run on this message" : "It must not run on this message"} onClick={() => field("run", v === "as main" || l.run === v ? null : v)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      {!ran && !l.run ? <div className="small muted">Didn't run here on main.</div> : null}
      {l.run === "must not" ? null : (
        <>
          {Object.entries(f.picks).map(([k, opts]) => (
            <div className="ts-row" key={k}>
              <label title={k}>{k}</label>
              <div className="seg2" data-f={k}>
                {[...opts, "any"].map((v) => (
                  <button key={v} aria-pressed={l[k] === v} data-v={v} onClick={() => field(k, l[k] === v ? null : v)}>
                    {v}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {f.texts.map((k) => (
            <div className="ts-row" key={k}>
              <label title={k}>{k}</label>
              <input data-f={k} key={m.id + k + String(l[k] ?? "")} defaultValue={(l[k] as string) || ""} placeholder={k === "why" ? "optional" : "what it should say"} onBlur={(e) => e.target.value.trim() !== ((l[k] as string) || "") && field(k, e.target.value.trim() || null)} />
            </div>
          ))}
          {f.lines ? (
            <>
              <Lines c={c} m={m} n={n} k="must" word="Must" l={l} />
              <Lines c={c} m={m} n={n} k="never" word="Never" l={l} />
            </>
          ) : null}
          <button className={"ts-ghost" + (l.star ? " on" : "")} id="starNode" title={l.star ? "A unit test: runs on every change, given everything above this message" : "Kept as a label, checked in the nightly sweep"} onClick={() => field("star", l.star ? null : true)}>
            {l.star ? "★ Unit test" : "☆ Make it a unit test"}
          </button>
        </>
      )}
    </>
  );
}

export function Inspector({ c }: { c: Conversation }) {
  const s = useSets();
  const m = c.msgs.find((x) => x.id === s.msg);
  const n = G().nodes.find((x) => x.id === s.col && s.col !== "who" && s.col !== "text");
  if (!m || !n || m.tex) return null;
  const i = c.msgs.indexOf(m);
  return (
    <>
      <div className="ts-dh">
        <b id="inspTitle">
          {n.label} · #{i + 1}
        </b>
        <span className="sp" />
        <button className="ib" id="closeInsp" title="Close" aria-label="Close details" onClick={() => setUi({ msg: null, col: null, editing: false })}>
          <Close />
        </button>
      </div>
      <div className="ts-db" id="insp">
        <div className="quote">
          <small>{m.who}</small>
          <div>{m.text || <span className="muted">(no words)</span>}</div>
        </div>
        <LabelForm c={c} m={m} n={n} />
        <Reads c={c} i={i} n={n} />
      </div>
    </>
  );
}
