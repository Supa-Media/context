/**
 * A setup's search settings laid over the ones a store already carries. Context's search fills every setting the
 * store leaves out with its own default when it reads them (`apps/mcp/src/search/settings.js` `searchSettingsOf`),
 * so Tex sets only what the setup names and reads none of the gateway's search code.
 *
 * @param {object} store the turn's store, whose `searchSettings` the search tools read
 * @param {object} over the setup's checked settings (`readSearchSettings`)
 */
export function overSearchSettings(store, over) {
  const base = store?.searchSettings && typeof store.searchSettings === "object" ? store.searchSettings : {};
  return { ...base, ...over };
}
