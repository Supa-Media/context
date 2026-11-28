/**
 * The hash a take-over link's browser is watched by (`handback.js`): a SHA-256 of the browser's tag under its own
 * prefix, so the watch names nobody. The Worker and the gateway both derive it from this one function.
 */

/** The hex SHA-256 of a browser's tag, or null for anything that isn't one. */
async function browserHash(tag) {
  if (typeof tag !== "string" || !/^[0-9a-f]{64}$/.test(tag)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`browser-handback:${tag}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

module.exports = { browserHash };
