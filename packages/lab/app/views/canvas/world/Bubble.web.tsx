/**
 * One bubble of the Chat view (artboards 06 to 08 of `group-chat-sim-artboards/`): its text (@mentions bold), its
 * pictures or card, its tapbacks and Edited, and, on hover, the Lab's tools beside it: React (the tapback picker, as
 * whoever you text as), Reply, and More (Edit and Undo Send as its sender, Copy, Retry from here, Delete, Show its
 * steps in Grid). An edit opens in the bubble itself. Each runs as the Grid's ⋯ does, through the test chat's ops.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { dropText, editText, reactTo, retryText, TAPBACKS, unsendText, useSandbox } from "../../../engine/sandbox";
import { pickStep, setDockView } from "../../../engine/sandboxPlay";
import { firstName } from "./worldModel";
import type { Bubble } from "./chatModel";
import { setFill } from "./worldStore";

/** "@Tex" and "@Name" bold in accent; the rest as typed. */
export function withMentions(text: string, names: string[]): ReactNode {
  const short = [...new Set(["Tex", ...names.map(firstName), ...names])].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`@(${short.join("|")})\\b`, "g");
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(at, m.index));
    out.push(
      <span key={m.index} className={"mn" + (m[1] === "Tex" ? " tx" : "")}>
        @{m[1]}
      </span>,
    );
    at = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(at));
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const wave = (n: number) => Array.from({ length: n }, (_, k) => 6 + Math.round(18 * Math.abs(Math.sin(k * 1.7) * Math.cos(k * 0.43))));

/** A card a row carries (`media`): a voice message, a file, a link preview, a contact or a sticker; else its words. */
function mediaOf(m: Record<string, unknown>): { body: ReactNode; raw: boolean } {
  const kind = str(m.kind);
  if (kind === "voice")
    return {
      raw: false,
      body: (
        <span className="voice bt">
          <span className="pl">▶</span>
          <span className="vwf">
            {wave(34).map((h, k) => (
              <i key={k} style={{ height: h }} />
            ))}
          </span>
          <span className="du">{str(m.duration) || str(m.d)}</span>
        </span>
      ),
    };
  if (kind === "file")
    return {
      raw: false,
      body: (
        <span className="filec bt">
          <span className="fi">{(str(m.ext) || str(m.name).split(".").pop() || "file").toUpperCase().slice(0, 4)}</span>
          <span>
            <span className="fn" style={{ display: "block" }}>
              {str(m.name)}
            </span>
            <span className="fs">{str(m.size)}</span>
          </span>
        </span>
      ),
    };
  if (kind === "link") {
    const url = str(m.url);
    const img = str(m.image);
    const inner = (
      <>
        {img.startsWith("https://") ? (
          <div className="li">
            <img src={img} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
        ) : null}
        <div className="lt">
          <b>{str(m.title) || url}</b>
          <span>{str(m.site)}</span>
        </div>
      </>
    );
    return {
      raw: true,
      body: (
        <div className="lnk">
          {url.startsWith("https://") ? (
            <a href={url} target="_blank" rel="noreferrer">
              {inner}
            </a>
          ) : (
            inner
          )}
        </div>
      ),
    };
  }
  if (kind === "contact")
    return {
      raw: false,
      body: (
        <span className="contact bt">
          <span className="ca">
            {str(m.initials) ||
              str(m.name)
                .split(/\s+/)
                .map((w) => w[0])
                .join("")
                .slice(0, 2)}
          </span>
          <span>
            <span className="cn" style={{ display: "block" }}>
              {str(m.name)}
            </span>
            <span className="cs">{str(m.sub)}</span>
          </span>
          <span className="chev">›</span>
        </span>
      ),
    };
  if (kind === "sticker") return { raw: true, body: <span className="stk alone">{str(m.emoji)}</span> };
  return { raw: false, body: <span className="bt">{str(m.text) || str(m.title) || str(m.name) || kind || "An attachment"}</span> };
}

/** Closes a menu on a click outside `ref`. */
function useAway(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, ref, close]);
}

