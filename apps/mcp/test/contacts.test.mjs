/**
 * `list_contacts` and `read_contact`: two reads over pages named by strangers.
 *
 * A contact page is an ordinary note at an ordinary path, so the privacy
 * engine already decides it and nothing here may bypass that — that half is
 * asserted the same way `communications.test.mjs` asserts it for the days.
 * What these two tools add is the consequence of one fact the security review
 * of `#448` said to carry forward into anything built on contacts:
 *
 *   **A contact's key is chosen by whoever sent the user a message.**
 *
 * Two failure modes follow from it, and neither is visible to the rest of the
 * suite:
 *
 * 1. **A path under the contacts folder is not proof the note is ours.**
 *    `parseContactView` is lenient by design and reads anything, so a note the
 *    user wrote at a contact's key — or one they encrypted — would render back
 *    as that person's contact details, fields and all. The gate is
 *    `isContactNote`, the positive frontmatter marker, never a successful
 *    parse. *A lenient reader is a dangerous gate*, applied on the read side.
 * 2. **The page is a stranger's self-description.** The name, the
 *    organization and every identifier came off inbound mail. A model handed
 *    them with nothing said will report them as this context's own claim about
 *    a person, so both tools print the provenance sentence — the listing
 *    because that is where somebody chooses who to read about, the read
 *    because that is where they choose what to believe.
 *
 * And one this file shares with the days: **a listing is a count, and a count
 * is an oracle**. Here the thing it would leak is which people the user knows.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured rather than
 * as expected.
 *
 * 1. **`canSee` dropped from the `list_contacts` filter** — 3 checks failed:
 *    the private contact appeared, its name with it, and the "more" count
 *    began counting people this connection may not see. The count check was
 *    added *because* the first run of this sabotage failed only 2: with the
 *    default limit of 10 the fixture never overflowed, so nothing was
 *    asserting that the number is computed over the visible list at all.
 * 2. **`canSee` dropped from `read_contact`** — 1 check failed, and the
 *    refusal stopped being byte-identical to the one a path that never existed
 *    gets.
 * 3. **The listing gated on a successful parse instead of `isContactNote`** —
 *    1 check failed: the user's own note at a contact's key was listed as a
 *    person, with the first heading of their writing as that person's name.
 * 4. **`read_contact` gated on the parse instead of the marker** — 1 check
 *    failed, the same note rendered as somebody's contact details.
 * 5. **The provenance sentence removed from the constant** — 2 checks failed,
 *    one on each tool, which is the point of it being one constant.
 * 6. **The listing sorted on the key rather than on when the page was last
 *    touched** — 2 checks failed. The fixture is arranged for this: the
 *    published contact is the *older* page and its slug sorts *first*.
 * 7. **The activity preview cap removed** — 2 checks failed: a three-year
 *    correspondence came back whole, uninvited, with nothing said about it.
 * 8. **The `isContactNotePath` guard removed from `read_contact`** — 2 checks
 *    failed: `index.md` and a channel day were both read through a tool that
 *    would have rendered them as people.
 * 9. **The catalogue entry claiming no tools** (in `catalog.js`, not here) —
 *    2 checks failed, one of them `contextPlugins.test.mjs`'s existing "every
 *    Context plugin has a surface its switch actually governs", which is the
 *    rule that kept drawings out of that list.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { renderContactNote } from "../../../packages/communications/src/contacts.js";

const OWNER_TOKEN = `cat_contacts_owner_${"0".repeat(18)}`;
const TEAM_TOKEN = `cat_contacts_member_${"0".repeat(17)}`;

/**
 * Private by default, with exactly one contact published to the team.
 *
 * An exact-note override rather than a folder default, because that is the
 * shape this folder really takes: a person publishes the colleague their team
 * already emails and keeps the rest, and the tools must not turn the ones they
 * kept into a number.
 */
