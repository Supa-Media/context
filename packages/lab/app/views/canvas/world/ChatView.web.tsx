/**
 * The test chat's Chat view, as Messages shows a group chat (Dev, 2026-11-24, approved artboards 03 to 08 of
 * `group-chat-sim-artboards/`), in the dock in the grid's place: a centered column of runs of bubbles (whoever you
 * text as on the right, in blue), time and event lines, Tex typing with the step running, and under each person's
 * text the why line, which opens in place to the Triage and Decide steps with Play, Open in Grid and Retry. What it
 * draws is `chatModel.ts`'s; the Grid and the Timeline show the same rows.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { dropText, retryText, useSandbox } from "../../../engine/sandbox";
import { pickStep, playText, setDockView } from "../../../engine/sandboxPlay";
import { node } from "../../../engine/state";
import { msWords } from "../../grid/TextGrid.web";
import { BubbleView } from "./Bubble.web";
import { chatEntries, type Bubble, type ChatEntry, type Why } from "./chatModel";
import { Av } from "./parts.web";
import { firstName, type Account } from "./worldModel";
import { setFill, useWorld } from "./worldStore";
import { worldNow } from "./worldView";

const STEP_NODE = { Triage: "triage", Decide: "decide" } as const;

function WhyLine({ why, b, no, open, onToggle, guest }: { why: Why; b: Bubble; no?: number; open: boolean; onToggle: () => void; guest?: string }) {
  const r = b.row;
  const verdict = why.yes === null ? "Tex is deciding" : why.yes ? "Tex answers" : "Tex stays quiet";
  return (
    <>
      <button type="button" className={"wy " + (why.yes ? "yes" : "no")} aria-expanded={open} data-why={r.id} title={why.by ? `Decided at ${why.by}` : undefined} onClick={onToggle}>
        <span className="v">{verdict}</span>
        <span className="wyr">· {why.reason}</span> <span className="car2">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div className="whyx" id={"sbWhy-" + r.id}>
          <div className="wxh">
            <b>{why.yes === null ? "Tex is deciding" : why.yes ? "Why Tex answered" : "Why Tex stayed quiet"}</b> · {no ? `text ${no} · ` : ""}
            {firstName(r.who)}
            {guest ? ` (${guest})` : ""}
          </div>
          {why.steps.map((s) => (
            <div className="wxr" key={s.step}>
              <span className="wsn">{s.step}</span>
              <span className={"wso" + (s.out === "nothing" ? " no" : "")}>{s.out}</span>
              <span className="wms">{msWords(s.ms)}</span>
              <span className="wrs">{s.why ? (s.step === "Decide" ? `“${s.why}”` : s.why) : ""}</span>
            </div>
          ))}
          {!why.steps.length ? (
            <div className="wxr">
              <span className="wrs">No Triage or Decide step logged for this text.</span>
            </div>
          ) : null}
          <div className="wxf">
            <button
              className="ghost"
              onClick={() => {
                setFill(false);
                playText(r.id);
              }}
            >
              ▶ Play the steps
            </button>
            <button
              className="ghost"
              onClick={() => {
                setFill(false);
                setDockView("grid");
                pickStep(r.id, why.by ? STEP_NODE[why.by] : null);
              }}
            >
              Open in Grid
            </button>
            {!r.prod ? (
              <button className="ghost" onClick={() => void retryText(r.id)}>
                ⟲ Retry from here
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function Run({
  e,
  account,
  guest,
  names,
  onReply,
  openWhy,
  toggle,
  nos,
}: {
  e: Extract<ChatEntry, { t: "run" }>;
  account: (n: string) => Account;
  guest: (n: string) => string | undefined;
  names: string[];
  onReply: (id: string) => void;
  openWhy: Set<string>;
  toggle: (id: string) => void;
  /** Each row's number in the Grid, so the why detail names the same text. */
  nos: Map<string, number>;
}) {
  const acct: Account | "tex" = e.tex ? "tex" : account(e.who);
  const out: ReactNode[] = [];
  e.items.forEach((b, i) => {
    const first = i === 0;
    const last = i === e.items.length - 1;
    const raw = b.kind === "pics" || (b.kind === "media" && (b.media?.kind === "link" || b.media?.kind === "sticker"));
    if ((first || b.quote) && e.side === "in")
      out.push(
        <div className="nm2" key={b.id + "n"}>
          {e.tex ? "Tex" : firstName(e.who)}
          {acct === "off" ? <span className="gst"> · not on Context</span> : null}
        </div>,
      );
    if (b.quote)
      out.push(
        <div className={"thq " + e.side} key={b.id + "q"}>
          <span className="qb">
            {firstName(b.quote.who)}: {b.quote.text}
          </span>
          <span className="ln" />
        </div>,
      );
    out.push(
      <div className={["r", e.side, (first || b.quote) && e.side === "out" ? "first" : "", b.reactions?.length ? "tb" : ""].filter(Boolean).join(" ")} key={b.id}>
        <div className="avc">{last ? <Av name={e.who} account={acct} size={28} /> : null}</div>
        <div className="bc">
          <BubbleView b={b} tail={last && !raw} names={names} onReply={onReply} />
        </div>
      </div>,
    );
    const under = b.edited || b.status || b.note || b.why;
    if (under)
      out.push(
        <div className={"und " + e.side} key={b.id + "u"}>
          {b.edited ? <span className="edl">Edited</span> : null}
          {b.status ? <span className="st2">{b.status}</span> : null}
          {b.note ? <span className="typenote">{b.note}</span> : null}
          {b.why ? <WhyLine why={b.why} b={b} no={nos.get(b.row.id)} open={openWhy.has(b.row.id)} onToggle={() => toggle(b.row.id)} guest={guest(e.who)} /> : null}
        </div>,
      );
  });
  return <>{out}</>;
}

