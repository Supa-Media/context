/**
 * What the CSP candidate's static server keeps from a violation report, and
 * nothing more: the same bounded schema the router logs in production
 * (`infra/router/src/cspReport.ts`, `parseCspReport`).
 *
 * The router is TypeScript and this server is plain Node, so the rules are
 * repeated here rather than imported. `cspReportFixtureParity.test.ts` in the
 * router suite feeds the same hostile reports to both and fails if the
 * directive or the blocked source ever differ, or if anything from a path,
 * a query or a script sample reaches a line. Every field is one of:
 *
 *  - `document`: a class from `DOCUMENT_CLASSES`, never the document's URL;
 *  - `directive`: lowercase letters and hyphens, at most 40, else "unknown";
 *  - `blocked`: an origin, or one of the keywords CSP itself reports;
 *  - `disposition`: "enforce", "report" or "unknown".
 */

/** The classes a document can be logged as; the static server's rules name the first four. */
export const DOCUMENT_CLASSES = [
  "shell",
  "diagram",
  "drawing-editor",
  "plugin-sandbox",
  "srcdoc-or-about",
  "other-scheme",
  "unmatched",
  "unparsed",
  "none",
];

/** `blocked-uri` reduced to an origin or a keyword, exactly as the router does. */
export function originOnly(value) {
  if (typeof value !== "string" || value === "") return "none";
  if (/^(inline|eval|wasm-eval|trusted-types-policy|trusted-types-sink|self|data|blob)$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "data:" || url.protocol === "blob:") return url.protocol.slice(0, -1);
    return url.origin === "null" ? url.protocol.slice(0, -1) : url.origin;
  } catch {
    return "unparsed";
  }
}

/** A directive name, exactly as the router bounds it. */
export function directiveOf(value) {
  return typeof value === "string" && /^[a-z-]{1,40}$/.test(value) ? value : "unknown";
}

function dispositionOf(value) {
  // Chrome's legacy report omits it for an enforced policy.
  if (value === undefined) return "enforce";
  return value === "enforce" || value === "report" ? value : "unknown";
}

/**
 * The document's class. `classify` maps a path to a class; anything it
 * answers outside `DOCUMENT_CLASSES` is logged as "unmatched", so a rule can
 * never put a path in the log.
 */
function documentOf(value, classify) {
  if (typeof value !== "string" || value === "") return "none";
  // Chrome's legacy report names a `srcdoc` frame's document as bare "about".
  if (value === "about") return "srcdoc-or-about";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "unparsed";
  }
  if (url.protocol === "about:") return "srcdoc-or-about";
  if (url.protocol !== "http:" && url.protocol !== "https:") return "other-scheme";
  const found = classify(url.pathname);
  return DOCUMENT_CLASSES.includes(found) ? found : "unmatched";
}

/** The report bodies in `text`: both shapes, the same limits as the router. */
function bodiesOf(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const bodies = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed.slice(0, 20)) {
      if (entry && typeof entry === "object" && entry.type === "csp-violation" && entry.body && typeof entry.body === "object") {
        bodies.push(entry.body);
      }
    }
  } else if (parsed && typeof parsed === "object") {
    const legacy = parsed["csp-report"];
    if (legacy && typeof legacy === "object") bodies.push(legacy);
  }
  return bodies;
}

/** One log line per violation in `text`, every field bounded as above. */
export function reportLines(text, classify) {
  return bodiesOf(text).map((body) => ({
    document: documentOf(body["document-uri"] ?? body.documentURL, classify),
    directive: directiveOf(body["effective-directive"] ?? body.effectiveDirective ?? body["violated-directive"]),
    blocked: originOnly(body["blocked-uri"] ?? body.blockedURL),
    disposition: dispositionOf(body.disposition),
  }));
}
