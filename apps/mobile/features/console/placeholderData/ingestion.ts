import type { IngestionSettings } from "../ingestion/settings";

/**
 * The email ingestion alias, derived rather than fetched.
 *
 * Not really a placeholder any more: `getIngestionSettings` exists and returns
 * the issued alias, but it answers `null` for a personal context that has no
 * policy row yet, and its owner still needs an address to forward mail to. This
 * is the same formula the backend applies — `ingestionAddressFor` in
 * `apps/convex/functions/lib/ingestion.ts` — so what the console shows in that
 * gap is the address that would actually receive.
 *
 * **The address is real; neither half of the delivery is.** Two separate facts
 * have to hold before any surface may say mail lands, and this function knows
 * neither of them:
 *
 *  - *Does this context have an address?* Only a personal one does, so this is
 *    only ever displayed for a context that has one. A shared context is shown
 *    no address at all; see `ingestion/settings.ts`.
 *  - *Is a receiver live?* There is none deployed. Mail sent here bounces with
 *    `550 5.1.1 Address does not exist`, so every surface that renders this
 *    string must gate its delivery claims — and its Copy button — on
 *    `receivesMail`, which is where the two are `&&`-ed.
 *
 * This function deliberately returns neither fact. The first belongs to the
 * workspace and the second to the deployment; a placeholder module is the last
 * place that should be guessing at either.
 */
export function placeholderIngestionAddress(slug: string): string {
  return `${slug}@context.lc`;
}

/**
 * PLACEHOLDER — the demo's ingestion rules, one set per **personal** context.
 *
 * Replaced by the same `getIngestionSettings` call as everything else. These
 * exist so the landing page shows the two shapes the control actually has — a
 * single address, and a whole domain — instead of an empty list that would read
 * as "this does nothing".
 *
 * `pw` is absent, and that absence is the point: a shared context has no capture
 * address, so there is no policy to mock up. It used to have an entry here, and
 * the demo showed a team an inbox it would never have. See
 * `ingestion/settings.ts`.
 */
export const DEMO_INGESTION: Record<string, IngestionSettings> = {
  seyi: {
    address: "seyi@context.lc",
    targetFolder: "0-inbox/",
    allowedSenders: ["seyi@publicworship.life"],
    allowedDomains: [],
    allowAnySender: false,
    attachmentPolicy: "store",
    maxAttachmentBytes: 2_000_000,
  },
  lk: {
    address: "lk@context.lc",
    targetFolder: "0-inbox/",
    allowedSenders: [],
    allowedDomains: ["publicworship.life"],
    allowAnySender: false,
    attachmentPolicy: "list",
    maxAttachmentBytes: 2_000_000,
  },
};
