/**
 * context.lc's robots.txt, served by `robotsResponse` (`icons.ts`).
 *
 * It mirrors Cloudflare's managed robots.txt list (the content-signals block
 * and its AI-crawler rules), with two changes: GPTBot and ClaudeBot are
 * `Allow: /`, because Seyi wants those two to crawl the site, and every other
 * training crawler stays at `Disallow: /`. Keep it byte for byte with that
 * list when updating it; `icons.test.ts` pins the rules that matter.
 *
 * Cloudflare's own managed robots.txt, while it is on, prepends its block
 * (GPTBot and ClaudeBot disallowed) in front of this file at the edge, and its
 * AI-crawler blocking answers those crawlers before this Worker runs. Those
 * are Cloudflare settings, not this file.
 */
export const APEX_ROBOTS_TXT = `# As a condition of accessing this website, you agree to abide by the following
# content signals:

# (a)  If a Content-Signal = yes, you may collect content for the corresponding
#      use.
# (b)  If a Content-Signal = no, you may not collect content for the
#      corresponding use.
# (c)  If the website operator does not include a Content-Signal for a
#      corresponding use, the website operator neither grants nor restricts
#      permission via Content-Signal with respect to the corresponding use.

# The content signals and their meanings are:

# search:   building a search index and providing search results (e.g., returning
#           hyperlinks and short excerpts from your website's contents). Search does not
#           include providing AI-generated search summaries.
# ai-input: inputting content into one or more AI models (e.g., retrieval
#           augmented generation, grounding, or other real-time taking of content for
#           generative AI search answers).
# ai-train: training or fine-tuning AI models.
# use:      how AI systems may consume the content (immediate, reference, or full).

# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF
# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON COPYRIGHT
# AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.

# Mirrors Cloudflare's managed robots.txt list, except GPTBot and ClaudeBot,
# which are allowed.


User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

# Training crawlers
User-agent: Amazonbot
Disallow: /

User-agent: Applebot-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: ClaudeBot
Allow: /

User-agent: Diffbot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: GPTBot
Allow: /

User-agent: omgili
Disallow: /

User-agent: anthropic-ai
Disallow: /

User-agent: Claude-Web
Disallow: /

User-agent: cohere-ai
Disallow: /

User-agent: MistralAI-Training
Disallow: /

User-agent: meta-externalagent
Disallow: /

User-agent: GoogleOther
Disallow: /

User-agent: Baiduspider
Disallow: /

User-agent: PetalBot
Disallow: /

User-agent: AwarioSmartBot
User-agent: AwarioRssBot
Disallow: /

User-agent: Google-CloudVertexBot
Disallow: /

User-agent: QualifiedBot
Disallow: /

User-agent: Cotoyogi
Disallow: /

User-agent: ICC-Crawler
Disallow: /

User-agent: atlassian-bot
Disallow: /

User-agent: FishBot
Disallow: /

User-agent: BorderxBot
Disallow: /

User-agent: NavuBot
Disallow: /

User-agent: SemrushBot-SWA
Disallow: /

User-agent: WARDBot
Disallow: /

User-agent: magpie-crawler
Disallow: /

User-agent: KimiBot
Disallow: /

User-agent: CitibotSiteCrawler
Disallow: /
`;
