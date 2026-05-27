import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

type TaskTier = 'plan' | 'build' | 'verify' | 'refine';

type TimeoutGlobal = typeof globalThis & {
  __fluePromptAttempts?: number;
};

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-meta-timeout-'));
const testGlobal = globalThis as TimeoutGlobal;

function writeRuntimeModule(relativePath: string, content: string): void {
  const target = path.join(runtimeRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

writeRuntimeModule('@flue/runtime/dist/index.mjs', `
export async function createSandboxSessionEnv() {
  return {};
}
`);

writeRuntimeModule('@flue/runtime/dist/internal.mjs', `
export class InMemorySessionStore {}
export function resolveModel(model) { return { model }; }
export function createFlueContext() {
  return {
    async init() {
      return {
        async session() {
          return {
            async prompt(_prompt, options) {
              globalThis.__fluePromptAttempts = (globalThis.__fluePromptAttempts || 0) + 1;
              await new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                  reject(new Error('controller prompt aborted by timeout'));
                }, { once: true });
              });
            },
          };
        },
      };
    },
  };
}
`);

writeRuntimeModule('@flue/runtime/dist/app.mjs', `
export function configureProvider() {}
`);

writeRuntimeModule('valibot/dist/index.mjs', `
export function object(shape) { return { type: 'object', shape }; }
export function picklist(values) { return { type: 'picklist', values }; }
export function string() { return { type: 'string' }; }
export function number() { return { type: 'number' }; }
export function boolean() { return { type: 'boolean' }; }
export function array(item) { return { type: 'array', item }; }
`);

async function main(): Promise<void> {
  process.env.FLUE_RUNTIME_NODE_MODULES = runtimeRoot;
  process.env.FLUE_META_ROUTER_TIMEOUT_MS = '25';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { flueMetaRouterService } = require('../src/main/services/flue-meta-router.service');

  const candidateModelsByTier: Record<TaskTier, string[]> = {
    plan: ['claude-sonnet-4-6'],
    build: ['codex:gpt-5.3-codex'],
    verify: ['gemini:gemini-3.5-flash'],
    refine: ['cursor:composer-2.5'],
  };
  const request = {
    sessionId: 'timeout-verifier',
    message: 'implement the fixed Auto Build category settings',
    domain: 'backend',
    config: {
      enabled: true,
      planModel: 'claude-sonnet-4-6',
      buildModel: 'codex:gpt-5.3-codex',
      verifyModel: 'gemini:gemini-3.5-flash',
      refineModel: 'cursor:composer-2.5',
      fallbackModel: 'claude-sonnet-4-6',
      costAware: true,
      costThresholdPercent: 75,
    },
    phase: {
      hasPlanContext: false,
      hasBuildContext: false,
      recentTiers: [],
    },
    heuristicTier: 'build',
    workflowTier: 'build',
    permissionMode: 'default',
    attachmentCount: 0,
    attachmentTypes: [],
    candidateModelsByTier,
    recentMessages: [],
    cerebrasKey: 'test-cerebras-key',
  };

  const startedAt = Date.now();
  const firstDecision = await flueMetaRouterService.route(request);
  const firstElapsedMs = Date.now() - startedAt;
  const secondStartedAt = Date.now();
  const secondDecision = await flueMetaRouterService.route(request);
  const secondElapsedMs = Date.now() - secondStartedAt;

  assert.equal(firstDecision, null);
  assert.equal(secondDecision, null);
  assert.equal(testGlobal.__fluePromptAttempts, 1);
  assert.ok(firstElapsedMs < 250, `Timed-out controller route took ${firstElapsedMs}ms`);
  assert.ok(secondElapsedMs < 25, `Timeout cooldown short-circuit took ${secondElapsedMs}ms`);

  console.log('auto-router Flue timeout verifier passed');
}

main()
  .finally(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    delete process.env.FLUE_META_ROUTER_TIMEOUT_MS;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
