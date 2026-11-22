/**
 * The test chat's Timeline (Lab live sandbox, approved by Dev2 2026-11-16, mockup
 * https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): in the dock's own space, instead of the grid, the run at the
 * head (`engine/sandboxPlay.ts`) as one row per step with a row of Tex's texts delivered and a red playhead. Rows are
 * as tall as the dock lets them be: 20px with names, 12px, or packed, where steps that never overlap share a row and
 * carry their name inside the bar when it fits. A text still running draws only what has started, on a scale that
 * grows with it, and its clock says how far behind live the playback is.
 */
import { isLineStep, lineLabel } from "../../engine/lineSteps";
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent } from "react";
import { stepCount, stepsWord, type PlayRun, type PlayStep } from "../../engine/playRun";
import { densityFor, packSteps, runStart, texCauseRun, trackOrder } from "../../engine/sandboxRun";
import { timeMap } from "../../engine/timeMap";
import { useSandbox } from "../../engine/sandbox";
import { externalRuns, playTexText, runOf, seek, showRun, togglePlay, usePlay, type DockView } from "../../engine/sandboxPlay";
import { node, set } from "../../engine/state";
import { useLab } from "../../store";
import { ranWhen } from "./RunPill.web";
import { msWords } from "../grid/TextGrid.web";

const NAME_W = 118 + 8;
const fmt = (ms: number) => msWords(Math.max(0, ms));
const labelOf = (id: string) => (isLineStep(id) ? lineLabel(id) : (node(id)?.label ?? id));

/** Grid | Timeline, in the dock's head. */
export function DockSwitch({ view, onView }: { view: DockView; onView: (v: DockView) => void }) {
  return (
    <div className="dockseg" role="group" aria-label="Show as" id="sbView">
      <button type="button" data-v="grid" aria-pressed={view === "grid"} onClick={() => onView("grid")}>
        Grid
      </button>
      <button type="button" data-v="timeline" aria-pressed={view === "timeline"} title="Timeline (T)" onClick={() => onView("timeline")}>
        Timeline
      </button>
    </div>
  );
}

/** Every text with a run, numbered as the grid numbers it: your texts, and Tex's texts whose steps were logged. */
function useRunTexts(): Array<{ value: string; label: string }> {
  const sb = useSandbox();
  const out: Array<{ value: string; label: string }> = [];
  const real = externalRuns();
  sb.rows.forEach((r, i) => {
    const short = (r.text || (r.pics?.length ? "a picture" : "")).slice(0, 40);
    // A real text played from production's log.
    const prod = r.prod ? real.find((x) => x.id === r.id || x.id.endsWith("#" + r.id)) : undefined;
    if (prod) out.push({ value: prod.id, label: `Text ${i + 1} · ${r.tex ? "Tex: " : ""}${short}` });
    else if (r.prod) return;
    else if (!r.tex && (r.steps?.length || sb.running === r.id)) out.push({ value: r.id, label: `Text ${i + 1} · ${short}` });
    else if (r.tex) {
      const run = texCauseRun(r.id, sb.rows);
      if (run) out.push({ value: run.id, label: `Text ${i + 1} · Tex: ${short}` });
    }
  });
  return out;
}

function kindOf(r: PlayRun) {
  if (r.of) return <span className="k of"> · {stepsWord(stepCount(r))} that led to it{r.prod ? ", ran in prod" : ""}</span>;
  if (r.prod) return <span className="k prod"> · ran in prod, {ranWhen(r.prod.at)}</span>;
  return <span className="k"> · test chat</span>;
}

