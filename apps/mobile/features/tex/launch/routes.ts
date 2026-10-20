/** tex.lc's status page: "You're on the list" until staff let the row in, then "You're in". */
export const WAITLIST_ROUTE = "/waitlist";

/** tex.lc's signed-in page: "Text Tex." with the number, and the console under it (Dev2, 2026-10-20). */
export const TEXT_ROUTE = "/text";

/**
 * Open Messages at Tex's line. Somebody who has never texted Tex finds "hi"
 * already typed (Dev2, 2026-10-20). `?&body=` is the form both iOS and
 * Android read.
 */
export function messagesHref(line: string, firstText: boolean): string {
  return firstText ? `sms:${line}?&body=hi` : `sms:${line}`;
}
