/**
 * Shared fixtures for the packaging suite, split out of `packaging.test.mjs`
 * so each behavioural slice can stay under the file-size ceiling. Not a test
 * module itself — it exports no `run*Checks` and the runner does not
 * discover it.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const require = createRequire(import.meta.url);

/** The builder config, read as text: this file has no YAML parser and needs none. */
export const BUILDER = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
export const ENTITLEMENTS = readFileSync(join(ROOT, "build/entitlements.mac.plist"), "utf8");

/**
 * A .p8 as Apple issues it, with a fake key in it. Every check that uses it is
 * about the *shape* of the document, so the bytes inside can be nonsense —
 * and in a public repository they had better be. Shared between
 * `notarizeAndShip.test.mjs`, where it is checked against `credentials()` and
 * `privateKey()`, and `deployWorkflow.test.mjs`, where it drives the
 * notarize-hook-failure checks.
 */
export const P8 = "-----BEGIN PRIVATE KEY-----\nbm90LWEtcmVhbC1rZXk=\n-----END PRIVATE KEY-----";
