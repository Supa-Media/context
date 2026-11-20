/**
 * `make_login`: CREATING A NEW ACCOUNT, WITHOUT THE MODEL EVER HOLDING THE PASSWORD.
 *
 * Tex is on a sign-up page in its own browser. The gateway makes a strong
 * password (`vault/newPassword.js`), saves the login to the person's vault
 * FIRST, and only then types it into the page's boxes (`browse.js`
 * `fillSecret`, which checks the origin and the kind of box again as it
 * types). The save comes first so that a page that fails after taking the
 * password never leaves the person with an account whose login is nowhere.
 * What comes back to the model is the entry's id and name, never the
 * password or the username (`docs/decisions/texting-assistant/vault.md`).
 *
 * The site is read from the browser, never from the model. An account the
 * person already has on that site is refused, because a second password would
 * lock the first one out; sign-in is `fill_login`'s job. A retry on the same
 * page in the same turn refills the same password rather than making a
 * second one, so the saved login and the typed one can never disagree.
 */

import { newEntryId, writeEntry, listMeta, actorMayUse, siteMatches } from "../../../../apps/mcp/src/vault/entries.js";
import { entryType } from "../../../../apps/mcp/src/vault/fields.js";
import { chatShareTo } from "../../../../apps/mcp/src/vault/access.js";
import { openVault } from "../../../../apps/mcp/src/vault/reach.js";
import { openForFill } from "../../../../apps/mcp/src/vault/fill.js";
import { newPassword } from "../../../../apps/mcp/src/vault/newPassword.js";
import { savedLoginOn } from "./fillLogin.js";

/** Roles whose grant may add to a workspace's vault: the same editor clearance a vault_add link needs. */
const WRITERS = new Set(["owner", "editor"]);

export const MAKE_LOGIN_TOOL = "make_login";

/** New accounts per question: a sign-up and the one retry it may need. */
export const MAX_NEW_LOGINS_PER_TURN = 2;

const MAX_USERNAME = 200;
const MAX_NAME = 80;
// Control characters, newlines included: a username is one line typed into one box.
const CONTROL = /[\u0000-\u001f\u007f]/;

export const MAKE_LOGIN_DEFINITION = {
  name: MAKE_LOGIN_TOOL,
  description:
    "Only when you are creating a NEW account for the person on the sign-up page your browser is on: makes a strong password, saves the login (this site, the username or email you pass, the password) to their vault first, then types it into the page's boxes. " +
    "You never see the password. Pass username (the email or username the account is made with), the box numbers from the last reading (username_ref, password_ref, and confirm_ref when the page asks for the password twice), and name for the vault entry. " +
    "Press the sign-up button with send action browse afterwards; later sign-ins use fill_login with the id it returns. " +
    "Never for an account they already have: then use fill_login with their saved login, or with none saved send manage action vault_add's link. " +
    "Pass symbols: false only when the site refuses symbols.",
  inputSchema: {
    type: "object",
    properties: {
      username: { type: "string", description: "The email or username the account is made with." },
      username_ref: { type: "integer", description: "The username or email box's number, from the last reading." },
      password_ref: { type: "integer", description: "The password box's number, from the last reading." },
      confirm_ref: { type: "integer", description: "The repeat-password box's number, when the page asks for the password twice." },
      name: { type: "string", description: "The vault entry's name, like the site's name." },
      symbols: { type: "boolean", description: "false only when the site refuses symbols." },
      context: { type: "string", description: "The workspace whose vault keeps it, like @team; left out, the turn's own." },
    },
    required: ["username", "password_ref"],
  },
  annotations: { openWorldHint: true },
};

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

/** Logs the event and its code only: never a username, a password or the host. */
function log(fields) {
  console.log(JSON.stringify({ event: MAKE_LOGIN_TOOL, ...fields }));
}

function isRef(value) {
  return Number.isInteger(value) && value > 0;
}

const isAbsent = (value) => value === undefined || value === null;

