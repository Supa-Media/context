// Gmail and Chat contact writes on the gateway's store: found by identifier,
// revived out of the archive with the gateway's own move, and the lookup's
// snapshot kept as plumbing.
//
// SABOTAGE RECORD
//   write to contactPathForDraft's answer instead of the found page -> 2 checks failed
//   move the archived page with a bare put/delete instead of toolMoveNote -> 1 check failed
//   the Gmail pass never calls sweepDormant                         -> 2 checks failed
//   sweepDormant lets a throw out (no catch)                        -> 1 check failed
//   sweepDormant ignores moveSafetyRefusal                          -> 1 check failed
//   the sweep moves with a bare put/delete instead of toolMoveNote  -> 1 check failed
//   (the Chat pass: dropping its sweepDormant call fails the Chat
//   archive test in apps/convex/__tests__/googleSyncLoop/endToEnd.test.ts)

import { CONTACT_INDEX_KEY, renderContactNote } from "../../../../packages/communications/src/index.js";
import { gmailMessageToEvent } from "../../src/communications/gmail/parsing.js";
import { openContactLookup, writeContactDraft } from "../../src/communications/contactLookup.js";
import { syncOneDay } from "../../src/communications/gmail/render.js";
import { runIncrementalSync } from "../../src/communications/gmail/sync.js";
import { createFixtureGmail, fixtureMessage } from "./fixtures.mjs";
import { withPrivacyAuthority } from "../../src/store/privacyAuthority.js";

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

/**
 * The access rows behind a store, as the control plane keeps them: the workspace is private by default, and a
 * row's tier is one `setAccess` the fixture records here. A move that lands a note at a new path writes its
 * row through this, so a later check sees it.
 */
function withRows(store) {
  const notes = [];
  let version = 1;
  const authority = {
    rules: { etag: "rows-1", folders: [], notes, accessVersion: version },
    async setAccess(change) {
      version += 1;
      const others = notes.filter((note) => note.path !== change.path);
      notes.splice(0, notes.length, ...others, ...(change.base === "inherit" ? [] : [{ path: change.path, visibility: change.base }]));
      return { ok: true, version };
    },
  };
  return withPrivacyAuthority(store, authority);
}

const claire = (extra = {}) => ({
  name: "Claire",
  wroteTo: false,
  identifiers: [{ kind: "email", value: "claire@example.invalid" }],
  activity: [{ date: "2026-10-12", path: "inbox/email/me/2026/10/2026-10-12.md", anchor: "msg-0123456789abcdef", label: "news", channel: "email" }],
  updatedAt: "2026-10-12T09:00:00.000Z",
  ...extra,
});

const page = (name, email) => renderContactNote({ name, slug: "x", identifiers: [{ kind: "email", value: email }], now: "2026-01-01T00:00:00.000Z" });
const contactKeys = (store) => [...store.objects.keys()].filter((key) => key.startsWith("inbox/contacts/"));

