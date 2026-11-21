import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useFrame } from "../app/AppFrame";
import { AppFrameVisualFixture } from "./AppFrameVisualFixture";
import { AsideStrip } from "../console/aside/AsideStrip";
import type { AsideTab } from "../console/aside/tabs";
import { space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import type { AppChatRow, AskChoice, ChatLine, ReactionEmoji } from "../tex/chat/appChatGateway";
import type { AppChatView } from "../tex/chat/appChatView";
import type { LiveStep } from "../tex/chat/appChatRun";
import { TexChatView } from "../tex/chat/TexChatTab";

/**
 * `/e2e-fixture?screen=tex-chat`: the console frame on the same demo data as
 * `app-frame-visual`, with the right panel open on the Tex tab.
 *
 * The tab's body is `TexChatView` fed by `useFakeTexChat`, a local `useState`
 * chat with no network. `AsidePanel` cannot be used here: its Tex tab mounts
 * `useAppChat`, which polls the gateway. So this file draws the tab strip and
 * hands the body to the same view the product uses.
 *
 * `fold=1` draws the panel folded to its rail (`AsideStrip`, the product's own),
 * so the Tex figure under the calendar is on the board.
 *
 * Everything in the chat is invented: no account, no route, no picture of a
 * real person. Pictures are a tiny PNG generated for this file.
 */

/** A 48x36 PNG (a sun over a hill), so a picture row has something to show. */
const PICTURE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAkCAIAAABAJy5dAAABD0lEQVR4nO3Oy0rDQBjF8fNgWfeZRKSUUIpIKaWIiEgpIiK913u9tPWy8EnOQ7jqIhDKJPNNTPLRWQR+yznf/HEwpFdwOKJXcDSmV1Cf0CtoTOkVhDPq+fsNkuQJmnMqSa2JCCu0FtQg1ERsQxzfUYMzyDbEyT01OINsQ7QfqMEZZBui80gNziDbEN0nanAG2YboPVODM8g2xOkLlQg1wgpnS+pJrZEnOH+lV3DxRq/g8p1eQf+DJQrCmuG/FzBYsbhkhyH7KVytWZCzJpblGq43zC17Ssx5E0FYu/lkDjlqYsJZxI9uv5hRkZRdqcdhPBp+U1BWivCdGRQZ/9BQeortx/SgPaqCqqAqqAraty2eudxxuk8XpAAAAABJRU5ErkJggg==";
const PICTURE_ID = "0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f";
const TABS: AsideTab[] = ["meetings", "tex"];

/** The seeded chat, oldest first. Every value is invented. */
function seedRows(now: number): AppChatRow[] {
  const minutesAgo = (m: number) => now - m * 60_000;
  return [
    { id: "r1", who: "tex", kind: "text", text: "Hi! I'm Tex. Ask me anything, or tell me what to do.", at: minutesAgo(20) },
    {
      id: "r2",
      who: "me",
      kind: "text",
      text: "add chicken salad stuff to my grocery list",
      at: minutesAgo(18),
      editable: true,
      reactions: [{ who: "tex", emoji: "❤️" }],
    },
    {
      id: "r3",
      who: "tex",
      kind: "text",
      text: "Added a Chicken salad section to Grocery List.",
      at: minutesAgo(17),
      reactions: [{ who: "me", emoji: "👍" }],
    },
    {
      id: "r3b",
      who: "tex",
      kind: "text",
      text: "Two things are still open on [Saturday party plan](https://context.lc/note/@demo/projects/saturday-party.md):\n\n- Whether to add the **$3 cake fee** to the booking.\n- Who picks up the cake.\n\nhttps://context.lc/note/@demo/areas/bible-study/daniel-6-study.md",
      at: minutesAgo(16),
    },
    {
      id: "r4",
      who: "me",
      kind: "picture",
      text: "this one?",
      at: minutesAgo(12),
      pics: [PICTURE_ID],
      editable: true,
    },
    {
      id: "r5",
      who: "me",
      kind: "text",
      text: "pick up milk, eggs and oat milk",
      at: minutesAgo(10),
      edited: true,
      editable: true,
    },
    {
      id: "r5b",
      who: "me",
      kind: "file",
      text: "can you check this?",
      at: minutesAgo(8),
      files: [{ id: "f".repeat(32), name: "Q3 budget.pdf", type: "application/pdf", size: 245760 }],
      editable: true,
    },
    { id: "r6", who: "me", kind: "text", text: "", at: minutesAgo(9), unsent: true },
    {
      id: "r7",
      who: "me",
      kind: "text",
      text: "yes, and the chicken salad too",
      at: minutesAgo(6),
      replyTo: { id: "r3", text: "Added a Chicken salad section to Grocery List." },
      editable: true,
    },
    {
      id: "r8",
      who: "tex",
      kind: "text",
      text: "Here's the email to Sam: Hi Sam, the chicken salad order is set for Friday. Give it a 👍 and I'll send it.",
      at: minutesAgo(2),
      ask: { id: "a1", open: true },
    },
  ];
}

/**
 * `seed=mock`: the approved mock's chat (artifact "In-app Tex", Approval demo), so a screenshot of this board sits
 * beside the mock's. Every value is invented.
 */
function mockRows(now: number): AppChatRow[] {
  const day = new Date(now);
  const at = (daysBack: number, h: number, m: number) =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate() - daysBack, h, m).getTime();
  const steps = (start: number, n: number): LiveStep[] =>
    Array.from({ length: n }, (_, i) => ({ k: "tool" as const, at: start + i * 1_000, name: "search", what: "Public Worship notes", ok: true, ms: 900 }));
  return [
    { id: "m1", who: "me", kind: "text", text: "whats on the public worship reading list?", at: at(1, 10, 30), state: "read" },
    {
      id: "m2",
      who: "tex",
      kind: "text",
      text: "I can't find a reading list in the Public Worship notes. Two searches came up empty, and the background job I started gave up without finding one.\n\nSend me the list's name or a link and I'll read it.",
      at: at(1, 10, 32),
      run: { secs: 94, steps: steps(at(1, 10, 30), 3) },
    },
    {
      id: "m3",
      who: "me",
      kind: "text",
      text: "Prepare daniel 6 notes for me in the same format I use for bible study",
      at: at(0, 8, 25),
      state: "failed",
      failedAt: at(0, 8, 25),
    },
    { id: "m4", who: "me", kind: "text", text: "Email Puttery about 2 more guests", at: now - 60_000, state: "read" },
    {
      id: "m5",
      who: "tex",
      kind: "text",
      text: "Here's the email. It goes as a reply in your Puttery thread, and it waits for you.",
      at: now - 57_000,
      run: { secs: 3, steps: steps(now - 60_000, 3) },
      ask: {
        id: "a1",
        open: true,
        card: {
          kind: "email",
          state: "wait",
          from: "you@gmail.example",
          to: "Kameela · events@puttery.example",
          cc: "",
          subject: "Re: Puttery - New York City: Your Event is Confirmed!",
          thread: true,
          body: "Hi Kameela,\n\nWe'd like to add 2 more guests to Saturday's 7 PM party, bringing us to 20. Could you update the booking and let me know the new total?\n\nThanks!",
          editable: true,
        },
      },
    },
  ];
}

