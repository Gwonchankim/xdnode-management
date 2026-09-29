// R4(r4-autostart·r4-deploy, Design §11.5.8, Plan R4·D18·D19): 운영 스크립트는 개발 폴더의 state 를 대상으로 삼지 않고,
// Deploy 는 개발 폴더와 운영 폴더가 아닌 경로를 아무것도 하기 전에 거부한다. 기동 경로는 Start-ScheduledTask 하나다.
// 소스 가드 + (Windows 에서) 실제 PowerShell 로 거부 경로만 실행한다. 거부 경로가 뚫려도 운영에 닿지 않게
// 포트(1)·작업 이름·pid/로그 폴더를 모두 가짜로 넘긴다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const codeOf = (source) => source.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
const OPS = ['Stop-XDNodeManagement', 'Backup-XDNodeManagement', 'Deploy-XDNodeManagement', 'Register-XDNodeManagementTasks'];
const TARGETING = ['Backup-XDNodeManagement', 'Deploy-XDNodeManagement', 'Register-XDNodeManagementTasks'];

test('R4: every operations script exists, is UTF-8 with BOM (PowerShell 5.1 reads Korean correctly)', () => {
  for (const name of ['Start-XDNodeManagement', ...OPS]) {
    const bytes = readFileSync(path.join(root, 'scripts', `${name}.ps1`));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name}.ps1 needs a UTF-8 BOM`);
  }
});

test('R4: no script names the development folder or reaches its .wrangler state', () => {
  for (const file of readdirSync(path.join(root, 'scripts'), { recursive: true }).map(String).filter((name) => /\.(ps1|mjs)$/.test(name))) {
    const source = read(path.join('scripts', file));
    assert.doesNotMatch(source, /Documents[\\/]+ChatGPT|ChatGPT[\\/]+XDNODE/i, `${file} names the development folder`);
  }
  for (const name of TARGETING) {
    const code = codeOf(read(`scripts/${name}.ps1`));
    // 대상 state 는 -ProdRoot(기본 C:\xdm\prod) 아래에서만 만든다. 스크립트 자기 위치($PSScriptRoot) 기준 .wrangler 는 쓰지 않는다.
    assert.ok(code.includes('[string]$ProdRoot = "C:\\xdm\\prod"'), `${name}: default ProdRoot`);
    for (const match of code.matchAll(/^.*\.wrangler.*$/gm)) assert.match(match[0], /Join-Path \$ProdRoot "\.wrangler\\state\\v3"/, `${name}: ${match[0].trim()}`);
    assert.doesNotMatch(code, /\$PSScriptRoot[^\n]*\.wrangler/);
    // 개발 폴더 거부: 이 저장소의 작업 사본(C:\xdm 밖)과 문서 폴더 아래는 거부한다. 경로 확인이 첫 동작이다.
    assert.ok(code.includes('$devCopy = ($full -ieq $repo) -and -not ($repo -like "C:\\xdm\\*")'), `${name}: dev copy check`);
    assert.ok(code.includes('[Environment]::GetFolderPath("MyDocuments")'), `${name}: Documents check`);
    const guard = code.indexOf('Assert-NotDevFolder $ProdRoot');
    assert.ok(guard > 0, `${name}: Assert-NotDevFolder $ProdRoot is not called`);
    for (const effect of ['$StopScript -Port', 'Invoke-Robocopy $', 'Invoke-Git @(', 'Register-ScheduledTask @', 'Start-ScheduledTask']) {
      const at = code.indexOf(effect, code.indexOf('\n$ProdRoot = Resolve-FullPath'));
      if (at >= 0) assert.ok(guard < at, `${name}: ${effect} runs before the dev-folder guard`);
    }
  }
});

test('R4: all restarts go through the autostart task; only the launcher starts preview or the bridges', () => {
  for (const name of ['Backup-XDNodeManagement', 'Deploy-XDNodeManagement']) {
    const code = codeOf(read(`scripts/${name}.ps1`));
    assert.ok(code.includes('Start-ScheduledTask -TaskName $TaskName'), `${name}: restart via the task`);
    assert.ok(code.includes('[string]$TaskName = "XDnodeManagement-Autostart"'), name);
    assert.doesNotMatch(code, /Start-XDNodeManagement\.ps1|serve:lan|vite\.js preview|resume:bridge|assistant:claude/, `${name} starts the server directly`);
  }
  const deploy = codeOf(read('scripts/Deploy-XDNodeManagement.ps1'));
  // Deploy 순서(Design §11.5.8): 태그 확인 → Stop → 스냅샷·검증 → checkout → npm ci → build → write-dev-vars·build-rev → Start-ScheduledTask → 헬스체크.
  const order = ['"refs/tags/$Tag^{commit}"', '-File $StopScript -Port $Port', '"--out", (Join-Path $snapshot "snapshot-report.json")',
    'Build-Revision $target $lockChanged', 'if (-not (Start-AndWait)) { throw "the new version did not become healthy" }', 'downtime ${seconds}s'];
  let last = -1;
  for (const marker of order) {
    const at = deploy.indexOf(marker);
    assert.ok(at > last, `deploy order: ${marker}`);
    last = at;
  }
  const build = deploy.slice(deploy.indexOf('function Build-Revision'), deploy.indexOf('function Start-AndWait'));
  const steps = ['"checkout", "--detach", $Revision', 'Invoke-Npm "ci" "npm-ci"', 'Invoke-Npm "run build" "build"', 'scripts\\write-dev-vars.mjs', 'dist\\.build-rev'];
  last = -1;
  for (const marker of steps) {
    const at = build.indexOf(marker);
    assert.ok(at > last, `build order: ${marker}`);
    last = at;
  }
  assert.doesNotMatch(deploy, /npm(?:\.cmd)? (?:run )?test\b|Invoke-Npm "test"/, 'npm test never runs in the operations folder');
  assert.ok(deploy.includes('$AllowedRoots = @("C:\\xdm\\prod", "C:\\xdm\\staging")'));
  assert.ok(deploy.includes('if (-not ($AllowedRoots -contains $ProdRoot)) {'));
  assert.ok(deploy.indexOf('if (-not ($AllowedRoots -contains $ProdRoot)) {') < deploy.indexOf('"fetch", "--tags"'), 'path check before any git call');
});

test('R4: the register script creates the D19 startup task with a stored password, 3 retries 5 minutes apart, and a logon fallback', () => {
  const code = codeOf(read('scripts/Register-XDNodeManagementTasks.ps1'));
  assert.ok(code.includes('$AutostartTask = "XDnodeManagement-Autostart"'));
  assert.ok(code.includes('$BackupTask = "XDnodeManagement-Backup"'));
  assert.ok(code.includes('[string]$BackupTime = "03:00"'));
  assert.ok(code.includes('[ValidateSet("Startup", "Logon")][string]$Mode = "Startup"'));
  assert.ok(code.includes('$autostartTrigger = New-ScheduledTaskTrigger -AtStartup'));
  assert.ok(code.includes('$logonType = "Password"'));
  assert.ok(code.includes('$autostartTrigger = New-ScheduledTaskTrigger -AtLogOn -User $User'));
  assert.ok(code.includes('$logonType = "Interactive"'));
  assert.ok(code.includes('New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)'));
  assert.ok(code.includes('`"$startScript`" -Headless'));
  // 놓친 백업을 업무 시간에 몰아서 돌리지 않는다.
  const backupSettings = code.slice(code.indexOf('$backupSettings ='), code.indexOf('$definitions ='));
  assert.doesNotMatch(backupSettings, /StartWhenAvailable/);
  // 견적 툴 작업은 건드리지 않는다. 암호는 출력하지 않는다.
  assert.ok(code.includes('$ProtectedTasks = @("XDNODE 견적서 서버")'));
  assert.doesNotMatch(code, /Write-Host[^\n]*\$password|Out-File|Set-Content/);
  assert.doesNotMatch(code, /Unregister-ScheduledTask|powercfg|netsh|New-NetFirewallRule/);
});

