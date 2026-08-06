import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { DEFAULT_POMODORO_MINUTES, formatPomodoroTime } from '../src/shared/utils/pomodoro';

assert.equal(DEFAULT_POMODORO_MINUTES, 25);
assert.equal(formatPomodoroTime(1500), '25:00');
assert.equal(formatPomodoroTime(65), '01:05');
assert.equal(formatPomodoroTime(-1), '00:00');

const root = path.resolve(__dirname, '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const service = read('src/main/services/pomodoro.service.ts');
const main = read('src/main/index.ts');
const preload = read('src/main/preload.ts');
const store = read('src/renderer/stores/task.store.ts');
const taskList = read('src/renderer/components/tasks/TaskList.tsx');
const setup = read('src/renderer/components/tasks/PomodoroSetupDialog.tsx');
const picker = read('src/renderer/components/tasks/TaskSessionPicker.tsx');

assert.match(service, /new Tray\(icon\)/, 'the main process should own a system tray timer');
assert.match(service, /import buildIconPath from '\.\.\/\.\.\/\.\.\/assets\/build-icon\.png'/, 'the tray icon should be emitted into the packaged webpack bundle');
assert.match(service, /endsAt: now \+ durationSeconds \* 1000/, 'timer state should survive renderer/window closure');
assert.match(service, /this\.tray\.setTitle\(active \? ` \$\{time\}` : ''\)/);
assert.match(service, /new ElectronNotification/);
assert.match(service, /show\(\): void {[\s\S]*action: this\.state\.status === 'idle' \? 'start-first' : 'open-active'/);
assert.match(main, /!pomodoroService\.isActive\(\)/, 'an active timer should keep the app alive without a Build window');
assert.match(main, /accelerator: 'CommandOrControl\+P'/, 'Cmd+P should open the Pomodoro workflow');
assert.match(preload, /onUIRequested/);

assert.match(store, /if \(!plan\.external && !plan\.sessionId\)/, 'a focus location must be chosen');
assert.match(store, /if \(!subtaskTitle\)/, 'one slot outcome must be provided');
assert.match(store, /setActiveSession\(plan\.sessionId\)/, 'a linked session should be focused');
assert.match(taskList, /find\(\(task\) => task\.status !== 'done'\)/, 'global start should choose the first open task');
assert.match(taskList, /formatPomodoroTime\(pomodoroState\.remainingSeconds\)/);
assert.match(setup, /What single outcome will you finish in this slot/);
assert.match(setup, /Outside Build keeps the timer available in the system menu bar/);

assert.match(picker, /Search sessions, branches, or paths/);
assert.match(picker, /Outside Build/);
assert.match(picker, /session\.parentSessionId && <GitFork/, 'fork sessions should remain visible');
assert.doesNotMatch(picker, /filter\([^\n]*!.*parentSessionId/, 'fork sessions must not be filtered out');

console.log('Pomodoro verification passed');
