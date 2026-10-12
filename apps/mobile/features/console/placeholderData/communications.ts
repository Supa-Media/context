import {
  CONTACTS_FOLDER,
  channelDayNotePath,
  contactSlug,
  messageAnchor,
  renderChannelDayNote,
  renderContactNote,
} from "@context/communications";
import type { CommunicationEvent } from "@context/communications/protocol";
import type { FolderListing } from "../files/types";
import { file, folder, listing } from "./treeHelpers";

// ── Communications fixtures ──────────────────────────────────────────────────
//
// Real notes, rendered by the same package the gateway renders a customer's
// mail with — `renderChannelDayNote` and `renderContactNote` from
// `@context/communications` — never hand-typed markdown standing in for them.
// The anchor on the fixture's contact page and the anchor on the rendered
// message are the same `messageAnchor(event)` call, not two numbers somebody
// kept in sync by hand.
//
// `@seyi` is the fixture `useDemoConsoleData` selects by default, so this is
// the one tree that carries them.

/** One communication, with the fields every fixture message shares. */
function commsMessage(
  overrides: Partial<CommunicationEvent> &
    Pick<CommunicationEvent, "messageId" | "threadId" | "sentAt" | "subject" | "from" | "body">,
): CommunicationEvent {
  return {
    channel: "email",
    account: "name-at-example-com",
    to: [{ address: "name@example.com" }],
    attachments: [],
    ...overrides,
  };
}

/**
 * Six messages across four threads on one day — enough that the sixth,
 * `BOARD_MESSAGE_ANCHOR`, is not the first thing on screen, so a WebKit case
 * following a link to it is actually asserting a scroll rather than a message
 * that was already in view.
 */
const EMAIL_DAY_EVENTS = [
  commsMessage({
    messageId: "<kickoff@mail.example.net>",
    threadId: "thread-kickoff",
    sentAt: "2026-09-07T09:05:00.000Z",
    subject: "LTN 2026 kickoff",
    from: { name: "Bea Lindqvist", address: "bea@example.net" },
    body: "Quick kickoff for LTN 2026 — notes are below, shout if anything is missing.",
  }),
  commsMessage({
    messageId: "<permit@mail.example.net>",
    threadId: "thread-permit",
    sentAt: "2026-09-07T10:20:00.000Z",
    subject: "Bandshell permit window",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    body: "The 3–6 PM slot is confirmed. The amplification cap is still the open question.",
  }),
  commsMessage({
    messageId: "<rider@mail.example.net>",
    threadId: "thread-permit",
    sentAt: "2026-09-07T11:02:00.000Z",
    subject: "Re: Bandshell permit window",
    from: { name: "Name", address: "name@example.com" },
    body: "Assuming we bring our own PA — **rider** is attached.",
    attachments: [{ filename: "rider.pdf", contentType: "application/pdf", size: 48213 }],
  }),
  commsMessage({
    messageId: "<budget@mail.example.net>",
    threadId: "thread-budget",
    sentAt: "2026-09-07T13:45:00.000Z",
    subject: "Production budget draft",
    from: { name: "Bea Lindqvist", address: "bea@example.net" },
    body: "First pass at the budget. Load-in is the biggest line item by a wide margin.",
  }),
  commsMessage({
    messageId: "<soundcheck@mail.example.net>",
    threadId: "thread-permit",
    sentAt: "2026-09-07T15:30:00.000Z",
    subject: "Re: Bandshell permit window",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    body: "Sound check moved to 2 PM sharp — please tell the crew.",
  }),
  commsMessage({
    messageId: "<board@mail.example.net>",
    threadId: "thread-board",
    sentAt: "2026-09-07T17:58:00.000Z",
    subject: "Board wants a one-pager",
    from: { name: "Adam Okonkwo", address: "adam@example.net" },
    body:
      "Can you put together a one-page summary for the board before Friday? Keep it short — " +
      "a page they will actually read, not a report nobody gets through.",
  }),
];

const EMAIL_DAY = {
  channel: "email" as const,
  account: "name-at-example-com",
  address: "name@example.com",
  date: "2026-09-07",
  nonce: "e2efixturenonceone",
  now: "2026-09-07T18:04:11.221Z",
  events: EMAIL_DAY_EVENTS,
};

const EMAIL_DAY_EARLIER = {
  ...EMAIL_DAY,
  date: "2026-09-05",
  events: [
    commsMessage({
      messageId: "<early@mail.example.net>",
      threadId: "thread-early",
      sentAt: "2026-09-05T08:00:00.000Z",
      subject: "Save the date",
      from: { name: "Bea Lindqvist", address: "bea@example.net" },
      body: "Save September 7th for the LTN 2026 kickoff.",
    }),
  ],
};

const GOOGLE_CHAT_DAY = {
  channel: "google-chat" as const,
  date: "2026-09-06",
  nonce: "e2efixturenoncetwo",
  now: "2026-09-06T20:00:00.000Z",
  events: [
    commsMessage({
      channel: "google-chat",
      account: "",
      messageId: "<gc-1>",
      threadId: "gc-thread-1",
      sentAt: "2026-09-06T14:00:00.000Z",
      subject: "",
      from: { name: "Bea Lindqvist" },
      body: "Anyone free to help load in Saturday morning?",
    }),
    commsMessage({
      channel: "google-chat",
      account: "",
      messageId: "<gc-2>",
      threadId: "gc-thread-1",
      sentAt: "2026-09-06T14:05:00.000Z",
      subject: "",
      from: { name: "Adam Okonkwo" },
      body: "Yep, I'm in.",
    }),
  ],
};

