/**
 * The canvas's run pill (Lab live sandbox, approved mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): at the
 * canvas's top left, ahead of the change legend in the same row, it says which run the canvas shows and how far it is.
 * While the dock plays or shows a run on the Timeline, that run: Tex's text with the steps that led to it, a real text
 * replayed as it ran in prod, a live text watched at the Lab's speed, or a playback. Otherwise the text the canvas
 * lights (the one picked, the one running, else the newest test text): live with what runs now, or done with its time,
 * steps and cost.
 */
import { stepCount, stepsWord, type PlayRun } from "../../engine/playRun";
import { useSandbox, type SandboxRow } from "../../engine/sandbox";
import { runOf, usePlay } from "../../engine/sandboxPlay";
import { node } from "../../engine/state";
import { useLab } from "../../store";
import { msWords } from "../grid/TextGrid.web";

const fmt = (ms: number) => msWords(Math.max(0, ms));
const SPEED: Record<number, string> = { 0.25: "¼×", 0.5: "½×", 1: "real time", 2: "2×", 4: "4×" };
/** When a real text ran, as the Timeline's head says it ("Sat 9:02 PM"). */
export const ranWhen = (at: number) => new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The text the canvas lights while nothing plays: the one picked, the one running, else the newest test text that ran. */
export function litTextId(rows: SandboxRow[], running: string | null, picked: string | null): string | null {
  if (picked) return picked;
  if (running) return running;
  return [...rows].reverse().find((x) => !x.prod && !x.tex && x.steps?.length)?.id ?? null;
}

/** The pill's words for a run not being played: live with what runs now, or done. */
export function restingWords(run: PlayRun, n: number): string {
  if (run.running) {
    const now = run.steps.filter((x) => x.ms === undefined).map((x) => node(x.node)?.label ?? x.node);
    return `Live · text ${n} · ${fmt(run.total)} · ${now.length ? now.join(", ") : "between steps"}`;
  }
  const cost = run.steps.reduce((a, x) => a + (x.cost ?? 0), 0);
  return `Text ${n} · done in ${fmt(run.total)} · ${stepsWord(stepCount(run))} · $${cost.toFixed(3)}`;
}

export function RunPill() {
  const { play, pick, view } = usePlay();
  const sb = useSandbox();
  const s = useLab();
  const n = (id: string) => sb.rows.findIndex((r) => r.id === id) + 1;
  const shown = play && (play.playing || view === "timeline") ? runOf(play.id) : null;
  if (!shown || !play) {
    const id = litTextId(sb.rows, sb.running, pick?.msgId ?? null);
    const run = id ? runOf(id) : null;
    if (!id || !run) return null;
    const words = restingWords(run, n(id));
    return (
      <div className="float runpill" id="runPill" title={words}>
        {run.running ? (
          <>
            <b>Live</b>
            {words.slice(4)}
          </>
        ) : (
          words
        )}
      </div>
    );
  }
  const run = shown;
  let body;
  if (run.of) {
    const tex = run.id.slice(run.id.indexOf("#") + 1);
    const t0 = run.steps.length ? Math.min(...run.steps.map((x) => x.at)) : 0;
    body = (
      <>
        <span className="rp">Tex's text {n(tex)}</span> · the {stepsWord(stepCount(run))} that led to it{run.prod ? ", as they ran in prod" : ""} · {fmt(play.t - t0)} of {fmt(run.total - t0)}
      </>
    );
  } else if (run.prod)
    body = (
      <>
        <span className="rp">Replay</span> · text {n(run.id)} on Tex as it was {ranWhen(run.prod.at)}: its graph, its steps, only what was logged
      </>
    );
  else if (run.running && play.playing)
    body = (
      <>
        <b>Live</b> · text {n(run.id)} · watching at {SPEED[s.speed] ?? `${s.speed}×`} · {fmt(play.t)}
      </>
    );
  else
    body = (
      <>
        <span className="rp">Playback</span> · text {n(run.id)} · {fmt(play.t)} of {fmt(run.total)}
      </>
    );
  return (
    <div className="float runpill" id="runPill">
      {body}
    </div>
  );
}