export function SandboxTimeline() {
  const { play } = usePlay();
  useSandbox();
  const s = useLab();
  const texts = useRunTexts();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ h: 400, w: 600 });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize({ h: el.clientHeight, w: el.clientWidth }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const run = play ? runOf(play.id) : null;
  const t = play?.t ?? 0;
  const live = !!run?.running && !run.of;
  const upTo = run ? (live || play?.playing ? t : run.total) : 0;
  const map = run ? timeMap(run, t, live) : null;
  const scale = map?.span ?? 1;
  /** Where a time sits on the lane: long stretches where nothing ran are folded (engine/timeMap.ts). */
  const frac = (v: number) => (map ? map.x(v) : 0);
  const at = (v: number) => `${(frac(v) * 100).toFixed(3)}%`;
  const shown = run ? run.steps.filter((x) => x.at <= upTo) : [];
  const order = run ? trackOrder(run) : [];
  const delivered = run ? run.texts.filter((x) => x.at <= upTo) : [];
  const density = densityFor(size.h - 10, order.length + (run?.texts.length ? 1 : 0));
  const selId = s.sel?.t === "node" ? s.sel.id : null;
  const width = (x: PlayStep) => Math.max(0, Math.min(x.ms ?? upTo - x.at, upTo - x.at));
  const barStyle = (x: PlayStep) => ({ left: at(x.at), width: `${((frac(x.at + width(x)) - frac(x.at)) * 100).toFixed(3)}%` });

  /** A click on a track: the head goes there and the step is picked (and pinned) in the node panel. */
  const onTrack = (e: RMouseEvent<HTMLElement>, id: string | null) => {
    const lane = e.currentTarget.closest(".sbtrk")?.querySelector<HTMLElement>(".sblane");
    if (!lane) return;
    const b = lane.getBoundingClientRect();
    if (b.width > 0 && e.clientX >= b.left) seek(map ? map.at((e.clientX - b.left) / b.width) : 0);
    if (id) set({ sel: { t: "node", id }, pin: true });
  };

  const time = !run ? "" : live ? fmt(t) + (run.total - t > 300 ? ` · ${fmt(run.total - t)} behind live` : " · live") : run.of ? `${fmt(t - runStart(run))} / ${fmt(run.total - runStart(run))}` : `${fmt(t)} / ${fmt(run.total)}`;
  const lanePx = Math.max(200, size.w - 28 - (density === "packed" ? 0 : NAME_W));

  return (
    <div className="sbtl" id="sbTimeline" aria-label="Timeline">
      <div className="sbtlh">
        <button className="ib" id="sbtlPlay" aria-label={play?.playing ? "Pause" : "Play"} disabled={!run} onClick={togglePlay}>
          <svg className="i" viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: play?.playing ? '<path d="M8 5v14M16 5v14"/>' : '<path d="M8 5l11 7-11 7z"/>' }} />
        </button>
        <select
          id="sbtlPick"
          aria-label="Which text"
          value={run?.id ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes("#") || externalRuns().some((x) => x.id === v)) playTexText(v);
            else showRun(v);
          }}
        >
          {run ? null : <option value="">No text yet</option>}
          {texts.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
        <span id="sbtlKind">{run ? kindOf(run) : null}</span>
        <input id="sbtlScrub" type="range" min={0} max={1000} step={1} value={run ? Math.round(frac(t) * 1000) : 0} aria-label="Scrub the timeline" disabled={!run} onChange={(e) => seek(map ? map.at(Number(e.target.value) / 1000) : 0)} />
        <span className="t" id="sbtlTime">
          {time}
        </span>
      </div>
      <div className={"sbtracks" + (density === "full" ? "" : " " + density)} ref={box} data-density={density}>
        {!run ? (
          <div className="scne">Send a text, or press ▶ on one, to see its steps here.</div>
        ) : (
          <div className="sbtin">
            {density === "packed"
              ? packSteps(shown, (6 / lanePx) * scale, upTo).map((rowSteps, i) => (
                  <div key={i} className="sbtrk" data-row={i} onClick={(e) => onTrack(e, null)}>
                    <div className="sblane">
                      {rowSteps.map((x) => {
                        const name = labelOf(x.node);
                        const px = (frac(x.at + width(x)) - frac(x.at)) * lanePx;
                        return (
                          <span
                            key={x.id}
                            className={"sbtb" + (selId === x.node ? " selb" : "") + (x.ok ? "" : " bad")}
                            data-n={x.node}
                            style={barStyle(x)}
                            title={`${name} · ${x.ms === undefined ? "running" : fmt(x.ms)}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onTrack(e, x.node);
                            }}
                          >
                            {px >= name.length * 5.5 + 8 ? name : ""}
                          </span>
                        );
                      })}
                      {i === 0 ? delivered.map((m) => <span key={m.rowId} className="sbtb msg" data-text={m.rowId} style={{ left: at(m.at) }} title="Text delivered" />) : null}
                    </div>
                  </div>
                ))
              : order.map((id) => {
                  const bars = shown.filter((x) => x.node === id);
                  return (
                    <div key={id} className={"sbtrk" + (selId === id ? " sel" : "")} data-n={id} hidden={!bars.length} onClick={(e) => onTrack(e, id)}>
                      <span className="nm" title={labelOf(id)}>
                        {labelOf(id)}
                      </span>
                      <div className="sblane">
                        {bars.map((x) => (
                          <span key={x.id} className={"sbtb" + (x.ok ? "" : " bad")} style={barStyle(x)} title={x.ms === undefined ? "running" : fmt(x.ms)} />
                        ))}
                      </div>
                    </div>
                  );
                })}
            {density !== "packed" && run.texts.length ? (
              <div className="sbtrk dlv" hidden={!delivered.length}>
                <span className="nm">Texts delivered</span>
                <div className="sblane">
                  {delivered.map((m) => (
                    <span key={m.rowId} className="sbtb msg" data-text={m.rowId} style={{ left: at(m.at) }} title="Text delivered" />
                  ))}
                </div>
              </div>
            ) : null}
            {map?.gaps.map((g) => (
              <span key={g.from} className="sbgap" data-gap={Math.round(g.to - g.from)} style={{ left: `calc(${density === "packed" ? 0 : NAME_W}px + (100% - ${density === "packed" ? 0 : NAME_W}px) * ${g.x.toFixed(4)})`, width: `calc((100% - ${density === "packed" ? 0 : NAME_W}px) * ${(g.x2 - g.x).toFixed(4)})` }} title={`${fmt(g.to - g.from)} with nothing running`}>
                <i>{fmt(g.to - g.from)}</i>
              </span>
            ))}
            <span className="sbhead" id="sbtlHead" style={{ left: `calc(${density === "packed" ? 0 : NAME_W}px + (100% - ${density === "packed" ? 0 : NAME_W}px) * ${frac(t).toFixed(4)})` }} />
          </div>
        )}
      </div>
    </div>
  );
}

/** While one of Tex's texts plays, the steps that didn't lead to it fade on the canvas. */
export function DimOthers({ only }: { only: ReadonlySet<string> | null }) {
  if (!only?.size) return null;
  // Only the canvas's own step ids and the line's two (`lineDecor.ts`), so a step id from the gateway never becomes CSS of its own.
  const keep = [...only]
    .filter((id) => !!node(id) || isLineStep(id))
    .map((id) => (isLineStep(id) ? `:not([data-line="${id}"])` : `:not([data-id="${CSS_ESC(id)}"])`))
    .join("");
  if (!keep) return null;
  return <style>{`.tl .archcv.only .nd${keep}{opacity:.28}.tl .archcv.only .wire{opacity:.35}`}</style>;
}
const CSS_ESC = (s: string) => s.replace(/["\\]/g, "\\$&");

