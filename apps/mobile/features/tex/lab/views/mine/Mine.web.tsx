/**
 * "Your texts" on the Lab's Test cases page, when the test user is You (`engine/mine.ts`): the texts the signed-in
 * person sent Tex, newest first, each with the chat just before it, what Tex said then and which Tex that was. A
 * ticked text goes into the version's run as a read-only replay, and a pasted "## Lab replay" shows what this
 * version says now beside it. Drawn with the Test cases page's own pieces (`.who`, `.tbar`, `.tgrid`, `.tc`, `.bb`).
 */
import { emit, lab } from "../../engine/state";
import { shortVersion, type MyText, type ReplayNow } from "../../engine/mine";
import { useLab } from "../../store";
import { Ic } from "../ic";
import { readMyTexts, readTurnReads } from "./useMine";

const when = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function pick(id: string, on: boolean) {
  lab.myPicks = on ? [...new Set([...lab.myPicks, id])] : lab.myPicks.filter((x) => x !== id);
  emit();
  if (on) void readTurnReads(id);
}

function Bub({ who, text, cls = "" }: { who?: string; text: string; cls?: string }) {
  return (
    <div className={`bb ${cls}`}>
      {who ? <span className="bw">{who}</span> : null}
      {text}
    </div>
  );
}

function TextCard({ t, now }: { t: MyText; now?: ReplayNow }) {
  const on = lab.myPicks.includes(t.id);
  const reads = lab.myReads[t.id];
  return (
    <article className={`tc ${on ? "" : "off"}`}>
      <div className="tch">
        <label className="inrun" title="In the replay">
          <input type="checkbox" checked={on} data-mypick={t.id} aria-label={`Replay ${when(t.at)}`} onChange={(e) => pick(t.id, e.target.checked)} />
        </label>
        <span className="cid">{when(t.at)}</span>
        <span className="pill">1:1</span>
        <span className={`pill${t.then.version ? " acc" : ""}`} title={t.then.version ? JSON.stringify(t.then.version) : "Sent before Tex kept its version"}>
          {shortVersion(t.then.version)}
        </span>
        {on && reads ? <span className="pill">{reads.length + " note" + (reads.length === 1 ? "" : "s")}</span> : null}
      </div>
      <div className="thr">
        {t.earlier.slice(-2).map((l, i) => (
          <div key={i} className="ctxl">
            {(l.from === "tex" ? "Tex: " : "You: ") + l.text.slice(0, 120)}
          </div>
        ))}
        <Bub text={t.text} cls="new" />
        {t.then.text ? <Bub who="Tex then" text={t.then.text} cls="tex" /> : null}
        {now ? <Bub who="Tex now" text={now.failed ? `Failed: ${now.failed}` : now.now} cls="tex" /> : null}
      </div>
    </article>
  );
}

export function MineMain() {
  useLab();
  const me = lab.me;
  const list = Array.isArray(lab.myTexts) ? lab.myTexts : [];
  const shown = list.filter((t) => !lab.tQ || (t.text + " " + t.then.text).toLowerCase().includes(lab.tQ));
  const now = lab.myNow;
  return (
    <section className="tmain">
      <div className="who">
        <div className="wp">
          <span className="av">
            <Ic k="text" style={{ width: 16, height: 16 }} />
          </span>
          <div>
            <b>{me ? me.name : "You"}</b>
            <div className="hint">Your texts · read only</div>
          </div>
        </div>
      </div>
      <div className="tbar">
        <input
          className="search"
          id="myQ"
          placeholder="Search"
          value={lab.tQ}
          aria-label="Search your texts"
          onChange={(e) => {
            lab.tQ = e.target.value.toLowerCase();
            emit();
          }}
        />
        <span className="hint">
          {lab.myPicks.length} of {list.length} in the replay
        </span>
        <span className="spacer"></span>
        <button
          className="ghost"
          id="myNone"
          onClick={() => {
            lab.myPicks = [];
            emit();
          }}
        >
          None
        </button>
      </div>
      {lab.myTexts === "failed" ? (
        <p className="hint">{"Couldn't read your texts."}</p>
      ) : lab.myTexts === null ? (
        <p className="hint">Reading your texts…</p>
      ) : (
        <div className="tgrid">
          {shown.map((t) => (
            <TextCard key={t.id} t={t} now={now[t.id]} />
          ))}
          {shown.length ? null : <p className="hint">No texts match.</p>}
        </div>
      )}
      {lab.myOlder !== null && Array.isArray(lab.myTexts) ? (
        <div className="flex" style={{ marginTop: 12, justifyContent: "center" }}>
          <button className="ghost" id="myOlder" onClick={() => void readMyTexts(true)}>
            Older
          </button>
        </div>
      ) : null}
    </section>
  );
}
