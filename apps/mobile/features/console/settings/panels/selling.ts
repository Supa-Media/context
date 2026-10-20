/**
 * Whether this deployment sells anything right now: the one question every
 * dormant Premium surface (the Plan row, the priced storage card, the confirm
 * screen) asks before drawing itself. Context is free (decided by the owner,
 * 2026-10-20), so today the answer is no; `docs/decisions/billing.md`.
 *
 * Only an explicit `free: false` answers yes. A status still in flight, and a
 * control plane that never sent the field, both read as "not selling", so a
 * slow query can never flash a price at somebody.
 */
export function isSelling(status: { free?: boolean } | null | undefined): boolean {
  return status?.free === false;
}
