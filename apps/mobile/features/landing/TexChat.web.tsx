import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tex } from "../chaos/Tex";

/**
 * Page a's picture: one conversation with Tex, played once (Dev, 2026-10-18:
 * "more Tex/Chat focused", replacing the graph "that confuses people", then
 * "show it doing something a bit more useful, like sending an email doing
 * something research"). An idea filed into a note, a search whose results
 * land in it, and an email that goes only after the person's YES, then a
 * reminder. Every reply is something Tex does today: web search
 * (`agent/search.js`), email through the send-review gate (`emailGate.js`),
 * routines, and a texted write answers with the note's link (`agent/noteLinks.js`).
 *
 * The card is its final height from the start and the thread fills it from
 * the bottom, so the page never moves while it plays. It starts when it is on screen, plays once and holds
 * the end; a visitor who asks for less motion sees the end at once.
 */

type Bubble = {
  from: "me" | "tex";
  label?: string;
  body: ReactNode;
  /** A second bubble of the same reply: it lands just after, with no typing. */
  follows?: boolean;
  /** Drawn as a link preview rather than a bubble of text. */
  card?: boolean;
};

const Folder = ({ children }: { children: ReactNode }) => <b className="tp-f">{children}</b>;

/**
 * The note's link as a phone draws it. A note's link unfurls as Context's own
 * card, never with the note's name (`infra/router`, a private note's name is
 * not put in a preview), so that is what is drawn.
 */
function NoteCard() {
  return (
    <span className="tp-card">
      <span className="tp-card-t">Context</span>
      <span className="tp-card-w">context.lc</span>
    </span>
  );
}

export const CHAT: readonly Bubble[] = [
  { from: "me", body: "supper club idea: everyone brings a dish from where they grew up" },
  { from: "tex", body: <>Started a note in <Folder>Projects › Supper club</Folder>.</> },
  { from: "me", body: "find a place in brooklyn with a private room for 12" },
  { from: "tex", body: "Found three under $60 a head, with their menus. Added them to Supper club:" },
  {
    from: "tex",
    follows: true,
    card: true,
    label: "A link to the note Supper club",
    body: <NoteCard />,
  },
  { from: "me", body: "email maya, sam and jo: first one is friday at 7" },
  { from: "tex", body: "Here's the email I'd send: “Supper club starts Friday at 7. Bring a dish from where you grew up!” Look good?" },
  { from: "me", body: "yes" },
  { from: "tex", body: "Sent. I'll remind you Thursday to book the room." },
];

/** How long Tex "types" before a reply, and the pause after each bubble. */
const TYPING_MS = 900;
const AFTER_ME_MS = 700;
const AFTER_TEX_MS = 1400;
const START_MS = 600;
const FOLLOW_MS = 450;

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
    if (next?.from === "tex" && next.follows !== true && !typing) {
      const t = setTimeout(() => setTyping(true), shown === 0 ? START_MS : 0);
      return () => clearTimeout(t);
    }
    const wait = typing
      ? TYPING_MS
      : next?.follows === true
        ? FOLLOW_MS
        : shown === 0
          ? START_MS
          : CHAT[shown - 1]?.from === "tex"
            ? AFTER_TEX_MS
            : AFTER_ME_MS;
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
      <p className={bubble.card === true ? "tp-b tp-linkb" : "tp-b"} aria-label={bubble.label}>
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
