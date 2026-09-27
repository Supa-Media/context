import type { Visibility } from "./types";

/**
 * How a note's visibility is put into words: the Properties panel's
 * `visibility` row. (It was also the breadcrumb's chip until that was removed.)
 *
 * Exported and tested on its own because it is a **claim about who can read
 * this note**, and the three cases are easy to collapse into two by somebody
 * tidying up — at which point a note that merely follows a `team` folder and a
 * note deliberately shared as an exception look identical, and the one you can
 * safely make private without thinking is no longer distinguishable.
 *
 * `brief` is the phone's wording, and it is a second *phrasing* rather than a
 * second function for exactly that reason: the branch stays here, so a case
 * cannot be dropped from one surface and kept on the other. "team — follows
 * its folder" is 24 characters beside a note name on a 390pt screen, and it
 * was winning — the name ellipsised while the sentence did not. The
 * distinction the long form exists to draw survives the trim: `set here` and
 * `inherited` are still two different answers, and still not the same as the
 * manifest's own.
 */
export function describe({
  visibility,
  inherited,
  exception,
  readOnly,
  brief = false,
}: {
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
  /** The phone's shorter wording. Same three cases. */
  brief?: boolean;
}): string {
  if (readOnly) return brief ? "access map" : "the access map";
  if (exception) return brief ? `${visibility} · set here` : `${visibility} — set on this note`;
  return brief ? `${inherited} · inherited` : `${inherited} — follows its folder`;
}
