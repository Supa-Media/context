/**
 * `POST /api/sheets/rows`: rows added to a sheet by its source key.
 *
 * The door is `sheetSourceRoute`: no handler runs until the request carries
 * `Authorization: Bearer ctxs_…` in the key's exact shape, and the key is
 * hashed there, so nothing past it ever holds the key itself. What the key may
 * do, and every refusal, is `functions/sheetSources.ts`.
 *
 * The body is `{ "rows": [ {column: value}, … ] }`, or one row on its own. A
 * value is text, a number or true/false; anything nested is refused before a
 * lookup, so the sheet module only ever sees one level of text.
 *
 * Answers carry the outcome and nothing of the sheet: how many rows went in,
 * or why none did.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import { httpAction } from "../../_generated/server";
import type { ActionCtx } from "../../_generated/server";
import { json, readJsonBody } from "./gatewayAuth";
import { serverError } from "./gatewayRoutes/responses";
import { sourceKeyHash } from "./sheetSourceKeys";
import { MAX_SOURCE_ROWS } from "./fileOps/sheetAppend";

/** Bytes a request may carry: a hundred readings, not an import. */
export const MAX_SOURCE_REQUEST_BYTES = 64_000;
const MAX_COLUMN = 80;
const MAX_VALUE = 2_000;

type Row = Record<string, string>;

/** One answer for every refusal about the key, the same as for no key at all. */
export function keyRefusedResponse(): Response {
  return json({ error: "key_refused", message: "This key cannot add rows." }, 401);
}

function refused(status: number, error: string, message: string): Response {
  return json({ error, message }, status);
}

/** A key in the header, in its shape, or nothing runs. */
export function sheetSourceRoute(handler: (ctx: ActionCtx, keyHash: string, request: Request) => Promise<Response>) {
  return httpAction(async (ctx, request) => {
    const keyHash = await sourceKeyHash(request.headers.get("authorization"));
    if (keyHash === null) return keyRefusedResponse();
    return await handler(ctx, keyHash, request);
  });
}

function cell(value: unknown): string | null {
  if (typeof value === "string") return value.length > MAX_VALUE ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "";
  return null;
}

/** The rows a body names, as one level of text, or a sentence saying why not. */
export function rowsOfBody(body: Record<string, unknown>): Row[] | string {
  const given: unknown[] = Array.isArray(body.rows) ? body.rows : "rows" in body ? [] : [body];
  if (given.length === 0) return "Send at least one row.";
  if (given.length > MAX_SOURCE_ROWS) return `Send at most ${MAX_SOURCE_ROWS} rows at a time.`;
  const rows: Row[] = [];
  for (const [index, input] of given.entries()) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return `Row ${index + 1} is not an object of column: value.`;
    const row: Row = {};
    for (const [column, value] of Object.entries(input)) {
      if (column.trim() === "" || column.length > MAX_COLUMN) return `Row ${index + 1} has a column name that is empty or too long.`;
      const text = cell(value);
      if (text === null) return `Row ${index + 1}, ${column.slice(0, MAX_COLUMN)}: a value is text, a number or true/false, at most ${MAX_VALUE} characters.`;
      row[column] = text;
    }
    rows.push(row);
  }
  return rows;
}

export async function sheetRowsHandler(ctx: ActionCtx, keyHash: string, request: Request): Promise<Response> {
  const body = await readJsonBody(request, MAX_SOURCE_REQUEST_BYTES);
  if (body === null) return refused(400, "invalid_request", `Send JSON: {"rows": [{"column": "value"}]}, at most ${MAX_SOURCE_REQUEST_BYTES} bytes.`);
  const rows = rowsOfBody(body);
  if (typeof rows === "string") return refused(400, "rows_refused", rows);
  try {
    const { appended } = await ctx.runAction(internal.functions.sheetSources.appendThroughSource, { keyHash, rows });
    return json({ appended }, 200);
  } catch (error) {
    const data = error instanceof ConvexError ? (error.data as { code?: string; message?: string } | null) : null;
    switch (data?.code) {
      case "KEY_REFUSED":
        return keyRefusedResponse();
      case "RATE_LIMITED":
        return refused(429, "rate_limited", data.message ?? "Try again later.");
      case "SHEET_ROWS_REFUSED":
        return refused(400, "rows_refused", data.message ?? "Nothing was added.");
      case "NOT_A_SHEET":
      case "NOTE_ENCRYPTED":
      case "CONTENT_TOO_LARGE":
        return refused(409, "sheet_refused", data.message ?? "Nothing was added.");
      case "CONFLICT":
        return refused(409, "busy", "The sheet was changing; send the rows again.");
      default:
        return serverError();
    }
  }
}