function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The model's arguments, checked before anything is read, saved or typed. */
function checkArgs(args) {
  const username = typeof args?.username === "string" ? args.username.trim() : "";
  if (username.length === 0 || username.length > MAX_USERNAME || CONTROL.test(username)) {
    return { error: `username must be the email or username the account is made with, up to ${MAX_USERNAME} characters, on one line.` };
  }
  if (!isRef(args.password_ref)) return { error: "password_ref must be the password box's number." };
  if (!isAbsent(args.username_ref) && !isRef(args.username_ref)) return { error: "username_ref must be the username box's number." };
  if (!isAbsent(args.confirm_ref) && !isRef(args.confirm_ref)) return { error: "confirm_ref must be the repeat-password box's number." };
  return {
    username,
    refs: {
      username: isAbsent(args.username_ref) ? undefined : args.username_ref,
      password: args.password_ref,
      confirm: isAbsent(args.confirm_ref) ? undefined : args.confirm_ref,
    },
  };
}

/**
 * The workspace's vault the turn may write to: the named one, or the turn's own. `{ vault }`, or `{ code }` when it
 * keeps no logins (`no_key`) or the grant there only reads (`read_only`, the editor clearance a vault_add link needs).
 */
async function pickVault(store, context) {
  const named = typeof context === "string" ? context.trim() : "";
  const vault = named === "" ? store : await openVault(store, named);
  if (!vault?.encryptionKey || typeof vault?.actor?.workspaceId !== "string") return { code: "no_key" };
  if (!WRITERS.has(vault.actor.role)) return { code: "read_only" };
  return { vault };
}

/**
 * Types the username and password into the boxes given, in page order. A
 * failure names which box and why, never the value. Returns an error text, or
 * null when every box took its value.
 */
async function fillBoxes(browser, { origin, username, password, refs, id, name }) {
  const boxes = [];
  if (refs.username !== undefined) boxes.push({ which: "the username", ref: refs.username, value: username, field: "username" });
  boxes.push({ which: "the password", ref: refs.password, value: password, field: "password" });
  if (refs.confirm !== undefined) boxes.push({ which: "the repeat password", ref: refs.confirm, value: password, field: "password" });
  for (const box of boxes) {
    let filled;
    try {
      filled = await browser.fillSecret({ ref: box.ref, value: box.value, origin, field: box.field });
    } catch {
      filled = { ok: false, reason: "the browser could not type into it" };
    }
    if (!filled?.ok) {
      const reason = typeof filled?.reason === "string" ? filled.reason : "the page refused";
      return text(
        `Saved the new login as ${name} (id ${id}), but couldn't fill ${box.which}: ${reason}. Read the page again and use send action fill_login with id ${id}.`,
        true,
      );
    }
  }
  return null;
}

/** The entry this turn already made for `origin`, reopened from the vault it was saved in. */
async function refill(browser, made, origin, refs, host) {
  const { id, vault, name } = made;
  let login;
  try {
    login = await openForFill(vault, undefined, { entryId: id, origin });
  } catch {
    return text(`Couldn't reopen the login saved for ${host} (id ${id}). Read the page again and use send action fill_login with id ${id}.`, true);
  }
  const failed = await fillBoxes(browser, { origin, username: login.username, password: login.password, refs, id, name });
  if (failed) return failed;
  log({ entry: id, ok: true, refill: true });
  return text(`Filled the boxes again with the login saved for ${host} (id ${id}). Press the page's sign-up button with send action browse.`);
}

/** Returns the entry's owner: the tagger when a group chat's turn made it, else the person. */
function ownerOf(actor) {
  const owner = typeof actor?.taggerId === "string" && actor.taggerId ? actor.taggerId : actor?.userId;
  return typeof owner === "string" && owner.length > 0 ? owner : null;
}

/** The new entry's meta: this site, one login, the owner's; a group chat's own link is shared to that chat. */
function newMeta({ actor, owner, host, name, now }) {
  return {
    type: "login",
    name,
    sites: [host],
    fields: [],
    people: [owner],
    ...(typeof actor.chat === "string" && actor.chat !== "" ? { shares: [{ to: chatShareTo(actor.chat), level: "use", by: owner, at: now }] } : {}),
    createdBy: owner,
    createdAt: now,
    updatedAt: now,
    madeBy: "tex",
  };
}

/**
 * Makes the password, saves the login, then types it. The password lives only
 * in this function: nothing returned or thrown carries it.
 */
