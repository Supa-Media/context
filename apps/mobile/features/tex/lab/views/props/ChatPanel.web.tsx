/**
 * The right panel's conversation while the test user is You (Dev2, 2026-11-14: "first select like whether it's like
 * your one-on-one versus ... a different group chat ... and then you can ... scroll through and click on the
 * different things ... it shows like the full text of the group chat, and then you can just click on one"). Dev2 picked
 * mock C of three: the chats are listed in the sidebar, and the chosen one's whole conversation fills this panel,
 * newest at the bottom. A click on one of the person's texts traces it on the canvas and plays it at the pace it ran;
 * while it plays the panel shows each step's inputs and outputs, and closing a step's panel comes back here. Read only,
 * like everything "You" reads.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { emit, lab } from "../../engine/state";
import { traceMine } from "../../engine/traces";
import type { ChatLine } from "../../engine/mine";
import { useLab } from "../../store";
import { readMyTexts, readTurnTimes } from "../mine/useMine";

const time = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const day = (at: number) => new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** Trace the text, read its measured times, then ask the canvas to play it (`lab.playReq`). */
async function play(l: ChatLine) {
  if (!l.play) return;
  traceMine(l.play.text);
  emit();
  await readTurnTimes(l.play);
  lab.playReq += 1;
  emit();
}

export function ChatPanel({ extra }: { extra?: ReactNode }) {
  useLab();
  const list = useRef<HTMLDivElement>(null);
  const chat = (lab.myChats ?? []).find((c) => c.key === lab.myChat);
  const lines = lab.myLines;
  const newest = (lines.length ? lines[lines.length - 1].id : "") + "|" + lab.myChat;
  // Open on the newest text, as a chat app does; reading older texts keeps the place.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [newest]);

  let lastDay = "";
  return (
    <div className="chatp" id="chatPanel" aria-label="Conversation">
      <div className="ph">
        <div className="cdtl">
          <b id="chatName">{chat?.name ?? (lab.myChat === "me" ? "Just you and Tex" : "Group chat")}</b>
          <span className="hint">{(chat?.people ? `${chat.people} people · ` : "") + "click a text to play it"}</span>
        </div>
        {extra}
      </div>
      <div className="cdl" ref={list}>
        {lab.myOlder !== null && Array.isArray(lab.myTexts) ? (
          <button className="ghost cdo" id="chatOlder" onClick={() => void readMyTexts(true)}>
            Older texts
          </button>
        ) : null}
        {lab.myTexts === null ? <div className="scne">Reading the chat…</div> : null}
        {lab.myTexts === "failed" ? <div className="scne">{"Couldn't read this chat"}</div> : null}
        {Array.isArray(lab.myTexts) && !lines.length ? <div className="scne">No texts yet</div> : null}
        {lines.map((l) => {
          const d = day(l.at);
          const head = d !== lastDay ? <div className="cdd">{d}</div> : null;
          lastDay = d;
          const on = !!l.play && lab.scn === "own" && lab.ownText === l.play.text;
          const cls = `cdb ${l.from === "tex" ? "tex" : lab.myChat === "me" ? "me" : "them"}${l.play ? " can" : ""}${on ? " on" : ""}`;
          const body = (
            <>
              {lab.myChat !== "me" || l.from === "tex" ? <span className="cdw">{l.who}</span> : null}
              <span className="cdt">{l.text}</span>
              <span className="cdm">
                {time(l.at)}
                {l.play ? (l.play.turn ? " · play" : " · trace") : ""}
              </span>
            </>
          );
          return (
            <div key={l.id} className="cdr">
              {head}
              {l.play ? (
                <button className={cls} data-line={l.id} aria-current={on ? "true" : "false"} title={l.play.turn ? "Play this text at the pace it ran" : "Trace this text (no measured times kept)"} onClick={() => play(l)}>
                  {body}
                </button>
              ) : (
                <div className={cls} data-line={l.id}>
                  {body}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
