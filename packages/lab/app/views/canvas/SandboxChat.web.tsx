/**
 * The test chat docked under the Architecture canvas (decluttered Lab, mockup
 * https://claude.ai/artifact/W21NekNf2vtnFLXXzAmp7N, approved by Dev2 2026-11-16): pick a chat from your account, the
 * test account or the Training / Dev sets (never the Test set), text as anyone in it, and the version open in the Lab
 * answers on live models; every step's output fills its column. One ▶ per text (`engine/sandboxPlay.ts`) plays back
 * what ran, or runs it fresh once the version changed; ⤺ goes back to a text and 🗑 deletes it. Each message's ⋯ reacts
 * or replies, edits or takes back (Delete, iMessage's Undo Send) a test text, and the composer takes pictures (picked,
 * pasted or dropped), each run as production runs it (`docs/decisions/texting-assistant/edits-and-unsends.md`). Nothing
 * reaches the real chat, the workspace or anyone's phone. Folds to its head with ▾.
 *
 * Lab live sandbox (approved by Dev2 2026-11-16, mockup https://claude.ai/artifact/XtEn67XPWMTFVUBYanYLG5): the head's
 * Grid | Timeline switch shows the texts or the run playing (`SandboxTimeline.web.tsx`) in the same space, a text sent
 * plays at once on the Timeline, ▶ on one of Tex's texts plays only the steps that led to it, and the grip on the top
 * edge makes the dock taller or shorter.
 */
import { useEffect, useRef, useState } from "react";
import { attachSandbox, takeUrlSandbox, tryFromHere, backTo, dropText, editText, reactTo, unsendText, readSandboxChats, sandboxProblem, takeDraft, openSandbox, resetSandbox, sendAs, sendText, TAPBACKS, useSandbox, type SandboxRow } from "../../engine/sandbox";
import { isStale, noteRan, pickStep, playExternal, playLit, playTexText, playText, setDockView, usePlay } from "../../engine/sandboxPlay";
import { chatKeyOf, playProd } from "../mine/playProd";
import { texCauseRun } from "../../engine/sandboxRun";
import { stepsWord } from "../../engine/playRun";
import { sinceOf } from "../../engine/stepRunNow";
import { DockSwitch, SandboxTimeline } from "./SandboxTimeline.web";
import { useDockHeight } from "./useDockHeight.web";
import { usePicUpload } from "./usePicUpload";
import { useLab } from "../../store";
import { useSandboxCall } from "./sandboxCall";
import { TextGrid, msWords, type TextRow } from "../grid/TextGrid.web";
import { Pop } from "../bar/Pop.web";
import { SandboxWrites } from "./SandboxWrites.web";
import { ChatPick } from "./SandboxChatPick.web";
import type { Lit } from "./usePlayback";

const MAX_PICS = 6;
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

/** A US number as a phone shows it: "+14157918922" as "+1 (415) 791-8922"; any other as given. */
export const phoneWords = (n: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(n.replace(/[\s()-]/g, ""));
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : n;
};

/** The line between the real chat's texts and the test texts (the mockup's "Sandbox from here"). */
export const sandboxFromHere = (copied: number) =>
  copied ? `Test from here · copied ${copied.toLocaleString("en-US")} text${copied === 1 ? "" : "s"} from your real chat · writes stay in the test chat` : "Test from here · writes stay in the test chat";

