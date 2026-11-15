/**
 * The test-case pieces of the Lab's Tests page, ported from the artifact's
 * `modName`, `caseFit`, `ioPanel`, `whoPanel`, `bub`, `caseThread` and
 * `caseWant` (the "test cases" section of the Tex Architecture Lab artifact).
 */
import { Fragment } from "react";
import { G, MODELS, emit } from "../../engine/state";
import { fmtS, fmtUsd } from "../../engine/sim";
import { ScnOptions } from "../parts";
import { Ic } from "../ic";
import type { LabCase } from "../../types";
import { caseWant, ioInfo, whoInfo } from "./caseInfo";

export { caseFit, modName } from "./caseInfo";

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
  const w = caseWant(c, !!ed);
  if (w.musts)
    return (
      <div className="want">
        <span className="wl">{w.want}</span>
        <div>
          {w.musts.map((m, i) => (
            <div key={i} className="mi ok">
              {m}
            </div>
          ))}
          {(w.nots || []).map((m, i) => (
            <div key={`n${i}`} className="mi no">
              never {m}
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <div className="want">
      <span className="wl">{w.want}</span>
      <div className="flex" style={{ gap: 6 }}>
        <span className={`pill ${w.tone}`}>{w.expect}</span>
        {w.field ? (
          <span className="ioc o">
            {w.field} = {w.value}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The area's test panel (`ioPanel`): for an integration area, the traced moment and its path; for a unit area, what goes in, the step and the check. */
export function IoPanel({ area }: { area: string }) {
  const info = ioInfo(area, G(), pipeScn);
  if (!info) return null;
  const n = info.step;
  const m = info.model;

  if (info.int) {
    const { sim } = info;
    return (
      <div className="iop">
        <div className="ior">
          <span className="iol">Test</span>
          <select id="intScn" aria-label="Test" style={{ maxWidth: 420 }} value={info.test} onChange={(e) => { setPipeScn(e.target.value); emit(); }}>
            <ScnOptions only={area} />
          </select>
          <span className="hint" style={{ fontSize: 12 }}>
            {fmtS(sim.reply)} to the reply · {fmtUsd(sim.usd)}
          </span>
        </div>
        <div className="ior">
          <span className="iol">Path</span>
          <div className="ipath">
            {info.path.map((x, i) => {
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
          <span className="ioc o">{info.check}</span>
          <span className="hint" style={{ fontSize: 12 }}>
            {info.how}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="iop">
      <div className="ior">
        <span className="iol">In</span>
        {info.chips.map((c, i) => (
          <span key={i} className={`ioc ${c.cls}`}>
            {c.name}
          </span>
        ))}
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
        <span className="ioc o">{info.check}</span>
        <span className="hint" style={{ fontSize: 12 }}>
          {info.how}
        </span>
      </div>
      <div className="iok hint">
        <span>
          <i className="ioc g"></i>the case gives it
        </span>
        {info.fixture ? (
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
  const w = whoInfo(area, inArea);
  if (!w) return null;
  return (
    <div className="who">
      <div className="wp">
        <span className="av">
          <Ic k={w.icon} style={{ width: 16, height: 16 }} />
        </span>
        <div>
          <b>{w.how}</b>
          <div className="hint">
            No workspace{area === "respond" ? ` · ${w.groups} group chats · ${w.ones} 1:1` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
