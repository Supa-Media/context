import { useEffect, useState } from "react";
import type { AnswerChoice, AskCard } from "./appChatGateway";
import { AskButton, AskFace, SendingLine, clockOf, type FaceField, type FaceHead } from "./TexAskFace";

/** The heading over a card that waits for the person's OK. Nothing sends until they say so. */
export const WAITING_HEAD = "Waiting for you · nothing sends until you say so";
/** The heading over a held email: Tex kept the draft and nothing went. */
export const HELD_HEAD = "Not sent. Tex kept the draft.";
/** The heading over a card whose ask is no longer waiting. */
export const GONE_HEAD = "No longer waiting";
/** The line under the buttons while the words can be changed. */
export const EDIT_HINT = "Click the text to change it.";
/** The line under the buttons when the email is a reply inside its existing thread. */
export const THREAD_HINT = "A reply in the existing thread.";

/**
 * The words of Tex's bubble over a card: its own lead, without the copy the card already shows and without the
 * texted "Give it a 👍" line the card's buttons stand in for (`textedApprovals.js` `askLine`). "Here's the email I'd
 * send:" and its copy become "Here's the email I'd send." Words Tex wrote itself stay as they are. Empty when nothing
 * is left, and then no bubble is drawn.
 */
export function askLead(text: string): string {
  const yes = text.search(/(?:@\S+, )?give it a \u{1F44D}/iu);
  const before = (yes >= 0 ? text.slice(0, yes) : text).trim();
  const paragraphs = before.split(/\n\s*\n/);
  if (paragraphs.length > 1 && paragraphs[0].trim().endsWith(":")) return paragraphs[0].trim().replace(/:$/, ".");
  return before;
}

/**
 * One card Tex holds for the person's OK, from the route's `ask.card` (`appChatCards.js`).
 *
 * Draws what it is given. A press goes back up through `onDecide` as `(rowId, choice, body?)`. `body` is the words only
 * when the person changed them, and `undefined` when the held text goes as it was. The hook owns whether it took.
 */
export function TexAskCard({
  rowId,
  card,
  onDecide,
  onReply,
}: {
  rowId: string;
  card: AskCard;
  onDecide: (rowId: string, choice: AnswerChoice, body?: string) => void;
  onReply: () => void;
}) {
  const waiting = card.state === "wait";
  const email = card.kind === "email";
  // The words change in place only while the card waits (the mock: a held draft is read, then sent by a reply).
  const editable = card.kind === "email" && card.editable && card.state === "wait";

  // The person's draft. It follows the held text when that text changes, and keeps their typing between polls.
  const heldBody = card.kind === "email" ? card.body : "";
  const [draft, setDraft] = useState(heldBody);
  useEffect(() => {
    setDraft(heldBody);
  }, [heldBody]);

  const words = card.kind === "email" ? draft : card.detail;
  const changed = card.kind === "email" && draft !== card.body;
  const sendLabel = email ? "Send" : "Go ahead";
  const what = email ? card.subject : card.kind === "other" ? card.summary : "";

  const actions = waiting ? (
    <>
      <AskButton
        label={sendLabel}
        variant="primary"
        onPress={() => onDecide(rowId, "send", changed ? draft : undefined)}
        accessibilityLabel={`${sendLabel}: ${what}`}
        testID={`tex-ask-send-${rowId}`}
      />
      <AskButton label="Not now" variant="ghost" onPress={() => onDecide(rowId, "hold")} accessibilityLabel={`Not now: ${what}`} testID={`tex-ask-hold-${rowId}`} />
    </>
  ) : card.state === "sending" ? (
    <SendingLine testID={`tex-ask-sending-${rowId}`} />
  ) : null;

  const hints: string[] = [];
  if (waiting && editable) hints.push(EDIT_HINT);
  if (waiting && card.kind === "email" && card.thread) hints.push(THREAD_HINT);

  return (
    <AskFace
      testID={`tex-ask-card-${rowId}`}
      head={headOf(rowId, card)}
      onReply={card.state === "sent" ? undefined : onReply}
      replyTestID={`tex-ask-reply-${rowId}`}
      fields={card.kind === "email" ? fieldsOf(card) : undefined}
      title={card.kind === "other" ? card.summary : undefined}
      body={
        words === null
          ? undefined
          : {
              value: words,
              onChangeText: editable ? setDraft : undefined,
              testID: `tex-ask-body-${rowId}`,
              label: "Email text, editable",
            }
      }
      actions={actions}
      footer={hints.length > 0 ? hints.join(" ") : null}
    />
  );
}

/** The head for each state. A sent email names its sender and the time it went. */
function headOf(rowId: string, card: AskCard): FaceHead {
  const testID = `tex-ask-state-${rowId}`;
  if (card.state === "wait" || card.state === "sending") return { tone: "warn", icon: "lock", text: WAITING_HEAD, testID };
  if (card.state === "held") return { tone: "muted", icon: null, text: HELD_HEAD, testID };
  if (card.state === "sent") {
    const who = card.kind === "email" && card.from !== null && card.from.length > 0 ? `Sent from ${card.from}` : "Sent";
    const when = card.at !== undefined ? ` · ${clockOf(card.at)}` : "";
    return { tone: "ok", icon: "check", text: `${who}${when}`, testID };
  }
  return { tone: "muted", icon: null, text: GONE_HEAD, testID };
}

/** The From, To, Cc and Subject rows. From and Cc are left out when there is none. */
function fieldsOf(card: Extract<AskCard, { kind: "email" }>): FaceField[] {
  const rows: FaceField[] = [];
  if (card.from !== null && card.from.length > 0) rows.push({ label: "From", value: card.from });
  rows.push({ label: "To", value: card.to });
  if (card.cc.length > 0) rows.push({ label: "Cc", value: card.cc });
  rows.push({ label: "Subject", value: card.subject });
  return rows;
}
