/**
 * The consent check's words test (`consentContext.js`): a reply that names the thing, or, with a judge, answers Tex's
 * own offer. The gateway's texting actions (`machines/texActions.js`) run it on the same words.
 */

/** The longest reply that may answer Tex's offer instead of naming the thing itself ("ok yeah go ahead and share it"). */
const MAX_YES = 160;

/**
 * The code word check before a consent judge: the person's own words name the thing (`pattern`), or (Dev2,
 * 2026-11-22) they are a short reply to Tex's last text and that text names it, so "yes", "go ahead" or "do it" can
 * answer Tex's own offer. Only with a judge (`judged`): the judge, shown the same offer as `offered`, still decides
 * whether the reply agrees to it.
 */
function namesOrAnswers(pattern, words, offered = "", judged = false) {
  const said = typeof words === "string" ? words.trim() : "";
  if (pattern.test(said)) return true;
  if (!judged || said === "" || said.length > MAX_YES) return false;
  return typeof offered === "string" && offered !== "" && pattern.test(offered);
}

module.exports = { MAX_YES, namesOrAnswers };
