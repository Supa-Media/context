/**
 * Whether this bridge runs Tex's Photon line: only with the project's credentials, and never where the deployment
 * turns the line off. Staging shares production's Photon project (one line, one set of secrets), so a staging bridge
 * that listened too would answer every text a second time from staging Tex; on 2026-11-15 it did, sending Dev2
 * staging's sign-up link beside production's reply. Staging's `wrangler.jsonc` sets `PHOTON_LINE: "off"`.
 */
export type LineEnv = { PHOTON_PROJECT_ID?: string; PHOTON_PROJECT_SECRET?: string; PHOTON_LINE?: string };

export function lineOn(env: LineEnv): boolean {
  return Boolean(env.PHOTON_PROJECT_ID && env.PHOTON_PROJECT_SECRET) && env.PHOTON_LINE?.trim() !== "off";
}
