import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { REMOTE_BUILD_CLI_SOURCE } from '../src/main/services/remote-build-cli-source';

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const service = read('src/main/services/remote-voice.service.ts');
const composer = read('src/renderer/components/chat/VoiceComposerControl.tsx');
const preload = read('src/main/preload.ts');
const voiceIpc = read('src/main/ipc/voice.ipc.ts');
const channels = read('src/shared/constants/channels.ts');

let runtimeParses = true;
try {
  new vm.Script(REMOTE_BUILD_CLI_SOURCE, { filename: 'remote-build-cli.js' });
} catch (error) {
  runtimeParses = false;
  console.error(error);
}

const checks: Array<[string, boolean]> = [
  ['SSH-only deployment guard', service.includes('Remote Voice currently supports SSH sessions')],
  ['tailnet-only Tailscale Serve (not Funnel)', service.includes('tailscale serve --bg --yes') && !service.includes('tailscale funnel')],
  ['Remote Voice never publishes or repairs the host HTTPS port', service.includes('const REMOTE_VOICE_SERVE_PORT = 8_443') && service.includes('persisted.servePort !== REMOTE_VOICE_SERVE_PORT') && service.includes('servePort !== REMOTE_VOICE_SERVE_PORT') && !service.includes('hasServeRoute(existingServe, dnsName, 443)') && !service.includes('servePort = 443')],
  ['Tailscale Serve handles operator-restricted SSH hosts', service.includes('sudo -n tailscale serve --bg --yes')],
  ['deployment verifies the exact published Tailscale route before advertising it', service.includes('configureServeRoute(client, dnsName, servePort)') && service.includes('did not publish the expected Remote Agent URL')],
  ['status reads validate and retire stale Remote Agent URLs', service.includes('await this.ensureActiveRoute(deployment)') && service.includes('The Remote Agent URL was lost and could not be restored')],
  ['desktop can reattach to an app-close-surviving deployment', service.includes('restorePersistedDeployment') && service.includes('remoteVoice.activeDeployment')],
  ['status rejects a runtime owned by a different Build session', service.includes('runtimeStatus.sessionId !== deployment.session.id') && service.includes('This SSH host is serving a different Build session')],
  ['same-session deployment replaces an outdated remote runtime', service.includes('const REMOTE_RUNTIME_VERSION = 4') && service.includes('runtimeStatus.runtimeVersion !== REMOTE_RUNTIME_VERSION') && REMOTE_BUILD_CLI_SOURCE.includes('runtimeVersion: RUNTIME_VERSION')],
  ['remote runtime self-restores disappeared Serve routes', REMOTE_BUILD_CLI_SOURCE.includes('ensureServeRoute') && REMOTE_BUILD_CLI_SOURCE.includes('30000')],
  ['remote HTTP server binds only to loopback', REMOTE_BUILD_CLI_SOURCE.includes("server.listen(config.serverPort, '127.0.0.1'")],
  ['remote runtime source is syntactically valid JavaScript', runtimeParses],
  ['remote runtime creates Realtime sessions directly', REMOTE_BUILD_CLI_SOURCE.includes("fetch('https://api.openai.com/v1/realtime/client_secrets'")],
  ['OpenAI credential is protected in a mode-0600 server config', service.includes('openAiApiKey') && service.includes('chmod 600 config.json') && REMOTE_BUILD_CLI_SOURCE.includes('config.openAiApiKey')],
  ['standalone runtime reports no desktop bridge', REMOTE_BUILD_CLI_SOURCE.includes('serverIndependent: true') && REMOTE_BUILD_CLI_SOURCE.includes('desktopBridge: false')],
  ['desktop reverse tunnel and renderer RPC were removed', !service.includes('setupReverseTunnel') && !service.includes('createBridgeServer') && !service.includes('requestRenderer') && !voiceIpc.includes('VOICE_REMOTE_RENDERER_RESPONSE') && !channels.includes('VOICE_REMOTE_RENDERER_REQUEST')],
  ['partial deployments clean up only the remote process and route', service.includes('Partial remote deployment cleanup failed') && !service.includes('teardownReverseTunnel')],
  ['deployment replaces every managed daemon before binding the shared host port', service.includes('for managed_pid_file in') && service.includes('/*/server.pid')],
  ['deployment health requires the requested session ID and the new daemon PID', service.includes('expectedHealthSession') && service.includes('kill -0 "$(cat server.pid)"') && service.includes('grep -Fq')],
  ['a stale app cannot stop a different session runtime', service.includes('Stop skipped remote cleanup because another Build session owns the SSH runtime')],
  ['an already-open mobile client reloads when the served session changes', service.includes('boundSessionId!==runtimeStatus.sessionId') && service.includes('window.location.reload()') && service.includes('setInterval(pollRuntimeIdentity,3000)')],
  ['remote client uses an ephemeral secret for WebRTC', service.includes("Authorization:'Bearer '+boot.clientSecret")],
  ['preload exposes deploy, status, and stop without a renderer bridge', ['deployRemoteAgent', 'getRemoteAgentStatus', 'stopRemoteAgent'].every((name) => preload.includes(name)) && !preload.includes('onRemoteAgentRequest') && !preload.includes('respondToRemoteAgent')],
  ['deployment installs a first-class Build CLI wrapper', service.includes('/build-cli') && service.includes('chmod 700 build-cli') && service.includes('./build-cli serve')],
  ['Build CLI supports status, send, and wait', ["command === 'status'", "command === 'send'", "command === 'wait'"].every((value) => REMOTE_BUILD_CLI_SOURCE.includes(value))],
  ['server resumes native Claude or Codex harness state', REMOTE_BUILD_CLI_SOURCE.includes("args.push('--resume', state.resumeId)") && REMOTE_BUILD_CLI_SOURCE.includes("args.push('resume', state.resumeId)")],
  ['server queues behind both its own run and the desktop detached runner', REMOTE_BUILD_CLI_SOURCE.includes('latestDesktopJob') && REMOTE_BUILD_CLI_SOURCE.includes("source: 'desktop-detached-runner'") && REMOTE_BUILD_CLI_SOURCE.includes('state.queue.push')],
  ['server adopts a late native resume ID before draining desktop-queued turns', REMOTE_BUILD_CLI_SOURCE.includes('function syncResumeFromDesktopJob') && REMOTE_BUILD_CLI_SOURCE.includes('syncResumeFromDesktopJob(desktopJob)')],
  ['server never adopts a resume ID from another desktop harness', REMOTE_BUILD_CLI_SOURCE.includes('commandName !== config.harness') && REMOTE_BUILD_CLI_SOURCE.includes("path.basename(metadata.command)")],
  ['server parses native Codex app-server thread identities', REMOTE_BUILD_CLI_SOURCE.includes('event.result.thread.id') && REMOTE_BUILD_CLI_SOURCE.includes('event.params.thread.id') && REMOTE_BUILD_CLI_SOURCE.includes('event.params.threadId')],
  ['server persists resume, queue, outcome, and errors atomically', REMOTE_BUILD_CLI_SOURCE.includes('writeJsonAtomic') && ['resumeId:', 'queue:', 'lastOutcome:', 'lastError:'].every((value) => REMOTE_BUILD_CLI_SOURCE.includes(value))],
  ['server resets incompatible state when a session changes harnesses', REMOTE_BUILD_CLI_SOURCE.includes('storedState.version === 2') && REMOTE_BUILD_CLI_SOURCE.includes('storedState.harness === config.harness')],
  ['harness completion waits for log quiescence before publishing an outcome', REMOTE_BUILD_CLI_SOURCE.includes('observedLogSize') && REMOTE_BUILD_CLI_SOURCE.includes('settleUntil') && REMOTE_BUILD_CLI_SOURCE.includes('timestamp + 2000')],
  ['server reads the live git branch instead of trusting stale desktop metadata', REMOTE_BUILD_CLI_SOURCE.includes("execFileSync('git', ['-C', config.workingDirectory, 'branch', '--show-current']") && REMOTE_BUILD_CLI_SOURCE.includes('BRANCH: \' + (currentBranch()')],
  ['remote voice speaks as the active Build agent', REMOTE_BUILD_CLI_SOURCE.includes('You are Build, the same coding agent') && REMOTE_BUILD_CLI_SOURCE.includes('Speak in the first person')],
  ['desktop voice memory is seeded into each remote deployment', service.includes('voiceMemory: getVoiceMemoryService().snapshot()') && service.includes('existingRemoteMemory')],
  ['desktop and remote voice memory synchronize bidirectionally', service.includes('syncDeploymentVoiceMemory') && service.includes('/api/memory') && service.includes('getVoiceMemoryService().merge(payload.entries)')],
  ['standalone runtime persists bounded voice memory on the SSH host', REMOTE_BUILD_CLI_SOURCE.includes("voice-memory.json") && REMOTE_BUILD_CLI_SOURCE.includes('MAX_VOICE_MEMORY_ENTRIES = 160') && REMOTE_BUILD_CLI_SOURCE.includes('voiceMemoryPrompt()')],
  ['remote voice and chat store finalized dialogue for later connections', service.includes("remember('user',text)") && service.includes("remember('user',userText)") && service.includes("remember('assistant',agentText)")],
  ['active desktop harness overrides a stale same-session remote harness', service.includes('const harness = desktopHarness || existingHarness') && service.includes('desktopResumeId || existingResumeId')],
  ['cross-profile redeploy preserves a same-session remote harness and resume ID', service.includes('existingIdentityScript') && service.includes('desktopHarness || existingHarness') && service.includes('const existingResumeId = existingHarness === harness')],
  ['remote voice loads native Claude and Codex conversation context', REMOTE_BUILD_CLI_SOURCE.includes('recentClaudeConversation') && REMOTE_BUILD_CLI_SOURCE.includes('recentCodexConversation') && REMOTE_BUILD_CLI_SOURCE.includes("entry.payload.type === 'agent_message'")],
  ['remote voice bootstrap includes the substantive live Build outcome', REMOTE_BUILD_CLI_SOURCE.includes('CURRENT BUILD CLI STATUS:') && REMOTE_BUILD_CLI_SOURCE.includes('Latest completed Build response:') && REMOTE_BUILD_CLI_SOURCE.includes('generic acknowledgement such as "OK"')],
  ['composer includes a first-class Remote Agent button and URL UI', composer.includes('data-testid="remote-voice-control"') && composer.includes('build-remote-voice-url')],
  ['deployment popover renders a scannable QR code for the exact Tailnet URL', composer.includes("import { QRCodeSVG } from 'qrcode.react'") && composer.includes('value={remoteVoice.url}') && composer.includes('Scan for voice + chat')],
  ['deployment UI says it survives desktop app closure', composer.includes('Runs on the SSH host even after Build closes')],
  ['remote page offers text chat in the same Realtime conversation', service.includes('id="chat-form"') && service.includes("type:'input_text'") && service.includes('void submitChat(text)')],
  ['text chat connects without requesting microphone access', service.includes('await connect(false)') && service.includes("addTransceiver('audio',{direction:'sendrecv'})")],
  ['voice can join an existing chat connection without reconnecting', service.includes('await audioTransceiver.sender.replaceTrack(track)') && service.includes('void connect(true)')],
  ['failed chat connection restores the unsent message', service.includes("if(!connected){chatInput.value=text;resizeInput();chatInput.focus();return;}")],
  ['remote chat uses a mobile safe-area and keyboard-aware app shell', service.includes('viewport-fit=cover') && service.includes('env(safe-area-inset-bottom)') && service.includes('window.visualViewport.addEventListener')],
  ['remote chat has a multiline composer with enter-to-send and stop behavior', service.includes('id="chat-input"') && service.includes('chatForm.requestSubmit()') && service.includes('function cancelResponse()')],
  ['remote chat renders rich streamed responses and copy controls', service.includes('function renderRichText') && service.includes("copy.className='copy-message'") && service.includes('response.output_audio_transcript.delta')],
  ['remote chat exposes Build-like tool activity cards', service.includes('function toolActivity') && service.includes('response.output_item.added') && service.includes('data-state="running"')],
];

const failures = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (failures.length > 0) process.exit(1);
