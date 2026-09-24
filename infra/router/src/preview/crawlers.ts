/**
 * Crawler detection by User-Agent.
 *
 * Split out of `../preview.ts`; see that file's docblock for why nothing here
 * ever fetches a workspace.
 */

/**
 * Crawlers named outright.
 *
 * Lowercase substrings, matched against a lowercased User-Agent. Generous on
 * purpose: a crawler we fail to recognise falls through to the SPA and unfurls
 * as a blank card, which is the failure mode people actually notice.
 */
const CRAWLER_TOKENS: readonly string[] = [
  // Chat and social unfurlers — the ones that matter for a shared link.
  "slackbot",
  "twitterbot",
  "facebookexternalhit",
  "facebookcatalog",
  "facebot",
  "whatsapp",
  "discordbot",
  "linkedinbot",
  "telegrambot",
  "skypeuripreview",
  "viber",
  "line/",
  "snapchat",
  "redditbot",
  "pinterest",
  "tumblr",
  "flipboard",
  "vkshare",
  "nuzzel",
  "quora link preview",
  "outbrain",
  "embedly",
  "iframely",
  "bitlybot",
  // Mastodon / Fediverse instances fetch cards on post.
  "mastodon",
  "pleroma",
  "misskey",
  // Apple's unfurler is what iMessage uses.
  "applebot",
  // Search engines. Not preview clients, but they read the same tags.
  "googlebot",
  "google-inspectiontool",
  "storebot-google",
  "bingbot",
  "msnbot",
  "yandexbot",
  "duckduckbot",
  "baiduspider",
  "sogou",
  "applebot-extended",
  // Auditing tools that render the head.
  "chrome-lighthouse",
  "w3c_validator",
];

/**
 * Generic fallback for crawlers nobody has heard of yet: a UA product token
 * that ENDS in bot / crawler / spider, e.g. `PetalBot/1.0`, `SemrushBot`,
 * `acme-crawler (+http://…)`, `Bytespider`.
 *
 * Requiring a non-letter (or the end of the string) after the word is what
 * stops it firing on the middle of a longer word.
 */
const GENERIC_CRAWLER = /(bot|crawler|spider)([^a-z]|$)/;

/**
 * A User-Agent presenting itself as a real browser: an engine or brand token
 * with a version number attached.
 *
 * The generic fallback above is suppressed for these, and it has to be. A bare
 * `includes("bot")` — which is what Togather's worker does — matches Android
 * Chrome on a **Cubot** handset, because the model name lands in the UA:
 * `… (Linux; Android 13; CUBOT NOTE 20) … Chrome/120 … Safari/537.36`.
 * Serving that person a preview shell means the app simply never loads for
 * them, with nothing in the response to explain why. Real crawlers that also
 * advertise Chrome — Googlebot does — are matched by name in CRAWLER_TOKENS,
 * which is checked first and is unaffected by this.
 */
const BROWSER_ENGINE =
  /(chrome|crios|firefox|fxios|safari|edg|edga|edgios|opr|opera|samsungbrowser|version)\/\d/;

/**
 * Does this User-Agent belong to a link-preview crawler or a search engine?
 *
 * A missing or empty UA is treated as human. curl and scripted clients land
 * there too, which is right: they get the SPA, the same as a browser, and
 * nothing about the response tells them anything they could not already see.
 */
export function isCrawler(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  if (CRAWLER_TOKENS.some((token) => ua.includes(token))) return true;
  if (BROWSER_ENGINE.test(ua)) return false;
  return GENERIC_CRAWLER.test(ua);
}