/**
 * A local `AppChatView`: sends, reactions, edits, unsends and answers change the
 * rows in `useState`, and nothing leaves the page.
 *
 * Timers are cleared on unmount, so leaving the screen cannot write into a view
 * that is gone.
 */
function useFakeTexChat(mock = false): AppChatView {
  const [lines, setLines] = useState<ChatLine[]>(() => (mock ? mockRows : seedRows)(Date.now()));
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, AskChoice>>({});
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const nextId = useRef(0);
  const sentPictures = useRef(new Map<string, string>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
  const freshId = () => {
    nextId.current += 1;
    return `local-${nextId.current}`;
  };
  const texText = (text: string): AppChatRow => ({ id: freshId(), who: "tex", kind: "text", text, at: Date.now() });

  const updateRow = (rowId: string, change: (row: AppChatRow) => AppChatRow) =>
    setLines((prev) => prev.map((line) => ("pending" in line || line.id !== rowId ? line : change(line))));

  return {
    available: true,
    phase: "listed",
    lines,
    busy,
    sending: false,
    error: null,
    answers,
    run: null,
    toast: null,
    stop() {
      setBusy(false);
    },
    retryRow() {},
    send(text, options) {
      const pictureIds = (options?.pictures ?? []).map((blob) => {
        const id = freshId();
        sentPictures.current.set(id, URL.createObjectURL(blob));
        return id;
      });
      const fileRows = (options?.files ?? []).map((file) => ({
        id: freshId(),
        name: file.name,
        type: file.type,
        size: file.size,
      }));
      const replyId = options?.replyTo ?? null;
      setLines((prev) => {
        const quoted = replyId === null ? undefined : prev.find((line): line is AppChatRow => !("pending" in line) && line.id === replyId);
        const row: AppChatRow = {
          id: freshId(),
          who: "me",
          kind: pictureIds.length > 0 ? "picture" : fileRows.length > 0 ? "file" : "text",
          text: text.trim(),
          at: Date.now(),
          editable: true,
          ...(pictureIds.length > 0 ? { pics: pictureIds } : {}),
          ...(fileRows.length > 0 ? { files: fileRows } : {}),
          ...(quoted !== undefined ? { replyTo: { id: quoted.id, text: quoted.text } } : {}),
        };
        return [...prev, row];
      });
      setBusy(true);
      later(() => setBusy(false), 1_200);
    },
    retry() {},
    answer(rowId, choice) {
      setAnswers((prev) => ({ ...prev, [rowId]: choice }));
      updateRow(rowId, (row) => (row.ask ? { ...row, ask: { ...row.ask, open: false } } : row));
      if (choice === "approve") {
        later(() => setLines((prev) => [...prev, texText("Sent to Sam.")]), 1_200);
      }
    },
    // The fixture has no held email, so a card answer only settles the card as its own page would.
    decide(rowId, choice) {
      updateRow(rowId, (row) =>
        row.ask?.card ? { ...row, ask: { ...row.ask, card: { ...row.ask.card, state: choice === "send" ? "sending" : "held" } } } : row,
      );
    },
    react(rowId, emoji: ReactionEmoji) {
      updateRow(rowId, (row) => ({
        ...row,
        reactions: [...(row.reactions ?? []).filter((r) => r.who !== "me"), { who: "me", emoji }],
      }));
    },
    edit(rowId, text) {
      updateRow(rowId, (row) => ({ ...row, text: text.trim(), edited: true }));
    },
    unsend(rowId) {
      updateRow(rowId, (row) => ({ ...row, text: "", unsent: true }));
    },
    pictureUrl(id) {
      if (id === PICTURE_ID) return PICTURE_DATA_URL;
      return sentPictures.current.get(id) ?? null;
    },
    // The fixture keeps no file bytes: a download has nothing to save.
    downloadFile() {},
    typing() {},
  };
}

/**
 * The right panel with the Tex tab showing, beside the product's own rail (`AsideStrip`), as `AsidePanel` lays it out
 * (its Tex tab mounts `useAppChat`, which reaches the network).
 */
function TexAside({ folded, view }: { folded: boolean; view: AppChatView }) {
  const frame = useFrame();
  const setFolded = frame.setAsideFolded;
  const styles = useThemedStyles(makeStyles);

  useEffect(() => {
    setFolded(folded);
  }, [folded, setFolded]);

  if (frame.state.asideFolded) {
    return <AsideStrip tabs={TABS} showing="tex" recording={false} onUnfold={() => setFolded(false)} />;
  }

  return (
    <View style={styles.row}>
      <View style={styles.panel} testID="aside-panel">
        <View style={styles.body} testID="aside-tex">
          <TexChatView view={view} />
        </View>
      </View>
      <AsideStrip tabs={TABS} showing="tex" recording={false} open onUnfold={() => {}} onFold={() => setFolded(true)} onSearch={() => {}} />
    </View>
  );
}

function TexChatBoard({ folded, mock }: { folded: boolean; mock: boolean }) {
  const view = useFakeTexChat(mock);
  return <AppFrameVisualFixture panel fakeMeeting={false} aside={<TexAside folded={folded} view={view} />} />;
}

export function TexChatFixture({ params }: { params: Record<string, string | string[] | undefined> }) {
  const fold = (Array.isArray(params.fold) ? params.fold[0] : params.fold) === "1";
  const mock = (Array.isArray(params.seed) ? params.seed[0] : params.seed) === "mock";
  return <TexChatBoard folded={fold} mock={mock} />;
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    row: { flex: 1, minWidth: 0, flexDirection: "row" },
    panel: { flex: 1, minWidth: 0, paddingTop: space.x2 },
    body: { flex: 1, minHeight: 0 },
  });
