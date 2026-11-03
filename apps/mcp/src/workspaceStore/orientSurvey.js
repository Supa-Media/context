/**
 * `orient`'s map of this workspace, drawn here from the object's own rows (`ws.orient.survey`), decided 2026-11-03
 * for Dev's "every read under 0.1 s".
 *
 * Before, the gateway asked for every path the reader may see (`ws.rows.manifest`, a megabyte for 10,000 notes),
 * then drew each workspace's map itself, one after another on one thread, then asked again for the folder notes and
 * the built-in jobs. Here the object judges its rows exactly as that listing does (`manifestPage` over `judgeFor`),
 * draws the same map with the same code (`orient/surveyOf.js`), answers its facts from its own tables, and sends only
 * the map. Each workspace of an `orient` draws its own at once.
 *
 * `{served: false}` wherever the listing would not be served whole (no rules held, notes not at home here, more than
 * one page), and the gateway draws the map as before.
 */

import { manifestPage } from "./manifest.js";
import { servedListingStore } from "../tree/served.js";
import { surveyLocally } from "../orient/surveyOf.js";

const NOT_SERVED = Object.freeze({ served: false });

/**
 * @param {ReturnType<import("./rows.js").workspaceRows>} rows
 * @param {ReturnType<import("./serve.js").judgeFor>} judge the reader as every other answer here judges them
 * @param {(request: object) => object} facts this object's own facts answer for the same reader (`ws.facts`)
 */
export async function orientSurvey(rows, judge, facts) {
  if (judge.clearance === null || judge.parsed === null) return NOT_SERVED;
  const page = manifestPage(rows, { folder: "" }, judge);
  if (page.served !== true || page.cursor !== null) return NOT_SERVED;
  const entries = page.entries;
  const listing = servedListingStore({
    treeManifest: async ({ folder } = {}) => ({
      served: true,
      entries: folder === undefined || folder === "" ? entries : entries.filter((entry) => entry.path.startsWith(`${folder}/`)),
      cursor: null,
    }),
  });
  const survey = await surveyLocally(listing, { treeFacts: async (request) => facts(request) }, judge.clearance.scope, judge.parsed.rules, judge.parsed.overrides);
  if (survey.unreadable) return NOT_SERVED;
  return { served: true, survey };
}
