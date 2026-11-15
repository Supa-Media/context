/**
 * A message's own fields, as the prototype's grid editor and the inspector both show them: its type (a text, or a
 * reaction, reply, edit or delete of an earlier message), which message it points at, the reaction's emoji or the
 * words; and the speaker picker, with Tex and a new speaker.
 */
import { useState } from "react";
import { EMOJI, KIND_NAMES, type Conversation, type Message } from "../../engine/sets";
import { change, type Op } from "../../engine/setsStore";

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
