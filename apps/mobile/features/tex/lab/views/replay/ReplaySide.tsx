/**
 * Replay's left column: the chats you can replay (your 1:1 and every group chat you're in) and the picked chat's
 * conversation cut into moments, newest at the bottom. A click on a moment shows it on the canvas and its timeline.
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
        {moments.map((m) => {
          const d = day(m.at);
          const head = d !== lastDay ? <div className="cdd">{d}</div> : null;
          lastDay = d;
          const asked = m.lines.filter((l) => l.from === "person").length;
          return (
            <div key={m.id} className="rmw">
              {head}
              <button className="rmoment" data-moment={m.id} aria-current={lab.moment === m.id} onClick={() => openMoment(m)}>
                <span className="rmt">
                  <b>{asked}</b> {asked === 1 ? "text" : "texts"} · {time(m.at)}
                  {m.turns.length > 1 ? ` · ${m.turns.length} turns` : ""}
                </span>
                {m.lines.map((l) => (
                  <span key={l.id} className={`cdb ${l.from === "tex" ? "tex" : group ? "them" : "me"}`}>
                    {group || l.from === "tex" ? <span className="cdw">{l.who}</span> : null}
                    <span className="cdt">{l.text}</span>
                  </span>
                ))}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