const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n\n" +
  "note_overrides:\n  0-inbox/contacts/email-adam-at-example-net.md: team\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    objects,
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value) {
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
      if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
      const page = [];
      const prefixes = new Set();
      let index = from;
      for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
        const key = keys[index];
        const remainder = key.slice(prefix.length);
        const slash = delimiter ? remainder.indexOf(delimiter) : -1;
        if (slash === -1) {
          const stored = objects.get(key);
          page.push({ key, size: stored.body.length, uploaded: stored.uploaded });
        } else {
          prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
        }
      }
      const truncated = index < keys.length;
      return {
        objects: page,
        delimitedPrefixes: [...prefixes],
        truncated,
        cursor: truncated ? keys[index - 1] : undefined,
      };
    },
  };
}

async function callTool(env, token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx
  );
  const body = await response.json();
  await settle();
  return body?.result?.content?.[0]?.text ?? "";
}

/** A contact page, rendered by the package that owns the format rather than by hand. */
function seedContact(bucket, { slug, name, organization, identifiers, activity, notes, uploaded }) {
  const text = renderContactNote({
    slug,
    name,
    organization,
    identifiers,
    activity,
    notes,
    now: "2026-09-08T00:00:00.000Z",
  });
  const key = `0-inbox/contacts/${slug}.md`;
  bucket.seed(key, text, uploaded);
  return key;
}

function chatActivity(date, label) {
  return {
    date,
    path: `0-inbox/google-chat/${date}.md`,
    anchor: "msg-0123456789abcdef",
    label,
    channel: "google-chat",
  };
}

