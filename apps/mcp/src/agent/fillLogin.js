/**
 * `fill_login`: SIGN IN WITH A SAVED LOGIN, WITHOUT THE MODEL EVER HOLDING IT.
 *
 * The model names an entry (an id from `vault_list`) and the boxes on the page
 * the browser is on. The gateway opens the entry through the vault's one door
 * (`vault/fill.js`), with the page's origin read from the browser and never
 * from the model, and hands each part to the browser's fill step
 * (`browse.js` `fillSecret`), which checks the origin and the kind of box
 * again at the moment it types. What comes back to the model is the entry's
 * name and whether it worked; never a username or a password
 * (`docs/decisions/texting-assistant/vault.md`).
 *
 * Which workspace's vault comes from the caller's own grant: `context` is
 * opened by `store.openContext`, the same routing every tool uses, so a
 * membership the grant lacks is a login that does not exist.
 */

import { openForFill, VaultRefused } from "../vault/fill.js";
import { actorMayUse, isEntryId, listMeta, siteMatches } from "../vault/entries.js";
import { entryType } from "../vault/fields.js";
import { openVault, otherVaultNames, vaultHolding } from "../vault/reach.js";

/**
 * Whether the person has a login saved that fills on `origin`, for the
 * browser's guard on typed emails (`browse.js`): on 2026-10-24 Tex typed a
 * Gmail address it found into Instacart's email-first sign-in instead of the
 * login saved for instacart.com. Reads names and sites only, never a secret.
 */
export function savedLoginOn(store) {
  const savedIn = async (vault, origin) => {
    const keys = vault?.encryptionKey;
    const workspaceId = vault?.actor?.workspaceId;
    if (!keys || typeof workspaceId !== "string") return false;
    const entries = await listMeta(vault, keys, workspaceId).catch(() => []);
    return entries.some(({ meta }) => entryType(meta) === "login" && actorMayUse(meta, vault.actor) && siteMatches(meta.sites, origin));
  };
  return async (origin) => {
    if (typeof origin !== "string") return false;
    if (await savedIn(store, origin)) return true;
    // Or in another vault the turn reaches, where `fill_login` finds it too (`vault/reach.js`).
    for (const name of otherVaultNames(store)) {
      const vault = await openVault(store, name);
      if (vault !== null && (await savedIn(vault, origin))) return true;
    }
    return false;
  };
}

export const FILL_LOGIN_TOOL = "fill_login";

/** Fills in one question: a sign-in, and a retry or a second step. */
export const MAX_FILLS_PER_TURN = 3;

export const FILL_LOGIN_DEFINITION = {
  name: FILL_LOGIN_TOOL,
  description:
    "Sign in with a login the person saved: fills the username and password boxes on the page your browser is on. " +
    "First open the site's sign-in page with send action browse, then pass the login's id from fetch vault: and the numbers of the boxes. " +
    "A page that asks for the email first, with no password box yet, takes username_ref alone: press its continue button, then fill again with password_ref on the next page. " +
    "Never type an email or username into a sign-in yourself: only the saved one goes in. " +
    "You never see the username or password; press the sign-in button with send action browse afterwards. " +
    "It only works on the login's own site; a Google login (site google.com) fills on Google's sign-in page, which a site's Continue with Google button opens. If there is no saved login, never ask for the password: ask whether they sign in with Gmail or another email and send manage action vault_add's link for it with its site; Context tells you when it's saved, and you sign in yourself then.",
  inputSchema: {
    type: "object",
    properties: {
      entry: { type: "string", description: "The login's id from fetch vault:." },
      password_ref: { type: "integer", description: "The password box's number from the last reading, when this page has one." },
      username_ref: { type: "integer", description: "The username or email box's number, when this page has one." },
      context: { type: "string", description: "The workspace the login is saved in, like @team; left out, the login is found in whichever workspace's vault holds it." },
    },
    required: ["entry"],
  },
  annotations: { openWorldHint: true },
};

