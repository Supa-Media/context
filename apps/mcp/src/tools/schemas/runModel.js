import { LAB_MODELS } from "../runModel.js";

/** `run_model` (`manage` action `run_model`): see `tools/runModel.js`. Staff only, never offered to Tex. */
export function runModelToolDefinitions() {
  return [
    {
      name: "run_model",
      title: "Run a Lab model",
      description:
        "Run one Workers AI model for the Architecture Lab: " +
        `${LAB_MODELS.join(" or ")}. Give input as one JSON object (at most 64,000 characters of JSON). ` +
        "The answer is the model's raw output as JSON text. Only for people who edit @context-lc's AI setup; " +
        "it changes nothing and tells nobody.",
      inputSchema: {
        type: "object",
        properties: {
          model: { type: "string", enum: [...LAB_MODELS], description: "The model to run." },
          input: { type: "object", description: "What the model is given, as one JSON object." },
        },
        required: ["model", "input"],
        additionalProperties: false,
      },
      // Not read-only: a read-only tool is offered to an agent turn, and this one is staff's alone.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}
