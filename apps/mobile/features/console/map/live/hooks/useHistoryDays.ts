import { MCP_ENDPOINT } from "../../../placeholderData";

/**
 * How much happened on each day of a context's history, for the range
 * picker's activity strip. `at` is the day's local midnight; `startsAt` is the
 * first moment anything happened, or `null` when nothing did.
 */
export type HistoryDay = { at: number; count: number };
export type HistoryDays = { days: HistoryDay[]; startsAt: number | null; loading: boolean };

/**
 * A stand-in with the signature the real hook (`hooks/useHistory.ts`) will
 * have. It knows nothing yet, so it answers empty and not loading: the picker
 * then shows no history. Swapping the import is the whole change.
 */
export function useHistoryDays(_contextIds: readonly string[], _endpoint: string | null = MCP_ENDPOINT): HistoryDays {
  return { days: [], startsAt: null, loading: false };
}
