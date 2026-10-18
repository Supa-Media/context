import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tex } from "../chaos/Tex";

/**
 * Page a's picture: one conversation with Tex, played once (Dev, 2026-10-18:
 * "more Tex/Chat focused", replacing the graph "that confuses people"). Three
 * things texted in, each filed where it belongs, then a question answered
 * from them. Every reply is something Tex does today: it reads links, photos,
 * voice memos and PDFs, files them into the starting folders, and answers
 * from the notes.
 *
 * The card is its final height from the start and the thread fills it from
 * the bottom, so the page never moves while it plays. It starts when it is on screen, plays once and holds
 * the end; a visitor who asks for less motion sees the end at once.
 */

type Bubble = { from: "me" | "tex"; label?: string; body: ReactNode };

const Folder = ({ children }: { children: ReactNode }) => <b className="tp-f">{children}</b>;

export const CHAT: readonly Bubble[] = [
  { from: "me", body: "supper club idea: everyone brings a dish from where they grew up" },
  { from: "tex", body: <>Started a note in <Folder>Projects › Supper club</Folder>.</> },
  { from: "me", body: <span className="tp-u">example.com/short-ribs</span> },
  { from: "tex", body: <>Saved to <Folder>Resources › Recipes</Folder>.</> },
  { from: "me", label: "A voice memo, 9 seconds", body: <Voice /> },
  { from: "tex", body: "Added to Supper club: “ask Sam to bring bread.”" },
  { from: "me", body: "what am I making for supper club?" },
  {
    from: "tex",
    body: <>Braised short ribs. The recipe's in <Folder>Resources › Recipes</Folder>, and Sam's bringing bread.</>,
  },
];

/** How long Tex "types" before a reply, and the pause after each bubble. */
const TYPING_MS = 900;
const AFTER_ME_MS = 700;
const AFTER_TEX_MS = 1400;
const START_MS = 600;

const WAVE = [6, 10, 7, 14, 9, 16, 8, 12, 15, 7, 11, 16, 9, 13, 6, 10];

function Voice() {
  return (
    <span className="tp-voice" aria-hidden>
      <svg width="12" height="14" viewBox="0 0 12 14">
        <path d="M1 1.2v11.6L11 7z" fill="currentColor" />
      </svg>
      <span className="tp-wave">
        {WAVE.map((h, i) => (
          <i key={i} style={{ height: h }} />
        ))}
      </span>
      <span className="tp-len">0:09</span>
    </span>
  );
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** How many bubbles are showing, and whether Tex is typing the next one. */
export function useChatPlayback(total: number) {
  const box = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(() => (reducedMotion() ? total : 0));
  const [typing, setTyping] = useState(false);
  const [started, setStarted] = useState(shown === total);

  useEffect(() => {
    if (started) return;
    const el = box.current;
    if (el === null || typeof IntersectionObserver === "undefined") {
      setStarted(true);
      return;
    }
    const seen = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setStarted(true);
      },
      { threshold: 0.3 },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started || shown >= total) return;
    const next = CHAT[shown];
    if (next?.from === "tex" && !typing) {
      const t = setTimeout(() => setTyping(true), shown === 0 ? START_MS : 0);
      return () => clearTimeout(t);
    }
    const wait = typing ? TYPING_MS : shown === 0 ? START_MS : CHAT[shown - 1]?.from === "tex" ? AFTER_TEX_MS : AFTER_ME_MS;
    const t = setTimeout(() => {
      setTyping(false);
      setShown((n) => n + 1);
    }, wait);
    return () => clearTimeout(t);
  }, [started, shown, typing, total]);

  return { box, shown, typing };
}

function Row({ bubble, children }: { bubble: Bubble; children?: ReactNode }) {
  return (
    <div className={`tp-msg tp-from-${bubble.from}`}>
      <p className="tp-b" aria-label={bubble.label}>
        {children ?? bubble.body}
      </p>
    </div>
  );
}

/**
 * The card is as tall as the whole conversation from the start (an unseen
 * copy holds the height), and the live thread fills it from the bottom, as a
 * phone's does, so it never looks half empty and the page never moves.
 */
export function TexChat({ onProgress }: { onProgress?: (done: number) => void }) {
  const { box, shown, typing } = useChatPlayback(CHAT.length);
  useEffect(() => onProgress?.(shown / CHAT.length), [shown, onProgress]);
  const chaos = Math.round(100 * (1 - shown / CHAT.length));
  return (
    <section ref={box} className="tp-chat" aria-label="An example conversation with Tex">
      <div className="tp-chat-top">
        <span className="tp-av">
          <Tex chaos={chaos} size={28} scheme="light" />
        </span>
        <span className="tp-name">Tex</span>
      </div>
      <div className="tp-logs">
        <div className="tp-log tp-ghost" aria-hidden>
          {CHAT.map((bubble, i) => (
            <Row key={i} bubble={bubble} />
          ))}
        </div>
        <div className="tp-log tp-live">
          {CHAT.slice(0, shown).map((bubble, i) => (
            <Row key={i} bubble={bubble} />
          ))}
          {typing ? (
            <div className="tp-msg tp-from-tex" aria-hidden>
              <span className="tp-typing">
                <i />
                <i />
                <i />
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
