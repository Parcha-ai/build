import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const sshService = fs.readFileSync(path.join(root, 'src/main/services/ssh.service.ts'), 'utf8');
const codexService = fs.readFileSync(path.join(root, 'src/main/services/codex.service.ts'), 'utf8');
const bridgeScript = fs.readFileSync(path.join(root, 'src/main/services/remote-bridge-script.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(root, 'src/renderer/stores/session.store.ts'), 'utf8');

assert.match(sshService, /requireDetached\?: boolean/);
assert.match(sshService, /Refusing direct SSH fallback for persistent harness turn/);
assert.match(sshService, /\.build\/bridge/);
assert.doesNotMatch(sshService, /claudette-remote-bridge-\$\{safeUsername\}\.js/);
assert.match(sshService, /test -s \$\{this\.quoteForShell\(install\.bridgePath\)\} && echo ready \|\| echo missing/);
assert.match(sshService, /Cached detached bridge install is missing; reinstalling/);
assert.match(sshService, /Detached bridge did not become ready; reinstalling once/);
assert.match(sshService, /launcher\.log/);
assert.match(sshService, /chmod 600/);
assert.match(sshService, /RECOVERABLE_BRIDGE_COMMANDS\.has\(job\.command\)/);
const activeProbe = sshService.match(/async hasActiveRemoteProcess\([\s\S]*?\n {2}\}/)?.[0] || '';
assert.match(activeProbe, /test -f "\$jobdir\/recovered\.json" && continue/);
assert.match(activeProbe, /kill -0 "\$pid"/);
assert.doesNotMatch(activeProbe, /buildSessionEnvProcessLoop/, 'normal admission must rely on detached bridge ownership, not a full process scan');
assert.match(sshService, /metadata\.json/);
assert.match(codexService, /command: 'codex',[\s\S]{0,260}requireDetached: true/);
assert.match(sshService, /command: 'claude',[\s\S]{0,300}requireDetached: true/);
assert.match(bridgeScript, /config = parseConfig\(configPath\);[\s\S]{0,300}finally[\s\S]{0,300}safeUnlink\(configPath\);/);

const startupRecovery = sessionStore.match(/function startRunningSshProcessMonitors\([\s\S]*?\n\}/)?.[0] || '';
assert.match(startupRecovery, /waitForNoActiveStream\(getState\)/);
assert.match(startupRecovery, /attachStream: true/);
assert.doesNotMatch(startupRecovery, /attachStream: session\.id ===/);

console.log('SSH detached persistence verifier passed');