test('R4.2: task-started servers are stopped by their own supervisor, because other logon sessions get access denied', () => {
  const start = codeOf(read('scripts/Start-XDNodeManagement.ps1'));
  const stop = codeOf(read('scripts/Stop-XDNodeManagement.ps1'));
  // Start -Headless 는 띄운 프로세스가 있으면 감독자로 남고, 요청 파일을 보면 자기 프로세스를 끈 뒤 pid·요청 파일을 지운다.
  assert.ok(start.includes('$StopRequest = Join-Path $RunDir "stop-$Port.request"'));
  assert.ok(start.includes('$SupervisorPidFile = Join-Path $RunDir "xdm-supervisor-$Port.pid"'));
  assert.ok(start.includes('if ($serverProcess -or $script:OwnedBridges.Count -gt 0) { Invoke-Supervisor $serverProcess }'));
  const clearStale = start.indexOf('Remove-Item -LiteralPath $StopRequest', start.indexOf('Write-Log "INFO" ("begin port='));
  assert.ok(clearStale > 0 && clearStale < start.indexOf('$portProxy = @('), 'a stale stop request is cleared before starting');
  const supervisor = start.slice(start.indexOf('function Invoke-Supervisor'), start.indexOf('# 로그 회전'));
  assert.match(supervisor, /Stop-OwnedTree \$ServerProcess\.Id/);
  assert.match(supervisor, /finally \{[\s\S]*Remove-Item -LiteralPath \$SupervisorPidFile[\s\S]*Remove-Item -LiteralPath \$StopRequest/);
  // Stop 은 감독자에게 먼저 요청하고(끝날 때까지 기다림), 그다음 pid 파일·포트 대체 경로로 간다.
  assert.ok(stop.indexOf('Set-Content -LiteralPath $stopRequest') < stop.indexOf('foreach ($target in $targets) { Stop-FromPidFile'));
  assert.ok(stop.includes('$supervisor.ProcessName -ieq "powershell"'), 'only a PowerShell supervisor is waited for');
  // 다른 세션 프로세스는 StartTime 을 읽을 수 없다. 읽지 못한 것을 pid 재사용으로 보면 pid 파일만 지우고 서버는 남는다.
  assert.ok(stop.includes('if ($startedAt -and $startedAt -gt $NotStartedAfter) {'));
});

// ── 실제 실행(거부 경로만) ───────────────────────────────────────────────────────
function runPowerShell(script, args) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', script), ...args],
      { windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: `${stdout}\n${stderr}` }));
  });
}