export async function runContactsChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    controlPlane.addWorkspace("ws_contacts", "contacts-fixture", {
      provider: "r2-binding",
      bindingName: "CONTACTS_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_contacts",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_contacts_owner",
      userId: "user_contacts_owner",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TOKEN,
      workspaceId: "ws_contacts",
      role: "editor",
      scopes: ["context:read"],
      clientId: "mcp_client_contacts_member",
      userId: "user_contacts_member",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "CONTACTS_BUCKET",
      CONTACTS_BUCKET: bucket,
    };

    bucket.seed("privacy.md", PRIVACY_MANIFEST);
    bucket.seed("index.md", "# The front page");

    // Published to the team, and deliberately the OLDER upload of the two
    // generated pages: a listing that sorted on the key rather than on when
    // the page was last touched would put it first, since `adam` sorts before
    // `dara`.
    const adam = seedContact(bucket, {
      slug: "email-adam-at-example-net",
      name: "Adam Okonkwo",
      organization: "Example Ltd",
      identifiers: [
        { kind: "email", value: "adam@example.net" },
        { kind: "chat", value: "users/12345" },
      ],
      activity: [chatActivity("2026-09-05", "Quarterly numbers")],
      notes: "Met at the conference. Prefers a call.",
      uploaded: new Date("2026-09-05T10:00:00.000Z"),
    });

    // Private, and the one a team connection must not learn exists — not from
    // a row, not from a count, not from the difference between two refusals.
    const dara = seedContact(bucket, {
      slug: "email-dara-at-example-org",
      name: "Dara Ibrahim",
      identifiers: [{ kind: "email", value: "dara@example.org" }],
      activity: Array.from({ length: 8 }, (_, index) =>
        chatActivity(`2026-09-${String(index + 1).padStart(2, "0")}`, `Thread ${index + 1}`)
      ),
      uploaded: new Date("2026-09-07T10:00:00.000Z"),
    });

    // The user's own note, at a key a sender could have chosen. Frontmatter of
    // its own, so "it has frontmatter" cannot stand in for "it is ours", and a
    // `# heading` a lenient parse would happily report as somebody's name.
    const mine = "0-inbox/contacts/email-mine-at-example-com.md";
    bucket.seed(
      mine,
      "---\nupdated: 2026-09-08\nstatus: draft\n---\n\n# Who to call about the lease\n\nRing the agent first.\n",
      new Date("2026-09-08T10:00:00.000Z")
    );

    /*
      A contact page the owner sealed. The bytes carry the encryption marker
      and nothing else — `renderEncryptedNote` replaces the note wholesale, so
      `type: contact` is gone with the rest of it — and that is exactly the
      case the review of `#448` named: a lenient parse of ciphertext produced
      a contact page with an empty name, and here it would produce a row and a
      read. Sealed by hand rather than through `set_encryption`, so this check
      does not need a passphrase round trip to assert what it is about.
    */
    const sealed = "0-inbox/contacts/email-sealed-at-example-net.md";
    bucket.seed(
      sealed,
      "---\ncontext_encryption: v1\n---\n\n> [!NOTE] This note is encrypted.\n\n" +
        "```context-encrypted\n{\"v\":1,\"ciphertext\":\"0000\"}\n```\n",
      new Date("2026-09-04T10:00:00.000Z")
    );

    /* -------------------------------- listing ----------------------------- */

    const ownerList = await callTool(env, OWNER_TOKEN, "list_contacts");
    check("list_contacts lists a generated contact page", ownerList.includes(adam));
    check("...under the person's name, not its filename slug", ownerList.includes("Adam Okonkwo"));
    check("...with the organization the page carries", ownerList.includes("Example Ltd"));
    check("...and how many identifiers it holds", ownerList.includes("2 identifiers"));
    check(
      "...and when they were last in touch, with the channel",
      ownerList.includes("last google-chat 2026-09-05")
    );
    check(
      "most recently touched first, not alphabetically by key",
      ownerList.indexOf(mine) < ownerList.indexOf(dara) &&
        ownerList.indexOf(dara) < ownerList.indexOf(adam)
    );
    check(
      "a note of the user's own at a contact's key is named rather than parsed as a person",
      ownerList.includes(`(a note of your own)\n  ${mine}`) &&
        !ownerList.includes("Who to call about the lease")
    );
    check(
      "an encrypted note at a contact's key is never parsed into a person",
      ownerList.includes(`(encrypted)\n  ${sealed}`) &&
        !ownerList.includes("ciphertext") &&
        !ownerList.includes("(unnamed contact)")
    );
    check(
      "the listing says where a contact page's contents came from",
      ownerList.includes("a claim its sender made") || ownerList.includes("claim its sender made")
    );
    check("...and how to read one", ownerList.includes("read_contact"));

    const teamList = await callTool(env, TEAM_TOKEN, "list_contacts");
    check("a connection that may not see a contact is not shown it", !teamList.includes(dara));
    check("...nor the name on it", !teamList.includes("Dara Ibrahim"));
    check("...and still sees the one published to it", teamList.includes(adam));
    check(
      "...and no row it may not see, anywhere in the answer",
      !teamList.includes("more;")
    );
    /*
      The count oracle, stated as a number rather than as an absence. The
      fixture holds four notes under this folder and a team connection may see
      one, so a "more" computed over the listing instead of over the visible
      list would say 3 — and "there are three more people here you may not
      see" is the fact this tool exists to not disclose.
    */
    check(
      "a 'more' count is over what this connection can see, never over the folder",
      !(await callTool(env, TEAM_TOKEN, "list_contacts", { limit: 1 })).includes("more")
    );

    /*
      Refused by the advertised schema, before the handler — which is where
      `toolArgumentRefusal` says it should happen: a call whose arguments we
      never said we would take reaches no storage. The handler keeps its own
      range check anyway, the same way `list_channel_days` does, because the
      two are reached by different callers and a schema is not a contract the
      dispatcher shares.
    */
    const badLimit = await callTool(env, OWNER_TOKEN, "list_contacts", { limit: 99 });
    check(
      "a limit outside the advertised range is refused, and says which argument",
      badLimit.includes("limit") && !badLimit.includes("0-inbox/contacts")
    );
    const capped = await callTool(env, OWNER_TOKEN, "list_contacts", { limit: 1 });
    check(
      "a limit shows that many and says how many more there are",
      capped.includes(mine) && !capped.includes(adam) && capped.includes("3 more")
    );

    /* -------------------------------- reading ----------------------------- */

    const page = await callTool(env, OWNER_TOKEN, "read_contact", { path: adam });
    check("read_contact returns the person", page.includes("# Adam Okonkwo"));
    check("...their identifiers", page.includes("- email: adam@example.net") && page.includes("- chat: users/12345"));
    check("...the user's own notes about them", page.includes("Prefers a call."));
    check("...their activity as links into the days", page.includes("[[0-inbox/google-chat/2026-09-05#msg-0123456789abcdef|Quarterly numbers]]"));
    check("...and the visibility of the note it read", page.includes("visibility: team"));
    check(
      "...saying the messages live in the day rather than here",
      page.includes("read_channel_day")
    );
    check(
      "...and that what is on the page is a sender's claim",
      page.includes("claim its sender made")
    );

    const busy = await callTool(env, OWNER_TOKEN, "read_contact", { path: dara });
    check(
      "a long history is cut to the recent entries",
      (busy.match(/\[\[0-inbox\/google-chat\//g) ?? []).length === 5
    );
    check(
      "...saying how many there are and how to get them",
      busy.includes("8 activity entries") && busy.includes("activity: true")
    );
    const whole = await callTool(env, OWNER_TOKEN, "read_contact", { path: dara, activity: true });
    check(
      "and returns the whole page when asked",
      (whole.match(/\[\[0-inbox\/google-chat\//g) ?? []).length === 8
    );

    check(
      "a note of the user's own is handed to read_note rather than rendered as a person",
      (await callTool(env, OWNER_TOKEN, "read_contact", { path: mine })).includes("Read it with read_note") &&
        !(await callTool(env, OWNER_TOKEN, "read_contact", { path: mine })).includes(
          "# Who to call about the lease"
        )
    );

    check(
      "and an encrypted one is handed to read_note, which is what can open it",
      (await callTool(env, OWNER_TOKEN, "read_contact", { path: sealed })).includes(
        "an encrypted note"
      ) &&
        (await callTool(env, OWNER_TOKEN, "read_contact", { path: sealed })).includes(
          "Read it with read_note"
        )
    );
    check(
      "a contact nobody may see reads exactly like one that never existed",
      (await callTool(env, TEAM_TOKEN, "read_contact", { path: dara })) === "not found" &&
        (await callTool(env, TEAM_TOKEN, "read_contact", {
          path: "0-inbox/contacts/email-nobody-at-example-net.md",
        })) === "not found"
    );
    check(
      "an ordinary note is read through read_note, not through this",
      (await callTool(env, OWNER_TOKEN, "read_contact", { path: "index.md" })) ===
        "not a contact page — read it with read_note"
    );
    check(
      "a day of a channel is read through its own tool",
      (await callTool(env, OWNER_TOKEN, "read_contact", { path: "0-inbox/google-chat/2026-09-05.md" })) ===
        "not a contact page — read it with read_note"
    );
    check(
      "a traversal is refused before anything is read",
      (await callTool(env, OWNER_TOKEN, "read_contact", { path: "../../etc/passwd" })) === "invalid path"
    );

    /* ------------------------------ the switch ---------------------------- */

    await bucket.put(
      ".context/plugins/enabled.json",
      JSON.stringify({ version: 1, enabled: [], disabled: ["context-contacts"] })
    );
    const refused = await callTool(env, OWNER_TOKEN, "list_contacts");
    check(
      "turning Contacts off refuses its tools by name, with the way back",
      refused.includes("Contacts") && refused.includes("Plugins") && !refused.includes("unknown tool")
    );
    check(
      "...and the pages are still ordinary notes the read tools serve",
      (await callTool(env, OWNER_TOKEN, "read_note", { path: adam })).includes("Adam Okonkwo")
    );
    await bucket.delete(".context/plugins/enabled.json");
  } finally {
    restore();
  }
}