async function saveAndFill(browser, made, { vault, origin, host, username, refs, args }) {
  const keys = vault.encryptionKey;
  const workspaceId = vault.actor.workspaceId;
  const actor = vault.actor;
  const owner = ownerOf(actor);
  if (owner === null) return text("There is no person to save this login for.", true);
  const now = Date.now();
  const label = typeof args.name === "string" ? args.name.trim().slice(0, MAX_NAME) : "";
  const name = label || host;
  const id = newEntryId();
  const password = newPassword({ symbols: args.symbols !== false });
  const meta = newMeta({ actor, owner, host, name, now });

  // The write comes first: if it fails, nothing is typed and no account is half made.
  try {
    await writeEntry(vault, keys, workspaceId, { id, meta, secret: { username, password, fields: [] } });
  } catch {
    log({ ok: false, code: "write_failed" });
    return text("Couldn't save the new login to the vault, so nothing was typed. Try again.", true);
  }
  made.set(origin, { id, vault, name });

  const failed = await fillBoxes(browser, { origin, username, password, refs, id, name });
  if (failed) {
    log({ entry: id, workspace: workspaceId, ok: false, code: "fill_failed" });
    return failed;
  }
  log({ entry: id, workspace: workspaceId, ok: true });
  return text(
    `Made a new password and saved the login for ${host} to the vault as ${name} (id ${id}) before typing it in; the boxes are filled. ` +
      `Press the page's sign-up button with send action browse. Later sign-ins use fill_login with id ${id}.`,
  );
}

/**
 * `browser` is the question's `browserSession`; `store` the turn's own vault
 * holder, whose `actor` names the person the grant belongs to.
 */
export function makeLoginTool(browser, store) {
  // origin -> the entry made for it this turn, so a retry refills it.
  const made = new Map();
  let created = 0;
  return {
    definition: MAKE_LOGIN_DEFINITION,
    async call(args) {
      const checked = checkArgs(args);
      if (checked.error) return text(checked.error, true);
      // Where the browser actually is, from its last reading: the model's say has no part in the site.
      const origin = browser.currentOrigin();
      if (origin === null || origin === undefined) return text("Open the site's sign-up page with send action browse first.", true);
      if (!origin.startsWith("https://")) return text("A login can only be made on a secure https:// sign-up page.", true);
      const host = hostOf(origin);
      if (host === "") return text("A login can only be made on a secure https:// sign-up page.", true);
      const { username, refs } = checked;

      if (made.has(origin)) return refill(browser, made.get(origin), origin, refs, host);

      const picked = await pickVault(store, args.context);
      if (!picked.vault) {
        log({ ok: false, code: picked.code });
        return text(
          picked.code === "read_only"
            ? "Your access to that workspace is read only, so a login can't be saved there. Pass context: a workspace you can edit, like their own."
            : "Saved logins are not set up in that workspace. Pass context: the workspace whose vault should keep it.",
          true,
        );
      }
      const { vault } = picked;

      // Never a second account's login for a site the person already has one on: first in the vault it would go to.
      const keys = vault.encryptionKey;
      const workspaceId = vault.actor.workspaceId;
      const entries = await listMeta(vault, keys, workspaceId).catch(() => []);
      const existing = entries.find(
        ({ meta }) => entryType(meta) === "login" && actorMayUse(meta, vault.actor) && siteMatches(meta.sites, origin),
      );
      if (existing) {
        const saved = typeof existing.meta.name === "string" && existing.meta.name !== "" ? existing.meta.name : "the login";
        log({ ok: false, code: "already_saved" });
        return text(
          `A login for ${host} is already saved (${saved}, id ${existing.id}). Sign in with send action fill_login and that id; never make a second account.`,
          true,
        );
      }

      // Nor in any other vault the turn reaches (`vault/reach.js`), where fill_login would find it too.
      if (await savedLoginOn(store)(origin)) {
        log({ ok: false, code: "already_saved" });
        return text(`A login for ${host} is already saved. Check fetch vault: and sign in with send action fill_login and its id; never make a second account.`, true);
      }

      if (created >= MAX_NEW_LOGINS_PER_TURN) {
        log({ ok: false, code: "cap" });
        return text("That's all the new logins one question gets. Answer with what you have.", true);
      }
      const result = await saveAndFill(browser, made, { vault, origin, host, username, refs, args });
      if (made.has(origin)) created += 1;
      return result;
    },
  };
}
