/**
 * The Chat view's composer (artboard 09 of `group-chat-sim-artboards/`): Texting as (a chip for everyone in the chat
 * but Tex), a round + (Photo; the other kinds wait for the line work), a pill field with the send arrow inside, a
 * staged photo as a thumbnail, and typing @ lists Tex first, then everyone here but you. The words, pictures, reply
 * and edit are the Grid composer's (`useComposer.ts`).
 */
import { useRef, useState } from "react";
import { sendAs, useSandbox } from "../../../engine/sandbox";
import { MAX_PICS, type Composer } from "../useComposer";
import { Av } from "./parts.web";
import { firstName, type Account } from "./worldModel";

const arrow = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

/** The @mention being typed at the end of the words, if any. */
export const mentionAt = (text: string): string | null => /(?:^|\s)@([\p{L}\p{N}]*)$/u.exec(text)?.[1] ?? null;

export function ChatComposer({ c, account, hint }: { c: Composer; account: (name: string) => Account; hint?: string }) {
  const sb = useSandbox();
  const [plus, setPlus] = useState(false);
  const [hi, setHi] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const as = firstName(sb.as || "");
  const q = mentionAt(c.text);
  const options =
    q === null
      ? []
      : [{ name: "Tex", tex: true }, ...sb.people.filter((p) => p !== sb.as).map((name) => ({ name, tex: false }))].filter(
          (o) =>
            !q ||
            o.name
              .toLowerCase()
              .split(/\s+/)
              .some((w) => w.startsWith(q.toLowerCase())),
        );
  const pick = (name: string) => {
    c.setText(c.text.replace(/@([\p{L}\p{N}]*)$/u, "@" + firstName(name) + " "));
    setHi(0);
    c.txt.current?.focus();
  };
  const reply = c.replyTo ? sb.rows.find((r) => r.id === c.replyTo) : undefined;
  const edited = c.editing ? sb.rows.find((r) => r.id === c.editing) : undefined;
  return (
    <div className="imcw" id="sbCompose">
      {reply || edited || c.uploading ? (
        <div className="pend" id="sbPend">
          {edited ? (
            <span className="chip">
              <span>✎ Editing {firstName(edited.who)}&apos;s text</span>
              <button type="button" aria-label="Cancel the edit" onClick={() => (c.setEditing(null), c.setText(""))}>
                ✕
              </button>
            </span>
          ) : null}
          {reply ? (
            <span className="chip">
              <span>
                ↩ Replying to {reply.tex ? "Tex" : firstName(reply.who)}: {reply.text}
              </span>
              <button type="button" id="sbPendX" aria-label="Cancel the reply" onClick={() => c.setReplyTo(null)}>
                ✕
              </button>
            </span>
          ) : null}
          {c.uploading ? <span className="small muted">Uploading…</span> : null}
        </div>
      ) : null}
      <div className="asrow" role="group" aria-label="Texting as">
        <span className="lbl">Texting as</span>
        {sb.people.map((p) => {
          const a = account(p);
          return (
            <button key={p} type="button" className="asc" data-as={p} aria-pressed={p === sb.as} title={p} onClick={() => sendAs(p)}>
              <Av name={p} account={a} />
              {firstName(p)}
              {a === "off" ? <span style={{ color: "var(--dim)", fontWeight: 400 }}> · not on Context</span> : null}
            </button>
          );
        })}
        <span className="note2">{hint ?? "Pick who you are; your texts go on the right"}</span>
      </div>
      <form
        className="imc"
        ref={form}
        onSubmit={(e) => {
          e.preventDefault();
          c.send();
        }}
      >
        <button className="plus" type="button" aria-expanded={plus} aria-label="Add a photo or more" id="sbPlus" onClick={() => setPlus(!plus)}>
          +
        </button>
        <div className="ifld">
          {c.pics.length ? (
            <div className="stg">
              {c.pics.map((u, i) => (
                <span className="th2" key={u + i}>
                  <img src={u} alt="Picture to send" />
                  <button type="button" data-unpic={i} aria-label="Remove the picture" onClick={() => c.setPics((ps) => ps.filter((_, k) => k !== i))}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="row1">
            <input
              className={"tx" + (c.text ? " has" : "")}
              id="sbTxt"
              ref={c.txt}
              aria-label="Test text"
              autoComplete="off"
              placeholder={c.editing ? "The new words" : `Text as ${as || "…"}`}
              value={c.text}
              onChange={(e) => {
                c.setText(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (!options.length) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setHi((h) => (h + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
                } else if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pick(options[Math.min(hi, options.length - 1)].name);
                }
              }}
              onPaste={(e) => {
                const fs = Array.from(e.clipboardData?.files ?? []);
                if (fs.length) {
                  e.preventDefault();
                  void c.addFiles(fs);
                }
              }}
            />
            <button className="send" id="sbSend" type="submit" disabled={!c.canSend} aria-label={c.editing ? "Save edit" : "Send"}>
              {arrow}
            </button>
          </div>
        </div>
        <input
          type="file"
          id="sbAttIn"
          accept="image/*"
          multiple
          hidden
          ref={c.fileIn}
          onChange={(e) => {
            void c.addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        {plus ? (
          <div className="popm pmenu" role="menu">
            <div className="vmenu">
              <button
                type="button"
                className="mi"
                id="sbAtt"
                disabled={c.pics.length >= MAX_PICS}
                onClick={() => {
                  setPlus(false);
                  c.fileIn.current?.click();
                }}
              >
                <span className="ic">🖼</span>
                <span className="nm">Photo</span>
                <span className="meta">pick, paste or drop</span>
              </button>
              {(
                [
                  ["🎙", "Voice message"],
                  ["📄", "File"],
                  ["🔗", "Link"],
                ] as const
              ).map(([ic, w]) => (
                <button key={w} type="button" className="mi" disabled title="Test chats take words and photos for now">
                  <span className="ic">{ic}</span>
                  <span className="nm">{w}</span>
                  <span className="meta">not in test chats yet</span>
                </button>
              ))}
              <div className="mnote">Sent as {as || "you"}. Tex gets each as production does.</div>
            </div>
          </div>
        ) : null}
        {options.length ? (
          <div className="popm mmenu" role="listbox" id="sbMention">
            <div className="vmenu">
              <div className="mh">Mention</div>
              {options.map((o, i) => {
                const n = o.tex ? "Tex" : o.name;
                const k = q ? Math.min(q.length, n.length) : 0;
                return (
                  <button key={o.name} type="button" className="mi" aria-current={i === hi} onMouseDown={(e) => (e.preventDefault(), pick(o.name))}>
                    {o.tex ? <Av name="Tex" account="tex" size={22} /> : <Av name={o.name} account={account(o.name)} />}
                    <span className="nm">
                      <b>{n.slice(0, k)}</b>
                      {n.slice(k)}
                    </span>
                    {o.tex ? <span className="meta">answers when tagged</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </form>
    </div>
  );
}
