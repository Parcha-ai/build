#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_REMOTE_HOST = 'm';
const DEFAULT_REMOTE_USER = 'ubuntu';
const DEFAULT_REMOTE_KEY = path.join(os.homedir(), '.ssh/id_ed25519_2026');

function parseArgs(argv) {
  const args = {
    remoteHost: DEFAULT_REMOTE_HOST,
    remoteUser: DEFAULT_REMOTE_USER,
    remoteKey: DEFAULT_REMOTE_KEY,
    skipRemote: false,
    failOnSkips: false,
  };

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--skip-remote') {
      args.skipRemote = true;
    } else if (arg === '--fail-on-skips') {
      args.failOnSkips = true;
    } else if (arg === '--remote-host') {
      args.remoteHost = argv[++index];
    } else if (arg.startsWith('--remote-host=')) {
      args.remoteHost = arg.slice('--remote-host='.length);
    } else if (arg === '--remote-user') {
      args.remoteUser = argv[++index];
    } else if (arg.startsWith('--remote-user=')) {
      args.remoteUser = arg.slice('--remote-user='.length);
    } else if (arg === '--remote-key') {
      args.remoteKey = argv[++index];
    } else if (arg.startsWith('--remote-key=')) {
      args.remoteKey = arg.slice('--remote-key='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node scripts/verify-mcp-runtime-matrix.js [options]',
        '',
        'Options:',
        '  --skip-remote          Only check local harnesses/configs',
        '  --fail-on-skips        Exit non-zero if any harness runtime is skipped',
        '  --remote-host HOST     SSH host alias or hostname (default: m)',
        '  --remote-user USER     SSH username (default: ubuntu)',
        '  --remote-key PATH      SSH private key path',
      ].join('\n'));
      process.exit(0);
    }
  }

  return args;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || 20_000,
    maxBuffer: 10 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });

  const stdout = result.stdout?.toString?.() || '';
  const stderr = result.stderr?.toString?.() || '';
  return {
    ok: result.status === 0 && !result.error,
    stdout,
    stderr,
    output: `${stdout}${stderr ? `\n${stderr}` : ''}`,
  };
}

