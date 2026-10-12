// Gmail and Chat contact writes on the gateway's store: found by identifier,
// revived out of the archive with the gateway's own move, and the lookup's
// snapshot kept as plumbing.
//
// SABOTAGE RECORD
//   write to contactPathForDraft's answer instead of the found page -> 2 checks failed
//   move the archived page with a bare put/delete instead of toolMoveNote -> 1 check failed

import { CONTACT_INDEX_KEY, renderContactNote } from "../../../../packages/communications/src/index.js";
import { gmailMessageToEvent } from "../../src/communications/gmail/parsing.js";
import { openContactLookup, writeContactDraft } from "../../src/communications/contactLookup.js";
import { syncOneDay } from "../../src/communications/gmail/render.js";

/** A store with every guard a move asks for: conditional create, write and delete, and a paged list. */
function guardedStore(seed = {}) {
  const objects = new Map();
  let counter = 0;
  const set = (key, body) => {
    const etag = `g${++counter}`;
    objects.set(key, { body, etag });
    return { etag };
  };
  for (const [key, body] of Object.entries(seed)) set(key, body);
  return {
    objects,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return { key, etag: stored.etag, size: stored.body.length, text: async () => stored.body, arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer };
    },
    async head(key) {
      const stored = objects.get(key);
      return stored ? { key, etag: stored.etag, size: stored.body.length } : null;
    },
    async put(key, value, options = {}) {
      const current = objects.get(key);
      if (options.onlyIf?.absent && current) return null;
      if (options.onlyIf?.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) return null;
      return set(key, typeof value === "string" ? value : new TextDecoder().decode(value));
    },
    async delete(key, options = {}) {
      if (options.onlyIf?.etagMatches !== undefined && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      objects.delete(key);
      return true;
    },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const listed = [];
      const prefixes = new Set();
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const slash = delimiter ? rest.indexOf(delimiter) : -1;
        if (slash === -1) listed.push({ key, size: objects.get(key).body.length, etag: objects.get(key).etag, uploaded: new Date() });
        else prefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
      }
      return { objects: listed, delimitedPrefixes: [...prefixes], truncated: false };
    },
    text: (key) => objects.get(key)?.body ?? null,
  };
}

const PRIVACY =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\n" +
  "default_visibility: private\n\nfolder_defaults:\n  index.md: team\n\nnote_overrides:\n  # none\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n";

const claire = (extra = {}) => ({
  name: "Claire",
  wroteTo: false,
  identifiers: [{ kind: "email", value: "claire@example.invalid" }],
  activity: [{ date: "2026-10-12", path: "0-inbox/email/me/2026/10/2026-10-12.md", anchor: "msg-0123456789abcdef", label: "news", channel: "email" }],
  updatedAt: "2026-10-12T09:00:00.000Z",
  ...extra,
});

const page = (name, email) => renderContactNote({ name, slug: "x", identifiers: [{ kind: "email", value: email }], now: "2026-01-01T00:00:00.000Z" });
const contactKeys = (store) => [...store.objects.keys()].filter((key) => key.startsWith("0-inbox/contacts/"));

export async function runGmailContactChecks(check) {
  {
    const store = guardedStore({ "0-inbox/contacts/people/claire-dubois.md": page("Claire", "claire@example.invalid") });
    const result = await writeContactDraft(store, claire(), { remainingQuotaBytes: 1_000_000 });
    check("the gateway writer updates a moved page found by its email",
      result.wrote && store.text("0-inbox/contacts/people/claire-dubois.md").includes("2026-10-12") && contactKeys(store).length === 1);
    check("...and keeps the lookup for the next run as plumbing under .context/",
      JSON.parse(store.text(CONTACT_INDEX_KEY)).pages["0-inbox/contacts/people/claire-dubois.md"].ids[0] === "email:claire@example.invalid");
  }
  {
    // The archived page, and a note of the owner's that links to it.
    const archived = "4-archive/0-inbox/contacts/c/claire.md";
    const store = guardedStore({
      "privacy.md": PRIVACY,
      [archived]: page("Claire", "claire@example.invalid"),
      "2-areas/people.md": "# People\n\n- [[4-archive/0-inbox/contacts/c/claire|Claire]]\n",
    });
    await writeContactDraft(store, claire(), { remainingQuotaBytes: 1_000_000 });
    check("an archived contact is moved back to its live path by the next message, and updated there",
      store.text(archived) === null && store.text("0-inbox/contacts/c/claire.md")?.includes("2026-10-12") && contactKeys(store).length === 1);
    check("...through the gateway's own move, so a link to it follows",
      store.text("2-areas/people.md").includes("[[0-inbox/contacts/c/claire|Claire]]"));
  }
  {
    // A quota that the page does not fit in stops, as the day writer does.
    const store = guardedStore();
    const result = await writeContactDraft(store, claire({ wroteTo: true }), { remainingQuotaBytes: 10 });
    check("a new page past the remaining quota is not written and says so", result.quotaExceeded && contactKeys(store).length === 0);
  }
  {
    // One lookup across a day's drafts: the folder is listed once.
    const store = guardedStore({ "0-inbox/contacts/c/claire.md": page("Claire", "claire@example.invalid") });
    let lists = 0;
    const list = store.list.bind(store);
    store.list = async (options) => {
      if (String(options?.prefix ?? "").includes("contacts/")) lists += 1;
      return list(options);
    };
    const contacts = await openContactLookup(store);
    for (let index = 0; index < 5; index += 1) {
      await writeContactDraft(store, claire({ activity: [{ ...claire().activity[0], anchor: `msg-012345678900000${index}` }] }), { remainingQuotaBytes: 1_000_000, contacts });
    }
    check("one lookup lists the contacts folder and its archive once for a whole run, not once per draft", lists === 2);
  }
  {
    const message = (headers) => ({ id: "m", threadId: "t", internalDate: "0", payload: { mimeType: "text/plain", headers: [{ name: "From", value: "news@paper.invalid" }, ...headers], body: { data: "" } } });
    check("a List-Unsubscribe message is marked bulk", gmailMessageToEvent(message([{ name: "List-Unsubscribe", value: "<mailto:x@paper.invalid>" }]), { mailboxSlug: "me" }).bulk === true);
    check("...and so is Precedence: bulk or list", gmailMessageToEvent(message([{ name: "Precedence", value: "list" }]), { mailboxSlug: "me" }).bulk === true);
    check("...and ordinary mail is not, with no new field at all", !("bulk" in gmailMessageToEvent(message([]), { mailboxSlug: "me" })));
  }
  {
    const store = guardedStore();
    const event = { channel: "email", account: "me", messageId: "m1", threadId: "t1", sentAt: "2026-10-12T09:00:00.000Z", subject: "hi", from: { name: "Me", address: "me@example.invalid" }, to: [{ name: "Ann", address: "ann@example.invalid" }], body: "x" };
    await syncOneDay({ store, mailboxSlug: "me", address: "me@example.invalid", date: "2026-10-12", events: [event], nonce: "n", remainingQuotaBytes: 1_000_000 });
    check("a day's sync files a new page for somebody the owner wrote to under their letter",
      contactKeys(store).length === 1 && store.text("0-inbox/contacts/a/email-ann-example-invalid.md") !== null);
  }
}
