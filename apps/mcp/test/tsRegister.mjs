// `node --import ./test/tsRegister.mjs`: registers `tsHook.mjs` (see its header).
import { register } from "node:module";

register("./tsHook.mjs", import.meta.url);
