/**
 * The prototype's left column: the three sets, each with its chats, stars and note; drag a chat onto a set to move
 * it. The Test Set's chats stay hidden (counts only) until a person asks to see them, with the warning.
 */
import { useState } from "react";
import { labelCount, SET_INFO, SETS, starsIn, type Conversation, type SetId } from "../../engine/sets";
import { change, createChat, fold, setUi, showTest, useSets } from "../../engine/setsStore";

const kindName = (k: string) => (k === "one" ? "1:1" : "group");

export function newChat(): Conversation {
  return { id: "chat-" + Date.now().toString(36), title: "New chat", set: "dev", kind: "one", members: ["Jo"], msgs: [] };
}

export function SetsList() {
  const s = useSets();
  const [drop, setDrop] = useState<SetId | null>(null);
  const open = (c: Conversation) => setUi({ chat: c.id, msg: null, col: null, editing: false, fresh: null });
  return (
    <div className="panel" id="tstSets">
      <div className="ph">
        <b>Sets</b>
        <span className="muted small">drag a chat to move it</span>
        <button className="btn sm p" id="newChat" style={{ marginLeft: "auto" }} onClick={() => createChat(newChat())}>
          + Chat
        </button>
        <button className="foldbtn" id="foldSets" title="Hide Sets" aria-label="Hide Sets" onClick={() => fold("sets", true)}>
          «
        </button>
      </div>
      <div className="scroll" id="sets">
        {SETS.map((id) => {
          const info = SET_INFO[id];
          const list = s.convs.filter((c) => c.set === id);
          const hidden = id === "test" && !s.showTest;
          const count = hidden ? s.hiddenTest.length : list.length;
          const stars = hidden ? s.testStars : list.reduce((a, c) => a + starsIn(c), 0);
          return (
            <div
              key={id}
              className={"set" + (drop === id ? " drop" : "")}
              data-set={id}
              onDragOver={(e) => (e.preventDefault(), setDrop(id))}
              onDragLeave={() => setDrop(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDrop(null);
                const c = s.convs.find((x) => x.id === e.dataTransfer.getData("text/plain"));
                if (c && c.set !== id) change(c.id, [{ op: "set", value: id }]);
              }}
            >
              <div className="sethead">
                <span>
                  <span className="dot" style={{ background: info.color }} /> {info.name}
                </span>
                <span className="muted small">
                  {count} chat{count === 1 ? "" : "s"} · ★ {stars}
                </span>
              </div>
              <div className="muted small" style={{ padding: "0 4px 4px" }}>
                {info.note}
              </div>
              {hidden ? (
                <>
                  {s.hiddenTest.map((h, i) => (
                    <button key={i} className="chat" data-hidden={i}>
                      <span className="t">
                        Hidden chat {i + 1}
                        <span className="muted small">★ {h.stars}</span>
                      </span>
                      <span className="muted small">
                        {kindName(h.kind)} · {h.msgs} messages
                      </span>
                    </button>
                  ))}
                  <div className="lock">
                    People only: write and read these by hand. An agent that sees them can overfit.
                    <button className="btn sm" id="showTest" style={{ alignSelf: "flex-start", color: "var(--team)" }} onClick={() => void showTest(true)}>
                      Show Test chats
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {list.map((c) => (
                    <button key={c.id} className={"chat" + (c.id === s.chat ? " on" : "")} draggable data-chat={c.id} onClick={() => open(c)} onDragStart={(e) => e.dataTransfer.setData("text/plain", c.id)}>
                      <span className="t">
                        {c.title}
                        <span className="muted small">★ {starsIn(c)}</span>
                      </span>
                      <span className="muted small">
                        {kindName(c.kind)} · {c.msgs.length} messages · {c.msgs.reduce((a, m) => a + labelCount(m), 0)} labels
                      </span>
                    </button>
                  ))}
                  {!list.length && !(id === "test") ? (
                    <div className="muted small" style={{ padding: 6 }}>
                      Drop a chat here
                    </div>
                  ) : null}
                  {id === "test" ? (
                    <button className="btn sm ghost" id="hideTest" onClick={() => void showTest(false)}>
                      Hide Test chats
                    </button>
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
