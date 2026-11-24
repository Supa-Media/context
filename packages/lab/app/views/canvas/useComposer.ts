/**
 * The test chat composer's state, shared by the Grid's composer and the Chat view's (`world/Composer.web.tsx`): the
 * words, the pictures staged (picked, pasted or dropped, uploaded first), the text it replies to or edits, and
 * sending them as whoever the composer texts as.
 */
import { useEffect, useRef, useState } from "react";
import { editText, sandboxProblem, sendText, takeDraft, useSandbox } from "../../engine/sandbox";
import { usePicUpload } from "./usePicUpload";

export const MAX_PICS = 6;

export function useComposer() {
  const sb = useSandbox();
  const upload = usePicUpload();
  const [text, setText] = useState(() => takeDraft()?.text ?? "");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pics, setPics] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const fileIn = useRef<HTMLInputElement>(null);
  const txt = useRef<HTMLInputElement>(null);
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
  const reply = (id: string) => {
    setEditing(null);
    setReplyTo(id);
    txt.current?.focus();
  };
  return { text, setText, replyTo, setReplyTo, editing, setEditing, pics, setPics, uploading, addFiles, canSend, send, reply, fileIn, txt };
}
export type Composer = ReturnType<typeof useComposer>;
