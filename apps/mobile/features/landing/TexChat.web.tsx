import type { ReactNode } from "react";
import { Tex } from "../chaos/Tex";

/**
 * Page a's picture: one conversation with Tex (Dev, 2026-10-18: "more
 * Tex/Chat focused", replacing the graph "that confuses people", then "show it
 * doing something a bit more useful, like sending an email doing something
 * research"). An idea filed into a note, a search whose results land in it,
 * and an email that goes only after the person's yes, then a reminder. Every
 * reply is something Tex does today: web search (`agent/search.js`), email
 * through the send-review gate (`emailGate.js`), routines, and a texted write
 * answers with the note's link (`agent/noteLinks.js`).
 *
 * It is drawn whole and still (Dev, 2026-10-18: "just do the full convo no
 * animating"): a visitor reads it at once, and on a phone the card is never
 * empty while it waits to play.
 */

type Bubble = {
  from: "me" | "tex";
  label?: string;
  body: ReactNode;
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
    card: true,
    label: "A link to the note Supper club",
    body: <NoteCard />,
  },
  { from: "me", body: "email maya, sam and jo: first one is friday at 7" },
  { from: "tex", body: "Here's the email I'd send: “Supper club starts Friday at 7. Bring a dish from where you grew up!” Look good?" },
  { from: "me", body: "yes" },
  { from: "tex", body: "Sent. I'll remind you Thursday to book the room." },
];

function Row({ bubble }: { bubble: Bubble }) {
  return (
    <div className={`tp-msg tp-from-${bubble.from}`}>
      <p className={bubble.card === true ? "tp-b tp-linkb" : "tp-b"} aria-label={bubble.label}>
        {bubble.body}
      </p>
    </div>
  );
}

export function TexChat() {
  return (
    <section className="tp-chat" aria-label="An example conversation with Tex">
      <div className="tp-chat-top">
        <span className="tp-av">
          <Tex chaos={0} size={28} scheme="light" />
        </span>
        <span className="tp-name">Tex</span>
      </div>
      <div className="tp-log">
        {CHAT.map((bubble, i) => (
          <Row key={i} bubble={bubble} />
        ))}
      </div>
    </section>
  );
}
