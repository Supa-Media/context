/**
 * The test-case pieces of the Lab's Tests page, ported from the artifact's
 * `modName`, `caseFit`, `ioPanel`, `whoPanel`, `bub`, `caseThread` and
 * `caseWant` (the "test cases" section of the Tex Architecture Lab artifact).
 */
import { Fragment } from "react";
import { AREA_INFO, AREA_IO, PEOPLE } from "../../data/areas";
import { MAIN, G, MODELS, emit, lab, node } from "../../engine/state";
import { mods } from "../../engine/modules";
import { SCENARIOS } from "../../engine/traces";
import { simulate, fmtS, fmtUsd } from "../../engine/sim";
import { ScnOptions } from "../parts";
import { Ic } from "../ic";
import type { LabCase, LabGraph, LabNode } from "../../types";

/** The pipe scenario the Test select shows (the artifact's `pipeScn`). */
let pipeScn: string | null = null;
export const getPipeScn = () => pipeScn;
export const setPipeScn = (v: string | null) => {
  pipeScn = v;
};

/** Extra fields some areas' cases carry (the artifact read them off the case directly). */
type CaseExtra = {
  msg?: { from: string; text: string };
  lines?: Array<{ from: string; text: string }>;
  earlier?: Array<{ text: string }>;
  did?: string[];
  reply?: string;
  about?: string;
  title?: string;
  path?: string;
  as?: string;
  chat?: string;
  must?: boolean;
  group?: string;
  musts?: string[];
  nots?: string[];
};
const ex = (c: LabCase) => c as LabCase & CaseExtra;

export function modName(k: string, g: LabGraph): string {
  return k.startsWith("out:") ? (node(k.slice(4), g)?.label || k) + "'s output" : mods(g)[k]?.name || k;
}

/** Why a case can't test this version the way it tests main: the step is gone or off, it no longer reads what the case gives, or the field the case checks is gone. */
export function caseFit(c: LabCase, g: LabGraph = G()): string[] {
  const I = AREA_INFO[c.area], io = AREA_IO[c.area];
  if (!I || !io) return [];
  const n = node(I.step, g);
  if (!n) return [`This version has no ${node(I.step, MAIN.graph)?.label || I.step}`];
  const w: string[] = [];
  if (!n.on && node(I.step, MAIN.graph)?.on) w.push(`${n.label} is off`);
  if (io.check.code) return w;
  const miss = io.gives.filter((k) => !n.ctx.includes(k));
  if (miss.length) w.push(`${n.label} no longer reads ${miss.map((k) => modName(k, g)).join(", ")}`);
  const sc = n.outSchema || [];
  if (io.check.field) {
    const f = sc.find((x) => x.name === io.check.field);
    const want = io.check.map ? io.check.map(c) : "";
    if (!f) w.push(`checks ${io.check.field}, which ${n.label} no longer answers`);
    else if (f.type === "choice" && f.options && !f.options.split(/\s*,\s*/).includes(want)) w.push(`expects ${io.check.field} = ${want}, not one of its options`);
  } else if (sc.length && !sc.some((x) => x.type === "text")) w.push(`checks words, but ${n.label} answers only typed fields`);
  return w;
}

/** A chat bubble (`bub`): who said it, the text, and the class the artifact gave it. */
function Bub({ who, text, cls = "" }: { who?: string; text: string; cls?: string }) {
  return (
    <div className={`bb ${cls}`}>
      {who ? <span className="bw">{who}</span> : null}
      {text}
    </div>
  );
}

const used = (did: string[] | undefined) =>
  did?.length ? (
    <div className="used">
      <Ic k="tools" style={{ width: 13, height: 13 }} />
      {did.join(" · ")}
    </div>
  ) : null;

