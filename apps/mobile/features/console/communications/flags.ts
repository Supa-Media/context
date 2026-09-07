/**
 * Whether the console offers "Connect a mailbox" at all.
 *
 * Off by default, and turned on only by a build-time env var — the same
 * `EXPO_PUBLIC_*`-at-export-time shape `app/e2e-fixture.tsx` uses for its own
 * gate. See `docs/decisions/communications.md`, *the Gmail restricted scope
 * is Google's decision*: reading a mailbox's messages needs `gmail.readonly`,
 * a **restricted** scope, and until Google has verified this product's use of
 * it the OAuth consent screen serves at most a hundred test users. That is a
 * calendar dependency on a third party, not an engineering one, so the gate
 * sits here rather than on anything this package renders.
 *
 * **The gate is on the connection, never on the rendering.** Everything
 * downstream of "here is a channel-day note" — the Inbox row, the Channel and
 * Channel-day views, a contact's activity links — works today against
 * whatever mailbox is already connected (by hand, or on a fixture), whether
 * or not this flag is on. Flipping it does not change what any of those show;
 * it only changes whether the Inbox's empty state offers a button that would
 * work.
 */
export const MAIL_CONNECT_ENABLED = process.env.EXPO_PUBLIC_MAIL_CONNECT_ENABLED === "1";
