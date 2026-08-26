/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as auth from "../auth.js";
import type * as functions_audit from "../functions/audit.js";
import type * as functions_grants from "../functions/grants.js";
import type * as functions_lib_audit from "../functions/lib/audit.js";
import type * as functions_lib_crypto from "../functions/lib/crypto.js";
import type * as functions_lib_nameClaims from "../functions/lib/nameClaims.js";
import type * as functions_lib_names from "../functions/lib/names.js";
import type * as functions_lib_workspaceAuth from "../functions/lib/workspaceAuth.js";
import type * as functions_names from "../functions/names.js";
import type * as functions_storage from "../functions/storage.js";
import type * as functions_workspaces from "../functions/workspaces.js";
import type * as http from "../http.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "functions/audit": typeof functions_audit;
  "functions/grants": typeof functions_grants;
  "functions/lib/audit": typeof functions_lib_audit;
  "functions/lib/crypto": typeof functions_lib_crypto;
  "functions/lib/nameClaims": typeof functions_lib_nameClaims;
  "functions/lib/names": typeof functions_lib_names;
  "functions/lib/workspaceAuth": typeof functions_lib_workspaceAuth;
  "functions/names": typeof functions_names;
  "functions/storage": typeof functions_storage;
  "functions/workspaces": typeof functions_workspaces;
  http: typeof http;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