export function ChatView({ empty, onReply }: { empty: ReactNode; onReply: (id: string) => void }) {
  const sb = useSandbox();
  const w = useWorld();
  const [openWhy, setOpenWhy] = useState<Set<string>>(() => new Set());
  const isWorld = sb.source.kind === "world";
  const now = isWorld ? worldNow(sb, w) : null;
  const entries = chatEntries(sb.rows, {
    as: sb.as,
    running: sb.running,
    hotWords: sb.hot ? (node(sb.hot)?.label ?? sb.hot) : null,
    now: Date.now(),
    world: isWorld && w.opened ? { opened: w.opened, known: w.known, guest: now?.guest } : null,
  });
  const scroller = useRef<HTMLDivElement>(null);
  const lastKey = entries.length ? entries[entries.length - 1].key + ":" + (entries[entries.length - 1].t === "run" ? (entries[entries.length - 1] as { items: unknown[] }).items.length : 0) : "";
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [sb.id, lastKey]);
  const toggle = (id: string) =>
    setOpenWhy((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const account = (n: string): Account => (now ? now.account(n) : "on");
  const guest = (n: string) => now?.guest(n);
  const idle = !sb.running && !sb.busy;
  // The Grid's # for each row: every row but Tex's quiet turns, which it folds into the why line.
  const nos = new Map(sb.rows.filter((r) => !(isWorld && r.tex && r.quiet)).map((r, i) => [r.id, i + 1]));
  return (
    <div className="imsg" id="sbChatView" ref={scroller}>
      <div className="imw">
        {!sb.rows.length ? <div className="scne">{empty}</div> : null}
        {entries.map((e) => {
          if (e.t === "time")
            return (
              <div className="tm2" key={e.key}>
                {e.day ? <b>{e.day}</b> : null} {e.time}
              </div>
            );
          if (e.t === "event")
            return (
              <div key={e.key}>
                <div className={"ev" + (e.id ? "" : " mut")}>
                  {e.text}
                  {e.id && !e.row.prod ? (
                    <button className="evx" data-drop={e.id} title="Undo: delete this and everything after it" disabled={!idle} onClick={() => void dropText(e.id)}>
                      ⤺ Undo
                    </button>
                  ) : null}
                </div>
                {e.change ? <div className="evchg">{e.change.map((s, i) => (s.b ? <b key={i}>{s.t}</b> : <span key={i}>{s.t}</span>))}</div> : null}
              </div>
            );
          return <Run key={e.key} e={e} account={account} guest={guest} names={sb.people} onReply={onReply} openWhy={openWhy} toggle={toggle} nos={nos} />;
        })}
      </div>
    </div>
  );
}
