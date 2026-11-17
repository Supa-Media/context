#!/usr/bin/env node
/**
 * Write the Photon project credentials as one JSON file for
 * `wrangler deploy --secrets-file`.
 *
 * JSON, not dotenv: a `$` in a value must stay a `$`. The file is the only
 * place the values go. Stdout stays empty. Stderr gets the count, never a
 * value. Exit 2 when either value is missing, and write nothing.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ PHOTON_PROJECT_ID: string, PHOTON_PROJECT_SECRET: string } | null}
 */
export function photonSecrets(env) {
  const id = env.PHOTON_PROJECT_ID ?? "";
  const secret = env.PHOTON_PROJECT_SECRET ?? "";
  if (!id || !secret) return null;
  return { PHOTON_PROJECT_ID: id, PHOTON_PROJECT_SECRET: secret };
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("photon-secrets-file.mjs: pass the output path");
    process.exit(1);
  }
  const secrets = photonSecrets(process.env);
  if (!secrets) {
    console.error("PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET are not both set.");
    process.exit(2);
  }
  writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 });
  console.error(`Wrote ${Object.keys(secrets).length} Photon secret(s) for one deploy.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
