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
import { isEntryId } from "../vault/entries.js";

export const FILL_LOGIN_TOOL = "fill_login";

/** Fills in one question: a sign-in, and a retry or a second step. */
export const MAX_FILLS_PER_TURN = 3;

export const FILL_LOGIN_DEFINITION = {
  name: FILL_LOGIN_TOOL,
  description:
    "Sign in with a login the person saved: fills the username and password boxes on the page your browser is on. " +
    "First open the site's sign-in page with browse, then pass the login's id from vault_list and the numbers of the boxes. " +
    "You never see the username or password; press the sign-in button with browse afterwards. " +
    "It only works on the login's own site. If there is no saved login, give them vault_add_link instead of asking for the password.",
  inputSchema: {
    type: "object",
    properties: {
      entry: { type: "string", description: "The login's id from vault_list." },
      password_ref: { type: "integer", description: "The password box's number from the last reading." },
      username_ref: { type: "integer", description: "The username or email box's number, when this page has one." },
      context: { type: "string", description: "The workspace the login is saved in, like @team, when it is not the person's own." },
    },
    required: ["entry", "password_ref"],
  },
  annotations: { openWorldHint: true },
};

const REFUSED = {
  no_key: "Saved logins are not set up in that workspace. Give the person vault_add_link to save one.",
  not_found: "There is no such login. Check vault_list.",
  not_yours: "There is no such login. Check vault_list.",
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
      if (!isEntryId(args?.entry)) return text("entry must be a login id from vault_list.", true);
      if (!isRef(args?.password_ref)) return text("password_ref must be the password box's number.", true);
      if (args.username_ref !== undefined && !isRef(args.username_ref)) {
        return text("username_ref must be the username box's number.", true);
      }
      if (fills >= MAX_FILLS_PER_TURN) return text("That's all the signing in one question gets. Answer with what you have.", true);
      // Where the browser actually is, from its last reading: the model's say
      // has no part in which site the login is checked against.
      const origin = browser.currentOrigin();
      if (origin === null) return text("Open the site's sign-in page with browse first.", true);
      fills += 1;

      let vault = store;
      if (typeof args.context === "string" && args.context.trim() !== "") {
        try {
          vault = (await store.openContext(args.context.trim())).store;
        } catch {
          vault = null;
        }
        if (!vault) return text(REFUSED.not_found, true);
      }

      let login;
      try {
        login = await openForFill(vault, undefined, { entryId: args.entry, origin });
      } catch (error) {
        return text(error instanceof VaultRefused ? (REFUSED[error.code] ?? REFUSED.not_found) : "The login could not be opened right now.", true);
      }

      const name = login.name || "the login";
      if (args.username_ref !== undefined && login.username !== "") {
        const filled = await browser.fillSecret({ ref: args.username_ref, value: login.username, origin, field: "username" });
        if (!filled.ok) return text(`Couldn't fill the username for ${name}: ${filled.reason}. Read the page again.`, true);
      }
      if (login.password === "") return text(`${name} has no password saved.`, true);
      const filled = await browser.fillSecret({ ref: args.password_ref, value: login.password, origin, field: "password" });
      if (!filled.ok) return text(`Couldn't fill the password for ${name}: ${filled.reason}. Read the page again.`, true);
      return text(`Filled the login for ${name}. Press the page's sign-in button with browse.`);
    },
  };
}
