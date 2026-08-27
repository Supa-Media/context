/**
 * The single refusal. Deliberately says nothing: not whether the address
 * exists, not whether the sender is allowed, not why.
 *
 * "550 5.7.1" is the right class — a permanent policy rejection — and the text
 * is the same for a mistyped address and for a targeted probe.
 *
 * It lives here rather than in `index.ts` because a Workers **entry** module may
 * only export handlers. One exported string there and the script fails to
 * instantiate, with no log and no stack — see `entryExports.test.ts`.
 */
export const REFUSAL = "550 5.7.1 Message rejected by recipient policy";