/** The case's conversation (`caseThread`): what the step was shown, with the case's text as the new message. */
export function CaseThread({ c, ed }: { c: LabCase; ed?: LabCase }) {
  const x = ex(c);
  const A = ed ? c.ask : null;
  if (c.area === "respond") {
    const m = x.msg || { from: "", text: c.ask };
    return (
      <>
        {(x.lines || []).map((l, i) => (l.from === "You" ? <Bub key={i} who="Tex" text={l.text} cls="tex" /> : <Bub key={i} who={l.from} text={l.text} />))}
        <Bub who={m.from} text={A ?? m.text} cls="new" />
      </>
    );
  }
  if (c.area === "review")
    return (
      <>
        {(x.earlier || []).map((l, i) => (
          <div key={i} className="ctxl">
            {l.text}
          </div>
        ))}
        <Bub text={c.ask} />
        {used(x.did)}
        {x.reply ? <Bub who="Tex's draft" text={x.reply} cls="tex" /> : null}
      </>
    );
  if (c.area === "advisor-chat")
    return (
      <>
        {x.about ? <div className="ctxl">{x.about}</div> : null}
        <Bub text={c.ask} />
        {used(x.did)}
      </>
    );
  if (c.area === "advisor-job-check")
    return (
      <>
        <div className="ctxl">
          <Ic k="job" style={{ width: 13, height: 13 }} />
          {c.ask}
        </div>
        {used(x.did)}
        {x.reply ? <Bub who="The job's answer" text={x.reply} cls="tex" /> : null}
      </>
    );
  if (c.area === "advisor-job-mail")
    return (
      <>
        {x.title ? (
          <div className="ctxl">
            <Ic k="job" style={{ width: 13, height: 13 }} />
            {x.title}
          </div>
        ) : null}
        <Bub who="The job" text={c.ask} />
      </>
    );
  if (c.area === "pipeline")
    return (
      <>
        <div className="ctxl">
          <Ic k="text" style={{ width: 13, height: 13 }} />
          {x.path}
        </div>
        <Bub who="What went wrong" text={A ?? c.ask} />
      </>
    );
  if (c.area === "jobs")
    return (
      <>
        <Bub who={x.as || ""} text={c.ask} cls="new" />
        {x.title ? (
          <div className="used">
            <Ic k="job" style={{ width: 13, height: 13 }} />
            {x.title}
          </div>
        ) : null}
      </>
    );
  return <Bub who={x.as || ""} text={c.ask} cls="new" />;
}

