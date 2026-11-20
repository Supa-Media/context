/** Door node "readTheSetup" (texConfig.json, group "door"): reads Tex's production setup: its prompt, history length, skills, models, router and fallback. Its code is the door step `../../texEntryPoint/readTheSetup.js`. A setup that names its own models (a bench variant; live Tex's names none, `texConfig.js`) turns this turn's nodes on or off to match it, and says which. */
import { readTheSetup } from "../../texEntryPoint/readTheSetup.js";
import { doorNode } from "../doorNode.js";

export const readTheSetupNode = doorNode(readTheSetup, (t, io) => ({ production: t.production != null, productionModel: t.productionModel != null, router: t.router != null, delegation: t.delegation != null, shown: Array.isArray(t.shown) ? t.shown.length : 0, variant: io.ctx.useSetup(t.production) }));
