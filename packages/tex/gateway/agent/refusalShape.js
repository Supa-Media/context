/**
 * WHAT A MODEL PROVIDER'S REFUSAL WAS ABOUT, WITHOUT ITS WORDS.
 *
 * 2026-11-24: every background job part in one person's chat failed with "status 400" from every payer, six times in a
 * row, and nothing kept said why, so nobody could tell a bad request from a refused key. A refusal's body can quote the
 * request (a 400 has come back "no such key quoting <their question>"), so its words are never kept. What is kept is its
 * shape: the error's type when it is a known word, the field it names as a path of plain words and numbers
 * (`messages.3.content.0.text`), and which of a fixed list of known causes it mentions. Nothing a person wrote can pass.
 */

/** The provider's error types worth naming; anything else is "other". */
const TYPES = new Set(["invalid_request_error", "authentication_error", "permission_error", "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error", "billing_error"]);

/** Known causes, each a tag and the words that mean it. Only the tag is kept. */
const CAUSES = [
  ["invalid_json", /not valid json|surrogate|invalid (json|unicode|utf-?8)/i],
  ["too_long", /prompt is too long|too many tokens|context (window|length)|exceeds? the maximum/i],
  ["empty_text", /must be non-empty|empty (text|content)/i],
  ["tool_result_missing", /tool_use.*without.*tool_result|tool_result.*(missing|expected)/i],
  ["tool_use_unmatched", /tool_result.*(does not|doesn't) (have|match)|unexpected .*tool_use_id/i],
  ["duplicate_id", /must be unique|duplicate/i],
  ["max_tokens", /max_tokens/i],
  ["thinking", /thinking|signature/i],
  ["cache_control", /cache_control|ttl/i],
  ["image", /\bimage\b|media_type|base64/i],
  ["document", /\bdocument\b|\bpdf\b/i],
  ["role_order", /roles must alternate|first message must|final assistant|prefill/i],
  ["extra_field", /extra inputs|not permitted|unexpected (field|key)/i],
  ["tools", /\btools\.\d+|tool name|input_schema/i],
  ["model", /\bmodel\b.*(not found|invalid|does not support)/i],
  ["effort", /\beffort\b|output_config/i],
  ["context_management", /context_management|context-management/i],
];

/** A dotted field path at the start of a message ("messages.3.content.0.text: ..."), plain words and numbers only. */
const FIELD = /^\s*([a-z_]{1,40}(?:\.(?:[a-z_]{1,40}|\d{1,4})){1,8})\s*:/;

/**
 * The shape of a refusal's body, `{ type?, at?, causes? }`, or null when there is none to read. Never a word of the body
 * beyond a known type, a path of plain field names and numbers, and tags from `CAUSES`.
 */
export function refusalShape(text) {
  if (typeof text !== "string" || text === "") return null;
  let error = null;
  try {
    error = JSON.parse(text)?.error ?? null;
  } catch {
    return null;
  }
  if (error === null || typeof error !== "object") return null;
  const message = typeof error.message === "string" ? error.message.slice(0, 2000) : "";
  const type = typeof error.type === "string" ? (TYPES.has(error.type) ? error.type : "other") : null;
  const at = FIELD.exec(message)?.[1] ?? null;
  const causes = CAUSES.filter(([, words]) => words.test(message)).map(([tag]) => tag);
  const shape = { ...(type ? { type } : {}), ...(at ? { at } : {}), ...(causes.length > 0 ? { causes } : {}) };
  return Object.keys(shape).length > 0 ? shape : null;
}