test('R4: Deploy and Backup refuse the development folder (and Deploy any non-operations path) before doing anything', { skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'xdm-ops-refusal-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const safe = ['-Port', '1', '-RunDir', path.join(work, 'run'), '-LogRoot', path.join(work, 'logs'), '-TaskName', 'XDnodeManagement-NoSuchTask-Test'];

  const deployDev = await runPowerShell('Deploy-XDNodeManagement.ps1', ['-Tag', 'no-such-tag-for-test', '-ProdRoot', root, ...safe]);
  assert.equal(deployDev.code, 3, deployDev.output);
  assert.match(deployDev.output, /refused: .* is the development folder/);
  const deployElsewhere = await runPowerShell('Deploy-XDNodeManagement.ps1', ['-Tag', 'no-such-tag-for-test', '-ProdRoot', path.join(work, 'prod'), ...safe]);
  assert.equal(deployElsewhere.code, 3, deployElsewhere.output);
  assert.match(deployElsewhere.output, /is not an operations folder/);

  const backupDev = await runPowerShell('Backup-XDNodeManagement.ps1', ['-ProdRoot', root, '-BackupRoot', path.join(work, 'backup'), '-Restart', 'None', ...safe]);
  assert.equal(backupDev.code, 3, backupDev.output);
  assert.match(backupDev.output, /refused: .* is the development folder/);
  // 백업 폴더를 운영 폴더 안에 두는 것도 거부한다.
  const backupInside = await runPowerShell('Backup-XDNodeManagement.ps1', ['-ProdRoot', path.join(work, 'prod'), '-BackupRoot', path.join(work, 'prod', 'backup'), '-Restart', 'None', ...safe]);
  assert.equal(backupInside.code, 3, backupInside.output);
  assert.match(backupInside.output, /must be outside the operations folder/);

  // 거부는 아무것도 바꾸지 않는다: 저장소 HEAD 그대로, 백업 폴더 없음.
  assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
  assert.deepEqual(readdirSync(work).filter((name) => name === 'backup'), []);
});
