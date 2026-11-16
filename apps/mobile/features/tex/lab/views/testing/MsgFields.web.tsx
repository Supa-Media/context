/**
 * A message's own fields, as the prototype's grid editor and the inspector both show them: its type (a text, or a
 * reaction, reply, edit or delete of an earlier message), which message it points at, the reaction's emoji or the
 * words; and the speaker picker, with Tex and a new speaker.
 */
import { useState } from "react";
import { EMOJI, KIND_NAMES, type Conversation, type Message } from "../../engine/sets";
import { change, uploadPic, type Op } from "../../engine/setsStore";

/** Upload picked, pasted or dropped pictures and add them to the message (Dev2, 2026-11-16: "No way to add images into these messages"). */
export async function addPics(c: Conversation, m: Message, files: File[]) {
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  if (!imgs.length) return;
  const got = (await Promise.all(imgs.map((f) => uploadPic(f)))).filter((p): p is NonNullable<typeof p> => !!p);
  if (!got.length) return;
  change(c.id, [{ op: "edit", msg: m.id, field: "pics", value: [...(m.pics ?? []), ...got].slice(0, 6) }]);
}

/** A message's pictures with a remove on each, and + Picture to add more. */
function PicsEdit({ c, m }: { c: Conversation; m: Message }) {
  const pics = m.pics ?? [];
  return (
    <span className="pics" data-p="pics">
      {pics.map((p, k) => (
        <span key={k} className="pic">
          <img src={p.url} alt={p.name || "Picture"} />
          <button
            title="Remove picture"
            aria-label="Remove picture"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              change(c.id, [{ op: "edit", msg: m.id, field: "pics", value: pics.filter((_, j) => j !== k) }]);
            }}
          >
            ×
          </button>
        </span>
      ))}
      {pics.length < 6 ? (
        <label className="picadd" onMouseDown={(e) => e.preventDefault()}>
          + Picture
          <input
            type="file"
            accept="image/*"
            multiple
            data-p="picfile"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              void addPics(c, m, files);
            }}
          />
        </label>
      ) : null}
    </span>
  );
}

/** The ops a change of one message field makes. */
export function kindOps(c: Conversation, m: Message, v: string): Op[] {
  if (v === "text") return [{ op: "edit", msg: m.id, field: "kind", value: null }];
  const ops: Op[] = [{ op: "edit", msg: m.id, field: "kind", value: v }];
  if (v === "react" && !EMOJI.includes(m.text)) ops.push({ op: "edit", msg: m.id, field: "text", value: "👍" });
  return ops;
}

export function MsgFields({ c, m, cls, onDone, autoFocus }: { c: Conversation; m: Message; cls: string; onDone?: () => void; autoFocus?: boolean }) {
  const i = c.msgs.findIndex((x) => x.id === m.id);
  const k = m.kind || "text";
  const [text, setText] = useState(m.text);
  const keep = () => {
    if (text.trim() !== m.text) change(c.id, [{ op: "edit", msg: m.id, field: "text", value: text.trim() }]);
  };
  return (
    <>
      <select className={cls} data-p="kind" aria-label="Message type" value={k} onChange={(e) => change(c.id, kindOps(c, m, e.target.value))}>
        {KIND_NAMES.map(([v, t]) => (
          <option key={v} value={v} disabled={v !== "text" && i === 0}>
            {t}
          </option>
        ))}
      </select>
      {k !== "text" ? (
        <select className={cls} data-p="to" aria-label="Which message" value={m.to} onChange={(e) => change(c.id, [{ op: "edit", msg: m.id, field: "to", value: e.target.value }])}>
          {c.msgs
            .slice(0, i)
            .map((x, j) => (
              <option key={x.id} value={x.id}>
                #{j + 1} {x.who}: {(x.text || "").slice(0, 30)}
              </option>
            ))
            .reverse()}
        </select>
      ) : null}
      {k === "react" ? (
        <select className={cls} data-p="emoji" aria-label="Reaction" value={m.text} onChange={(e) => change(c.id, [{ op: "edit", msg: m.id, field: "text", value: e.target.value }])}>
          {EMOJI.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
      ) : k !== "delete" ? (
        <textarea
          className={cls}
          data-p="text"
          rows={2}
          autoFocus={autoFocus}
          placeholder={k === "edit" ? "the new wording" : "type the message"}
          aria-label="Message text"
          value={text}
          onFocus={(e) => autoFocus && e.currentTarget.select()}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (!files.some((f) => f.type.startsWith("image/"))) return;
            e.preventDefault();
            void addPics(c, m, files);
          }}
          onDrop={(e) => {
            const files = [...e.dataTransfer.files];
            if (!files.length) return;
            e.preventDefault();
            void addPics(c, m, files);
          }}
          onBlur={keep}
          onKeyDown={(e) => {
            if (!onDone) return;
            e.stopPropagation();
            if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
              e.preventDefault();
              keep();
              onDone();
            }
          }}
        />
      ) : null}
      {k !== "react" && k !== "delete" ? <PicsEdit c={c} m={m} /> : null}
    </>
  );
}

/** Who says a message: the chat's members, Tex, or a new speaker typed in. */
export function SpeakerPick({ c, m, cls, id, onDone, autoFocus }: { c: Conversation; m: Message; cls: string; id?: string; onDone?: () => void; autoFocus?: boolean }) {
  const [typing, setTyping] = useState(false);
  const say = (who: string) => {
    const v = who.trim();
    if (v && v !== m.who) change(c.id, [{ op: "edit", msg: m.id, field: "who", value: v }]);
    onDone?.();
  };
  if (typing)
    return (
      <input
        className={cls}
        autoFocus
        placeholder="New speaker's name"
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") say(e.currentTarget.value);
          else if (e.key === "Escape") onDone?.();
        }}
      />
    );
  return (
    <select
      className={cls}
      id={id}
      data-ed="who"
      aria-label="Speaker"
      autoFocus={autoFocus}
      value={m.tex ? "Tex" : m.who}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onDone?.();
      }}
      onChange={(e) => (e.target.value === "__new" ? setTyping(true) : say(e.target.value))}
    >
      {[...c.members, "Tex"].map((p) => (
        <option key={p}>{p}</option>
      ))}
      <option value="__new">+ New speaker…</option>
    </select>
  );
}
