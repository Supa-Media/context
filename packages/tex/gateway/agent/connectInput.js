/**
 * What Text them hands the Connect step (`noteConnect.js`) after a turn, or null when the turn wrote no note.
 *
 * `tainted` is this turn's own reads only (`ledger.untrusted`): words from outside it read while it wrote the notes.
 * An earlier turn that read an email marks every turn in the chat's week as tainted for the steps that read the
 * history (`showsOutsideWords`), but Connect's model is never shown the history: it sees the notes, the person's text
 * and its own read tools. Held to the history, Connect never ran in a 1:1 that had read mail that week (Lab,
 * 2026-11-20: Dev2's test chat answered "tainted" on a plain Bible study note).
 */
export function connectInput({ steps, question, ledger, group }) {
  const notes = [...new Set((Array.isArray(steps) ? steps : []).flatMap((step) => (Array.isArray(step?.wrote) ? step.wrote : [])))];
  if (notes.length === 0) return null;
  return { notes, question: typeof question === "string" ? question : "", tainted: ledger?.untrusted === true, group: group !== null && group !== undefined };
}
