/**
 * `fill_card`: PAY WITH A SAVED CARD, WITHOUT THE MODEL EVER HOLDING IT.
 *
 * `fillLogin.js`'s sibling. The model names a card (an id from `fetch
 * vault:`) and the checkout's boxes by their numbers. The gateway asks the
 * person first, every time, in the Context app (`vault/pay.js`): the yes names
 * the card and the site the browser is on, read from the browser and never
 * from the model. Tex asks by text, with its answer; any other AI's ask waits
 * in the Context app. On a yes, each part is opened through the vault's one door
 * (`vault/fill.js`) and handed to the browser's fill step, which checks the
 * site and the kind of box again as it types (`infra/site-shots`). What comes
 * back is which parts were filled; never a digit of the card.
 *
 * It fills; it never presses Pay. The model presses the checkout's button
 * with send action browse, after telling the person the total.
 */

import { openForFill, VaultRefused } from "../vault/fill.js";
import { isEntryId, readMeta, siteMatches } from "../vault/entries.js";
import { CARD_PARTS, cardLabel, cardPartValue } from "../vault/card.js";
import { payAllowed } from "../vault/pay.js";
import { actorMayUse } from "../vault/access.js";

export const FILL_CARD_TOOL = "fill_card";

/** The boxes a call may name, by part: `number_ref`, `exp_ref` (one MM/YY box), `exp_month_ref`, and so on. */
const REF_ARGS = Object.fromEntries(CARD_PARTS.map((part) => [`${part}_ref`, part]));

export const FILL_CARD_DEFINITION = {
  name: FILL_CARD_TOOL,
  description:
    "Pay with a card the person saved: fills the card boxes on the checkout page your browser is on. " +
    "First get to the payment step with send action browse, then pass the card's id from fetch vault: and the numbers of the boxes. " +
    "The boxes are often in the payment processor's frame (a card form from another site), read after the page and numbered from 1001: those numbers fill too. " +
    "Each time, the person is asked to allow that card on that site; when the answer says they are being asked, tell them what you're buying and the total, and fill again once they allowed it. " +
    "You never see the card; it fills and never pays: press the page's pay button with send action browse yourself, after they know the total. " +
    "If there is no saved card, never ask for the number: send manage action vault_add's link with type card.",
  inputSchema: {
    type: "object",
    properties: {
      entry: { type: "string", description: "The card's id from fetch vault:." },
      number_ref: { type: "integer", description: "The card number box's number from the last reading." },
      exp_ref: { type: "integer", description: "One expiry box (MM/YY), when the page has one." },
      exp_month_ref: { type: "integer", description: "The expiry month box or menu, when month and year are separate." },
      exp_year_ref: { type: "integer", description: "The expiry year box or menu, when month and year are separate." },
      cvc_ref: { type: "integer", description: "The security code (CVC) box." },
      name_ref: { type: "integer", description: "The name-on-card box, when the page has one." },
      postal_code_ref: { type: "integer", description: "The billing ZIP or postcode box, when the page has one." },
      context: { type: "string", description: "The workspace the card is saved in, like @team, when it is not the person's own." },
    },
    required: ["entry", "number_ref"],
  },
  annotations: { openWorldHint: true },
};

/** One checkout gets one fill; a retry after a refused box is the second. */
export const MAX_CARD_FILLS_PER_TURN = 2;

const REFUSED = {
  no_key: "Saved cards are not set up in that workspace. Give the person a link to save one: manage action vault_add with type card.",
  not_found: "There is no such card. Check fetch vault:.",
  not_yours: "There is no such card. Check fetch vault:.",
  wrong_site: "That card is saved for different sites than the page your browser is on.",
  no_field: "That card has no value for one of those boxes.",
};

function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

const isRef = (value) => Number.isInteger(value) && value > 0;

/**
 * `browser` is the question's `browserSession`; `store` the turn's own;
 * `asks` a texted turn's ledger, so the payment ask goes out with its answer.
 */
