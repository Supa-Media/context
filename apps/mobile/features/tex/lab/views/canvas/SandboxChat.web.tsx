/**
 * The test chat docked under the Architecture canvas (decluttered Lab, mockup
 * https://claude.ai/artifact/W21NekNf2vtnFLXXzAmp7N, approved by Dev2 2026-11-16): pick a chat from your account, the
 * test account or the Training / Dev sets (never the Test set), text as anyone in it, and the version open in the Lab
 * answers on live models; every step's output fills its column. One ▶ per text (`engine/sandboxPlay.ts`) plays back
 * what ran, or runs it fresh once the version changed; ⤺ goes back to a text and 🗑 deletes it. Each message's ⋯ reacts
 * or replies, edits or takes back (Delete, iMessage's Undo Send) a test text, and the composer takes pictures (picked,
 * pasted or dropped), each run as production runs it (`docs/decisions/texting-assistant/edits-and-unsends.md`). Nothing
 * reaches the real chat, the workspace or anyone's phone. Folds to its head with ▾.
 */
import { useEffect, useRef, useState } from "react";
import { backTo, dropText, editText, reactTo, unsendText, readSandboxChats, readSandboxSets, sandboxProblem, takeDraft, openSandbox, resetSandbox, sendAs, sendText, TAPBACKS, useSandbox, type SandboxRow, type SandboxSource } from "../../engine/sandbox";
import { isStale, noteRan, pickStep, playLit, playText, usePlay } from "../../engine/sandboxPlay";
import { usePicUpload } from "./usePicUpload";
import { useLab } from "../../store";
import { useSandboxCall } from "./sandboxCall";
import { TextGrid, msWords, type TextRow } from "../grid/TextGrid.web";
import { Pop } from "../bar/Pop.web";
import type { Lit } from "./usePlayback";

const MAX_PICS = 6;
type Tab = "mine" | "test" | "sets";

const srcKey = (s: SandboxSource) => (s.kind === "maya" ? "maya" : s.kind === "chat" ? "chat:" + s.chatId : "set:" + s.convId);