/** What the case expects (`caseWant`): the musts for a core case, else the expected outcome and the field it checks. */
export function CaseWant({ c, ed }: { c: LabCase; ed?: LabCase }) {
  const x = ex(c);
  const I: { want?: string; how?: string } = AREA_INFO[c.area] || {};
  if (c.area === "core" && !ed && x.musts)
    return (
      <div className="want">
        <span className="wl">{I.want}</span>
        <div>
          {x.musts.map((m, i) => (
            <div key={i} className="mi ok">
              {m}
            </div>
          ))}
          {(x.nots || []).map((m, i) => (
            <div key={`n${i}`} className="mi no">
              never {m}
            </div>
          ))}
        </div>
      </div>
    );
  const q = /quiet|let it go|done$/i.test(c.expect) ? "ok" : /send it back|decline/i.test(c.expect) ? "bad" : "acc";
  const io = AREA_IO[c.area];
  return (
    <div className="want">
      <span className="wl">{I.want || "Should"}</span>
      <div className="flex" style={{ gap: 6 }}>
        <span className={`pill ${q}`}>{c.expect}</span>
        {io?.check.field ? (
          <span className="ioc o">
            {io.check.field} = {io.check.map ? io.check.map(c) : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The area's test panel (`ioPanel`): for an integration area, the traced moment and its path; for a unit area, what goes in, the step and the check. */
export function IoPanel({ area }: { area: string }) {
  const I = AREA_INFO[area], io = AREA_IO[area];
  if (!I || !io) return null;
  const g = G();
  const n = node(I.step, g) || node(I.step, MAIN.graph);
  if (!n) return null;
  const m = MODELS[n.model] || MODELS.code;

  if (I.int) {
    const pk = pipeScn && SCENARIOS[pipeScn]?.group === area ? pipeScn : Object.keys(SCENARIOS).find((k) => SCENARIOS[k].group === area) || "own";
    const sim = simulate(g, pk, lab.logRows);
    const order = Object.entries(sim.T)
      .sort((a, b) => a[1].start - b[1].start)
      .map(([id]) => node(id, g))
      .filter((x): x is LabNode => !!x);
    return (
      <div className="iop">
        <div className="ior">
          <span className="iol">Test</span>
          <select id="intScn" aria-label="Test" style={{ maxWidth: 420 }} value={pk} onChange={(e) => { setPipeScn(e.target.value); emit(); }}>
            <ScnOptions only={area} />
          </select>
          <span className="hint" style={{ fontSize: 12 }}>
            {fmtS(sim.reply)} to the reply · {fmtUsd(sim.usd)}
          </span>
        </div>
        <div className="ior">
          <span className="iol">Path</span>
          <div className="ipath">
            {order.map((x, i) => {
              const mm = MODELS[x.model] || MODELS.code;
              return (
                <Fragment key={x.id}>
                  {i > 0 ? <span className="arr">→</span> : null}
                  <span className="ioc s">
                    <Ic k={x.icon} style={{ width: 13, height: 13 }} />
                    {x.label}
                    <span style={{ color: `var(${mm.c})`, fontWeight: 400 }}>{mm.runs === "code" ? "code" : mm.name}</span>
                  </span>
                </Fragment>
              );
            })}
          </div>
        </div>
        <div className="ior">
          <span className="iol">Checks</span>
          <span className="ioc o">{io.check.code ? "code" : io.check.field || "words"}</span>
          <span className="hint" style={{ fontSize: 12 }}>
            {io.check.how}
          </span>
        </div>
      </div>
    );
  }

  const gives = new Set([...io.gives, ...(io.fixture || [])]);
  const rest = n.ctx.filter((k) => !gives.has(k));
  const chip = (k: string, cls: string) => (
    <span key={k} className={`ioc ${cls}`}>
      {modName(k, g)}
    </span>
  );
  return (
    <div className="iop">
      <div className="ior">
        <span className="iol">In</span>
        {io.gives.map((k) => chip(k, n.ctx.includes(k) ? "g" : "x"))}
        {(io.fixture || []).map((k) => chip(k, "f"))}
        {rest.map((k) => chip(k, "d"))}
      </div>
      <div className="ior">
        <span className="iol">Step</span>
        <span className="ioc s">
          <Ic k={n.icon} style={{ width: 13, height: 13 }} />
          {n.label} · <span style={{ color: `var(${m.c})` }}>{m.name}</span>
        </span>
      </div>
      <div className="ior">
        <span className="iol">Checks</span>
        {io.check.field ? <span className="ioc o">{io.check.field}</span> : <span className="ioc o">words</span>}
        <span className="hint" style={{ fontSize: 12 }}>
          {io.check.how}
        </span>
      </div>
      <div className="iok hint">
        <span>
          <i className="ioc g"></i>the case gives it
        </span>
        {io.fixture ? (
          <span>
            <i className="ioc f"></i>from Maya's workspace
          </span>
        ) : null}
        <span>
          <i className="ioc d"></i>the bench fills it
        </span>
        <span>
          <i className="ioc x"></i>the step no longer reads it
        </span>
      </div>
    </div>
  );
}

/** Who the area's cases are run as (`whoPanel`). An area with a person gets no panel. */
export function WhoPanel({ area, inArea }: { area: string; inArea: LabCase[] }) {
  const I: { as?: string; how?: string } = AREA_INFO[area] || {};
  if (I.as && PEOPLE[I.as]) return null;
  const groups = inArea.filter((c) => ex(c).chat === "group").length;
  const ones = inArea.filter((c) => ex(c).chat === "one").length;
  return (
    <div className="who">
      <div className="wp">
        <span className="av">
          <Ic k={node(AREA_INFO[area]?.step ?? "", MAIN.graph)?.icon || "judge"} style={{ width: 16, height: 16 }} />
        </span>
        <div>
          <b>{I.how || ""}</b>
          <div className="hint">
            No workspace{area === "respond" ? ` · ${groups} group chats · ${ones} 1:1` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