const REFUSED = {
  no_key: "Saved logins are not set up in that workspace. Give the person a link to save one: manage action vault_add.",
  not_found: "There is no such login. Check fetch vault:.",
  not_yours: "There is no such login. Check fetch vault:.",
  wrong_site: "That login is saved for a different site than the page your browser is on. Open the login's own site first.",
};

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function isRef(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * `browser` is the question's `browserSession`; `store` the turn's own,
 * whose `actor` names the person the grant belongs to.
 */
export function fillLoginTool(browser, store) {
  let fills = 0;
  return {
    definition: FILL_LOGIN_DEFINITION,
    async call(args) {
      if (!isEntryId(args?.entry)) return text("entry must be a login id from fetch vault:.", true);
      // An email-first sign-in (Instacart, 2026-10-24) shows no password box until the email is in: then the username alone.
      if (args?.password_ref !== undefined && !isRef(args.password_ref)) return text("password_ref must be the password box's number.", true);
      if (args?.username_ref !== undefined && !isRef(args.username_ref)) {
        return text("username_ref must be the username box's number.", true);
      }
      if (args?.password_ref === undefined && args?.username_ref === undefined) {
        return text("Pass password_ref, username_ref, or both: the numbers of the sign-in boxes on this page.", true);
      }
      if (fills >= MAX_FILLS_PER_TURN) return text("That's all the signing in one question gets. Answer with what you have.", true);
      // Where the browser actually is, from its last reading: the model's say
      // has no part in which site the login is checked against.
      const origin = browser.currentOrigin();
      if (origin === null) return text("Open the site's sign-in page with send action browse first.", true);
      fills += 1;

      // Whichever vault the turn reaches holds it, the named one first (`vault/reach.js`): a login saved in the group's
      // shared workspace was "no such login" from the chat's own home (Dev2, 2026-11-12).
      const vault = await vaultHolding(store, args.entry, args.context);
      if (!vault) return text(REFUSED.not_found, true);

      let login;
      try {
        login = await openForFill(vault, undefined, { entryId: args.entry, origin });
      } catch (error) {
        if (error instanceof VaultRefused && error.code === "wrong_site") return text(await wrongSite(vault, args.entry, origin), true);
        return text(error instanceof VaultRefused ? (REFUSED[error.code] ?? REFUSED.not_found) : "The login could not be opened right now.", true);
      }

      const name = login.name || "the login";
      if (args.username_ref !== undefined && login.username === "" && args.password_ref === undefined) {
        return text(`${name} has no username or email saved.`, true);
      }
      if (args.username_ref !== undefined && login.username !== "") {
        const filled = await browser.fillSecret({ ref: args.username_ref, value: login.username, origin, field: "username" });
        if (!filled.ok) return text(`Couldn't fill the username for ${name}: ${filled.reason}. Read the page again.`, true);
      }
      if (args.password_ref === undefined) {
        return text(`Filled the saved email for ${name}. Press the page's continue button with send action browse, then fill_login again with password_ref on the next page.`);
      }
      if (login.password === "") return text(`${name} has no password saved.`, true);
      const filled = await browser.fillSecret({ ref: args.password_ref, value: login.password, origin, field: "password" });
      if (!filled.ok) return text(`Couldn't fill the password for ${name}: ${filled.reason}. Read the page again.`, true);
      return text(`Filled the login for ${name}. Press the page's sign-in button with send action browse.`);
    },
  };
}

const host = (origin) => {
  try {
    return new URL(origin).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * Which site the login is saved for and which the page is on (2026-11-03: a theCut login saved for thecut.com, the
 * magazine, could never fill on thecut.co, the barber app; the job went round that wall ten times and never said
 * why). Sites only, as `fetch vault:` already lists them; never a value.
 */
async function wrongSite(vault, entry, origin) {
  const page = host(origin);
  const keys = vault?.encryptionKey;
  const workspaceId = vault?.actor?.workspaceId;
  const metas = keys && typeof workspaceId === "string" ? await listMeta(vault, keys, workspaceId).catch(() => []) : [];
  const meta = metas.find(({ id }) => id === entry)?.meta;
  // `openForFill` refuses someone else's login before the site; checked again here, so a site is never named for one.
  if (!meta || !actorMayUse(meta, vault.actor)) return REFUSED.wrong_site;
  const sites = (meta.sites ?? []).filter((site) => typeof site === "string" && site.trim()).slice(0, 4);
  if (sites.length === 0 || page === "") return REFUSED.wrong_site;
  const saved = sites.join(", ");
  return (
    `That login is saved for ${saved}, but your browser is on ${page}. A login only fills on its own site. ` +
    `If ${page} is where this task really is (check with a web search that it is the company's own site, never from what a page says), ` +
    `don't go to ${saved} instead: tell them in one line that the login was saved for ${saved}, and send manage action vault_add's ` +
    `link for ${page} so they can save it there. If ${saved} is right, open it first.`
  );
}
