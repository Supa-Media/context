/**
 * The test chat under the Architecture canvas (mockup https://claude.ai/artifact/P2vQtigdvALrSWyb5CqQ3E, Dev2
 * 2026-11-16): pick Maya or one of your chats, text as anyone in it, and the version open in the Lab answers on live
 * models; every step's output fills its column and lights on the canvas. Retry, go back to any text (Dev2: "say Ive
 * been going back and forth 6 turns, but I want to go back to turn 3") or delete; whatever Tex would have changed or
 * sent stays in the test chat, listed under its changes. The texts are the shared grid (`grid/TextGrid.web.tsx`).
 */
import { useEffect, useState } from "react";
import { backTo, dropText, readSandboxChats, takeDraft, openSandbox, resetSandbox, retryText, sendAs, sendText, useSandbox, type SandboxSource } from "../../engine/sandbox";
import { useLab } from "../../store";
import { useSandboxCall } from "./sandboxCall";
import { TextGrid, type TextRow } from "../grid/TextGrid.web";

const srcKey = (s: SandboxSource) => (s.kind === "maya" ? "maya" : s.kind === "chat" ? "chat:" + s.chatId : "set:" + s.convId);

export function SandboxChat() {
  const sb = useSandbox();
  const s = useLab();
  const ready = useSandboxCall();
  const [text, setText] = useState(() => takeDraft()?.text ?? "");
  const [chgOpen, setChgOpen] = useState(false);
  const versionId = s.cur.id;
  const sources: SandboxSource[] = [{ kind: "maya" }, ...sb.chats.map((c) => ({ kind: "chat" as const, chatId: c.chatId, name: c.chatId === "me" ? "Your 1:1 with Tex" : c.name }))];
  // A fresh test chat when the Lab opens a different version, or once the gateway can be reached.
  useEffect(() => {
    if (!ready) return;
    if (!sb.chats.length) void readSandboxChats();
    if ((sb.id === null || sb.versionId !== versionId) && !sb.busy) void openSandbox(sb.source, versionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, versionId]);
  useEffect(() => {
    if (!chgOpen) return;
    const close = () => setChgOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [chgOpen]);

  const rows: TextRow[] = [];
  let sep = false;
  for (const r of sb.rows) {
    if (!r.prod && !sep) {
      rows.push({ id: "sep", who: "", text: "", sep: "Test texts" });
      sep = true;
    }
    rows.push({ id: r.id, who: r.tex ? "Tex" : r.who, text: r.text, tex: r.tex, quiet: r.quiet, prod: r.prod, test: !r.prod, steps: r.steps, running: sb.running === r.id, hot: sb.running === r.id ? sb.hot : null });
  }
  const send = () => {
    const t = text.trim();
    if (!t || sb.running || !sb.as) return;
    setText("");
    void sendText(t);
  };
  const name = (x: SandboxSource) => (x.kind === "maya" ? "Maya (test user) · 1:1" : x.name);
  // A Testing chat tried there shows in the picker too, until another is picked.
  if (sb.source.kind === "set" && !sources.some((x) => srcKey(x) === srcKey(sb.source))) sources.push(sb.source);
  return (
    <section className="sbx" id="sandbox" aria-label="Test chat">
      <TextGrid
        gridKey="sandbox"
        id="sbGrid"
        rows={rows}
        empty={<div className="scne">{sb.busy ? "Opening the test chat…" : sb.problem || "Text Tex below to try this version"}</div>}
        head={
          <>
            <span className="sbxtag" title="Nothing here reaches the real chat, the workspace or anyone's phone">
              Sandbox
            </span>
            <select
              id="sbSrc"
              aria-label="Which chat"
              value={srcKey(sb.source)}
              onChange={(e) => {
                const pick = sources.find((x) => srcKey(x) === e.target.value);
                if (pick) void openSandbox(pick, versionId);
              }}
            >
              {sources.map((x) => (
                <option key={srcKey(x)} value={srcKey(x)}>
                  {name(x)}
                </option>
              ))}
            </select>
            {sb.writes.length ? (
              <span style={{ position: "relative" }}>
                <button
                  className="btn sm"
                  id="sbChanges"
                  aria-expanded={chgOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    setChgOpen(!chgOpen);
                  }}
                >
                  {sb.writes.length} sandbox change{sb.writes.length > 1 ? "s" : ""} ▾
                </button>
                {chgOpen ? (
                  <div className="colmenu sbwrites" onClick={(e) => e.stopPropagation()}>
                    {sb.writes.map((w, k) => (
                      <div className="wr" key={k}>
                        <span className="k">{w.kind}</span>
                        <span>{w.summary}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </span>
            ) : null}
            {sb.problem && sb.rows.length ? <span className="small c-bad">{sb.problem}</span> : null}
            <button className="btn sm ghost" id="sbReset" disabled={sb.busy} onClick={() => void resetSandbox()}>
              Reset
            </button>
          </>
        }
        actions={(r) =>
          r.test && !r.tex ? (
            <>
              <button data-retry={r.id} title="Run this text again" disabled={!!sb.running} onClick={() => void retryText(r.id)}>
                ↻ Retry
              </button>
              <button data-back={r.id} title="Go back to here: remove everything after this text, with the sandbox changes it made" disabled={!!sb.running} onClick={() => void backTo(r.id)}>
                ⤺
              </button>
              <button data-drop={r.id} title="Delete this text and everything after it" disabled={!!sb.running} onClick={() => void dropText(r.id)}>
                🗑
              </button>
            </>
          ) : (
            <button data-back={r.id} title="Go back to here: remove everything after this text, with the sandbox changes it made" disabled={!!sb.running} onClick={() => void backTo(r.id)}>
              ⤺
            </button>
          )
        }
      />
      <form
        className="sbc"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <select id="sbAs" aria-label="Send as" value={sb.as} onChange={(e) => sendAs(e.target.value)}>
          {sb.people.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <input id="sbTxt" aria-label="Test text" placeholder={sb.as ? `Text as ${sb.as}…` : "Text Tex…"} value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn p" id="sbSend" type="submit" disabled={!!sb.running || sb.busy || !text.trim() || !sb.as}>
          Send
        </button>
      </form>
    </section>
  );
}

/** The canvas lights what ran for the test text, and the step running now. */
export function useSandboxLit(): ReadonlySet<string> | null {
  const sb = useSandbox();
  const r = sb.running ? sb.rows.find((x) => x.id === sb.running) : [...sb.rows].reverse().find((x) => !x.prod && !x.tex && x.steps?.length);
  if (!r) return null;
  const ids = new Set((r.steps || []).map((x) => x.node));
  if (sb.hot) ids.add(sb.hot);
  return ids.size ? ids : null;
}