/** The chat picker: your account's 1:1 and group chats, the test account, and the Training and Dev conversations. */
function ChatPick({ versionId }: { versionId: string }) {
  const sb = useSandbox();
  const [tab, setTab] = useState<Tab>(sb.source.kind === "maya" ? "test" : sb.source.kind === "set" ? "sets" : "mine");
  const [q, setQ] = useState("");
  const name = sb.source.kind === "maya" ? "Maya (test account)" : sb.source.kind === "chat" && sb.source.chatId === "me" ? "Your 1:1 with Tex" : sb.source.name;
  const who = sb.source.kind === "maya" || (sb.source.kind === "chat" && sb.source.chatId === "me") ? "1:1" : sb.people.length ? sb.people.length + " people" : "";
  const qq = q.trim().toLowerCase();
  const hit = (s: string) => !qq || s.toLowerCase().includes(qq);
  const cur = srcKey(sb.source);
  const groupChat = () => sb.chats.find((c) => c.chatId !== "me" && c.kind !== "dm")?.chatId;
  return (
    <Pop
      id="sbChat"
      title="Which chat the test texts go to"
      button={
        <>
          <svg className="i" viewBox="0 0 24 24">
            <path d="M4 5h16v11H9l-5 4z" />
          </svg>
          <span className="nm" id="sbChatName">
            {name}
          </span>
          {who ? <span className="cwho">{who}</span> : null}
          <span className="car">▾</span>
        </>
      }
    >
      {(close) => {
        const open = (s: SandboxSource) => {
          close();
          void openSandbox(s, versionId);
        };
        const one = sb.chats.filter((c) => (c.chatId === "me" || c.kind === "dm") && hit(c.chatId === "me" ? "Your 1:1 with Tex" : c.name));
        const groups = sb.chats.filter((c) => c.chatId !== "me" && c.kind !== "dm" && hit(c.name));
        const convs = sb.sets.filter((c) => hit(c.title));
        return (
          <div className="vmenu chatpick">
            <div className="seg" role="tablist" id="sbPickTabs">
              {(
                [
                  ["mine", "Your account"],
                  ["test", "Test account"],
                  ["sets", "Training / Dev"],
                ] as const
              ).map(([k, w]) => (
                <button
                  key={k}
                  role="tab"
                  data-tab={k}
                  aria-selected={tab === k}
                  onClick={() => {
                    setTab(k);
                    if (k === "sets" && !sb.sets.length) void readSandboxSets();
                  }}
                >
                  {w}
                </button>
              ))}
            </div>
            <input type="search" id="sbChatQ" className="vren" placeholder="Find a chat" aria-label="Find a chat" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
            <div id="sbChatList">
              {tab === "mine" ? (
                <>
                  {one.length ? <div className="mh">1:1</div> : null}
                  {one.map((c) => (
                    <button key={c.chatId} className="mi" data-chat={c.chatId} aria-current={cur === "chat:" + c.chatId} onClick={() => open({ kind: "chat", chatId: c.chatId, name: c.chatId === "me" ? "Your 1:1 with Tex" : c.name })}>
                      <span className="nm">{c.chatId === "me" ? "Your 1:1 with Tex" : c.name}</span>
                      <span className="meta">1:1</span>
                    </button>
                  ))}
                  {groups.length ? <div className="mh">Group chats</div> : null}
                  {groups.map((c) => (
                    <button key={c.chatId} className="mi" data-chat={c.chatId} aria-current={cur === "chat:" + c.chatId} onClick={() => open({ kind: "chat", chatId: c.chatId, name: c.name })}>
                      <span className="nm">{c.name}</span>
                      {c.people != null ? <span className="meta">{c.people === 1 ? "only you" : c.people + " people"}</span> : null}
                    </button>
                  ))}
                  {!one.length && !groups.length ? <div className="mnote">{sb.chats.length ? "No chat matches." : "No chats with Tex on your account yet."}</div> : null}
                </>
              ) : tab === "test" ? (
                <>
                  <div className="mnote">A made-up person with her own workspace and chats, so nothing touches yours.</div>
                  {hit("Maya (test account)") ? (
                    <button className="mi" data-chat="maya" aria-current={cur === "maya"} onClick={() => open({ kind: "maya" })}>
                      <span className="nm">Maya (test account)</span>
                      <span className="meta">1:1</span>
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  {(["dev", "training"] as const).map((k) => {
                    const xs = convs.filter((c) => c.set === k);
                    return xs.length ? (
                      <div key={k}>
                        <div className="mh">{k === "dev" ? "Dev" : "Training"} set</div>
                        {xs.map((c) => (
                          <button
                            key={c.id}
                            className="mi"
                            data-conv={c.id}
                            aria-current={cur === "set:" + c.id}
                            onClick={() => {
                              const chatId = c.group ? groupChat() : undefined;
                              open({ kind: "set", convId: c.id, name: c.title + " (" + (k === "dev" ? "Dev" : "Training") + ")", ...(chatId ? { chatId } : {}) });
                            }}
                          >
                            <span className="nm">{c.title}</span>
                            <span className="meta">{c.texts} texts</span>
                          </button>
                        ))}
                      </div>
                    ) : null;
                  })}
                  {!convs.length ? <div className="mnote">No conversation matches.</div> : null}
                  <div className="mnote">The Test set never shows here; it only runs in the Promote gate.</div>
                </>
              )}
            </div>
          </div>
        );
      }}
    </Pop>
  );
}

/** A message's ⋯: the tapbacks and Reply, and on a test text Edit and Delete (Undo Send), each run as production runs it. */
function MsgOptions({ r, onReply, onEdit }: { r: SandboxRow; onReply: () => void; onEdit: () => void }) {
  const sb = useSandbox();
  const own = !r.prod && !r.tex && !r.kind && !r.unsent;
  const idle = !sb.running && !sb.busy;
  return (
    <Pop id={"sbOpt-" + r.id} label="Message options" title="React, reply, edit or delete" className="mopt" button="⋯">
      {(close) => (
        <div className="vmenu">
          <div className="taps">
            {TAPBACKS.map((e) => (
              <button
                key={e}
                data-tap={e}
                title={"React as " + sb.as}
                disabled={!!sb.running || sb.busy}
                onClick={() => {
                  close();
                  void reactTo(r.id, e);
                }}
              >
                {e}
              </button>
            ))}
          </div>
          <hr />
          <button
            className="mi"
            data-reply={r.id}
            onClick={() => {
              close();
              onReply();
            }}
          >
            ↩ Reply
          </button>
          {own ? (
            <>
              <button
                className="mi"
                data-edit-open={r.id}
                disabled={!idle}
                title={"Edit as " + r.who + ": Tex gets it as a real iMessage edit"}
                onClick={() => {
                  close();
                  onEdit();
                }}
              >
                ✎ Edit
              </button>
              <button
                className="mi"
                data-unsend={r.id}
                disabled={!idle}
                title={"Undo Send as " + r.who + ": Tex gets it as taken back and answers nothing"}
                onClick={() => {
                  close();
                  void unsendText(r.id);
                }}
              >
                ⌫ Delete <span className="meta">Undo Send</span>
              </button>
            </>
          ) : null}
          <div className="mnote">As {sb.as || "you"}; Tex runs on each.</div>
        </div>
      )}
    </Pop>
  );
}

export function SandboxChat() {
  const sb = useSandbox();
  const s = useLab();
  const { play, pick } = usePlay();
  const ready = useSandboxCall();
  const upload = usePicUpload();
  const [text, setText] = useState(() => takeDraft()?.text ?? "");
  const [folded, setFolded] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pics, setPics] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const fileIn = useRef<HTMLInputElement>(null);
  const txt = useRef<HTMLInputElement>(null);
  const versionId = s.cur.id;
  noteRan(sb.rows);
  // A test chat once the gateway can be reached, and a fresh one when the Lab opens a different version. A switch
  // while a call is in flight waits for it: `busy` going false runs this again. Reset opens its own fresh chat.
  const started = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (!started.current) {
      // A chat already being opened ("Try from here" opens one before this mounts) is waited for, not opened twice.
      if (sb.busy) return;
      started.current = true;
      if (!sb.chats.length) void readSandboxChats();
      if (sb.id === null || sb.versionId !== versionId) void openSandbox(sb.source, versionId);
      return;
    }
    if (!sb.busy && sb.versionId !== versionId) void openSandbox(sb.source, versionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, versionId, sb.busy]);
  // A reply to, or an edit of, a text that's gone (back, delete, another chat) is dropped.
  useEffect(() => {
    if (replyTo && !sb.rows.some((r) => r.id === replyTo)) setReplyTo(null);
    if (editing && !sb.rows.some((r) => r.id === editing)) setEditing(null);
  }, [sb.rows, replyTo, editing]);

  const byId = new Map(sb.rows.map((r) => [r.id, r]));
  const quoteOf = (id?: string) => {
    const q = id ? byId.get(id) : undefined;
    return q ? `${q.tex ? "Tex" : q.who}: ${q.text}` : undefined;
  };
  const rows: TextRow[] = [];
  let sep = false;
  for (const r of sb.rows) {
    if (!r.prod && !sep) {
      rows.push({ id: "sep", who: "", text: "", sep: "Test texts" });
      sep = true;
    }
    rows.push({
      id: r.id,
      who: r.tex ? "Tex" : r.who,
      text: r.kind === "unsend" ? "took back a text" : r.unsent ? r.text + " (unsent)" : r.text,
      tex: r.tex,
      quiet: r.quiet,
      prod: r.prod,
      test: !r.prod,
      steps: r.steps,
      running: sb.running === r.id,
      hot: sb.running === r.id ? sb.hot : null,
      quote: quoteOf(r.replyTo ?? (r.kind === "edit" || r.kind === "unsend" ? r.on : undefined)),
      pics: r.pics,
      reactions: r.reactions?.map((x) => x.emoji),
      edited: r.edited,
      evt: !!r.kind,
    });
  }

  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/")).slice(0, Math.max(0, MAX_PICS - pics.length));
    if (!imgs.length) return;
    setUploading((n) => n + imgs.length);
    const got = await Promise.all(
      imgs.map((f) =>
        upload(f).catch((e: unknown) => {
          sandboxProblem(e instanceof Error ? e.message : "Couldn't upload that picture");
          return null;
        }),
      ),
    );
    setUploading((n) => n - imgs.length);
    const urls = got.map((p) => p?.url).filter((u): u is string => !!u && u.startsWith("https://"));
    if (urls.length) setPics((ps) => [...ps, ...urls].slice(0, MAX_PICS));
  };
  const canSend = !sb.running && !sb.busy && !uploading && (editing ? !!text.trim() : !!sb.as && (!!text.trim() || pics.length > 0));
  const send = () => {
    if (!canSend) return;
    const t = text.trim();
    if (editing) {
      setText("");
      setEditing(null);
      void editText(editing, t);
      return;
    }
    const extra = { pics, ...(replyTo ? { replyTo } : {}) };
    setText("");
    setPics([]);
    setReplyTo(null);
    void sendText(t, extra);
  };
  const reply = replyTo ? byId.get(replyTo) : undefined;
  const edited = editing ? byId.get(editing) : undefined;
  const playing = (id: string) => play?.msgId === id;

  return (
    <section
      className={"sbx" + (folded ? " min" : "")}
      id="sandbox"
      aria-label="Test chat"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <TextGrid
        gridKey="sandbox"
        id="sbGrid"
        rows={rows}
        folded={folded}
        sel={pick?.msgId ?? null}
        selCol={pick?.upto ?? null}
        onRow={(r, col) => {
          if (!r.steps?.length) return;
          pickStep(r.id, col && col !== "who" && col !== "text" ? col : null);
        }}
        empty={<div className="scne">{sb.busy ? "Opening the test chat…" : sb.problem || `Text Tex below to try ${s.cur.name} in this chat`}</div>}
        head={
          <>
            <button className="ib" id="sbFold" aria-label={folded ? "Open the test chat" : "Fold the test chat"} title={folded ? "Open the test chat" : "Fold the test chat"} aria-expanded={!folded} onClick={() => setFolded(!folded)}>
              {folded ? "▴" : "▾"}
            </button>
            <b className="dtitle">Test chat</b>
            <span className="sbxtag" title="Nothing here reaches the real chat, the workspace or anyone's phone">
              Sandbox
            </span>
            <ChatPick versionId={versionId} />
            {sb.writes.length ? (
              <Pop id="sbChanges" className="ghost" button={<>{sb.writes.length} sandbox change{sb.writes.length > 1 ? "s" : ""} ▾</>}>
                {() => (
                  <div className="vmenu sbwrites">
                    <div className="mh">What Tex would have changed</div>
                    {sb.writes.map((w, k) => (
                      <div className="wr" key={k}>
                        <span className="k">{w.kind}</span>
                        <span>{w.summary}</span>
                      </div>
                    ))}
                    <div className="mnote">Kept in the sandbox only.</div>
                  </div>
                )}
              </Pop>
            ) : null}
            {sb.problem && sb.rows.length ? <span className="small c-bad">{sb.problem}</span> : null}
          </>
        }
        headEnd={
          <button className="ghost" id="sbReset" title="Throw away the test texts and start again from the real chat" disabled={sb.busy} onClick={() => void resetSandbox()}>
            Reset
          </button>
        }
        actions={(r) => {
          const src = byId.get(r.id);
          const stale = isStale(r.id);
          const sum = src?.steps?.reduce((a, x) => a + (x.ms ?? 0), 0) ?? 0;
          return (
            <>
              {!r.tex && r.steps?.length ? (
                <button
                  className={"play" + (stale ? " stale" : "")}
                  data-play={r.id}
                  disabled={(!!sb.running && !playing(r.id)) || sb.busy}
                  title={(stale ? "The version changed since this ran: ▶ runs it again on live models for a fresh answer" : "Nothing changed since this ran: ▶ plays back what it did, no new model calls") + ` (${msWords(sum)} · ${r.steps.length} steps)`}
                  onClick={() => void playText(r.id)}
                >
                  {playing(r.id) ? "⏸ " + msWords(play!.t) : "▶"}
                </button>
              ) : null}
              <button data-back={r.id} title="Go back to here: remove everything after this text, with the sandbox changes it made" disabled={!!sb.running || sb.busy} onClick={() => void backTo(r.id)}>
                ⤺
              </button>
              {r.test && !r.tex ? (
                <button data-drop={r.id} title="Delete this text and everything after it" disabled={!!sb.running || sb.busy} onClick={() => void dropText(r.id)}>
                  🗑
                </button>
              ) : null}
            </>
          );
        }}
        msgExtra={(r) => {
          const src = byId.get(r.id);
          if (!src) return null;
          // A row with no words (pictures only, a quiet or noted reply) can't be tapped or replied to.
          return r.evt || !src.text || src.quiet ? null : (
            <MsgOptions
              r={src}
              onReply={() => {
                setEditing(null);
                setReplyTo(src.id);
                txt.current?.focus();
              }}
              onEdit={() => {
                setReplyTo(null);
                setPics([]);
                setEditing(src.id);
                // The words it says now: its latest edit's, else its own.
                setText([...sb.rows].reverse().find((x) => x.kind === "edit" && x.on === src.id)?.text ?? src.text);
                txt.current?.focus();
              }}
            />
          );
        }}
      />
      {folded ? null : (
        <>
          {reply || edited || pics.length || uploading ? (
            <div className="pend" id="sbPend">
              {edited ? (
                <span className="chip">
                  <span>
                    ✎ Editing {edited.who}'s text: {edited.text}
                  </span>
                  <button
                    type="button"
                    id="sbEditX"
                    aria-label="Cancel the edit"
                    onClick={() => {
                      setEditing(null);
                      setText("");
                    }}
                  >
                    ✕
                  </button>
                </span>
              ) : null}
              {reply ? (
                <span className="chip">
                  <span>
                    ↩ Replying to {reply.tex ? "Tex" : reply.who}: {reply.text}
                  </span>
                  <button type="button" id="sbPendX" aria-label="Cancel the reply" onClick={() => setReplyTo(null)}>
                    ✕
                  </button>
                </span>
              ) : null}
              {pics.map((u, i) => (
                <span className="th" key={u + i}>
                  <img src={u} alt="Picture to send" />
                  <button type="button" data-unpic={i} aria-label="Remove the picture" onClick={() => setPics((ps) => ps.filter((_, k) => k !== i))}>
                    ✕
                  </button>
                </span>
              ))}
              {uploading ? <span className="small muted">Uploading…</span> : null}
            </div>
          ) : null}
          <form
            className="sbc"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <span className="lbl">as</span>
            <select id="sbAs" aria-label="Send as" value={sb.as} onChange={(e) => sendAs(e.target.value)}>
              {sb.people.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <button className="ib" type="button" id="sbAtt" title="Add a picture (or paste or drop one)" aria-label="Add a picture" disabled={pics.length >= MAX_PICS} onClick={() => fileIn.current?.click()}>
              <svg className="i" viewBox="0 0 24 24">
                <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
                <circle cx="9" cy="10" r="1.6" />
                <path d="M20 16l-5-5-8 8" />
              </svg>
            </button>
            <input
              type="file"
              id="sbAttIn"
              accept="image/*"
              multiple
              hidden
              ref={fileIn}
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <input
              id="sbTxt"
              ref={txt}
              aria-label="Test text"
              autoComplete="off"
              placeholder={sb.as ? `Text as ${sb.as}…` : "Text Tex…"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => {
                const fs = Array.from(e.clipboardData?.files ?? []);
                if (fs.length) {
                  e.preventDefault();
                  void addFiles(fs);
                }
              }}
            />
            <button className="primary" id="sbSend" type="submit" disabled={!canSend}>
              {editing ? "Save edit" : "Send"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}

/** What the canvas lights: the test text running (its steps so far and the one running), the one playing, or the one picked. */
export function useSandboxLit(): Lit | ReadonlySet<string> | null {
  const sb = useSandbox();
  usePlay();
  if (sb.running) {
    const r = sb.rows.find((x) => x.id === sb.running);
    const ids = new Set((r?.steps || []).map((x) => x.node));
    if (sb.hot) ids.add(sb.hot);
    return ids.size ? ids : null;
  }
  const p = playLit();
  if (p) return p;
  const r = [...sb.rows].reverse().find((x) => !x.prod && !x.tex && x.steps?.length);
  return r ? new Set((r.steps || []).map((x) => x.node)) : null;
}
