[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$TaskName = 'DSbot-Hermes-Observability',

    [string]$RepoPath = (Join-Path $PSScriptRoot '..\..'),

    [string]$RuntimeRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw 'Hermes monitor scheduled-task removal is supported only on Windows.'
}

Import-Module ScheduledTasks -ErrorAction Stop

$repo = (Resolve-Path -LiteralPath $RepoPath -ErrorAction Stop).Path
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = Join-Path $repo '.runtime-observability'
}
$runtime = [System.IO.Path]::GetFullPath($RuntimeRoot)
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($null -eq $task) {
    [pscustomobject]@{
        TaskName = $TaskName
        Removed = $false
        Reason = 'not_found'
        RuntimeDataPreserved = $true
    }
    return
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister scheduled task')) {
    if ($task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TaskName
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

    $operationsDir = Join-Path $runtime 'operations'
    New-Item -ItemType Directory -Path $operationsDir -Force | Out-Null
    [ordered]@{
        schemaVersion = '1.0'
        timestamp = [DateTime]::UtcNow.ToString('o')
        actor = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        action = 'scheduled_task.unregistered'
        riskClass = 'R2_STATEFUL_OPERATION'
        evidenceLevel = 'VERIFIED_OBSERVED'
        details = @{
            taskName = $TaskName
            runtimeDataPreserved = $true
            runtimeRoot = $runtime
        }
    } | ConvertTo-Json -Compress -Depth 5 |
        Add-Content -LiteralPath (Join-Path $operationsDir 'task-operations.jsonl') -Encoding UTF8

    [pscustomobject]@{
        TaskName = $TaskName
        Removed = $true
        RuntimeDataPreserved = $true
        RuntimeRoot = $runtime
    }
}
