/** The SHA-256 digest and object etag live in `packages/shared/src/objectEtag.cjs`, which the gateway imports too; re-exported so `objects.js` and the tests are unchanged. */
export { sha256, etagHex } from "../../../shared/src/objectEtag.cjs";
