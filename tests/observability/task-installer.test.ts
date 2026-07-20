import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const installerPath = join(
  process.cwd(),
  'scripts',
  'observability',
  'install-hermes-monitor-task.ps1',
);
const installer = readFileSync(installerPath, 'utf8');

test('scheduled-task installer fails closed before recording success', () => {
  const registerCall = installer.indexOf('Register-ScheduledTask `');
  const registeredRecord = installer.indexOf(
    "Write-OperationRecord -Action 'scheduled_task.registered'",
  );
  const startCall = installer.indexOf('Start-ScheduledTask -TaskName');
  const startedRecord = installer.indexOf(
    "Write-OperationRecord -Action 'scheduled_task.started'",
  );

  assert.ok(registerCall >= 0);
  assert.ok(registeredRecord > registerCall);
  assert.match(
    installer.slice(registerCall, registeredRecord),
    /Register-ScheduledTask[\s\S]*?-ErrorAction Stop/,
  );

  assert.ok(startCall > registeredRecord);
  assert.ok(startedRecord > startCall);
  assert.match(
    installer.slice(startCall, startedRecord),
    /Start-ScheduledTask[^\r\n]*-ErrorAction Stop/,
  );

  assert.match(
    installer,
    /Get-ScheduledTask -TaskName \$TaskName -ErrorAction Stop/,
  );
});
