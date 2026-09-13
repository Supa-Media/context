// Where a communication lands, and everywhere it must not.
//
// SABOTAGE RECORD — each break applied to the source, the suite re-run, the
// number of checks that noticed written down. A guard nobody has checked is not
// a guard. Two of these found real gaps and the checks below them exist because
// the first run of this table said 0.
//
//   drop `-at-` from slugifyAddress                       -> 3 checks failed
//   allow a deeper tree than channel/account/file         -> 1 check failed
//   let every channel have an account level               -> 1 check failed
//   drop isCalendarDate's round-trip (pattern only)       -> 3 checks failed
//   let a slug carry a dot, so a mailbox can be plumbing  -> 2 checks failed
//   return the base slug from chooseMailboxSlug always    -> 1 check failed
//   accept any segment as the account level               -> 5 checks failed
//   file a mailbox as a direct child of `0-inbox`          -> 5 checks failed

import {
  CHANNELS,
  CHANNEL_FOLDERS,
  CONTACTS_FOLDER,
  INBOX_FOLDER,
} from "../src/protocol.js";
import {
  MAX_SLUG_LENGTH,
  SLUG_FALLBACK,
  channelDayNotePath,
  channelFolder,
  chooseMailboxSlug,
  contactNotePath,
  contactSlug,
  isCalendarDate,
  isChannelDayNotePath,
  isContactNotePath,
  isMailboxSlug,
  parseChannelDayPath,
  slugifyAddress,
} from "../src/paths.js";

