/**
 * "Try a text" under a Training or Dev chat (mockup https://claude.ai/artifact/P2vQtigdvALrSWyb5CqQ3E): one more text
 * from one of its people, run as one whole turn in Tex's gateway on the version picked to run, on the same models live
 * Tex uses. It takes seconds and is read only (the test chat, `engine/sandbox.ts`). Its two rows sit under the chat
 * until kept as rows of the chat or discarded; the panel shows the steps that ran.
 */
import { useState } from "react";
import { G } from "../../engine/state";
import { runsUi, useRunsUi } from "../../engine/labRuns";
import { discardSandbox, tryText, useSandbox } from "../../engine/sandbox";
import { freshId, type Conversation } from "../../engine/sets";
import { change, setUi, useSets } from "../../engine/setsStore";
import { msWords } from "../grid/TextGrid.web";

/** The try for this chat, if the test chat is on it. */
export function useTry(c: Conversation) {
  const sb = useSandbox();
  if (sb.source.kind !== "set" || sb.source.convId !== c.id) return null;
  const rows = sb.rows.filter((r) => !r.prod);
  const person = rows.find((r) => !r.tex) ?? null;
  const reply = rows.find((r) => r.tex) ?? null;
  return person || sb.busy ? { person, reply, running: !!sb.running || sb.busy, problem: sb.problem } : null;
}

export function TryRows({ c, span }: { c: Conversation; span: number }) {
  const t = useTry(c);
  const s = useSets();
  if (!t?.person) return null;
  const sel = s.msg === "try";
  const steps = (t.person.steps ?? []).map((x) => G().nodes.find((n) => n.id === x.node)?.label ?? x.node);
  const keep = () => {
    const at = c.msgs.length;
    const id = freshId(c);
    const ops: Parameters<typeof change>[1] = [{ op: "addMsg", at, msg: { id, who: t.person!.who, text: t.person!.text } }];
    if (t.reply && !t.reply.quiet) ops.push({ op: "addMsg", at: at + 1, msg: { id: id + "t", who: "Tex", tex: true, text: t.reply.text } });
    change(c.id, ops);
    void discardSandbox();
    setUi({ msg: null });
  };
  const open = () => setUi({ msg: "try", col: null, editing: false });
  return (
    <>
      <tr className={"mr try" + (sel ? " sel" : "")} data-try="person" onClick={open}>
        <td className="num mono muted">
          <span className="trytag">Try</span>
        </td>
        <td>
          <b>{t.person.who}</b>
        </td>
        <td className="txt">{t.person.text}</td>
        <td colSpan={Math.max(1, span)} className="small muted">
          {t.running ? <span className="pill r"><span className="spin" />Running</span> : `ran ${steps.join(" → ")}`}
        </td>
        <td className="x" />
      </tr>
      <tr className={"mr tex try" + (sel ? " sel" : "")} data-try="tex" onClick={open}>
        <td className="num" />
        <td>
          <b className="texwho">Tex</b>
        </td>
        <td className="txt">{t.running ? <span className="muted">answering…</span> : t.reply && !t.reply.quiet ? t.reply.text : <span className="muted">(stays quiet: no reply)</span>}</td>
        <td colSpan={Math.max(1, span)} style={{ whiteSpace: "normal" }}>
          {t.running ? null : (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="btn sm" id="tryKeep" onClick={(e) => (e.stopPropagation(), keep())}>
                {t.reply && !t.reply.quiet ? "Keep both rows" : "Keep the text"}
              </button>
              <button className="btn sm ghost" id="tryDrop" onClick={(e) => (e.stopPropagation(), void discardSandbox(), setUi({ msg: null }))}>
                Discard
              </button>
            </div>
          )}
        </td>
        <td className="x" />
      </tr>
    </>
  );
}

export function TryCompose({ c }: { c: Conversation }) {
  const ui = useRunsUi();
  const sb = useSandbox();
  const people = c.members.length ? c.members : ["Maya"];
  const [who, setWho] = useState(people[0]);
  const [text, setText] = useState("");
  const go = () => {
    const v = text.trim();
    if (!v || sb.running || sb.busy) return;
    setText("");
    setUi({ msg: "try", col: null, editing: false });
    void tryText(c.id, c.title, runsUi.ver, who, v, c.kind === "group");
  };
  return (
    <div className="compose" id="tryCompose">
      <select id="tryWho" aria-label="Who sends it" value={who} onChange={(e) => setWho(e.target.value)}>
        {people.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <input id="tryTxt" aria-label="Try a text" placeholder={`Try a text: what happens if ${who} sends… (on ${ui.ver === "main" ? "main" : "the draft picked to run"})`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && go())} />
      <button className="btn p" id="trySend" disabled={!text.trim() || !!sb.running || sb.busy} onClick={go}>
        Send
      </button>
    </div>
  );
}

/** The panel for a try: Tex's reply and the steps the log shows ran, each with what it gave. */
export function TryPanel({ c }: { c: Conversation }) {
  const t = useTry(c);
  const ui = useRunsUi();
  if (!t)
    return (
      <div className="panel" id="tryPanel">
        <div className="insp">
          <div className="note">Nothing tried on this chat yet: type a text under the chat and Send.</div>
        </div>
      </div>
    );
  return (
    <div className="panel" id="tryPanel">
      <div className="insp">
        <div className="cap">Try a text · {c.title}</div>
        {t.person ? (
          <div className="quote">
            <span className="muted small">
              {t.person.who} · after #{c.msgs.length}
            </span>
            <div>{t.person.text}</div>
          </div>
        ) : null}
        <div className="small muted">Runs the whole turn in Tex's gateway on {ui.ver === "main" ? "main" : "the draft picked to run"}, on the same models live Tex uses, given this chat so far. It takes seconds, with no GitHub run. Read only: Try never texts anyone or changes a real note.</div>
        {t.problem ? <div className="small c-bad">{t.problem}</div> : null}
        <div className="cap">Tex's reply</div>
        <div>{t.running ? <span className="muted">waiting for the turn…</span> : t.reply && !t.reply.quiet ? t.reply.text : <span className="muted">No reply: Tex stays quiet.</span>}</div>
        <div className="cap">Steps that ran</div>
        <div className="steps">
          {(t.person?.steps ?? []).map((x, k) => (
            <div className="step" key={k}>
              <span className="mono muted">{k + 1}</span>
              <div>
                <b>{G().nodes.find((n) => n.id === x.node)?.label ?? x.node}</b>
                <div className="muted">{x.out}</div>
              </div>
              <span className="tm">{msWords(x.ms)}</span>
            </div>
          ))}
        </div>
        <div className="muted small">Only the steps the run's log shows ran.</div>
        <div className="cap">Same from any MCP session</div>
        <div className="mcp">{`tex_dev { action: "sandbox", op: "open", source: "set", convId: "${c.id}", versionId: "${ui.ver}" }\ntex_dev { action: "sandbox", op: "send", as: "${t.person?.who ?? ""}", text: "…" }`}</div>
      </div>
    </div>
  );
}
