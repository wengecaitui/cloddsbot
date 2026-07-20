[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$TaskName = 'DSbot-Hermes-Observability',

    [string]$RepoPath = (Join-Path $PSScriptRoot '..\..'),

    [string]$HermesHome = (Join-Path $env:LOCALAPPDATA 'hermes'),

    [string]$RuntimeRoot = '',

    [string]$NodeExecutable = '',

    [ValidateRange(1, 65535)]
    [int]$DashboardPort = 8765,

    [ValidateSet('AtLogOn', 'AtStartup')]
    [string]$TriggerMode = 'AtLogOn',

    [string]$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,

    [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Hermes monitor scheduled-task installation is supported only on Windows.'
}

Import-Module ScheduledTasks -ErrorAction Stop

function Resolve-ExistingPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][ValidateSet('Container', 'Leaf')][string]$PathType
    )

    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType $PathType)) {
        throw "Expected $PathType path: $resolved"
    }
    return $resolved
}

function Quote-ProcessArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Write-OperationRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        [Parameter(Mandatory = $true)][string]$OperationsRoot,
        [Parameter(Mandatory = $true)][hashtable]$Details
    )

    $operationsDir = Join-Path $OperationsRoot 'operations'
    New-Item -ItemType Directory -Path $operationsDir -Force | Out-Null
    $record = [ordered]@{
        schemaVersion = '1.0'
        timestamp = [DateTime]::UtcNow.ToString('o')
        actor = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        action = $Action
        riskClass = 'R2_STATEFUL_OPERATION'
        evidenceLevel = 'VERIFIED_OBSERVED'
        details = $Details
    }
    $record | ConvertTo-Json -Compress -Depth 5 |
        Add-Content -LiteralPath (Join-Path $operationsDir 'task-operations.jsonl') -Encoding UTF8
}

$repo = Resolve-ExistingPath -Path $RepoPath -PathType Container
$hermes = Resolve-ExistingPath -Path $HermesHome -PathType Container
$entry = Resolve-ExistingPath -Path (Join-Path $repo 'dist\bin\hermes-monitor.js') -PathType Leaf

if ([string]::IsNullOrWhiteSpace($NodeExecutable)) {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $NodeExecutable = $nodeCommand.Source
}
$node = Resolve-ExistingPath -Path $NodeExecutable -PathType Leaf

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = Join-Path $repo '.runtime-observability'
}
$runtime = [System.IO.Path]::GetFullPath($RuntimeRoot)

$monitorArguments = @(
    $entry,
    '--realtime',
    '--dashboard',
    '--quiet',
    '--write',
    '--root', $runtime,
    '--repo', $repo,
    '--hermes-home', $hermes,
    '--dashboard-port', $DashboardPort.ToString()
)
$argumentString = ($monitorArguments | ForEach-Object { Quote-ProcessArgument -Value ([string]$_) }) -join ' '

$action = New-ScheduledTaskAction `
    -Execute $node `
    -Argument $argumentString `
    -WorkingDirectory $repo

if ($TriggerMode -eq 'AtStartup') {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType S4U -RunLevel Limited
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
    $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$description = 'Read-only DSbot sidecar for Hermes logs, runtime health, audit events, alerts, and loopback dashboard.'

if ($PSCmdlet.ShouldProcess($TaskName, "Register $TriggerMode scheduled task for $UserId")) {
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description $description `
        -Force | Out-Null

    Write-OperationRecord -Action 'scheduled_task.registered' -OperationsRoot $runtime -Details @{
        taskName = $TaskName
        triggerMode = $TriggerMode
        userId = $UserId
        repoPath = $repo
        hermesHome = $hermes
        runtimeRoot = $runtime
        nodeExecutable = $node
        dashboardPort = $DashboardPort
    }

    if ($StartNow) {
        Start-ScheduledTask -TaskName $TaskName
        Write-OperationRecord -Action 'scheduled_task.started' -OperationsRoot $runtime -Details @{
            taskName = $TaskName
        }
    }

    Get-ScheduledTask -TaskName $TaskName |
        Select-Object TaskName, State, Author, Description
}