function commandExists(command) {
  return run('sh', ['-lc', `command -v ${shellQuote(command)}`], { timeoutMs: 5_000 }).ok;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function assertMcpConfig(label, text, options = {}) {
  assert.ok(text.includes('https://mcp.linear.app/sse'), `${label} should include Linear MCP URL`);
  assert.ok(text.includes('mcp-remote@0.1.38'), `${label} should use pinned mcp-remote`);
  assert.ok(!/\bmcp-remote\b(?!@0\.1\.38)/.test(text), `${label} should not use unpinned mcp-remote`);
  if (options.expectAllowHttp) {
    assert.ok(text.includes('--allow-http'), `${label} should allow HTTP localhost MCPs`);
  }
}

function checkLocalConfigs(report) {
  const home = os.homedir();
  const files = [
    ['local.cursor', path.join(home, '.cursor/mcp.json')],
    ['local.gemini', path.join(home, '.gemini/settings.json')],
    ['local.codex', path.join(home, '.codex/config.toml')],
    ['local.opencode', path.join(home, '.config/opencode/build-mcp.json')],
  ];

  for (const [label, filePath] of files) {
    const text = readIfExists(filePath);
    assertMcpConfig(label, text, { expectAllowHttp: label !== 'local.codex' || text.includes('Paper') });
    report.push({ target: label, status: 'pass', detail: filePath });
  }
}

function checkLocalRuntime(report) {
  const localCommands = {
    claude: commandExists('claude'),
    codex: commandExists('codex'),
    cursor: commandExists('cursor-agent'),
    gemini: commandExists('gemini'),
    opencode: commandExists('opencode'),
    npx: commandExists('npx'),
  };

  report.push({ target: 'local.cli', status: 'info', detail: localCommands });

  if (localCommands.codex) {
    const result = run('codex', ['mcp', 'list']);
    assert.ok(result.ok, `local codex mcp list failed: ${result.stderr || result.stdout}`);
    assert.ok(result.output.includes('linear'), 'local codex should list linear MCP');
    assert.ok(result.output.includes('mcp-remote@0.1.38'), 'local codex should list pinned mcp-remote');
    report.push({ target: 'local.codex.runtime', status: 'pass', detail: 'codex mcp list includes linear' });
  } else {
    report.push({ target: 'local.codex.runtime', status: 'skip', detail: 'codex CLI missing' });
  }

  if (localCommands.cursor) {
    const result = run('cursor-agent', ['mcp', 'list-tools', 'linear'], { timeoutMs: 30_000 });
    assert.ok(result.ok, `local cursor linear tools failed: ${result.stderr || result.stdout}`);
    assert.ok(result.output.includes('Tools for linear'), 'local cursor should list Linear tools');
    report.push({ target: 'local.cursor.runtime', status: 'pass', detail: 'cursor-agent lists Linear tools' });
  } else {
    report.push({ target: 'local.cursor.runtime', status: 'skip', detail: 'cursor-agent CLI missing' });
  }

  if (localCommands.gemini) {
    const result = run('gemini', ['mcp', 'list']);
    assert.ok(result.ok, `local gemini mcp list failed: ${result.stderr || result.stdout}`);
    assert.ok(result.output.includes('linear'), 'local gemini should list linear MCP');
    assert.ok(result.output.includes('mcp-remote@0.1.38'), 'local gemini should list pinned mcp-remote');
    report.push({ target: 'local.gemini.runtime', status: 'pass', detail: 'gemini mcp list includes linear; status may be disconnected until run with app-provided auth/trust' });
  } else {
    report.push({ target: 'local.gemini.runtime', status: 'skip', detail: 'gemini CLI missing' });
  }

  report.push(localCommands.claude
    ? { target: 'local.claude.runtime', status: 'info', detail: 'Build passes MCP servers directly to Claude SDK; Claude CLI config is separate' }
    : { target: 'local.claude.runtime', status: 'skip', detail: 'claude CLI missing' });
  const hasLocalOpenCodeRunner = localCommands.opencode || localCommands.npx;
  report.push(hasLocalOpenCodeRunner
    ? { target: 'local.opencode.runtime', status: 'info', detail: localCommands.opencode ? 'OpenCode receives OPENCODE_CONFIG at launch' : 'OpenCode runs through npx opencode-ai fallback' }
    : { target: 'local.opencode.runtime', status: 'skip', detail: 'opencode and npx missing' });

  if (hasLocalOpenCodeRunner) {
    const command = localCommands.opencode ? 'opencode' : 'npx';
    const args = localCommands.opencode ? ['mcp', 'list'] : ['-y', 'opencode-ai', 'mcp', 'list'];
    const result = run(command, args, {
      timeoutMs: 45_000,
      env: { OPENCODE_CONFIG: path.join(os.homedir(), '.config/opencode/build-mcp.json') },
    });
    assert.ok(result.ok, `local opencode mcp list failed: ${result.stderr || result.stdout}`);
    assert.ok(result.output.includes('linear'), 'local opencode should list linear MCP');
    assert.ok(result.output.includes('mcp-remote@0.1.38'), 'local opencode should list pinned mcp-remote');
    report.push({
      target: 'local.opencode.config-runtime',
      status: 'pass',
      detail: localCommands.opencode ? 'opencode mcp list includes linear' : 'npx opencode-ai mcp list includes linear',
    });
  } else {
    report.push({ target: 'local.opencode.config-runtime', status: 'skip', detail: 'opencode and npx missing' });
  }
}

function checkClaudeSdkInjection(report) {
  const claudeServiceSource = readIfExists(path.join(__dirname, '../src/main/services/claude.service.ts'));
  assert.ok(
    claudeServiceSource.includes('mcpService.getClaudeMcpServersConfig()'),
    'Claude service should load Build MCP servers from mcpService',
  );
  assert.ok(
    /Object\.assign\(mcpServersConfig,\s*userMcpServers\)/.test(claudeServiceSource),
    'Claude service should merge user MCP servers into the SDK MCP config',
  );
  assert.ok(
    /mcpServers:\s*mcpServersConfig/.test(claudeServiceSource),
    'Claude service should pass Build MCP servers to the Claude SDK query',
  );
  assert.ok(
    claudeServiceSource.includes('sshService.syncMcpConfigsToRemote(sessionId, session.sshConfig)'),
    'SSH Claude sessions should sync MCP config/auth before querying',
  );
  assert.ok(
    claudeServiceSource.includes('sshService.createRemoteProcess('),
    'SSH Claude sessions should launch the SDK process through the remote process bridge',
  );

  report.push({
    target: 'claude.sdk-injection',
    status: 'pass',
    detail: 'Claude SDK query receives mcpServersConfig locally and after SSH MCP sync',
  });
}

function remoteSshArgs(args, command) {
  return [
    '-i', args.remoteKey,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    `${args.remoteUser}@${args.remoteHost}`,
    command,
  ];
}

function remoteRun(args, command, timeoutMs = 20_000) {
  return run('ssh', remoteSshArgs(args, command), { timeoutMs });
}

function remotePathPrefix(args) {
  return [
    `export PATH="/home/${args.remoteUser}/.local/bin:/home/${args.remoteUser}/.cursor/bin:/home/${args.remoteUser}/.bun/bin:/home/${args.remoteUser}/.npm-global/bin:/home/${args.remoteUser}/bin:$HOME/.local/bin:$HOME/.cursor/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:$PATH"`,
    'for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done',
    'export PATH',
  ].join('\n');
}

function checkRemoteConfigs(args, report) {
  const script = `
for item in claude:$HOME/.claude/config.json cursor:$HOME/.cursor/mcp.json gemini:$HOME/.gemini/settings.json codex:$HOME/.codex/config.toml opencode:$HOME/.config/opencode/build-mcp.json; do
  name=\${item%%:*}
  file=\${item#*:}
  printf '___FILE_START___%s\\n' "$name"
  cat "$file" 2>/dev/null || true
  printf '\\n___FILE_END___\\n'
done
`;
  const result = remoteRun(args, script);
  assert.ok(result.ok, `remote config read failed: ${result.stderr || result.stdout}`);

  for (const block of result.output.split('___FILE_START___').filter(Boolean)) {
    const [nameLine, ...rest] = block.split('\n');
    const name = nameLine.trim();
    const text = rest.join('\n').split('___FILE_END___')[0] || '';
    assertMcpConfig(`remote.${name}`, text, { expectAllowHttp: text.includes('http://127.0.0.1') || text.includes('http://localhost') });
    report.push({ target: `remote.${name}`, status: 'pass', detail: 'contains pinned Linear MCP config' });
  }
}

function checkRemoteRuntime(args, report) {
  const availabilityScript = `
${remotePathPrefix(args)}
for cmd in claude codex cursor-agent gemini opencode npx; do
  if command -v "$cmd" >/dev/null 2>&1; then printf '%s=1\\n' "$cmd"; else printf '%s=0\\n' "$cmd"; fi
done
`;
  const availability = remoteRun(args, availabilityScript);
  assert.ok(availability.ok, `remote CLI availability check failed: ${availability.stderr || availability.stdout}`);
  const remoteCommands = Object.fromEntries(
    availability.output.trim().split('\n').filter(Boolean).map((line) => {
      const [key, value] = line.split('=');
      return [key, value === '1'];
    }),
  );
  report.push({ target: 'remote.cli', status: 'info', detail: remoteCommands });

  const linear = remoteRun(args, `${remotePathPrefix(args)}\ntimeout 10 npx -y mcp-remote@0.1.38 https://mcp.linear.app/sse --auth-timeout 5`, 15_000);
  assert.ok(linear.output.includes('Proxy established successfully'), `remote Linear mcp-remote did not connect: ${linear.stderr || linear.stdout}`);
  report.push({ target: 'remote.linear.runtime', status: 'pass', detail: 'mcp-remote connects with synced auth' });

  if (remoteCommands.codex) {
    const result = remoteRun(args, `${remotePathPrefix(args)}\ncodex mcp list`);
    assert.ok(result.ok, `remote codex mcp list failed: ${result.stderr || result.stdout}`);
    assert.ok(result.output.includes('linear'), 'remote codex should list linear MCP');
    assert.ok(result.output.includes('mcp-remote@0.1.38'), 'remote codex should list pinned mcp-remote');
    report.push({ target: 'remote.codex.runtime', status: 'pass', detail: 'codex mcp list includes linear' });
  } else {
    report.push({ target: 'remote.codex.runtime', status: 'skip', detail: 'codex CLI missing' });
  }

  report.push(remoteCommands.claude
    ? { target: 'remote.claude.runtime', status: 'info', detail: 'Claude CLI installed; Build passes MCP servers directly to Claude SDK during remote launch' }
    : { target: 'remote.claude.runtime', status: 'skip', detail: 'claude CLI missing on remote' });

  if (remoteCommands['cursor-agent']) {
    const result = remoteRun(args, `${remotePathPrefix(args)}\ntimeout 30 cursor-agent mcp list-tools linear`, 35_000);
    assert.ok(result.ok, `remote cursor linear tools failed: ${result.stderr || result.stdout}`);
    assert.ok(result.output.includes('Tools for linear'), 'remote cursor should list Linear tools');
    report.push({ target: 'remote.cursor.runtime', status: 'pass', detail: 'cursor-agent lists Linear tools' });
  } else {
    report.push({ target: 'remote.cursor.runtime', status: 'skip', detail: 'cursor-agent CLI missing on remote' });
  }

  if (remoteCommands.gemini) {
    const result = remoteRun(args, `${remotePathPrefix(args)}\ntimeout 30 gemini mcp list`, 35_000);
    assert.ok(result.ok, `remote gemini mcp list failed: ${result.stderr || result.stdout}`);
    assert.ok(result.output.includes('linear'), 'remote gemini should list linear MCP');
    assert.ok(result.output.includes('mcp-remote@0.1.38'), 'remote gemini should list pinned mcp-remote');
    report.push({ target: 'remote.gemini.runtime', status: 'pass', detail: 'gemini mcp list includes linear' });
  } else {
    report.push({ target: 'remote.gemini.runtime', status: 'skip', detail: 'gemini CLI missing on remote' });
  }

  const hasRemoteOpenCodeRunner = remoteCommands.opencode || remoteCommands.npx;
  report.push(hasRemoteOpenCodeRunner
    ? { target: 'remote.opencode.runtime', status: 'info', detail: remoteCommands.opencode ? 'OpenCode CLI installed; use harness launch smoke for full model auth' : 'OpenCode runs through remote npx opencode-ai fallback' }
    : { target: 'remote.opencode.runtime', status: 'skip', detail: 'opencode and npx missing on remote' });

  if (hasRemoteOpenCodeRunner) {
    const command = remoteCommands.opencode
      ? 'OPENCODE_CONFIG="$HOME/.config/opencode/build-mcp.json" timeout 45 opencode mcp list'
      : 'OPENCODE_CONFIG="$HOME/.config/opencode/build-mcp.json" timeout 45 npx -y opencode-ai mcp list';
    const result = remoteRun(args, `${remotePathPrefix(args)}\n${command}`, 60_000);
    assert.ok(result.ok, `remote opencode mcp list failed: ${result.stderr || result.stdout}`);
    assert.ok(result.output.includes('linear'), 'remote opencode should list linear MCP');
    assert.ok(result.output.includes('mcp-remote@0.1.38'), 'remote opencode should list pinned mcp-remote');
    report.push({
      target: 'remote.opencode.config-runtime',
      status: 'pass',
      detail: remoteCommands.opencode ? 'opencode mcp list includes linear' : 'npx opencode-ai mcp list includes linear',
    });
  } else {
    report.push({ target: 'remote.opencode.config-runtime', status: 'skip', detail: 'opencode and npx missing on remote' });
  }
}

function printReport(report) {
  for (const row of report) {
    const detail = typeof row.detail === 'string' ? row.detail : JSON.stringify(row.detail);
    console.log(`${row.status.toUpperCase().padEnd(5)} ${row.target}: ${detail}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const report = [];

  checkLocalConfigs(report);
  checkLocalRuntime(report);
  checkClaudeSdkInjection(report);

  if (!args.skipRemote) {
    checkRemoteConfigs(args, report);
    checkRemoteRuntime(args, report);
  }

  printReport(report);
  const skipped = report.filter((row) => row.status === 'skip');
  if (args.failOnSkips && skipped.length > 0) {
    throw new Error(`mcp runtime matrix has skipped harnesses: ${skipped.map((row) => row.target).join(', ')}`);
  }
  console.log(skipped.length > 0
    ? `mcp runtime matrix verifier passed with ${skipped.length} skipped unavailable harness${skipped.length === 1 ? '' : 'es'}`
    : 'mcp runtime matrix verifier passed with full harness coverage');
}

main();
