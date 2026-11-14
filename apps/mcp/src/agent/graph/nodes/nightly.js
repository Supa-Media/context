/**
 * Tex's nightly start: the night's work for one person, `dream` or `housekeeping`, from the nightly route. Its wires
 * (`nightly` -> `dream`, `nightly` -> `housekeep`) live in texConfig.json, not here, and the shared runner follows them.
 */
export default async function nightly(input) {
  if (input.run !== "dream" && input.run !== "housekeeping") throw new TypeError(`nightly: no run "${input.run}"`);
  return { to: input.run, timeZone: input.timeZone, ...(input.since !== undefined && input.since !== null ? { since: input.since } : {}) };
}