export async function runGmailContactChecks(check) {
  {
    const store = guardedStore({ "inbox/contacts/people/claire-dubois.md": page("Claire", "claire@example.invalid") });
    const result = await writeContactDraft(store, claire(), { remainingQuotaBytes: 1_000_000 });
    check("the gateway writer updates a moved page found by its email",
      result.wrote && store.text("inbox/contacts/people/claire-dubois.md").includes("2026-10-12") && contactKeys(store).length === 1);
    check("...and keeps the lookup for the next run as plumbing under .context/",
      JSON.parse(store.text(CONTACT_INDEX_KEY)).pages["inbox/contacts/people/claire-dubois.md"].ids[0] === "email:claire@example.invalid");
  }
  {
    // The archived page, and a note of the owner's that links to it.
    const archived = "archive/inbox/contacts/c/claire.md";
    const store = withRows(guardedStore({
      [archived]: page("Claire", "claire@example.invalid"),
      "2-areas/people.md": "# People\n\n- [[archive/inbox/contacts/c/claire|Claire]]\n",
    }));
    await writeContactDraft(store, claire(), { remainingQuotaBytes: 1_000_000 });
    check("an archived contact is moved back to its live path by the next message, and updated there",
      store.text(archived) === null && store.text("inbox/contacts/c/claire.md")?.includes("2026-10-12") && contactKeys(store).length === 1);
    check("...through the gateway's own move, so a link to it follows",
      store.text("2-areas/people.md").includes("[[inbox/contacts/c/claire|Claire]]"));
  }
  {
    // A keyed workspace (`notes-by-id.md`): the page's bytes live only at its id key,
    // so the bucket's listing of the contacts folder finds nothing. The name comes
    // from the tree, and the write goes to that name (the id layer routes it to the key).
    const KEY = "notes/0192f1a2-3b4c-7d5e-8f60-0000000000c1.md";
    const TREE_PATH = "inbox/contacts/people/claire-dubois.md";
    const store = guardedStore({ [KEY]: page("Claire", "claire@example.invalid") });
    const get = store.get.bind(store);
    const put = store.put.bind(store);
    const putPaths = [];
    store.get = (path, ...rest) => get(path === TREE_PATH ? KEY : path, ...rest);
    store.put = (path, ...rest) => {
      putPaths.push(path);
      return put(path === TREE_PATH ? KEY : path, ...rest);
    };
    store.keyedWorkspace = async () => true;
    store.treeManifest = async () => ({ served: true, entries: [{ path: TREE_PATH, etag: "t1", size: 10 }], cursor: null });
    const result = await writeContactDraft(store, claire(), { remainingQuotaBytes: 1_000_000 });
    const contactPuts = putPaths.filter((path) => path !== CONTACT_INDEX_KEY);
    check("a keyed workspace finds a contact page by the tree's name, and writes that page rather than a new one",
      result.wrote && contactPuts.length === 1 && contactPuts[0] === TREE_PATH && store.text(KEY).includes("2026-10-12"));
  }
  {
    // A quota that the page does not fit in stops, as the day writer does.
    const store = guardedStore();
    const result = await writeContactDraft(store, claire({ wroteTo: true }), { remainingQuotaBytes: 10 });
    check("a new page past the remaining quota is not written and says so", result.quotaExceeded && contactKeys(store).length === 0);
  }
  {
    // One lookup across a day's drafts: the folder is listed once.
    const store = guardedStore({ "inbox/contacts/c/claire.md": page("Claire", "claire@example.invalid") });
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
    check("one lookup lists the contacts folder and its archive (under each name the Inbox has had) once for a whole run, not once per draft", lists === 4);
  }
  {
    const message = (headers) => ({ id: "m", threadId: "t", internalDate: "0", payload: { mimeType: "text/plain", headers: [{ name: "From", value: "news@paper.invalid" }, ...headers], body: { data: "" } } });
    check("a List-Unsubscribe message is marked bulk", gmailMessageToEvent(message([{ name: "List-Unsubscribe", value: "<mailto:x@paper.invalid>" }]), { mailboxSlug: "me" }).bulk === true);
    check("...and so is Precedence: bulk or list", gmailMessageToEvent(message([{ name: "Precedence", value: "list" }]), { mailboxSlug: "me" }).bulk === true);
    check("...and ordinary mail is not, with no new field at all", !("bulk" in gmailMessageToEvent(message([]), { mailboxSlug: "me" })));
  }
  // -- the dormancy sweep, on the gateway's store and inside the Gmail pass --
  {
    const NOW = "2026-10-12T12:00:00.000Z";
    const dated = (name, email, date) => renderContactNote({
      name, slug: "x", now: "2026-01-01T00:00:00.000Z",
      identifiers: [{ kind: "email", value: email }],
      activity: [{ date, path: `inbox/email/me/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`, anchor: "msg-0123456789abcdef", label: "hi", channel: "email" }],
    });
    const seed = () => ({
      "inbox/contacts/c/claire.md": dated("Claire", "claire@example.invalid", "2025-06-01"),
      "inbox/contacts/d/dana.md": dated("Dana", "dana@example.invalid", "2026-09-01"),
      "2-areas/people.md": "# People\n\n- [[inbox/contacts/c/claire|Claire]]\n",
    });
    {
      const store = withRows(guardedStore(seed()));
      const contacts = await openContactLookup(store);
      const swept = await contacts.sweepDormant({ now: NOW });
      check("the gateway sweep archives a dormant page at its mirror path and keeps an active one",
        swept.archived.length === 1 && store.text("archive/inbox/contacts/c/claire.md") !== null &&
          store.text("inbox/contacts/c/claire.md") === null && store.text("inbox/contacts/d/dana.md") !== null);
      check("...through the gateway's own move, so a link to it follows",
        store.text("2-areas/people.md").includes("[[archive/inbox/contacts/c/claire|Claire]]"));
      await writeContactDraft(store, claire(), { remainingQuotaBytes: 1_000_000, contacts });
      check("...and the next message brings it back, with the link, and no duplicate",
        store.text("inbox/contacts/c/claire.md")?.includes("2026-10-12") && store.text("archive/inbox/contacts/c/claire.md") === null &&
          store.text("2-areas/people.md").includes("[[inbox/contacts/c/claire|Claire]]") && contactKeys(store).length === 2);
    }
    {
      const store = withRows(guardedStore(seed()));
      store.capabilities = { conditionalWrite: true };
      const swept = await (await openContactLookup(store)).sweepDormant({ now: NOW });
      check("on a bucket that cannot move a note safely the sweep does not try, and the page stays live",
        swept.failed === 0 && swept.archived.length === 0 && store.text("inbox/contacts/c/claire.md") !== null);
    }
    {
      const store = withRows(guardedStore(seed()));
      store.list = async () => { throw new Error("listing refused"); };
      let threw = false;
      try {
        await (await openContactLookup(store)).sweepDormant({ now: NOW });
      } catch {
        threw = true;
      }
      check("a sweep whose listing fails answers rather than throwing", !threw && store.text("inbox/contacts/c/claire.md") !== null);
    }
    const gmail = () => createFixtureGmail({
      messages: [fixtureMessage({ id: "i1", threadId: "t1", date: "2026-10-12T09:00:00.000Z", from: "a@example.invalid", to: "me@example.invalid", subject: "x", text: "x" })],
      history: { pages: [{ history: [{ messagesAdded: [{ message: { id: "i1" } }] }], historyId: "2000" }] },
    });
    const pass = (store) => {
      const fixture = gmail();
      return runIncrementalSync({
        store, fetchImpl: fixture.fetchImpl, accessToken: "tok", mailboxSlug: "me", address: "me@example.invalid",
        folders: ["inbox", "sent"], startHistoryId: "1000", nonce: "n", quotaBytes: 1_000_000, dormancyNow: NOW,
      });
    };
    {
      const store = withRows(guardedStore(seed()));
      const result = await pass(store);
      check("a Gmail forward pass sweeps dormant contacts after its own writes",
        result.daysTouched.length === 1 && store.text("archive/inbox/contacts/c/claire.md") !== null &&
          store.text("inbox/contacts/d/dana.md") !== null);
      check("...and keeps what the sweep learned in the lookup's snapshot",
        JSON.parse(store.text(CONTACT_INDEX_KEY)).pages["archive/inbox/contacts/c/claire.md"] !== undefined);
    }
    {
      const store = withRows(guardedStore(seed()));
      store.delete = async () => { throw new Error("store unreachable"); };
      let threw = false;
      let result;
      try {
        result = await pass(store);
      } catch {
        threw = true;
      }
      check("a sweep that fails never fails the Gmail pass", !threw && result.historyId === "2000" && result.daysTouched.length === 1);
    }
  }
  {
    const store = guardedStore();
    const event = { channel: "email", account: "me", messageId: "m1", threadId: "t1", sentAt: "2026-10-12T09:00:00.000Z", subject: "hi", from: { name: "Me", address: "me@example.invalid" }, to: [{ name: "Ann", address: "ann@example.invalid" }], body: "x" };
    await syncOneDay({ store, mailboxSlug: "me", address: "me@example.invalid", date: "2026-10-12", events: [event], nonce: "n", remainingQuotaBytes: 1_000_000 });
    check("a day's sync files a new page for somebody the owner wrote to under their letter",
      contactKeys(store).length === 1 && store.text("inbox/contacts/a/email-ann-example-invalid.md") !== null);
  }
}
