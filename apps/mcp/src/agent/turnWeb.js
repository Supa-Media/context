/**
 * A turn's computer and web search (`computer.js`, `search.js`), opened once
 * per question and wrapped so that reading anything from them marks the turn
 * untrusted (`privacy/egress.js`). Moved out of `route.js`, which calls it.
 *
 * The person's own texted turn (and a routine's run) gets their computer:
 * their browser tag, so a later text carries on in the same browser, their
 * sign-ins between browsers, and their saved logins for `fill_login`.
 *
 * A group chat's turn gets the web and nothing of the tagger's (the owner,
 * 2026-10-21: "computer use as well"): a browser with no tag and no sign-ins
 * kept between browsers, because anyone in the chat steers what it does. Its
 * `fill_login` opens the chat's shared workspace's vault, and there only what
 * is given to the whole workspace (`vault/access.js`;
 * docs/decisions/texting-assistant/groups.md).
 */

import { computerFor, webSession } from "./computer.js";
import { searcherFor } from "./search.js";
import { browserOwner } from "./browserProviders.js";
import { texViewerUrl } from "../http/texComputer.js";
import { decisionEngine } from "./decide.js";
import { resolveUpload } from "./uploads.js";
import { keepDownload } from "./downloads.js";
import { markUntrusted } from "../privacy/egress.js";

/**
 * `{ opened, web }`: the question's web session (null when it has none) and
 * what `runTurn` is handed of it.
 *
 * `vouched` is the text whose addresses count as the person's own
 * (`route.js` says why a routine's is its body and never its prompt).
 */
export async function openTurnWeb(env, { session, texting, group, question, vouched, channel, store, dispatch, ledger }) {
  // The person's browser tag lets a later text carry on in the same browser
  // (`browserProviders.js`); it is made from their id, never from the request.
  // A handoff texts their own `/tex/<handle>` page, never the browser's link.
  const computer = texting
    ? computerFor(env, { owner: await browserOwner(env, session.actorUserId), viewer: texViewerUrl(env, session), store })
    : group
      ? computerFor(env)
      : null;
  // Web search is the texting assistant's too, and runs on its own (the
  // owner's decision, 2026-10-07); `search.js` says why that is accepted.
  const search = texting || group ? searcherFor(env) : null;
  const opened =
    computer === null && search === null
      ? null
      : webSession(computer, question, {
          decide: decisionEngine(env.AI),
          search,
          addresses: vouched,
          // A browser handed to the person is texted the moment it exists.
          say: channel !== null ? (text) => channel.say(text) : null,
          // The vault this turn's grant opens, for `fill_login`: a group chat's is its
          // shared workspace's, narrowed to what the whole workspace was given.
          store,
          // A card's payment is asked by text, with the turn's other asks (`vault/pay.js`).
          asks: texting || group ? ledger : null,
          // The person's own files, read as them, for a page's upload box (`uploads.js`).
          files: (step) => resolveUpload(step, { dispatch, store }),
          // A file the browser downloaded, kept in their bucket for an email or another page (`downloads.js`).
          keep: (file) => keepDownload(store, file),
        });
  // A page or a search result is text from outside the workspace: once one
  // is read, every widening in this turn asks (`privacy/egress.js`).
  const web =
    opened === null
      ? null
      : {
          tools: opened.tools,
          usage: opened.usage,
          call: (name, args) => {
            markUntrusted(ledger);
            return opened.call(name, args);
          },
        };
  return { opened, web };
}
