import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const inputArea = fs.readFileSync(path.join(root, 'src/renderer/components/chat/InputArea.tsx'), 'utf8');
const installedVerifier = fs.readFileSync(path.join(root, 'scripts/verify-installed-build-fixes.js'), 'utf8');

assert.match(
  inputArea,
  /const SUBMITTED_INPUT_ECHO_SUPPRESS_MS = 60_000;/,
  'input area must define a bounded submitted-input echo suppression window',
);
assert.match(
  inputArea,
  /const submittedInputRef = useRef<\{ texts: string\[\]; at: number \} \| null>\(null\);/,
  'input area must remember recently submitted input text',
);
assert.match(
  inputArea,
  /const rememberSubmittedInput = useCallback/,
  'input area must expose a submit recorder',
);
assert.match(
  inputArea,
  /const suppressSubmittedInputEcho = useCallback/,
  'input area must expose stale echo suppression',
);
assert.match(
  inputArea,
  /rememberSubmittedInput\(message\.trim\(\), fullMessage\);[\s\S]*?setMessage\(''\);[\s\S]*?await sendMessage\(sessionId, fullMessage, attachmentsToSend\);/,
  'normal submit must record the submitted text before clearing and sending',
);
assert.match(
  inputArea,
  /suppressSubmittedInputEcho\(content, 'browser-insert-chat'\)/,
  'browser insert-chat events must not restore the just-submitted input',
);
assert.match(
  inputArea,
  /suppressSubmittedInputEcho\(content, 'send-annotation'\)/,
  'send-annotation populate path must not restore the just-submitted input',
);
assert.match(
  inputArea,
  /suppressSubmittedInputEcho\(text, 'voice-interim-transcript'\)/,
  'voice interim transcript path must not restore the just-submitted input',
);
assert.match(
  inputArea,
  /suppressSubmittedInputEcho\(text, 'voice-final-transcript'\)/,
  'voice final transcript path must not restore the just-submitted input',
);
assert.match(
  installedVerifier,
  /Suppressing stale submitted input echo/,
  'installed app verifier must assert submitted-input echo guard marker',
);

console.log('input submit echo guard verifier passed');
