import { requireOptionalNativeModule } from "expo";
import type { ContextNativeCryptoModule } from "./ContextNativeCrypto.types";

/** Null on binaries built before this module existed; callers must fail closed. */
export default requireOptionalNativeModule<ContextNativeCryptoModule>("ContextNativeCrypto");
