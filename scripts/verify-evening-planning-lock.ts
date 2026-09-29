import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const settings = read('src/main/services/settings.service.ts');
const app = read('src/renderer/App.tsx');
const service = read('src/main/services/planning-lock.service.ts');
const dialog = read('src/renderer/components/settings/SettingsDialog.tsx');
const preload = read('src/main/preload.ts');

assert.match(settings, /eveningPlanningLockEnabled:\s*true/);
assert.match(settings, /eveningPlanningLockTime:\s*'22:30'/);
assert.match(app, /EVENING_PLANNING_DONE_KEY/);
assert.match(app, /setPlanningLock\(\s*true/);
assert.match(app, /lockMode/);
assert.match(app, /sessionDurationMinutes=\{15\}/);
assert.match(app, /<PlanningLockErrorBoundary>/);
assert.doesNotMatch(service, /shell\.openExternal/, 'Planning must not force the system browser open.');
assert.match(service, /if \(this\.active\)/, 'Repeated checks must not reopen the calendar.');
assert.doesNotMatch(service, /app\.focus/, 'The lock must not steal focus from the calendar browser.');
assert.doesNotMatch(service, /window\.hide\(\)/, 'Planning must not hide other Build windows.');
assert.doesNotMatch(service, /System Events|osascript|application processes/, 'Planning must not hide other apps.');
assert.match(dialog, /Next-Day Planning Lock/);
assert.match(dialog, /Calendar Address/);
assert.match(preload, /setPlanningLock/);
const review = read('src/renderer/components/tasks/DailyReviewModal.tsx');
assert.match(review, /Start Planning/);
assert.doesNotMatch(review, /minimumTimeComplete/, 'The timer must never gate planner completion.');
assert.match(review, /Finish when your plan is ready\. The timer is only a planning guide\./);
assert.match(review, /disabled=\{!canContinue\}/, 'Finish Planning must depend only on a valid plan.');
assert.match(review, /planning-session-start-/);
assert.match(review, /data-planning-calendar-drop-zone/);
assert.match(review, /data-planning-calendar-timeline/);
assert.match(review, /data-planning-calendar-hour/);
assert.match(review, /closest<HTMLElement>\('\[data-planning-calendar-hour\]'\)/);
assert.match(review, /calendarTaskToPlaceId/);
assert.match(review, /Choose an hour below\./);
assert.match(review, /Drag a task to an hour, or press Schedule and choose a time\./);
assert.match(review, /onOpenCalendarEvents/);
assert.match(app, /createPlanningCalendarUrl/);
assert.match(app, /forceInApp:\s*true/);
assert.match(app, /newTab:\s*true/);
assert.match(app, /if \(due && !completed\)[\s\S]*else \{[\s\S]*setShowEveningPlanningLock\(false\)/, 'A stale planning lock must close after midnight.');
assert.ok(
  review.indexOf('const renderEditableOpenTaskList = useCallback') < review.indexOf('if (lockMode && !sessionStartedAt)'),
  'The planning start screen must render only after every hook has been called.',
);
assert.match(app, /planning-lock-active/, 'The app must suspend native webview input while the planning lock is visible.');
const globalStyles = read('src/renderer/styles/globals.css');
assert.match(globalStyles, /\.planning-lock-active webview[\s\S]*visibility:\s*hidden\s*!important/);
assert.match(globalStyles, /\.planning-lock-active webview[\s\S]*pointer-events:\s*none\s*!important/);
assert.match(globalStyles, /\.planning-lock-interactive,[\s\S]*-webkit-app-region:\s*no-drag/);
assert.match(review, /event\.metaKey \|\| event\.ctrlKey/, 'The lock needs a keyboard recovery path.');
const boundary = read('src/renderer/components/tasks/PlanningLockErrorBoundary.tsx');
assert.match(boundary, /componentDidCatch/);
assert.match(boundary, /Reload Planner/);

console.log('Evening planning lock verification passed.');
