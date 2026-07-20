[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$TaskName = 'DSbot-Hermes-Observability',

    [uri]$GatewayHealthUrl = 'http://127.0.0.1:8642/health',

    [uri]$DashboardHealthUrl = 'http://127.0.0.1:8765/api/health',

    [switch]$AllowMissingTask,

    [switch]$AllowStoppedDashboard
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LoopbackUri {
    param([Parameter(Mandatory = $true)][uri]$Uri)
    if ($Uri.Scheme -ne 'http' -or $Uri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        throw "Only loopback HTTP health URLs are allowed: $Uri"
    }
}

function Invoke-HealthProbe {
    param([Parameter(Mandatory = $true)][uri]$Uri)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
        return [ordered]@{
            url = $Uri.AbsoluteUri
            ok = $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
            status = $response.StatusCode
            error = $null
        }
    } catch {
        return [ordered]@{
            url = $Uri.AbsoluteUri
            ok = $false
            status = $null
            error = $_.Exception.Message
        }
    }
}

Assert-LoopbackUri -Uri $GatewayHealthUrl
Assert-LoopbackUri -Uri $DashboardHealthUrl
Import-Module ScheduledTasks -ErrorAction Stop

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskInfo = if ($null -ne $task) {
    Get-ScheduledTaskInfo -TaskName $TaskName
} else {
    $null
}

$gateway = Invoke-HealthProbe -Uri $GatewayHealthUrl
$dashboard = Invoke-HealthProbe -Uri $DashboardHealthUrl
$taskOk = $null -ne $task -or $AllowMissingTask
$dashboardOk = $dashboard.ok -or $AllowStoppedDashboard
$ok = $taskOk -and $gateway.ok -and $dashboardOk

[ordered]@{
    schemaVersion = '1.0'
    timestamp = [DateTime]::UtcNow.ToString('o')
    evidenceLevel = 'VERIFIED_OBSERVED'
    ok = $ok
    task = if ($null -eq $task) {
        [ordered]@{ exists = $false }
    } else {
        [ordered]@{
            exists = $true
            name = $task.TaskName
            state = [string]$task.State
            lastRunTime = $taskInfo.LastRunTime
            lastTaskResult = $taskInfo.LastTaskResult
            nextRunTime = $taskInfo.NextRunTime
        }
    }
    gateway = $gateway
    dashboard = $dashboard
} | ConvertTo-Json -Depth 6

if (-not $ok) {
    exit 2
}
