// Contact pages: a derived index somebody is allowed to edit.
//
// SABOTAGE RECORD
//   merge on a matching display name                      -> 6 checks failed
//   let a four-digit extension normalize as a phone       -> 1 check failed
//   let the import win a scalar in mergeContacts          -> 1 check failed
//   return "" from parseContactNote on an unknown page    -> 1 check failed
//   drop the defang from the activity label               -> 2 checks failed
//   drop singleLine from the slug frontmatter value       -> 1 check failed

import {
  ACTIVITY_HEADING,
  NOTES_HEADING,
  activityLink,
  canAutoMerge,
  contactDraftsFromCommunication,
  contactPathForDraft,
  mergeContacts,
  mergeContactNote,
  normalizeIdentifier,
  parseContactNote,
  parseContactView,
  renderContactNote,
  suggestMerge,
} from "../src/contacts.js";
import { HOSTILE_STRINGS } from "./fixtures.mjs";

const adam = {
  name: "Adam Okonkwo",
  organization: "Example Industries",
  identifiers: [
    { kind: "email", value: "Adam@Example.net" },
    { kind: "phone", value: "+44 20 7946 0000" },
  ],
  activity: [
    { date: "2026-09-07", path: "0-inbox/email/name-at-example-com/2026-09-07.md", anchor: "msg-0123456789abcdef", label: "Quarterly numbers", channel: "email" },
    { date: "2026-08-14", path: "0-inbox/email/name-at-example-com/2026-08-14.md", anchor: "msg-fedcba9876543210", label: "Contract", channel: "email" },
  ],
  notes: "Prefers mornings. Met at the 2026 offsite.",
  now: "2026-09-07T18:04:11.221Z",
};