export function runPathChecks(check) {
  // -- the inbox, and nothing beside it ------------------------------------
  //
  // The scoping note drew this tree under a top-level `inbox/`. It is
  // `0-inbox/`, and that is a decision with a migration behind it: see
  // docs/decisions/communications.md.
  check(
    "every channel folder is inside the inbox the bucket already has",
    CHANNELS.every((channel) => CHANNEL_FOLDERS[channel].startsWith(`${INBOX_FOLDER}/`))
  );
  check("...and contacts is a child of it too", CONTACTS_FOLDER.startsWith(`${INBOX_FOLDER}/`));
  check(
    "...and nothing this module writes starts anywhere else",
    [
      channelDayNotePath({ channel: "email", account: "a-at-example-com", date: "2026-09-07" }),
      channelDayNotePath({ channel: "imessage", date: "2026-09-07" }),
      contactNotePath("adam-okonkwo"),
    ].every((path) => path.startsWith(`${INBOX_FOLDER}/`))
  );

  // -- tenancy is bucket-level, never prefix-level -------------------------
  check(
    "no tenant, workspace or account id appears in a key",
    !channelDayNotePath({ channel: "email", account: "a-at-example-com", date: "2026-09-07" }).includes("tenants/")
  );
  check(
    "the customer's own root is the only prefix, and it is applied verbatim",
    channelDayNotePath(
      { channel: "email", account: "a-at-example-com", date: "2026-09-07" },
      { root: "workspace" }
    ) === "workspace/0-inbox/email/a-at-example-com/2026-09-07.md"
  );
  check(
    "...and a root that traverses is refused rather than normalized away",
    (() => {
      try {
        channelDayNotePath({ channel: "email", account: "a-at-example-com", date: "2026-09-07" }, { root: "../other" });
        return false;
      } catch {
        return true;
      }
    })()
  );

  // -- the address slug ----------------------------------------------------
  check("an address becomes lowercase ASCII with the @ spelled out", slugifyAddress("Name@Example.Com") === "name-at-example-com");
  check(
    "...so two addresses that differ only where the @ is do not collide",
    slugifyAddress("sales@a.example") !== slugifyAddress("sales.a@example")
  );
  check("accents fold to their base letter rather than vanishing", slugifyAddress("rené@example.com") === "rene-at-example-com");
  check("an address with nothing usable in it still names a folder", slugifyAddress("") === SLUG_FALLBACK && slugifyAddress("\u65e5\u672c") === SLUG_FALLBACK);
  check("a slug never begins with a dot, so isPlumbing cannot hide a mailbox", !slugifyAddress(".hidden@example.com").startsWith("."));
  check("...and never contains one at all", !slugifyAddress("first.last@example.com").includes("."));
  check("a slug is never `.` or `..`, raw or otherwise", !["", ".", ".."].includes(slugifyAddress("..@..")));
  check("a slug never contains a separator", !slugifyAddress("a/b@example.com").includes("/"));
  check("...nor a backslash", !slugifyAddress("a\\b@example.com").includes("\\"));
  check("...nor a percent escape that could decode to one", !slugifyAddress("%2e%2e@example.com").includes("%"));
  check("a slug is bounded, because the whole key has to stay addressable", slugifyAddress(`${"a".repeat(400)}@example.com`).length <= MAX_SLUG_LENGTH);
  check("...and does not end mid-separator after the cut", !slugifyAddress(`${"a".repeat(MAX_SLUG_LENGTH - 1)}-b@example.com`).endsWith("-"));
  check("case folds, because Dropbox folds and R2 does not", slugifyAddress("A@Example.com") === slugifyAddress("a@example.com"));

  check("two addresses that slugify alike get different folders", (() => {
    const first = chooseMailboxSlug("a.b@example.com", []);
    const second = chooseMailboxSlug("a-b@example.com", [first]);
    return first !== second;
  })());
  check("...and the second one is still a slug this module recognises", isMailboxSlug(chooseMailboxSlug("a-b@example.com", [chooseMailboxSlug("a.b@example.com", [])])));
  check("...and the first mailbox connected keeps the plain name", chooseMailboxSlug("a.b@example.com", []) === slugifyAddress("a.b@example.com"));

  // -- a real date ---------------------------------------------------------
  check("a date is a date", isCalendarDate("2026-09-07"));
  check("...and February the thirtieth is not one", !isCalendarDate("2026-02-30"));
  check("...nor month thirteen", !isCalendarDate("2026-13-01"));
  check("...nor a date with the wrong shape", !isCalendarDate("2026-9-7"));
  check("a leap day in a leap year is real", isCalendarDate("2028-02-29"));
  check("...and in a common year it is not", !isCalendarDate("2026-02-29"));

  // -- the paths themselves ------------------------------------------------
  check(
    "a mailbox day is the mailbox folder and a filename, nothing between",
    channelDayNotePath({ channel: "email", account: "name-at-example-com", date: "2026-09-07" }) ===
      "0-inbox/email/name-at-example-com/2026-09-07.md"
  );
  check(
    "a channel with no accounts has no account level",
    channelDayNotePath({ channel: "imessage", date: "2026-09-07" }) === "0-inbox/imessage/2026-09-07.md"
  );
  check(
    "...and passing one anyway is refused rather than ignored",
    (() => {
      try {
        channelDayNotePath({ channel: "imessage", account: "someone", date: "2026-09-07" });
        return false;
      } catch {
        return true;
      }
    })()
  );
  check("part 1 is the plain name, so a day that grows renames nothing", !channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 1 }).includes("part"));
  check(
    "...and part 3 is a sibling of it",
    channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 3 }) === "0-inbox/imessage/2026-09-07-part-3.md"
  );
  check(
    "a channel this package does not file into is refused",
    (() => {
      try {
        channelDayNotePath({ channel: "sms", date: "2026-09-07" });
        return false;
      } catch {
        return true;
      }
    })()
  );

  // -- the recogniser ------------------------------------------------------
  //
  // `list_*` is built out of this and out of no index, the way `list_meetings`
  // is: the files are canonical, so there is no second list to drift.
  const round = (day, options) => parseChannelDayPath(channelDayNotePath(day, options), options);
  check(
    "what this module writes is what it recognises",
    (() => {
      const day = { channel: "email", account: "name-at-example-com", date: "2026-09-07", part: 4 };
      const parsed = round(day, { root: "workspace/" });
      return (
        parsed !== null &&
        parsed.channel === "email" &&
        parsed.account === "name-at-example-com" &&
        parsed.date === "2026-09-07" &&
        parsed.part === 4
      );
    })()
  );
  check("...for a channel with no account level too", round({ channel: "google-chat", date: "2026-09-07" })?.channel === "google-chat");

  check(
    "a `YYYY/MM/` tree is not a channel-day note, and never becomes one",
    !isChannelDayNotePath("0-inbox/email/name-at-example-com/2026/09/2026-09-07.md")
  );
  check(
    "a forwarded capture sitting in the same folder is not a day",
    !isChannelDayNotePath("0-inbox/email/9f2c1d7a4b6e8035ac91d2f4.md")
  );
  check(
    "...and a mailbox folder is not mistaken for one either",
    !isChannelDayNotePath("0-inbox/email/name-at-example-com")
  );
  check("a meeting is not a channel-day note", !isChannelDayNotePath("0-inbox/meetings/2026-09-07-sync-8h9jkmnp.md"));
  check("an ordinary dated note elsewhere is not one", !isChannelDayNotePath("1-projects/foo/2026-09-07.md"));
  check("a day inside a dot folder is not one", !isChannelDayNotePath("0-inbox/email/.hidden/2026-09-07.md"));
  check(
    "a channel with no account level does not quietly gain one",
    !isChannelDayNotePath("0-inbox/imessage/someone/2026-09-07.md")
  );
  check(
    "...and no channel gains a second one",
    !isChannelDayNotePath("0-inbox/email/name-at-example-com/archive/2026-09-07.md") &&
      !isChannelDayNotePath("0-inbox/imessage/a/b/2026-09-07.md")
  );
  check("a day under a mailbox-shaped folder with a bad date is not one", !isChannelDayNotePath("0-inbox/email/name-at-example-com/2026-02-30.md"));
  check("`-part-1` is not a name this module writes, so it is not one it reads", !isChannelDayNotePath("0-inbox/imessage/2026-09-07-part-1.md"));
  check("a part number with a leading zero is not one either", !isChannelDayNotePath("0-inbox/imessage/2026-09-07-part-02.md"));
  /*
    The recogniser is what a listing is built from, so a key it accepts is a
    key a tool will read. These are the shapes a crafted key arrives in — a
    traversal that would leave the mailbox folder, the percent-encoded spelling
    of it (the storage adapter decodes before it compares), and an absolute
    path, which is a different key entirely and must not be read as this one
    with a leading slash.
  */
  for (const crafted of [
    "0-inbox/email/../../etc/2026-09-07.md",
    "0-inbox/email/a-at-b/../2026-09-07.md",
    "0-inbox/email/../2026-09-07.md",
    "0-inbox/email/..%2f..%2fetc/2026-09-07.md",
    "0-inbox/email/%2e%2e/2026-09-07.md",
    "0-inbox/email/./2026-09-07.md",
    "/0-inbox/imessage/2026-09-07.md",
    "//0-inbox/imessage/2026-09-07.md",
    "0-inbox//imessage/2026-09-07.md",
    "0-inbox/email/name-at-example-com//2026-09-07.md",
  ]) {
    check(`a crafted key is not a channel-day note: ${crafted}`, !isChannelDayNotePath(crafted));
  }
  check(
    "...and a traversal cannot climb out of the customer's chosen root either",
    !isChannelDayNotePath("workspace/../0-inbox/imessage/2026-09-07.md", { root: "workspace" }) &&
      !isChannelDayNotePath("0-inbox/imessage/2026-09-07.md", { root: "workspace" })
  );
  check(
    "a contact page is held to the same rule",
    !isContactNotePath("0-inbox/contacts/../privacy.md") && !isContactNotePath("/0-inbox/contacts/adam.md")
  );

  check(
    "a key outside the customer's chosen root is not theirs",
    !isChannelDayNotePath("0-inbox/imessage/2026-09-07.md", { root: "workspace" })
  );

  /*
    A mailbox slug is a folder name in somebody's bucket. A reserved name is a
    handle in the control plane's global namespace — and, because ingestion is
    on the apex, the local part of a real mailbox on our own domain
    (`functions/lib/names.ts`: *"Trimming an entry does not tidy the list, it
    opens a mailbox"*). The two namespaces must never be read into each other.

    The decision is explicit that `slugifyAddress` does **not** consult the
    reserved list, and the reasoning is worth restating where the check is:
    mapping a folder name through a mail-role denylist would rename somebody's
    real mailbox after a word on a list they cannot see. So the separation is
    STRUCTURAL, not a string comparison, and that is what is asserted — a
    mailbox lives one level down, under `0-inbox/email/`, where it can never be
    a handle, a route, or a sibling of the folders `0-inbox` already has.

    Every reserved word that could also be produced by the slug function is
    tried, which is the honest set: `support@…` slugifies to
    `support-at-example-com` and could not collide anyway, but an address with
    no `@` in it at all reaches the general rule and comes out as the bare word.
  */
  const RESERVED = ["mcp", "meetings", "oauth", "granola-webhook", "api", "support", "0-inbox", "workspace", "context", "inbox", "contacts", "sessions"];
  check(
    "a reserved name is never a top-level key, whatever address produced it",
    RESERVED.every((word) => {
      const key = channelDayNotePath({ channel: "email", account: slugifyAddress(word), date: "2026-09-07" });
      return key.startsWith(`${CHANNEL_FOLDERS.email}/`) && key.split("/").length === 4;
    })
  );
  check(
    "...so it is never a route the gateway reads, which only ever reads the first segment",
    RESERVED.every(
      (word) =>
        channelDayNotePath({ channel: "email", account: slugifyAddress(word), date: "2026-09-07" }).split("/")[0] ===
        INBOX_FOLDER
    )
  );
  check(
    "...and never a sibling of the folders the inbox already has",
    RESERVED.every((word) => {
      const slug = slugifyAddress(word);
      return ![`${INBOX_FOLDER}/meetings`, `${INBOX_FOLDER}/sessions`, CONTACTS_FOLDER].includes(
        `${CHANNEL_FOLDERS.email}/${slug}`
      );
    })
  );
  check(
    "a mailbox folder can never BE a channel folder, because it is never their sibling",
    CHANNELS.every((channel) => !isMailboxSlug(CHANNEL_FOLDERS[channel]))
  );
  check(
    "and nothing in this package reads a folder name back as a claimable name",
    // `@name` addressing is the control plane's, and a slug never carries the
    // sigil that would let one be mistaken for the other.
    RESERVED.every((word) => !slugifyAddress(`@${word}`).startsWith("@"))
  );

  // -- contacts ------------------------------------------------------------
  check("a person's name becomes a page name", contactSlug("Adam Okonkwo") === "adam-okonkwo");
  check("...and an `@` in a name is not spelled out, which would be nonsense there", contactSlug("Adam@Example") === "adam-example");
  check("a contact page is recognised", isContactNotePath(contactNotePath(contactSlug("Adam Okonkwo"))));
  check("...and a folder under contacts is not a contact", !isContactNotePath("0-inbox/contacts/team/adam.md"));
  check("...nor a dot file in it", !isContactNotePath("0-inbox/contacts/.adam.md"));
}
