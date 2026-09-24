// Comms search index: per-anchor sub-documents, capped independently, keyed
// path#anchor; an oversized message capped on its own without disturbing its
// neighbours; rebuilding reproduces the same sub-documents; non-channel notes
// are unchanged; encrypted notes still teach the index no plaintext;
// `messageSegmentFor` as the snippet source.
//
// Split out of commsSearchIndex.test.mjs; see fixtures.mjs for the shared
// message and bucket builders.

import {
  channelDaySubDocuments,
  isChannelDayIndexPath,
  messageSegmentFor,
  subDocumentsFor,
} from "../../src/search/commsIndex.js";
import { messageAnchor } from "../../../../packages/communications/src/anchors.js";
import { renderChannelDayNote } from "../../../../packages/communications/src/note.js";
import { isEncryptedNote } from "../../src/encryption.js";
import { NOTE_PATH, NOTE_INDEX_CHAR_CAP, bigDayNote, msg, DAY_BASE } from "./fixtures.mjs";

export async function runCommsSubDocumentChecks(check) {
  /* ---------------------------------------------------------------------- */
  /* 1. Per-anchor sub-documents, capped independently, keyed path#anchor    */
  /* ---------------------------------------------------------------------- */

  {
    const { text, events } = bigDayNote(NOTE_PATH, { count: 40, fillerChars: 80 });
    const subs = channelDaySubDocuments(NOTE_PATH, text);
    const last = subs[subs.length - 1];

    // The property that matters, checked directly rather than inferred from a
    // total-length heuristic: the LAST message's own heading sits well past
    // character 2,048 of the raw file, so a single whole-file cap applied
    // before splitting — today's bug — would never have reached it at all.
    const lastHeadingOffset = text.indexOf(`{#${last.anchor}}`);
    check(
      "the last message's heading sits well past NOTE_INDEX_CHAR_CAP in the raw file",
      lastHeadingOffset > NOTE_INDEX_CHAR_CAP
    );
    // And every individual message is small — the cap is never the reason a
    // message's own content is short here; independence is what is on trial.
    check(
      "each individual message is far smaller than the cap on its own",
      subs.every((sub) => sub.content.length < NOTE_INDEX_CHAR_CAP / 4)
    );

    check("one sub-document per message", subs.length === events.length);

    const anchors = new Set(subs.map((s) => s.anchor));
    check("every sub-document has a distinct anchor", anchors.size === events.length);
    for (const event of events) {
      check(
        `the anchor for message ${event.subject} matches messageAnchor()`,
        subs.some((s) => s.anchor === messageAnchor(event))
      );
    }

    for (const sub of subs) {
      check(`${sub.key} is keyed path#anchor`, sub.key === `${NOTE_PATH}#${sub.anchor}`);
      check(`${sub.key} carries the containing note's path`, sub.notePath === NOTE_PATH);
      check(`${sub.key}'s own content is capped at NOTE_INDEX_CHAR_CAP`, sub.content.length <= NOTE_INDEX_CHAR_CAP);
    }

    // The check that matters: the LAST message's word is findable in ITS OWN
    // sub-document — recall the whole-file cap could never give, since the
    // last message's heading sits well past character 2,048 of the file.
    check(
      "a term in the last message of a large day is found — the one CONTRACT.md names",
      last.content.includes("findme39uniquemarker")
    );

    // And fields are disjoint: message 0's word is not smuggled into the last
    // message's sub-document, or every message would falsely match every word.
    check(
      "a message's sub-document does not carry another message's word",
      !last.content.includes("findme00uniquemarker")
    );

    // Filterable fields, per the decision: date, channel, thread id (the
    // rendered thread label — see the module comment on why it is not a
    // hashed provider id), participants.
    for (const sub of subs) {
      check(`${sub.key} carries the day's channel`, sub.comms.channel === "email");
      check(`${sub.key} carries the day's date`, sub.comms.date === "2026-09-07");
      check(`${sub.key} carries a thread label`, typeof sub.comms.threadId === "string" && sub.comms.threadId.length > 0);
      check(`${sub.key} carries at least one participant`, sub.comms.participants.length > 0);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* A single oversized message is capped on its own, without disturbing    */
  /* its neighbours — "each capped independently".                          */
  /* ---------------------------------------------------------------------- */

  {
    const marker = "giant-message-marker-at-start";
    const events = [
      msg({ messageId: "<small@mail.example.net>", threadId: "t-small", subject: "Small", body: "a short message" }),
      msg({
        messageId: "<giant@mail.example.net>",
        threadId: "t-giant",
        sentAt: "2026-09-07T10:00:00.000Z",
        subject: "Giant",
        // The marker sits at the very start, so it survives truncation to
        // NOTE_INDEX_CHAR_CAP even though the body itself is many times that.
        body: `${marker} ${"z".repeat(NOTE_INDEX_CHAR_CAP * 3)}`,
      }),
    ];
    const text = renderChannelDayNote({ ...DAY_BASE, events });
    const subs = channelDaySubDocuments(NOTE_PATH, text);
    const giant = subs.find((s) => s.content.includes(marker) || s.anchor === messageAnchor(events[1]));
    const small = subs.find((s) => s.anchor === messageAnchor(events[0]));

    check("the oversized message's sub-document is capped at NOTE_INDEX_CHAR_CAP", giant.content.length === NOTE_INDEX_CHAR_CAP);
    check("...but the marker at its own start still survives the cap", giant.content.includes(marker));
    check(
      "...and its oversized neighbour does not shrink the small message's own sub-document",
      small.content.includes("a short message") && small.content.length < NOTE_INDEX_CHAR_CAP
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Rebuilding from the files produces the same sub-documents               */
  /* ---------------------------------------------------------------------- */

  {
    const { text } = bigDayNote(NOTE_PATH, { count: 5 });
    const first = channelDaySubDocuments(NOTE_PATH, text);
    const second = channelDaySubDocuments(NOTE_PATH, text);
    check(
      "rebuilding the index from the same note produces the same sub-documents",
      JSON.stringify(first) === JSON.stringify(second)
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Non-channel notes are unchanged                                        */
  /* ---------------------------------------------------------------------- */

  {
    const path = "1-projects/plan.md";
    const content = `# Plan\n\n${"y".repeat(NOTE_INDEX_CHAR_CAP + 500)}tail-word`;
    check("an ordinary path is not recognised as a channel day", !isChannelDayIndexPath(path));
    const subs = subDocumentsFor(path, content);
    check("an ordinary note yields exactly one sub-document", subs.length === 1);
    check("that sub-document's key is the note's own path", subs[0].key === path && subs[0].anchor === null);
    check(
      "and it keeps the existing whole-note cap — no independent per-message split for a note with no messages",
      subs[0].content.length === NOTE_INDEX_CHAR_CAP && !subs[0].content.includes("tail-word")
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Encrypted notes still learn the index nothing (the phase-1 rule)        */
  /* ---------------------------------------------------------------------- */

  {
    const encryptedLooking = [
      "---",
      "context_encryption: v1",
      "---",
      "",
      "```context-encrypted",
      '{"ciphertext":"not-real-and-holds-no-message-headings"}',
      "```",
      "",
    ].join("\n");
    check("the fixture reads as an encrypted note", isEncryptedNote(encryptedLooking));
    const subs = subDocumentsFor(NOTE_PATH, encryptedLooking);
    check(
      "an encrypted channel-day note yields no MESSAGE sub-documents",
      subs.every((sub) => sub.anchor === null)
    );
    /*
      It contributes the one whole-note document an ordinary encrypted note
      already contributes, and not zero. Zero was what this branch did when
      it was written, and review measured what that costs: `docsByShard`
      records a note's version by `doc.notePath`, so a note with no documents
      has no version recorded, is stale on every later listing, and is
      re-fetched and re-written on every pass forever — see
      `runNoMessageFallbackChecks`. Nothing of the plaintext reaches the index
      either way, which is the property the phase-1 rule is actually about,
      and `visible.js` still drops the note at snippet time on
      `isEncryptedNote`.
    */
    check(
      "...it contributes exactly the one whole-note document an ordinary encrypted note does",
      subs.length === 1 && subs[0].key === NOTE_PATH && subs[0].notePath === NOTE_PATH
    );
    check(
      "...and no message anchor was invented out of ciphertext",
      channelDaySubDocuments(NOTE_PATH, encryptedLooking).length === 0
    );
  }

  /* ---------------------------------------------------------------------- */
  /* messageSegmentFor: the snippet source, re-read fresh                   */
  /* ---------------------------------------------------------------------- */

  {
    const { text, events } = bigDayNote(NOTE_PATH, { count: 3 });
    const anchor = messageAnchor(events[1]);
    const segment = messageSegmentFor(NOTE_PATH, text, anchor);
    check("messageSegmentFor finds the anchor it is given", segment !== null);
    check(
      "and its snippetText carries that message's own word",
      segment.snippetText.includes("findme01uniquemarker")
    );
    check(
      "an anchor that does not exist in the note answers null, not a guess",
      messageSegmentFor(NOTE_PATH, text, "msg-0000000000000000") === null
    );
  }
}
