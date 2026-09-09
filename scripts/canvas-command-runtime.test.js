'use strict';

const assert = require('assert');
const path = require('path');
const { createSchemaFactory, ensureNodeRuntimeGlobals, runCanvasCommand } = require('./canvas-command');

async function main() {
  ensureNodeRuntimeGlobals();
  const sdk = require(
    path.resolve(process.argv[2] || path.join(__dirname, '../dist/xyq-canvas-command-runtime.cjs')),
  );
  let output = '';
  await runCanvasCommand(['canvas', 'command', 'list'], {
    sdk,
    stdout: {
      write(value) {
        output += value;
      },
    },
  });
  const { commands } = JSON.parse(output);
  assert.strictEqual(commands.length, 47);
  const create = commands.find(({ name }) => name === 'create_biz_node');
  for (const kind of ['scene3d', 'timeline-composition']) {
    assert(create.input_schema.properties.nodeKind.enum.includes(kind));
  }
  assert.strictEqual(
    commands.find(({ name }) => name === 'apply_mutations').input_schema.properties.atomic.default,
    true,
  );
  for (const command of commands) {
    assert(command.input_schema.properties, `Missing properties on ${command.name}`);
  }
  const director = commands.find(({ name }) => name === 'xyq.scene3d.apply');
  const createObject = director.input_schema.properties.operations.items.oneOf.find(
    (schema) => schema.properties.command.const === 'create_node',
  ).properties.args;
  const primitive = createObject.oneOf.find((schema) => schema.properties.kind.const === 'primitive');
  const sphere = primitive.allOf.find(
    (schema) => schema.if.properties.primitiveKind.const === 'SphereGeometry',
  ).then.properties.parameters;
  assert.strictEqual(sphere.properties.radius.default, 0.55);
  assert.match(sphere.properties.phiStart.description, /radians/);
  assert.strictEqual(sphere.additionalProperties, false);
  const updatePrompt = commands.find(({ name }) => name === 'xyq.generation.update_prompt');
  assert.deepStrictEqual(updatePrompt.input_schema.required, ['nodeId', 'prompt']);
  assert.strictEqual(updatePrompt.input_schema.properties.prompt.type, 'string');
  assert.strictEqual(updatePrompt.input_schema.properties.references, undefined);
  assert.strictEqual(updatePrompt.input_schema.additionalProperties, false);

  const runtime = sdk.createXyqCanvasCommandRuntime({
    canvasId: 'artifact-test',
    transportFactory() {
      throw new Error('Pure compiled document operations must not use network');
    },
  });
  const tools = sdk.createXyqCanvasOpencodeToolDefinitions({
    schema: createSchemaFactory(),
    runtime: {
      store: runtime.store,
      permissions: ['canvas.read', 'canvas.asset.read', 'canvas.write', 'canvas.asset.write'],
    },
  });
  async function apply(mutation) {
    const result = JSON.parse(
      await tools.apply_mutations.execute({ atomic: true, intent: 'Artifact smoke', mutations: [mutation] }),
    );
    assert.strictEqual(result.ok, true, JSON.stringify(result));
  }
  try {
    await apply({ kind: 'create_biz_node', nodeKind: 'image', id: 'prompt-target' });
    const originalCaption = runtime.store.getState().assets['prompt-target'].content.caption;
    await apply({
      kind: 'create_biz_node',
      nodeKind: 'image',
      id: 'prompt-reference',
      initialData: { pippitAssetId: 'reference-media', assetId: 'reference-cloud' },
    });
    await apply({
      kind: 'invoke_command',
      name: 'xyq.generation.update_prompt',
      args: [{ nodeId: 'prompt-target', prompt: 'Use <node-asset>prompt-reference</node-asset>' }],
    });
    const promptContent = runtime.store.getState().assets['prompt-target'].content;
    assert.strictEqual(promptContent.generation.prompt, 'Use <node-asset>prompt-reference</node-asset>');
    assert.strictEqual(promptContent.caption, originalCaption);
    assert(
      Object.values(runtime.store.getRootCanvasContent().edges).some(
        (edge) =>
          edge.type === 'reference' && edge.source === 'prompt-reference' && edge.target === 'prompt-target',
      ),
    );
    runtime.store.commands.updateNodeData('prompt-target', (draft) => {
      draft.generation.references = [
        {
          type: 'image',
          pippitAssetId: 'standalone-media',
          assetId: 'standalone-cloud',
        },
      ];
    });
    const nodesBeforeAssetReference = Object.keys(runtime.store.getRootCanvasContent().nodes);
    const edgesBeforeAssetReference = Object.keys(runtime.store.getRootCanvasContent().edges);
    await apply({
      kind: 'invoke_command',
      name: 'xyq.generation.update_prompt',
      args: [
        {
          nodeId: 'prompt-target',
          prompt: 'Use uploaded <pippit-asset-id>standalone-media</pippit-asset-id>',
        },
      ],
    });
    const standaloneContent = runtime.store.getState().assets['prompt-target'].content;
    assert.strictEqual(
      standaloneContent.generation.prompt,
      'Use uploaded <pippit-asset-id>standalone-media</pippit-asset-id>',
    );
    assert(
      standaloneContent.generation.references.some(
        (reference) =>
          reference.pippitAssetId === 'standalone-media' &&
          reference.assetId === 'standalone-cloud' &&
          !reference.nodeAssetId,
      ),
    );
    assert.deepStrictEqual(
      Object.keys(runtime.store.getRootCanvasContent().nodes),
      nodesBeforeAssetReference,
    );
    assert.deepStrictEqual(
      Object.keys(runtime.store.getRootCanvasContent().edges),
      edgesBeforeAssetReference,
    );
    assert.strictEqual(runtime.store.getState().assets['standalone-media'], undefined);
    await apply({ kind: 'create_biz_node', nodeKind: 'timeline-composition', id: 'timeline' });
    const timeline = JSON.parse(await tools['xyq.timeline.query'].execute({ nodeId: 'timeline' }));
    assert.strictEqual(timeline.ok, true);
    await apply({
      kind: 'invoke_command',
      name: 'xyq.timeline.apply',
      args: [
        {
          nodeId: 'timeline',
          expectedRevision: timeline.data.draft.revision,
          commands: [{ type: 'set_output_size', payload: { width: 1280, height: 720 } }],
        },
      ],
    });
    const updated = JSON.parse(await tools['xyq.timeline.query'].execute({ nodeId: 'timeline' }));
    assert.strictEqual(updated.data.draft.output.width, 1280);

    await apply({ kind: 'create_biz_node', nodeKind: 'scene3d', id: 'director' });
    const input = {
      nodeId: 'director',
      operations: [
        { command: 'create_node', args: { kind: 'camera', id: 'artifact-camera', name: 'Artifact camera' } },
      ],
    };
    await runtime.prepareCommand('xyq.scene3d.apply', input);
    await apply({ kind: 'invoke_command', name: 'xyq.scene3d.apply', args: [input] });
    const camera = JSON.parse(
      await tools['xyq.scene3d.query'].execute({ nodeId: 'director', objectId: 'artifact-camera' }),
    );
    assert.strictEqual(camera.ok, true);
    assert.strictEqual(camera.data.node.name, 'Artifact camera');
  } finally {
    runtime.canvas.dispose();
  }
  console.log(
    `Compiled Canvas runtime smoke passed: ${commands.length} discoverable commands; prompt/reference, director and timeline edits succeeded`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
