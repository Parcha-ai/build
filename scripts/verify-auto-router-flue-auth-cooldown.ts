import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

type TaskTier = 'plan' | 'build' | 'verify' | 'refine';

type AuthCooldownGlobal = typeof globalThis & {
  __flueConfigureAttempts?: number;
};

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-meta-auth-cooldown-'));
const testGlobal = globalThis as AuthCooldownGlobal;

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
            async prompt() {
              return { data: null };
            },
          };
        },
      };
    },
  };
}
`);

writeRuntimeModule('@flue/runtime/dist/app.mjs', `
export function configureProvider() {
  globalThis.__flueConfigureAttempts = (globalThis.__flueConfigureAttempts || 0) + 1;
  throw { status: 401, message: 'Wrong API Key', code: 'wrong_api_key', api_key: 'sk-live-1234567890abcdef' };
}
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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { flueMetaRouterService } = require('../src/main/services/flue-meta-router.service');

  const candidateModelsByTier: Record<TaskTier, string[]> = {
    plan: ['claude-sonnet-4-6'],
    build: ['codex:gpt-5.3-codex'],
    verify: ['gemini:gemini-3.5-flash'],
    refine: ['cursor:composer-2.5'],
  };
  const request = {
    sessionId: 'auth-cooldown-verifier',
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
    cerebrasKey: 'bad-cerebras-key',
  };

  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };

  let firstDecision: unknown;
  let secondDecision: unknown;
  let secondElapsedMs = 0;
  try {
    firstDecision = await flueMetaRouterService.route(request);
    const secondStartedAt = Date.now();
    secondDecision = await flueMetaRouterService.route(request);
    secondElapsedMs = Date.now() - secondStartedAt;
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(firstDecision, null);
  assert.equal(secondDecision, null);
  assert.equal(testGlobal.__flueConfigureAttempts, 1);
  assert.ok(secondElapsedMs < 25, `Auth cooldown short-circuit took ${secondElapsedMs}ms`);
  assert.doesNotMatch(warnings.join('\n'), /sk-live-1234567890abcdef/);
  assert.match(warnings.join('\n'), /\[REDACTED_SECRET\]/);

  console.log('auto-router Flue auth cooldown verifier passed');
}

main()
  .finally(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
