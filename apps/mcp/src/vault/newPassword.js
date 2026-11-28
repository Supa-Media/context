/**
 * The password generator lives in `packages/shared/src/vaultShapes.cjs`, so the gateway and Tex make one kind of
 * password. Re-exported here.
 */

export { PASSWORD_LENGTH, MIN_LENGTH, MAX_LENGTH, randomBelow, newPassword } from "../../../../packages/shared/src/vaultShapes.cjs";