export function SandboxChat() {
  const sb = useSandbox();
  const s = useLab();
  const { play, pick, view } = usePlay();
  const dock = useDockHeight();
  const ready = useSandboxCall();
  const upload = usePicUpload();
  const [text, setText] = useState(() => takeDraft()?.text ?? "");
  const [folded, setFolded] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pics, setPics] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  // A real text's run being read from production's log.
  const [reading, setReading] = useState<string | null>(null);
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
      // A link to a test chat (`/lab?testchat=<id>`) opens that one, followed live, whoever texts in it.
      const linked = takeUrlSandbox();
      if (linked) {
        void attachSandbox(linked, versionId);
        return;
      }
      if (sb.id === null || sb.versionId !== versionId) void openSandbox(sb.source, versionId);
      return;
    }
    // A shared test chat stays open: someone else may be texting in it.
    if (!sb.busy && !sb.shared && sb.versionId !== versionId) void openSandbox(sb.source, versionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, versionId, sb.busy]);
  // "Sandbox from here" on a real text puts it in the composer, as whoever sent it.
  useEffect(() => {
    if (!sb.draft) return;
    const d = takeDraft();
    if (d) setText(d.text);
  }, [sb.draft]);
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
  const copied = sb.rows.filter((r) => r.prod && !r.kind).length;
  for (const r of sb.rows) {
    if (!r.prod && !sep) {
      rows.push({ id: "sep", who: "", text: "", sep: sandboxFromHere(copied) });
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
      // A step still running shows only that it runs and for how long: its output once it is logged.
      steps: sb.running === r.id ? r.steps?.map((x) => (x.ms === null ? { ...x, runningFor: typeof x.at === "number" && typeof r.at === "number" ? Math.max(0, Date.now() - r.at - x.at) : sinceOf(`${r.id}:${x.node}`) } : x)) : r.steps,
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
    // Once it shows, the Timeline plays it from its first step, trailing the live run (`onSandboxText`).
    void sendText(t, extra);
  };
  const reply = replyTo ? byId.get(replyTo) : undefined;
  const edited = editing ? byId.get(editing) : undefined;
  const playing = (id: string) => play?.id === id && play.playing;
  /**
   * ▶ on a real text: what production logged of it, played on the graph Tex had then (`views/mine/playProd.ts`). On
   * one of Tex's texts only the steps of the turn that sent it, when the log says which; never inferred.
   */
  const playReal = async (src: SandboxRow) => {
    if (play && (play.id === src.id || play.id.endsWith("#" + src.id)) && play.playing) return playText(play.id);
    if (typeof src.at !== "number") return;
    setReading(src.id);
    try {
      const p = await playProd({ id: src.id, at: src.at });
      const run = p ? (p.replies[src.id] ?? (src.tex || p.run.texts.some((t) => t.rowId === src.id) ? null : p.run)) : null;
      if (run && p) playExternal(run, p);
      else sandboxProblem(src.tex ? "The log doesn't say which steps sent this text" : "Nothing in the log says what this text ran");
    } catch (e) {
      sandboxProblem(e instanceof Error ? e.message : "Couldn't read what this text ran");
    } finally {
      setReading(null);
    }
  };
  const realChat = chatKeyOf(sb.source, sb.chats) !== null;
  // T switches Grid and Timeline, as the mockup's; never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "t" && e.key !== "T")) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, select, textarea, [contenteditable=true]")) return;
      setDockView(view === "timeline" ? "grid" : "timeline");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view]);

  return (
    <section
      className={"sbx" + (folded ? " min" : "") + (dock.drag ? " drag" : "")}
      id="sandbox"
      aria-label="Test chat"
      style={folded || dock.h === null ? undefined : { height: dock.h }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div className="sbgrip" id="sbGrip" title="Drag to make it taller or shorter" aria-hidden="true" {...dock.grip} />
      <TextGrid
        gridKey="sandbox"
        id="sbGrid"
        rows={rows}
        folded={folded}
        bottomKey={`${sb.id}|${folded}|${view}|${rows.length}|${rows[rows.length - 1]?.id ?? ""}`}
        alt={view === "timeline" ? <SandboxTimeline /> : undefined}
        sel={pick?.msgId ?? null}
        selCol={pick?.upto ?? null}
        onRow={(r, col) => {
          if (!r.steps?.length) return;
          pickStep(r.id, col && col !== "who" && col !== "text" ? col : null);
        }}
        empty={
          <div className="scne">
            {sb.busy ? "Opening the test chat…" : sb.problem || (sb.preview?.starting ? `Starting pull request #${sb.preview.pr}'s preview: its GitHub run takes about a minute` : `Text Tex below to try ${s.cur.name} in this chat`)}
            {!sb.busy && sb.problem && sb.linked ? (
              <>
                {" "}
                <button className="ghost" id="sbLinkRetry" onClick={() => void attachSandbox(sb.linked as string, versionId)}>
                  Try again
                </button>
              </>
            ) : null}
          </div>
        }
        head={
          <>
            <button className="ib" id="sbFold" aria-label={folded ? "Open the test chat" : "Fold the test chat"} title={folded ? "Open the test chat" : "Fold the test chat"} aria-expanded={!folded} onClick={() => setFolded(!folded)}>
              {folded ? "▴" : "▾"}
            </button>
            <b className="dtitle">Test chat</b>
            {sb.preview ? (
              <span className="sbxtag" id="sbCode" title={`Pull request #${sb.preview.pr}'s own preview answers: its code, its fictional people, never production's data`}>
                PR #{sb.preview.pr}
              </span>
            ) : (
              <span className="sbxtag" title="Nothing here reaches the real chat, the workspace or anyone's phone">
                Test only
              </span>
            )}
            <ChatPick versionId={versionId} />
            <DockSwitch view={view} onView={setDockView} />
            <SandboxWrites />
            {sb.problem && sb.rows.length ? <span className="small c-bad">{sb.problem}</span> : null}
            {sb.fit && !sb.fit.asDrawn ? (
              <span className="small c-bad" id="sbNotAsDrawn" title={sb.fit.says}>
                Not the draft as drawn: {sb.fit.says ?? "some of its steps run as main's"}
              </span>
            ) : null}
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
              {r.prod && realChat && src && typeof src.at === "number" ? (
                <button
                  className="play"
                  data-play-prod={r.id}
                  disabled={reading !== null}
                  title={r.tex ? "Replay the steps that sent this text, as they ran in prod" : "Replay what ran in prod, on the graph Tex had then"}
                  onClick={() => void playReal(src)}
                >
                  {reading === r.id ? "…" : play?.playing && (play.id === r.id || play.id.endsWith("#" + r.id)) ? "⏸" : "▶"}
                </button>
              ) : null}
              {r.prod && !r.tex && src && (sb.source.kind === "chat" || sb.source.kind === "shared") ? (
                <button
                  data-fork={r.id}
                  title="Test from here: a test chat with the real texts before this one, and this text ready to send"
                  disabled={!!sb.running || sb.busy}
                  onClick={() => {
                    const c = sb.source;
                    if (c.kind === "chat" || c.kind === "shared") void tryFromHere(c.chatId, c.name, src.id, sb.handles[src.who] ?? src.who, src.text, c.kind);
                  }}
                >
                  ⑂
                </button>
              ) : null}
              {!r.prod && r.tex
                ? (() => {
                    // Only the steps the gateway logged as leading to it; with no `cause`, no ▶ (never inferred).
                    const cr = texCauseRun(r.id, sb.rows);
                    return cr ? (
                      <button className="play" data-play-tex={r.id} disabled={sb.busy} title={`Play the ${stepsWord(new Set(cr.steps.map((x) => x.node)).size)} that led to this text`} onClick={() => void playTexText(cr.id)}>
                        {playing(cr.id) ? "⏸" : "▶"}
                      </button>
                    ) : null;
                  })()
                : null}
              {!r.tex && r.steps?.length ? (
                <button
                  className={"play" + (stale ? " stale" : "")}
                  data-play={r.id}
                  disabled={(!!sb.running && !playing(r.id)) || sb.busy}
                  title={(stale ? "The version changed since this ran: ▶ runs it again on live models for a fresh answer" : "Nothing changed since this ran: ▶ plays back what it did, no new model calls") + ` (${msWords(sum)} · ${stepsWord(r.steps.length)})`}
                  onClick={() => void playText(r.id)}
                >
                  {playing(r.id) ? "⏸ " + msWords(play!.t) : "▶"}
                </button>
              ) : null}
              <button data-back={r.id} title="Go back to here: remove everything after this text, with the test changes it made" disabled={!!sb.running || sb.busy} onClick={() => void backTo(r.id)}>
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
              placeholder={sb.line?.number ? `Text Tex at ${phoneWords(sb.line.number)}…` : sb.as ? `Text as ${sb.as}…` : "Text Tex…"}
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
  // A playback first: what is playing, never ahead of it, even while the text runs.
  const p = playLit();
  if (p) return p;
  if (sb.running) {
    const r = sb.rows.find((x) => x.id === sb.running);
    const ids = new Set((r?.steps || []).map((x) => x.node));
    if (sb.hot) ids.add(sb.hot);
    return ids.size ? ids : null;
  }
  const r = [...sb.rows].reverse().find((x) => !x.prod && !x.tex && x.steps?.length);
  return r ? new Set((r.steps || []).map((x) => x.node)) : null;
}
