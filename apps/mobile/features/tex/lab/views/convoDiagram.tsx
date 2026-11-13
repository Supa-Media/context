/**
 * The Conversations view's picture of who writes a chat and what reads it
 * (the artifact's `cvDiagram`): the same 980 x 330 drawing, boxes and arrows,
 * with the texts that follow the settings. Pure: it draws from `c` alone.
 */
import type { ConvoSettings } from "../types";

type Pair = [string, string];

function Box({ x, y, w, h, t, sub, cls = "" }: { x: number; y: number; w: number; h: number; t: string; sub?: string; cls?: string }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect className={`cvb ${cls}`} width={w} height={h} rx={10} />
      <text className="cvt" x={12} y={22}>
        {t}
      </text>
      {sub ? (
        <text className="cvs" x={12} y={40}>
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Arr({ x1, y1, x2, y2, cls = "" }: { x1: number; y1: number; x2: number; y2: number; cls?: string }) {
  const mx = (x1 + x2) / 2;
  return <path className={`cva ${cls}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} markerEnd="url(#cvm)" />;
}

export function ConvoDiagram({ c }: { c: ConvoSettings }) {
  const W: Pair[] = [
    ["Worker", "texts in, parts out"],
    ["Front door turn", "thinking, tools, reply"],
    ["Reviewer · advisor", "judge, advisor"],
    ["Jobs · routines", "job, note"],
    ["Nightly", "day"],
  ];
  const V: Pair[] = [
    ["Prompt: last " + c.word + " h", "word for word, tagged by thread"],
    ["Prompt: threads", c.threads + " listed, open first"],
    ["Prompt: older", "up to " + Math.round(c.older / 1000) + "k chars, " + c.days + " day sums"],
    ["Tools", "read_thread, earlier_*"],
    ["History file", "read only, exported"],
  ];
  return (
    <svg viewBox="0 0 980 330" className="cvsvg" role="img" aria-label="Who writes a chat and what reads it">
      <defs>
        <marker id="cvm" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto">
          <path d="M0,1L9,5L0,9z" fill="var(--muted)" />
        </marker>
      </defs>
      {W.map(([t, s2], i) => (
        <g key={"w" + i}>
          <Box x={10} y={10 + i * 64} w={200} h={50} t={t} sub={s2} />
          <Arr x1={210} y1={35 + i * 64} x2={360} y2={120} />
        </g>
      ))}
      <Box x={370} y={70} w={240} h={110} t="Chat ledger" sub="append only · one per chat" cls="core" />
      <text className="cvs" x={382} y={140}>
        1:1: the person's workspace object
      </text>
      <text className="cvs" x={382} y={158}>
        group: the chat's own Tex object
      </text>
      <Box x={370} y={214} w={240} h={50} t="Threads ledger" sub="index, rebuilt from the ledger" cls="idx" />
      <Arr x1={490} y1={180} x2={490} y2={214} cls="dash" />
      <text className="cvs" x={500} y={202}>
        {"Classifier · " + (c.classify === "after" ? "after the reply" : "before the reply")}
      </text>
      <Box x={370} y={280} w={240} h={40} t="Worker outbox" sub="not yet in the ledger, ≤1 day" cls="tmp" />
      <path className="cva dash" d="M490,280 L490,264" />
      {V.map(([t, s2], i) => (
        <g key={"v" + i}>
          <Arr x1={610} y1={i === 1 ? 239 : 125} x2={760} y2={35 + i * 64} />
          <Box x={770} y={10 + i * 64} w={200} h={50} t={t} sub={s2} cls="view" />
        </g>
      ))}
    </svg>
  );
}
