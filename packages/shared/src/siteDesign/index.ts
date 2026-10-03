/** Website designs: code notes, their sanitizers and the layout templates. */
export { sanitizeSiteHtml, safeSiteHref, type SanitizedHtml, type SiteHtmlOptions } from "./html";
export {
  SITE_ID_PREFIX,
  googleFontsUrl,
  isPictureData,
  sanitizeSiteCss,
  sanitizeStyleAttribute,
  type SanitizedCss,
  type SiteCssOptions,
} from "./css";
export { decodeEntities, escapeHtml } from "./entities";
export {
  DEFAULT_SITE_FRAME,
  SITE_SCOPE,
  SITE_SCOPE_CLASS,
  composeSitePage,
  siteTemplateProblems,
  type SiteDesignSource,
  type SiteNavItem,
  type SitePageData,
  type SiteSection,
} from "./template";
export {
  WEBSITE_FRAME_FILE,
  WEBSITE_LAYOUT_NAME,
  websiteCodeBlock,
  websiteCodeLanguage,
  websiteCodeName,
  type CodeBlockResult,
  type WebsiteCodeLanguage,
  type WebsiteCodeRole,
} from "./codeNotes";
export { SITE_BASE_CSS } from "./baseCss";
