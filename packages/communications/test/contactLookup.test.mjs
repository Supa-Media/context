// Finding a contact's page by identifier, wherever the owner has filed it.
//
// SABOTAGE RECORD
//   write to a path recomputed from the draft, not the found one  -> 10 checks failed
//   (the moved-page regression among them)
//   never consult the lookup (always "not found")                 -> 9 checks failed
//   drop the archive prefix from contactPrefixes                  -> 2 checks failed
//   let shouldCreateContactPage answer true for every draft       -> 4 checks failed
//   keep only the renderer's own three frontmatter keys           -> 2 checks failed

import {
  contactDraftsFromCommunication,
  contactPathForDraft,
  isAutomatedAddress,
  mergeContactNote,
  shouldCreateContactPage,
} from "../src/contacts.js";
import {
  CONTACT_INDEX_VERSION,
  contactPageIdentity,
  createContactLookup,
  upsertContactDraft,
} from "../src/contactLookup.js";

const OWNER = "owner@example.com";

/** A bucket: path → {text, etag}, with the three operations a sync writer has. */
function memoryBucket(seed = {}) {
  const objects = new Map();
  let counter = 0;
  const put = (path, text) => objects.set(path, { text, etag: `e${(counter += 1)}` });
  for (const [path, text] of Object.entries(seed)) put(path, text);
  const stats = { reads: 0, lists: 0 };
  return {
    objects,
    stats,
    put,
    text: (path) => objects.get(path)?.text ?? null,
    list: async (prefix) => {
      stats.lists += 1;
      return [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, { etag }]) => ({ key, version: etag }));
    },
    read: async (path) => {
      stats.reads += 1;
      return objects.get(path)?.text ?? null;
    },
    io: {
      read: async (path) => (objects.has(path) ? { ...objects.get(path) } : null),
      write: async (path, text, etag) => {
        const current = objects.get(path);
        if ((current?.etag ?? null) !== etag) return { ok: false, conflict: true };
        put(path, text);
        return { ok: true, version: objects.get(path).etag };
      },
      move: async (from, to, etag) => {
        if (objects.get(from)?.etag !== etag || objects.has(to)) return { ok: false };
        put(to, objects.get(from).text);
        objects.delete(from);
        return { ok: true };
      },
    },
  };
}

function lookupFor(bucket, snapshot) {
  return createContactLookup({ list: bucket.list, read: bucket.read, snapshot });
}

function event({ from, to = [], sentAt = "2026-10-12T09:00:00.000Z", subject = "hello", id = "m1", bulk }) {
  return {
    channel: "email",
    account: "owner-at-example-com",
    messageId: id,
    threadId: `t-${id}`,
    sentAt,
    subject,
    from,
    to,
    body: "body",
    ...(bulk ? { bulk: true } : {}),
  };
}

/** Every draft of these events, through one lookup, the way a sync pass runs them. */
async function sync(bucket, events, snapshot) {
  const lookup = lookupFor(bucket, snapshot);
  const results = [];
  for (const draft of contactDraftsFromCommunication(events, { selfAddresses: [OWNER] })) {
    results.push(await upsertContactDraft(lookup, draft, bucket.io));
  }
  return { lookup, results };
}

const outboundTo = (name, address, extra = {}) =>
  event({ from: { name: "Owner", address: OWNER }, to: [{ name, address }], ...extra });
const inboundFrom = (name, address, extra = {}) =>
  event({ from: { name, address }, to: [{ name: "Owner", address: OWNER }], ...extra });

function contactPage(name, identifierLines, extraFrontmatter = "") {
  return `---\nupdated: "2026-01-01T00:00:00.000Z"\ntype: "contact"\nslug: "x"\n${extraFrontmatter}---\n\n# ${name}\n\n` +
    `## Identifiers\n\n${identifierLines.map((line) => `- ${line}`).join("\n")}\n\n## Activity\n\n_(nothing yet)_\n\n## Notes\n\nmine\n`;
}