/**
 * The message a contact's activity link points at, in `renderContactNote`'s
 * own words. `apps/mobile/e2e/webkit`'s anchor-scroll case locates this
 * message by its **visible subject** rather than importing this hash, so it
 * is asserting what a person actually sees rather than an internal value —
 * see that spec's own comment.
 */
const BOARD_MESSAGE_ANCHOR = messageAnchor(EMAIL_DAY_EVENTS[5]!);

const EMAIL_DAY_PATH = channelDayNotePath({
  channel: "email",
  account: "name-at-example-com",
  date: "2026-09-07",
});
const EMAIL_DAY_EARLIER_PATH = channelDayNotePath({
  channel: "email",
  account: "name-at-example-com",
  date: "2026-09-05",
});
const GOOGLE_CHAT_DAY_PATH = channelDayNotePath({ channel: "google-chat", date: "2026-09-06" });

const ADAM_CONTACT = {
  name: "Adam Okonkwo",
  organization: "Public Worship",
  identifiers: [{ kind: "email", value: "adam@example.net" }],
  activity: [
    {
      date: "2026-09-07",
      channel: "email",
      path: EMAIL_DAY_PATH,
      anchor: BOARD_MESSAGE_ANCHOR,
      label: "Board wants a one-pager",
    },
  ],
  notes: "Production lead for LTN 2026.",
  now: "2026-09-07T18:04:11.221Z",
};
/**
 * Contacts as they now land: one page per person under its letter folder
 * (`0-inbox/contacts/a/…`), with the legacy imported iMessage folder beside
 * the letters — the shape the contacts folder's A–Z index and a contact
 * page's header (`communications/contactPages.ts`) are drawn from.
 */
const ADAM_CONTACT_SLUG = contactSlug(ADAM_CONTACT.name);
const ADAM_CONTACT_PATH = `${CONTACTS_FOLDER}/a/${ADAM_CONTACT_SLUG}.md`;
const MARA_CONTACT = {
  name: "Mara Lindqvist",
  identifiers: [
    { kind: "email", value: "mara@example.org" },
    { kind: "phone", value: "+15550100123" },
  ],
  activity: [],
  notes: "",
  now: "2026-09-06T09:12:00.000Z",
};
const MARA_CONTACT_PATH = `${CONTACTS_FOLDER}/m/${contactSlug(MARA_CONTACT.name)}.md`;
/** The imported iMessage format: `role: communication-contact` and `## Identities`. */
const SAM_IMPORTED_PATH = `${CONTACTS_FOLDER}/imessage/sam-reyes.md`;
const SAM_IMPORTED =
  "---\ntitle: \"Sam Reyes\"\nrole: communication-contact\n---\n\n" +
  "# Sam Reyes\n\n## Identities\n\n- iMessage: `+15550100456`\n\n" +
  "## iMessage threads\n\n- 2026-08\n";

export const COMMS_LISTINGS: Record<string, FolderListing> = {
  "0-inbox/email": listing("0-inbox/email", "private", [
    folder("0-inbox/email/name-at-example-com", "private"),
  ]),
  "0-inbox/email/name-at-example-com": listing(
    "0-inbox/email/name-at-example-com",
    "private",
    [file(EMAIL_DAY_EARLIER_PATH), file(EMAIL_DAY_PATH)],
  ),
  "0-inbox/google-chat": listing("0-inbox/google-chat", "private", [file(GOOGLE_CHAT_DAY_PATH)]),
  [CONTACTS_FOLDER]: listing(CONTACTS_FOLDER, "private", [
    folder(`${CONTACTS_FOLDER}/a`, "private"),
    folder(`${CONTACTS_FOLDER}/m`, "private"),
    folder(`${CONTACTS_FOLDER}/imessage`, "private"),
  ]),
  [`${CONTACTS_FOLDER}/a`]: listing(`${CONTACTS_FOLDER}/a`, "private", [
    file(ADAM_CONTACT_PATH, { updatedAt: Date.parse(ADAM_CONTACT.now) }),
  ]),
  [`${CONTACTS_FOLDER}/m`]: listing(`${CONTACTS_FOLDER}/m`, "private", [
    file(MARA_CONTACT_PATH, { updatedAt: Date.parse(MARA_CONTACT.now) }),
  ]),
  [`${CONTACTS_FOLDER}/imessage`]: listing(`${CONTACTS_FOLDER}/imessage`, "private", [file(SAM_IMPORTED_PATH)]),
};

export const COMMS_NOTES: Record<string, string> = {
  [EMAIL_DAY_PATH]: renderChannelDayNote(EMAIL_DAY),
  [EMAIL_DAY_EARLIER_PATH]: renderChannelDayNote(EMAIL_DAY_EARLIER),
  [GOOGLE_CHAT_DAY_PATH]: renderChannelDayNote(GOOGLE_CHAT_DAY),
  [ADAM_CONTACT_PATH]: renderContactNote(ADAM_CONTACT),
  [MARA_CONTACT_PATH]: renderContactNote(MARA_CONTACT),
  [SAM_IMPORTED_PATH]: SAM_IMPORTED,
};