export function fillCardTool(browser, store, { asks = null } = {}) {
  let fills = 0;
  return {
    definition: FILL_CARD_DEFINITION,
    async call(args) {
      if (!isEntryId(args?.entry)) return text("entry must be a card id from fetch vault:.", true);
      const boxes = [];
      for (const [arg, part] of Object.entries(REF_ARGS)) {
        if (args?.[arg] === undefined) continue;
        if (!isRef(args[arg])) return text(`${arg} must be a box's number from the last reading.`, true);
        boxes.push({ part, ref: args[arg] });
      }
      if (!boxes.some((box) => box.part === "number")) return text("number_ref must be the card number box's number.", true);
      if (new Set(boxes.map((box) => box.ref)).size !== boxes.length) return text("Each box is named once.", true);
      if (fills >= MAX_CARD_FILLS_PER_TURN) return text("That's all the card filling one question gets. Answer with what you have.", true);
      // Where the browser actually is: the yes and the fill are for this site, never one the model names.
      const origin = browser.currentOrigin();
      if (origin === null || !origin.startsWith("https://")) return text("Open the checkout's payment page with send action browse first.", true);
      const host = new URL(origin).hostname;

      let vault = store;
      if (typeof args.context === "string" && args.context.trim() !== "") {
        try {
          vault = (await store.openContext(args.context.trim())).store;
        } catch {
          vault = null;
        }
        if (!vault) return text(REFUSED.not_found, true);
      }
      const meta = vault?.encryptionKey ? await readMeta(vault, vault.encryptionKey, vault.actor?.workspaceId, args.entry) : null;
      if (meta === null || meta.type !== "card" || !actorMayUse(meta, vault.actor)) return text(REFUSED.not_found, true);
      // A card saved for its sites is never asked about anywhere else; `fill.js` checks again as it opens.
      const sites = Array.isArray(meta.sites) ? meta.sites : [];
      if (sites.length > 0 && !siteMatches(sites, origin)) return text(REFUSED.wrong_site, true);
      const saved = new Set((Array.isArray(meta.fields) ? meta.fields : []).map((field) => field?.name));
      const missing = boxes.find(({ part }) => !(part === "exp" ? saved.has("exp_month") && saved.has("exp_year") : saved.has(part)));
      if (missing) return text(`${cardLabel(meta)} has nothing saved for the ${missing.part.replace("_", " ")} box; leave that box for the person.`, true);
      // Nothing is opened before the person's yes for this card on this site.
      // Only the turn's own vault is asked about by text: a yes texted to Tex settles in the turn's store (`textedPay.js`).
      const yes = await payAllowed(vault, { entryId: args.entry, meta, host, asks: vault === store ? asks : null });
      if (!yes.allowed) return text(yes.message, true);
      fills += 1;

      const opened = {};
      try {
        for (const part of ["number", "exp_month", "exp_year", "cvc", "name", "postal_code"]) {
          if (!boxes.some((box) => box.part === part || (box.part === "exp" && (part === "exp_month" || part === "exp_year")))) continue;
          opened[part] = (await openForFill(vault, undefined, { entryId: args.entry, origin, field: part })).value;
        }
      } catch (error) {
        return text(error instanceof VaultRefused ? (REFUSED[error.code] ?? REFUSED.not_found) : "The card could not be opened right now.", true);
      }
      const done = [];
      for (const { part, ref } of boxes) {
        const value = cardPartValue(part, (name) => opened[name] ?? null);
        if (!value) return text(`${cardLabel(meta)} has nothing saved for the ${part.replace("_", " ")} box.`, true);
        const filled = await browser.fillSecret({ ref, value, origin, field: `cc-${part.replace(/_/g, "-")}` });
        if (!filled.ok) {
          return text(`Couldn't fill the ${part.replace("_", " ")} box: ${filled.reason}. Read the page again; the yes was used, so filling again asks the person again.`, true);
        }
        done.push(part.replace("_", " "));
      }
      return text(`Filled ${done.join(", ")} with ${cardLabel(meta)}. Tell the person the total, then press the page's pay button with send action browse.`);
    },
  };
}