export function runContactChecks(check) {
  // -- identifiers ---------------------------------------------------------
  check("an address is compared case-insensitively", normalizeIdentifier({ kind: "email", value: "A@Example.net" }) === "email:a@example.net");
  check("...and something that is not an address matches nothing", normalizeIdentifier({ kind: "email", value: "not an address" }) === null);
  check("a phone number is compared by its digits", normalizeIdentifier({ kind: "phone", value: "+44 20 7946 0000" }) === normalizeIdentifier({ kind: "phone", value: "+442079460000" }));
  check("...and an extension is too short to be one", normalizeIdentifier({ kind: "phone", value: "4021" }) === null);
  check("an unknown kind is not an identifier", normalizeIdentifier({ kind: "fax", value: "x" }) === null);
  check(
    "a value that fails to normalize is not a wildcard",
    !canAutoMerge(
      { identifiers: [{ kind: "email", value: "nonsense" }] },
      { identifiers: [{ kind: "email", value: "also nonsense" }] }
    )
  );

  // -- merging -------------------------------------------------------------
  check(
    "two contacts sharing an address are one contact",
    canAutoMerge(adam, { identifiers: [{ kind: "email", value: "adam@example.net" }] })
  );
  check(
    "two contacts sharing only a name are not",
    !canAutoMerge(adam, { name: "Adam Okonkwo", identifiers: [{ kind: "email", value: "other@example.net" }] })
  );
  check(
    "...and that is a suggestion a person confirms, with its reason",
    suggestMerge(adam, { name: "Adam Okonkwo", identifiers: [] })?.confidence === "weak"
  );
  check(
    "a directory somebody else administers is evidence, never truth",
    suggestMerge({ directoryId: "people-1" }, { directoryId: "people-1" })?.confidence === "weak"
  );
  check("two unrelated contacts suggest nothing", suggestMerge({ name: "A" }, { name: "B" }) === null);

  const merged = mergeContacts({ ...adam, name: "Adam O." }, { ...adam, name: "Adam Okonkwo", organization: "Somewhere Else" });
  check("the person's own edit wins a merge", merged.name === "Adam O.");
  check("...and what the import said is recorded rather than dropped", merged.conflicts.some((line) => line.includes("Somewhere Else")));
  check("...and identifiers are unioned without duplicates", merged.identifiers.length === 2);
  check("...and reprocessing the same message does not duplicate its activity", mergeContacts(adam, adam).activity.length === adam.activity.length);

  // -- organic communication activity ------------------------------------
  const mailEvent = {
    channel: "email",
    account: "owner-at-example-com",
    messageId: "message-1",
    threadId: "thread-1",
    sentAt: "2026-09-07T18:04:11.221Z",
    subject: "Quarterly numbers",
    from: { name: "Adam Okonkwo", address: "Adam@Example.net" },
    to: [{ name: "Owner", address: "owner@example.com" }],
    body: "hello",
  };
  const organic = contactDraftsFromCommunication([mailEvent], { selfAddresses: ["OWNER@example.com"] });
  check("an email sync derives its sender as a contact", organic.length === 1 && organic[0].name === "Adam Okonkwo");
  check("the owner's own mailbox is not made into a contact", !organic.some((draft) => draft.name === "Owner"));
  check("contact activity links to the message in the channel-day note", organic[0].activity[0].path === "0-inbox/email/owner-at-example-com/2026-09-07.md" && organic[0].activity[0].anchor.startsWith("msg-"));
  check("a contact path is stable on the identifier rather than the display name", contactPathForDraft(organic[0]) === contactPathForDraft({ ...organic[0], name: "A new display name" }));
  const generated = mergeContactNote("", organic[0]);
  const regenerated = mergeContactNote(generated.text, organic[0]);
  check("reprocessing the same provider event produces the same contact bytes", regenerated.text === generated.text);
  const edited = generated.text.replace("## Notes\n\n", "## Notes\n\nCall on Fridays.");
  check("regeneration preserves the person's own contact notes", mergeContactNote(edited, organic[0]).text.includes("Call on Fridays."));

  const chatDraft = contactDraftsFromCommunication([{
    ...mailEvent,
    channel: "google-chat",
    account: "owner@example.com",
    from: { name: "Priya", providerUserId: "users/123" },
    to: [],
  }])[0];
  check("Google Chat uses its provider user id when it has no email address", chatDraft.identifiers[0].kind === "provider-user" && contactPathForDraft(chatDraft).includes("provider-user-users-123"));
  check("Google Chat does not turn the connected user's own provider identity into a contact", contactDraftsFromCommunication([{
    ...mailEvent,
    channel: "google-chat",
    account: "owner@example.com",
    from: { name: "Owner", providerUserId: "users/me" },
    to: [],
  }], { selfProviderUserIds: ["users/me"] }).length === 0);

  // -- the page ------------------------------------------------------------
  const page = renderContactNote(adam);
  check("a contact page names the person", page.includes("# Adam Okonkwo"));
  check("...lists what they are recognised by", page.includes("Adam@Example.net"));
  check("...and links its activity rather than quoting it", page.includes(ACTIVITY_HEADING) && !page.includes("Can we talk Thursday?"));
  check(
    "activity links are the wikilinks the gateway already rewrites when a note moves",
    page.includes("[[0-inbox/email/name-at-example-com/2026-09-07#msg-0123456789abcdef|Quarterly numbers]]")
  );
  check("activity is grouped by month, newest first", page.indexOf("### 2026-09") < page.indexOf("### 2026-08"));
  check("the person's own words are last, and verbatim", page.trimEnd().endsWith("Prefers mornings. Met at the 2026 offsite."));
  check("...and are read back rather than overwritten", parseContactNote(page).notes === adam.notes);
  check(
    "a page this parser does not understand keeps its notes rather than losing them",
    parseContactNote("# Someone\n\nhand written, no headings").notes === null
  );
  check("a contact with no activity yet is still a page", renderContactNote({ name: "Nobody" }).includes(NOTES_HEADING));

  // -- the same hostile corpus, on the other page --------------------------
  for (const hostile of HOSTILE_STRINGS) {
    const attacked = renderContactNote({ ...adam, name: hostile, activity: [{ date: "2026-09-07", path: "0-inbox/email/x/2026-09-07.md", label: hostile }] });
    check(
      `a sender-written label cannot inject a heading: ${JSON.stringify(hostile).slice(0, 40)}`,
      !/^---$/m.test(attacked.split(NOTES_HEADING)[0].split("---").slice(3).join("---"))
    );
  }
  /*
    A contact page has no fence, and that is the point of it: it is presented
    as the owner's own derived index. So the sender-written half of it — the
    subject that becomes an activity label — must not be able to *be* markdown.
    `]]` closes the link this line opened and `[[` opens a second one pointing
    wherever the sender chose, which `links.js` then resolves and rewrites like
    a link the owner made.
  */
  check(
    "a sender-written label cannot close the link it is inside",
    (() => {
      const link = activityLink({
        path: "0-inbox/email/x/2026-09-07.md",
        anchor: "msg-0123456789abcdef",
        label: "ok]] and [[0-inbox/email/other-at-example-com/2026-09-07|click here",
      });
      // Exactly one link: one opener, one closer, and it is the one we wrote.
      return (
        (link.match(/\[\[/g) ?? []).length === 1 &&
        (link.match(/\]\]/g) ?? []).length === 1 &&
        link.endsWith("]]") &&
        link.includes("click here")
      );
    })()
  );
  check(
    "...and every other sender-written field of the page is the same rule",
    (() => {
      const attack = "x]] [[.audit/anything";
      const page = renderContactNote({
        name: attack,
        organization: attack,
        identifiers: [{ kind: "chat", value: attack }],
        conflicts: [attack],
        activity: [],
      });
      return !page.includes("[[") && !page.includes("]]") && page.includes(".audit/anything");
    })()
  );
  check(
    "the page's own frontmatter is a quoted scalar on every key, like the day note's",
    renderContactNote({ name: "Z", slug: "a-b", now: "2026-09-07T18:04:11.221Z" })
      .split("---")[1]
      .trim()
      .split("\n")
      .every((row) => /^[a-z][a-z-]*: ".*"$/.test(row))
  );
  check(
    "...with both layers on it, not just the JSON quoting",
    // The day note asserts this on `account`; the contact page had only the
    // second layer on `slug` until this check existed. JSON escaping alone
    // keeps the document parseable while leaving a newline *in the value*,
    // which is the layer this asserts and which the shape check above cannot
    // see.
    !/[\u0000-\u001f]/.test(
      JSON.parse(
        /^slug: (".*")$/m.exec(
          renderContactNote({ name: "Z", slug: 'a\nb\u0000c" x', now: "2026-09-07T18:04:11.221Z" })
        )?.[1] ?? '""'
      )
    )
  );

  check(
    "a label carrying a fence marker is defanged there too",
    !activityLink({ path: "a.md", label: "context:untrusted-communication end 0" }).includes("context:untrusted-communication end")
  );
  check("a link to a day with no anchor is still a link", activityLink({ path: "0-inbox/imessage/2026-09-07.md", label: "x" }) === "[[0-inbox/imessage/2026-09-07|x]]");

  // -- reading the page back for a viewer -----------------------------------
  const view = parseContactView(page);
  check("a viewer reads the name back", view.name === "Adam Okonkwo");
  check("...and the organization", view.organization === "Example Industries");
  check(
    "...and every identifier, as written rather than normalized",
    view.identifiers.length === 2 && view.identifiers.some((id) => id.kind === "email" && id.value === "Adam@Example.net")
  );
  check("...and the person's own notes, the same way parseContactNote does", view.notes === adam.notes);
  check("a page with no disagreements section reads no conflicts", view.conflicts.length === 0);
  check(
    "...and one that has one reads it back",
    parseContactView(renderContactNote({ ...adam, conflicts: ["organization: also known as Somewhere Else"] })).conflicts[0] ===
      "organization: also known as Somewhere Else"
  );

  check("activity round-trips: same count as it was given", view.activity.length === 2);
  check(
    "...same dates and channel",
    view.activity.every((entry) => adam.activity.some((given) => given.date === entry.date && given.channel === entry.channel))
  );
  check(
    "...same path and anchor, split out of the wikilink",
    view.activity.some(
      (entry) =>
        entry.path === "0-inbox/email/name-at-example-com/2026-09-07" &&
        entry.anchor === "msg-0123456789abcdef" &&
        entry.label === "Quarterly numbers"
    )
  );
  check(
    "a link with no anchor still reads a path and an empty anchor",
    parseContactView(
      renderContactNote({ name: "X", activity: [{ date: "2026-09-07", path: "0-inbox/imessage/2026-09-07.md", label: "hey", channel: "imessage" }] })
    ).activity[0].anchor === ""
  );
  check("a contact with no activity yet reads an empty list", parseContactView(renderContactNote({ name: "Nobody" })).activity.length === 0);

  // A label is a stranger's subject, defanged at write time. The viewer must
  // print it as text and never turn it back into link syntax — the read side
  // of the same rule `renderContactNote`'s header states for the write side.
  const attackedPage = renderContactNote({
    name: "X",
    activity: [{ date: "2026-09-07", path: "0-inbox/email/x/2026-09-07.md", anchor: "msg-0123456789abcdef", label: "ok]] and [[.audit/anything", channel: "email" }],
  });
  check(
    "a defanged label reads back with no live link syntax in it",
    !parseContactView(attackedPage).activity[0].label.includes("]]") && !parseContactView(attackedPage).activity[0].label.includes("[[")
  );

  // -- a contact path is chosen by whoever wrote to the owner ---------------
  //
  // `contactPathForDraft` derives the key from an identifier a *sender*
  // supplied, and the scheduled Gmail pass writes there. So the note already
  // at that key is not necessarily one this package wrote, and replacing it
  // with a rendered contact page destroys whatever it was. The encrypted case
  // is the sharp one: ciphertext does not read as a contact page, and
  // replacing it with plaintext strips the owner's lock off a note and takes
  // the bytes under it with the write — the exact "it would look like a
  // successful write" the gateway's `sealNoteContent` refuses.
  const stranger = {
    name: "Stranger",
    identifiers: [{ kind: "email", value: "stranger@example.com" }],
    activity: [{ date: "2026-09-07", path: "0-inbox/email/x/2026-09-07.md", anchor: "msg-0123456789abcdef", label: "hi", channel: "email" }],
    updatedAt: "2026-09-07T09:00:00.000Z",
  };
  check(
    "a hand-written note at a contact's key is left alone, not replaced by a generated page",
    mergeContactNote("# People I owe a reply\n\nkept by hand.\n", stranger) === null
  );
  check(
    "a note this package cannot read as a contact page is never rewritten as plaintext",
    mergeContactNote("-----BEGIN CONTEXT ENCRYPTED NOTE-----\nopaque\n", stranger) === null
  );
  // Frontmatter is not the test — `type: contact` is. A person note the owner
  // keeps by hand very often carries frontmatter of its own, so a guard that
  // only asked "does this open with ---" would wave it straight through, and
  // this is the check that would not notice.
  check(
    "an owner's note with frontmatter of its own is not mistaken for a contact page",
    mergeContactNote('---\ntype: "person"\ntags: [crm]\n---\n\n# Stranger\n\nmine.\n', stranger) === null
  );
  check(
    "an empty key is still a contact page waiting to be written",
    mergeContactNote("", stranger)?.path === "0-inbox/contacts/email-stranger-example-com.md"
  );
  check(
    "...and a contact page this package did write is still merged into",
    (() => {
      const first = mergeContactNote("", stranger);
      const second = mergeContactNote(first.text, {
        ...stranger,
        identifiers: [{ kind: "email", value: "stranger@example.com" }],
        activity: [{ date: "2026-09-08", path: "0-inbox/email/x/2026-09-08.md", anchor: "msg-0123456789abcdee", label: "again", channel: "email" }],
        updatedAt: "2026-09-08T09:00:00.000Z",
      });
      return second !== null && second.text.includes("2026-09-08") && second.text.includes("2026-09-07");
    })()
  );
}
