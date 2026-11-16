/**
 * Replay's left column: the chats you can replay (your 1:1 and every group chat you're in) and the picked chat's
 * conversation as a grid of Speaker and Message, newest at the bottom. A click on any text someone sent replays from it:
 * the canvas and the timeline.
 */
import { useEffect, useRef } from "react";
import { LOGGED_FROM, QUIET_WORDS, startLabel, type Moment } from "../../engine/replay";
import { lab, set } from "../../engine/state";
import { pickChat, readMomentDetail, readMyTexts } from "../mine/useMine";
import { TextGrid, type TextRow } from "../grid/TextGrid.web";

const time = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const day = (at: number) => new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

export function openMoment(m: Moment) {
  set({ moment: m.id, sel: null });
  void readMomentDetail(m.at);
}

export function ReplaySide({ moments, onHide }: { moments: Moment[]; onHide?: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const chats = lab.myChats ?? [{ key: "me", name: "Just you and Tex" }];
  const newest = (moments.length ? moments[moments.length - 1].id : "") + "|" + lab.myChat;
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>("#replayGrid .scroll") || list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newest]);
  const group = lab.myChat !== "me";
  // Once the oldest text read is from before full logging, nothing older can be replayed: no Older button (no note either: Dev2, 2026-11-14, "No need for this text").
  const reachedStart = lab.myLines.length > 0 && lab.myLines[0].at < LOGGED_FROM;
  // The chat as it read, from when full logging began; each text someone sent replays from there.
  const lines = lab.myLines.filter((l) => l.at >= LOGGED_FROM);
  const byId = new Map(moments.map((m) => [m.id, m]));
  // A grid of Speaker and Message (Dev2, 2026-11-16: "just keep it on the left only showing speaker and message"), a line for each day.
  const rows: TextRow[] = [];
  let lastDay = "";
  for (const l of lines) {
    const d = day(l.at);
    if (d !== lastDay) rows.push({ id: "day:" + l.id, who: "", text: "", sep: d, day: true });
    lastDay = d;
    const m = byId.get(l.id);
    // Tex texting on its own says what started it: a check-in, a routine, another AI's ping.
    const who = l.start ? startLabel(l) : l.from === "tex" ? "Tex" : l.who || (group ? "" : "You");
    rows.push({
      id: l.id,
      who,
      text: l.quiet ? QUIET_WORDS : l.text,
      tex: l.from === "tex",
      whoCls: l.start ? "cds" : undefined,
      attrs: m ? { "data-moment": m.id, "aria-current": String(lab.moment === m.id) } : undefined,
      title: (m ? (l.start ? "Replay this run" : "Replay from this text") : l.start ? "Ran before its steps were logged, so it can't be walked through" : "") + " · " + time(l.at),
    });
  }
  return (
    <div className="rside" id="replaySide">
      <div className="rsideh">
      <select className="rchat" id="rChat" aria-label="Chat" value={lab.myChat} onChange={(e) => pickChat(e.target.value)}>
        {chats.map((c) => (
          <option key={c.key} value={c.key}>
            {(c.key === "me" ? "1:1 with Tex" : c.name) + (c.people ? ` · ${c.people} ${c.people === 1 ? "person" : "people"}` : "")}
          </option>
        ))}
      </select>
        {/* Hide the chats right beside them (Dev2, 2026-11-14: "the collapse button a little more conveniently placed"). */}
        {onHide ? (
          <button className="ib" id="rCollapse" aria-label="Hide your chats" title="Hide your chats" onClick={onHide}>
            <svg className="i" viewBox="0 0 24 24">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
        ) : null}
      </div>
      <div className="rmoments" ref={list}>
        {lab.myOlder !== null && !reachedStart && Array.isArray(lab.myTexts) ? (
          <button className="ghost cdo" id="rOlder" onClick={() => void readMyTexts(true)}>
            Older texts
          </button>
        ) : null}
        {lab.myTexts === null ? <div className="scne">Reading the chat…</div> : null}
        {lab.myTexts === "failed" ? <div className="scne">{"Couldn't read this chat"}</div> : null}
        {Array.isArray(lab.myTexts) && !moments.length && !reachedStart ? <div className="scne">No texts yet</div> : null}
        <TextGrid
          gridKey="replay"
          id="replayGrid"
          slim
          rows={rows}
          sel={lab.moment ? lines.find((l) => byId.get(l.id)?.id === lab.moment)?.id ?? null : null}
          onRow={(r) => {
            const m = byId.get(r.id);
            if (m) openMoment(m);
          }}
        />
      </div>
    </div>
  );
}