const pagesUnder = (bucket, prefix) => [...bucket.objects.keys()].filter((key) => key.startsWith(prefix));

export async function runContactLookupChecks(check) {
  // -- found by identifier, wherever it is ---------------------------------
  {
    const bucket = memoryBucket({ "0-inbox/contacts/c/claire.md": contactPage("Claire", ["email: claire@example.net"]) });
    await sync(bucket, [inboundFrom("Claire D.", "Claire@Example.net")]);
    check("a page filed under c/ is found by its email and updated there",
      bucket.text("0-inbox/contacts/c/claire.md").includes("2026-10-12") &&
        pagesUnder(bucket, "0-inbox/contacts/").length === 1);
    check("...and the owner's own notes on it survive", bucket.text("0-inbox/contacts/c/claire.md").includes("## Notes\n\nmine"));
  }
  {
    const imported = "---\ntitle: \"Alex\"\nrole: communication-contact\n---\n\n# Alex\n\n## Identities\n\n- iMessage: `+1 (555) 123-4567`\n";
    const bucket = memoryBucket({ "0-inbox/contacts/imessage/alex.md": imported });
    const draft = { name: "+15551234567", wroteTo: true, identifiers: [{ kind: "phone", value: "+15551234567" }], activity: [], updatedAt: "2026-10-12T00:00:00.000Z" };
    const lookup = lookupFor(bucket);
    check("a legacy imported iMessage page is found by its phone number",
      (await lookup.find(draft)) === "0-inbox/contacts/imessage/alex.md");
    await upsertContactDraft(lookup, draft, bucket.io);
    check("...and is neither rewritten nor shadowed by a second page",
      bucket.text("0-inbox/contacts/imessage/alex.md") === imported && pagesUnder(bucket, "0-inbox/contacts/").length === 1);
    check("both page formats yield their identifiers",
      contactPageIdentity(imported).ids[0] === "phone:+15551234567" &&
        contactPageIdentity(contactPage("C", ["email: c@example.net"])).ids[0] === "email:c@example.net" &&
        contactPageIdentity("# just mine\n") === null);
  }
  {
    // The owner merged by hand: one page, the email they started with and the
    // phone number they added. The phone's next message goes there.
    const merged = contactPage("Claire", ["email: claire@example.net", "phone: +1 555 765 4321"]);
    const bucket = memoryBucket({ "0-inbox/contacts/c/claire-dubois.md": merged });
    const draft = { name: "Claire", identifiers: [{ kind: "phone", value: "+15557654321" }], activity: [{ date: "2026-10-12", path: "0-inbox/imessage/2026/10/2026-10-12.md", anchor: "msg-0123456789abcdef", label: "hi", channel: "imessage" }], updatedAt: "2026-10-12T00:00:00.000Z" };
    await upsertContactDraft(lookupFor(bucket), draft, bucket.io);
    check("a hand-merged page is found by its second identifier and written in place",
      bucket.text("0-inbox/contacts/c/claire-dubois.md").includes("2026-10-12 · imessage") &&
        pagesUnder(bucket, "0-inbox/contacts/").length === 1);
    check("...and keeps its own page name in its slug",
      bucket.text("0-inbox/contacts/c/claire-dubois.md").includes('slug: "claire-dubois"'));
  }
  check("the merge writes to the path it is given, never one recomputed from the identifiers",
    mergeContactNote("", { name: "A", identifiers: [{ kind: "email", value: "a@example.net" }] }, { path: "0-inbox/contacts/z/zed.md" })?.path === "0-inbox/contacts/z/zed.md" &&
      mergeContactNote("", { name: "A", identifiers: [{ kind: "email", value: "a@example.net" }] }, {}) === null &&
      mergeContactNote("", { name: "A", identifiers: [{ kind: "email", value: "a@example.net" }] }, { path: "0-inbox/contacts/a/b/c.md" }) === null);

  // -- new pages: under a letter, and only for somebody the owner wrote to --
  {
    const bucket = memoryBucket();
    await sync(bucket, [outboundTo("Émile Zola", "emile@example.net")]);
    check("a new contact is created under the letter of their name",
      bucket.text("0-inbox/contacts/e/email-emile-example-net.md") !== null && pagesUnder(bucket, "0-inbox/contacts/").length === 1);
    await sync(bucket, [outboundTo("", "+1 555 222 3333")].map((item) => ({ ...item, channel: "imessage" })));
    check("...and under other/ when the name is only a number",
      pagesUnder(bucket, "0-inbox/contacts/other/").length === 1);
  }
  {
    const bucket = memoryBucket({ "0-inbox/contacts/email-legacy-example-net.md": contactPage("Legacy", ["email: legacy@example.net"]) });
    await sync(bucket, [inboundFrom("Legacy", "legacy@example.net")]);
    check("a flat page from before the letter folders is updated in place, not migrated",
      bucket.text("0-inbox/contacts/email-legacy-example-net.md").includes("2026-10-12") &&
        pagesUnder(bucket, "0-inbox/contacts/").length === 1);
  }

  // -- THE regression: a page the owner moved gets the next sync ----------
  {
    const bucket = memoryBucket();
    const first = await sync(bucket, [outboundTo("Claire", "claire@example.net")]);
    const created = "0-inbox/contacts/c/email-claire-example-net.md";
    check("the first message to a new person creates their page", bucket.text(created) !== null);
    bucket.put("0-inbox/contacts/people/claire-dubois.md", bucket.text(created));
    bucket.objects.delete(created);
    await sync(bucket, [inboundFrom("Claire", "claire@example.net", { id: "m2", sentAt: "2026-10-13T09:00:00.000Z", subject: "again" })], first.lookup.snapshot());
    check("a page the owner moved and renamed receives the next sync",
      bucket.text("0-inbox/contacts/people/claire-dubois.md").includes("2026-10-13"));
    check("...and no duplicate is recreated at the old address", pagesUnder(bucket, "0-inbox/contacts/").length === 1);
  }

  // -- the snapshot: a disposable derivative, checked against the listing --
  {
    const bucket = memoryBucket({ "0-inbox/contacts/c/claire.md": contactPage("Claire", ["email: claire@example.net"]) });
    const first = await sync(bucket, [inboundFrom("Claire", "claire@example.net")]);
    bucket.stats.reads = 0;
    await sync(bucket, [inboundFrom("Claire", "claire@example.net")], first.lookup.snapshot());
    check("a run handed the last run's snapshot reads no page it already knows", bucket.stats.reads === 0);
    check("...and a snapshot of another version is ignored rather than trusted",
      (await lookupFor(bucket, { version: CONTACT_INDEX_VERSION + 1, pages: { "0-inbox/contacts/x/y.md": { v: "e1", k: "contact", ids: ["email:claire@example.net"] } } })
        .find({ identifiers: [{ kind: "email", value: "claire@example.net" }] })) === "0-inbox/contacts/c/claire.md");
  }
  {
    // A snapshot whose version still matches the listing but whose bytes are
    // now the owner's own note (a listing that versions by size can do this).
    const bucket = memoryBucket({ "0-inbox/contacts/c/claire.md": "# Not a contact any more\n" });
    const stale = { version: CONTACT_INDEX_VERSION, pages: { "0-inbox/contacts/c/claire.md": { v: bucket.objects.get("0-inbox/contacts/c/claire.md").etag, k: "contact", ids: ["email:claire@example.net"] } } };
    await sync(bucket, [outboundTo("Claire", "claire@example.net")], stale);
    check("a non-contact note at the path the index named is left alone",
      bucket.text("0-inbox/contacts/c/claire.md") === "# Not a contact any more\n");
  }

  // -- the archive: a dormant page comes back ------------------------------
  {
    const archived = "4-archive/0-inbox/contacts/c/claire.md";
    const bucket = memoryBucket({ [archived]: contactPage("Claire", ["email: claire@example.net"]) });
    await sync(bucket, [inboundFrom("Claire", "claire@example.net")]);
    check("an archived page is moved back to its live path by the next message",
      bucket.text("0-inbox/contacts/c/claire.md")?.includes("2026-10-12") && bucket.text(archived) === null);
    check("...and no second page is started for them", pagesUnder(bucket, "0-inbox/contacts/").length === 1);
  }

  // -- who gets a page at all ----------------------------------------------
  {
    const bucket = memoryBucket();
    await sync(bucket, [inboundFrom("Stranger", "stranger@example.net")]);
    check("an inbound-only stranger gets no page", pagesUnder(bucket, "0-inbox/contacts/").length === 0);
    await sync(bucket, [outboundTo("Stranger", "stranger@example.net", { id: "m2" })]);
    check("...until the owner replies, which creates it", pagesUnder(bucket, "0-inbox/contacts/s/").length === 1);
    await sync(bucket, [inboundFrom("No Reply", "no-reply@service.example"), outboundTo("Robot", "noreply@service.example", { id: "m3" }), outboundTo("Mail", "mailer-daemon@example.net", { id: "m4" })]);
    check("an automated address never gets a page, even written to", pagesUnder(bucket, "0-inbox/contacts/").length === 1);
    check("the automated-address rule is on the whole local part",
      ["noreply@x.io", "no-reply@x.io", "donotreply@x.io", "do-not-reply@x.io", "notifications@x.io", "notification+abc@x.io",
        "newsletter@x.io", "MAILER-DAEMON@x.io", "postmaster@x.io", "bounces+123@x.io", "bounce@x.io"].every(isAutomatedAddress) &&
        !["norene@x.io", "notes@x.io", "bouncer-adam@x.io", "+15551234567"].some(isAutomatedAddress));
    check("a bulk message never creates a page",
      !shouldCreateContactPage({ wroteTo: true, bulk: true, identifiers: [{ kind: "email", value: "a@example.net" }] }));
  }
  {
    const bucket = memoryBucket({ "0-inbox/contacts/n/news.md": contactPage("News", ["email: newsletter@paper.example"]) });
    await sync(bucket, [inboundFrom("News", "newsletter@paper.example", { bulk: true })]);
    check("somebody who already has a page is updated by an inbound message, automated or not",
      bucket.text("0-inbox/contacts/n/news.md").includes("2026-10-12"));
  }
  check("an inbound sender's draft does not ask for a page, a recipient of the owner's does",
    (() => {
      const [sender] = contactDraftsFromCommunication([inboundFrom("A", "a@example.net")], { selfAddresses: [OWNER] });
      const [recipient] = contactDraftsFromCommunication([outboundTo("B", "b@example.net")], { selfAddresses: [OWNER] });
      return !shouldCreateContactPage(sender) && shouldCreateContactPage(recipient);
    })());

  // -- frontmatter the renderer does not own --------------------------------
  {
    const path = "0-inbox/contacts/c/claire.md";
    const page = contactPage("Claire", ["email: claire@example.net"], 'review: "possible duplicate of [[0-inbox/contacts/c/claire-2]]"\ntags:\n  - family\n');
    const bucket = memoryBucket({ [path]: page });
    await sync(bucket, [inboundFrom("Claire", "claire@example.net")]);
    const text = bucket.text(path);
    check("a review: question on a contact page survives the merge",
      text.includes('review: "possible duplicate of [[0-inbox/contacts/c/claire-2]]"'));
    check("...and so does any key a person added, list and all, inside the frontmatter",
      text.includes("tags:\n  - family\n") && text.indexOf("tags:") < text.indexOf("\n---\n\n# Claire"));
  }
  check("contactPathForDraft is where a new page lands, never where one is looked for",
    contactPathForDraft({ name: "Claire", identifiers: [{ kind: "email", value: "claire@example.net" }] }) === "0-inbox/contacts/c/email-claire-example-net.md");
}
