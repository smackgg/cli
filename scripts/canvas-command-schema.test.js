"use strict";

const assert = require("assert");
const { definitionToJSON, runCanvasCommand } = require("./canvas-command");

const inputSchema = {
  type: "object",
  required: ["nodeKind"],
  properties: {
    nodeKind: { type: "string", enum: ["scene3d", "timeline-composition"] },
    initialData: {
      type: "object",
      properties: { title: { type: "string", default: "" } },
      additionalProperties: true,
    },
  },
};
const operationSchema = {
  type: "object",
  properties: {
    operations: {
      type: "array",
      items: { oneOf: [{ type: "object", properties: { command: { const: "transform" } } }] },
    },
  },
};

async function main() {
  let executions = 0;
  const sdk = {
    XYQ_CANVAS_OPENCODE_MUTATION_DEFINITIONS: [
      { kind: "create_biz_node", description: "Create node", input: "{nodeKind}", inputSchema },
    ],
    XYQ_CANVAS_REGISTERED_COMMAND_DEFINITIONS: [
      { name: "xyq.scene3d.apply", description: "Edit scene", input: "{operations}", inputSchema: operationSchema },
    ],
    createXyqCanvasOpencodeToolDefinitions() {
      return {
        "xyq.scene3d.query": {
          args: {}, description: "Query scene", inputSchema,
          async execute() { executions += 1; throw new Error("Discovery must not execute commands"); },
        },
      };
    },
  };
  async function discover(args, options = {}) {
    let output = "";
    const status = await runCanvasCommand(["canvas", "command", ...args], {
      sdk, stdout: { write(value) { output += value; } }, ...options,
    });
    assert.strictEqual(status, 0);
    return JSON.parse(output);
  }
  const { commands } = await discover(["list"]);
  assert.strictEqual(commands.length, 3);
  for (const entry of commands) {
    const described = await discover(["describe", entry.name]);
    assert.deepStrictEqual(described, entry, "list and describe must expose the same schema");
    assert.deepStrictEqual(entry.input_schema, entry.name.endsWith("apply") ? operationSchema : inputSchema);
  }
  assert.strictEqual(executions, 0, "schema discovery needs no runtime, authentication or writes");
  assert.deepStrictEqual(inputSchema.properties.nodeKind.enum, ["scene3d", "timeline-composition"]);

  const legacy = definitionToJSON("legacy", {
    description: "Legacy runtime", args: { nodeId: { type: "string" } },
  });
  assert.deepStrictEqual(legacy.input_schema, {
    type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"],
  });
  console.log("Canvas command schema discovery tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
