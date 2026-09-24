/**
 * Storage bindings.
 *
 * The two things that must hold no matter what changes here:
 *  - the secret access key is never stored in the clear, and
 *  - no public function returns it, in any form, to anyone.
 */

import { expect } from "vitest";
import {
  type TestConvex,
  bindFakeStorage,
  createUser,
  createWorkspace,
  setupTest,
} from "../fixtures.helpers";

/**
 * Narrow a gateway credential to the S3 shape.
 *
 * The credential is a union now — a Dropbox binding carries an access token and
 * no key pair — so a test about a bucket secret has to say it is looking at a
 * bucket. Asserting rather than casting: if one of these fixtures ever became
 * a Dropbox binding, this fails instead of reading `undefined`.
 */
export function asS3(credential: unknown) {
  const c = credential as { provider?: string; secretAccessKey?: string; forcePathStyle?: boolean };
  expect(c?.provider).not.toBe("dropbox");
  return c;
}

export async function boundWorkspace() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  await bindFakeStorage(t, owner, workspaceId);
  return { t, owner, workspaceId };
}