export function BubbleView({ b, tail, names, onReply }: { b: Bubble; tail: boolean; names: string[]; onReply: (id: string) => void }) {
  const sb = useSandbox();
  const [open, setOpen] = useState<null | "react" | "more">(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [any, setAny] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const close = () => setOpen(null);
  useAway(open !== null, box, close);
  const r = b.row;
  const idle = !sb.running && !sb.busy;
  const own = !r.prod && !r.tex && !r.kind && !r.unsent;
  const who = firstName(r.who);
  const as = firstName(sb.as || "you");
  if (b.kind === "typing")
    return (
      <div className="bw">
        <span className="b tail" style={{ padding: 0 }}>
          <span className="typing bt">
            <i />
            <i />
            <i />
          </span>
        </span>
      </div>
    );
  const m = b.kind === "media" && b.media ? mediaOf(b.media) : null;
  const raw = b.kind === "pics" || !!m?.raw;
  const body =
    b.kind === "pics" ? (
      <div className={"pgr n" + Math.min(b.pics?.length ?? 1, 6)}>
        {(b.pics ?? []).map((u) => (
          <img key={u} className="ph1" src={u} alt="Picture sent" />
        ))}
      </div>
    ) : m ? (
      m.body
    ) : (
      <span className="bt">{withMentions(b.text, names)}</span>
    );
  const tbs = b.reactions?.length ? (
    <span className="tbs">
      {b.reactions.map((t, k) => (
        <span key={k} className={"tbk" + (t.who === sb.as || t.who === sb.handles[sb.as] ? " me" : "") + (t.who === "Tex" ? " tex" : "")} title={t.who}>
          {t.emoji}
        </span>
      ))}
    </span>
  ) : null;
  const react = (e: string) => {
    close();
    void reactTo(r.id, e);
  };
  if (edit !== null)
    return (
      <div className="bw">
        <div className="edf">
          <input
            className="ein"
            aria-label="Edit the text"
            value={edit}
            autoFocus
            onChange={(e) => setEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && edit.trim()) {
                setEdit(null);
                void editText(r.id, edit.trim());
              }
              if (e.key === "Escape") setEdit(null);
            }}
          />
          <button className="ok" aria-label="Save edit" disabled={!edit.trim() || !idle} onClick={() => (setEdit(null), void editText(r.id, edit.trim()))}>
            ✓
          </button>
          <button className="x" aria-label="Cancel" onClick={() => setEdit(null)}>
            ✕
          </button>
        </div>
        <div className="ednote">Editing as {who} · Tex gets it as an iMessage edit, and the judge runs again</div>
      </div>
    );
  return (
    <div className={"bw" + (open ? " act" : "")} ref={box} data-msg={r.id}>
      {raw ? (
        body
      ) : (
        <span className={"b" + (tail ? " tail" : "") + (open ? " lift" : "")} style={m ? { padding: 0 } : undefined}>
          {body}
        </span>
      )}
      {tbs}
      <span className="hov">
        <button className="ib" title="React" aria-pressed={open === "react"} disabled={!idle} onClick={() => setOpen(open === "react" ? null : "react")}>
          ☺︎
        </button>
        <button className="ib" title="Reply" onClick={() => onReply(r.id)}>
          ↩
        </button>
        <button className="ib" title="More" aria-pressed={open === "more"} onClick={() => setOpen(open === "more" ? null : "more")}>
          ⋯
        </button>
      </span>
      {open === "react" ? (
        <div className="tpk">
          {TAPBACKS.map((e) => (
            <button key={e} data-tap={e} onClick={() => react(e)}>
              {e}
            </button>
          ))}
          <input className="anyin" aria-label="Any emoji" title="Any emoji" placeholder="☺︎" value={any} onChange={(e) => setAny(e.target.value)} onKeyDown={(e) => e.key === "Enter" && any.trim() && (react(any.trim()), setAny(""))} />
          <span className="asw">as {as}</span>
        </div>
      ) : null}
      {open === "more" ? (
        <div className="popm ctxm" role="menu">
          <div className="vmenu">
            <button className="mi" onClick={() => (close(), onReply(r.id))}>
              ↩ <span className="nm">Reply</span>
            </button>
            {own ? (
              <Fragment>
                <button className="mi" data-edit-open={r.id} disabled={!idle} onClick={() => (close(), setEdit(b.text))}>
                  ✎ <span className="nm">Edit as {who}</span>
                </button>
                <button className="mi" data-unsend={r.id} disabled={!idle} onClick={() => (close(), void unsendText(r.id))}>
                  ⌫ <span className="nm">Undo Send as {who}</span>
                </button>
              </Fragment>
            ) : null}
            <button className="mi" onClick={() => (close(), void navigator.clipboard?.writeText(b.text).catch(() => {}))}>
              ⧉ <span className="nm">Copy</span>
            </button>
            {!r.prod && !r.tex ? (
              <>
                <hr />
                <button className="mi" data-retry={r.id} disabled={!idle} onClick={() => (close(), void retryText(r.id))}>
                  ⟲ <span className="nm">Retry from here</span>
                  <span className="meta">Tex runs again</span>
                </button>
                <button className="mi danger" data-drop={r.id} style={{ color: "var(--bad)" }} disabled={!idle} onClick={() => (close(), void dropText(r.id))}>
                  🗑 <span className="nm">Delete</span>
                  <span className="meta">and what came after</span>
                </button>
              </>
            ) : null}
            {r.steps?.length || r.reply ? (
              <>
                <hr />
                <button
                  className="mi"
                  onClick={() => {
                    close();
                    setFill(false);
                    setDockView("grid");
                    pickStep(r.reply ?? r.id, null);
                  }}
                >
                  ▦ <span className="nm">Show its steps in Grid</span>
                </button>
              </>
            ) : null}
            {own ? <div className="mnote">Edits and Undo Send reach Tex as real iMessage events.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
