/**
 * The texting Worker's entry point, kept where Wrangler, the deploy plan and
 * the CI scope look for it. Tex's Worker code lives in `packages/tex/worker`
 * (the `@context/tex` package); this file only re-exports it, so the Worker
 * deployed from here is byte for byte the one built from the package.
 */
export { default } from "../../../packages/tex/worker/index";
export * from "../../../packages/tex/worker/index";
