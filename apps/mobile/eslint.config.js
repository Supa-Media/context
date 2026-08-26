import supaPreset from "@supa-media/linter/preset";

export default [
  ...supaPreset,
  {
    ignores: ["metro.config.js", "babel.config.js"],
  },
];
