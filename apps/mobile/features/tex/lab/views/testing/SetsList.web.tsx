/**
 * The left column, simplified (Dev2, 2026-11-16, approved mockup https://claude.ai/artifact/PUjJ7Vd6tX6BJj7vkEir1T):
 * the 60/20/20 split as one small chip, then each set as a heading over one line per chat. Drag a chat onto another
 * set to move it ("just have it be able to be dragged on the left nav"). The Test Set's chats stay hidden (counts
 * only) until a person asks to see them and says yes to the people-only note.
 */
import { useState } from "react";
import { missingTest, SET_INFO, SETS, setsRatio, starsIn, type Conversation, type SetId } from "../../engine/sets";
import { change, createChat, fold, setUi, showTest, useSets } from "../../engine/setsStore";
import { Chev, Plus } from "./Menu.web";

export function newChat(): Conversation {
  return { id: "chat-" + Date.now().toString(36), title: "New chat", set: "dev", kind: "one", members: ["Jo"], msgs: [] };
}

/** The split of unit tests across the sets, against the 60/20/20 it should hold. */
export function Ratio() {
  const s = useSets();
  const r = setsRatio(
    s.convs.filter((c) => c.set !== "test"),
    s.testStars,
  );
  const colors = { training: "var(--accent)", dev: "var(--ok)", test: "var(--team)" } as const;
  // One pooled split over every step; per step only a warning when the Test Set has none of its tests (Dev2, 2026-11-17).
  const noTest = missingTest(
    s.convs.filter((c) => c.set !== "test"),
    s.testByNode,
  );
  return (
    <>
    <span className={"ts-ratio" + (r.holds ? "" : " off")} id="ratio" title={`${r.total} unit tests: ${r.pct.training} / ${r.pct.dev} / ${r.pct.test} across Training, Dev and Test, pooled over every step, target 60 / 20 / 20`}>
      <span className="rb" aria-hidden="true">
        {(["training", "dev", "test"] as const).map((k) => (
          <i key={k} style={{ width: r.pct[k] + "%", background: colors[k] }} />
        ))}
      </span>
      {r.pct.training}/{r.pct.dev}/{r.pct.test}
    </span>
    {noTest.length ? (
      <span className="ts-notest" id="noTest" title={`No unit tests in the Test Set for: ${noTest.map((x) => `${x.scope} (Training ${x.training}, Dev ${x.dev})`).join(", ")}. A warning only: CI never fails on it.`}>
        ! {noTest.length}
      </span>
    ) : null}
    </>
  );
}

export function SetsList() {
  const s = useSets();
  const [drop, setDrop] = useState<SetId | null>(null);
  const [sure, setSure] = useState(false);
  const open = (c: Conversation) => setUi({ chat: c.id, msg: null, col: null, editing: false, fresh: null });
  return (
    <aside className="ts-sets" id="tstSets" aria-label="Sets">
      <div className="ts-sh">
        <b>Sets</b>
        <Ratio />
        <span className="sp" />
        <button className="ib" id="newChat" title="New chat" aria-label="New chat" onClick={() => createChat(newChat())}>
          <Plus />
        </button>
        <button className="ib" id="foldSets" title="Hide sets" aria-label="Hide sets" onClick={() => fold("sets", true)}>
          <Chev left />
        </button>
      </div>
      <div className="ts-list" id="sets">
        {SETS.map((id) => {
          const info = SET_INFO[id];
          const list = s.convs.filter((c) => c.set === id);
          const hidden = id === "test" && !s.showTest;
          const count = hidden ? s.hiddenTest.length : list.length;
          const stars = hidden ? s.testStars : list.reduce((a, c) => a + starsIn(c), 0);
          return (
            <div
              key={id}
              className={"ts-set" + (drop === id ? " drop" : "")}
              data-set={id}
              onDragOver={(e) => (e.preventDefault(), drop !== id && setDrop(id))}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrop(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDrop(null);
                const c = s.convs.find((x) => x.id === e.dataTransfer.getData("text/plain"));
                if (c && c.set !== id) change(c.id, [{ op: "set", value: id }]);
              }}
            >
              <div className="ts-grp">
                <span className="ts-sw" style={{ background: info.color }} />
                {info.name}
                <span className="n">
                  {count} · ★ {stars}
                </span>
              </div>
              {hidden && sure ? (
                <div className="ts-sure" id="testSure" role="group" aria-label="Show the Test set">
                  <p>People only: an agent that reads these chats can learn them and overfit.</p>
                  <span>
                    <button
                      className="btn sm p"
                      id="showTestYes"
                      autoFocus
                      onClick={() => {
                        setSure(false);
                        void showTest(true);
                      }}
                    >
                      Show {count} chat{count === 1 ? "" : "s"}
                    </button>
                    <button className="btn sm" id="showTestNo" onClick={() => setSure(false)}>
                      Cancel
                    </button>
                  </span>
                </div>
              ) : hidden ? (
                <button className="ts-ci locked" id="showTest" title="People only: an agent that sees these can overfit" onClick={() => setSure(true)}>
                  <span className="t">{`${count} hidden chat${count === 1 ? "" : "s"}`}</span>
                  <span className="st">people only</span>
                </button>
              ) : (
                <>
                  {list.map((c) => (
                    <button key={c.id} className="ts-ci" aria-current={c.id === s.chat} draggable data-chat={c.id} onClick={() => open(c)} onDragStart={(e) => (e.dataTransfer.setData("text/plain", c.id), (e.dataTransfer.effectAllowed = "move"))}>
                      <span className="t">{c.title}</span>
                      <span className="st">★ {starsIn(c)}</span>
                    </button>
                  ))}
                  {id === "test" ? (
                    <button className="ts-showtest" id="hideTest" onClick={() => void showTest(false)}>
                      Hide Test chats
                    </button>
                  ) : null}
                </>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
