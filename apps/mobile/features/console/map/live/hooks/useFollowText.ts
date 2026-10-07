import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@context/convex/_generated/api";

/** How often the note an AI tool is writing is read again while it writes. */
const REREAD_MS = 6_000;

/**
 * The text of the note a followed AI tool is writing, for "Writing: <note>".
 *
 * Read through the console's own note read (`files.readNote`), so it is
 * exactly what this person could open themselves, and read again every few
 * seconds while the tool is still writing. `null` while nothing is being
 * written, before the first answer, and for a note stored encrypted — the
 * panel then shows the title with a typing mark and no words.
 */
export function useFollowText(target: { workspaceId: string; path: string } | null): string | null {
  const read = useAction(api.functions.files.readNote);
  const readRef = useRef(read);
  readRef.current = read;
  const [text, setText] = useState<{ key: string; text: string | null } | null>(null);
  const key = target === null ? null : `${target.workspaceId}\n${target.path}`;

  useEffect(() => {
    if (target === null || key === null) return;
    let stopped = false;
    const load = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void readRef
        .current({ workspaceId: target.workspaceId as never, path: target.path })
        .then((note) => {
          if (!stopped) setText({ key, text: note.encrypted ? null : note.text });
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, REREAD_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // `key` is the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return text !== null && text.key === key ? text.text : null;
}

/** The note's words without its frontmatter and heading marks, for a small panel. */
export function writingPreview(text: string, max = 280): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const plain = body
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
  return plain.length > max ? plain.slice(plain.length - max) : plain;
}
