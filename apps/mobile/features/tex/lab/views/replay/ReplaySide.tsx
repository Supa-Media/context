/**
 * Replay's left column: the chats you can replay (your 1:1 and every group chat you're in) and the picked chat's
 * conversation, newest at the bottom. A click on any text someone sent replays from it: the canvas and the timeline.
 */
import { useEffect, useRef } from "react";
import { LOGGED_FROM, type Moment } from "../../engine/replay";
import { lab, set } from "../../engine/state";
import { pickChat, readMomentDetail, readMyTexts } from "../mine/useMine";

const time = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const day = (at: number) => new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

export function openMoment(m: Moment) {
  set({ moment: m.id, sel: null });
  void readMomentDetail(m.at);
}

export function ReplaySide({ moments }: { moments: Moment[] }) {
  const list = useRef<HTMLDivElement>(null);
  const chats = lab.myChats ?? [{ key: "me", name: "Just you and Tex" }];
  const newest = (moments.length ? moments[moments.length - 1].id : "") + "|" + lab.myChat;
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newest]);
  const group = lab.myChat !== "me";
  // Once the oldest text read is from before full logging, nothing older can be replayed: no Older button, a note.
  const reachedStart = lab.myLines.length > 0 && lab.myLines[0].at < LOGGED_FROM;
  const since = `${day(LOGGED_FROM)}, ${time(LOGGED_FROM)}`;
  let lastDay = "";
  // The chat as it read, from when full logging began; each text someone sent replays from there.
  const lines = lab.myLines.filter((l) => l.at >= LOGGED_FROM);
  const byId = new Map(moments.map((m) => [m.id, m]));
  return (
    <div className="rside" id="replaySide">
      <select className="rchat" id="rChat" aria-label="Chat" value={lab.myChat} onChange={(e) => pickChat(e.target.value)}>
        {chats.map((c) => (
          <option key={c.key} value={c.key}>
            {(c.key === "me" ? "1:1 with Tex" : c.name) + (c.people ? ` · ${c.people} ${c.people === 1 ? "person" : "people"}` : "")}
          </option>
        ))}
      </select>
      <div className="rmoments" ref={list}>
        {lab.myOlder !== null && !reachedStart && Array.isArray(lab.myTexts) ? (
          <button className="ghost cdo" id="rOlder" onClick={() => void readMyTexts(true)}>
            Older texts
          </button>
        ) : null}
        {lab.myTexts === null ? <div className="scne">Reading the chat…</div> : null}
        {lab.myTexts === "failed" ? <div className="scne">{"Couldn't read this chat"}</div> : null}
        {reachedStart ? (
          <div className="scne" id="rLoggedFrom">
            Replay starts {since}, when every step began to be logged in full.
          </div>
        ) : null}
        {Array.isArray(lab.myTexts) && !moments.length && !reachedStart ? <div className="scne">No texts yet</div> : null}
        {lines.map((l) => {
          const d = day(l.at);
          const head = d !== lastDay ? <div className="cdd">{d}</div> : null;
          lastDay = d;
          const side = l.from === "tex" ? "tex" : group ? "them" : "me";
          const who = group || l.from === "tex" ? <span className="cdw">{l.who}</span> : null;
          const m = byId.get(l.id);
          return (
            <div key={l.id} className="rmw">
              {head}
              {m ? (
                <button className={`cdb ${side} can${lab.moment === m.id ? " on" : ""}`} data-moment={m.id} aria-current={lab.moment === m.id} title="Replay from this text" onClick={() => openMoment(m)}>
                  {who}
                  <span className="cdt">{l.text}</span>
                  <span className="cdm">{time(l.at)}</span>
                </button>
              ) : (
                <span className={`cdb ${side}`}>
                  {who}
                  <span className="cdt">{l.text}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
