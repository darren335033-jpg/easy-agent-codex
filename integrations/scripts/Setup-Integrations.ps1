[CmdletBinding()]
param(
    [string]$ProjectRoot = 'C:\Users\darre\Documents\easy-agent-org',
    [string]$IntegrationRoot = 'C:\Users\darre\codex-maintenance\easy-agent-integration-20261014',
    [switch]$InstallOmniRoute,
    [switch]$DownloadOrca
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Protect-Directory([string]$Path) {
    if (Test-Path -LiteralPath $Path) { return }
    [void](New-Item -ItemType Directory -Path $Path -Force)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Read-Sections([string]$Content) {
    $sections = [ordered]@{}
    $name = '__preamble__'
    $sections[$name] = ''
    foreach ($line in ($Content -split "`r?`n")) {
        if ($line -match '^\s*\[([^\[\]]+)\]\s*(?:#.*)?$') {
            $name = $Matches[1].Trim()
            if ($sections.Contains($name)) { throw 'Duplicate TOML section; configuration was not changed.' }
            $sections[$name] = ''
        } elseif ($line -match '^\s*\[\[') { throw 'Array TOML sections require manual merge; configuration was not changed.' }
        $sections[$name] += $line + "`r`n"
    }
    return ,$sections
}
function Normalize-Section([string]$Value) { return (($Value -replace "`r`n", "`n").Trim()) }
$node = Get-Command node -CommandType Application -ErrorAction Stop
$codex = Get-Command codex -ErrorAction Stop
$nodeOutput = @(& $node.Source --version 2>&1)
if ($LASTEXITCODE -ne 0 -or ($nodeOutput -join '') -notmatch '^v(\d+)\.(\d+)\.(\d+)\s*$') { throw 'Unable to determine Node version.' }
$nodeVersion = $Matches[0].Trim()
if ([int]$Matches[1] -lt 24) { throw 'Node 24 or newer is required. No changes were made.' }
$codexOutput = @(& $codex.Source --version 2>&1)
if ($LASTEXITCODE -ne 0 -or ($codexOutput -join '') -notmatch '^codex(?:-cli)?\s+[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?\s*$') { throw 'Unable to determine Codex version.' }
Write-Output ('Node: ' + $nodeVersion + '; path: ' + $node.Source)
Write-Output ('Codex: ' + ($codexOutput -join '').Trim() + '; path: ' + $codex.Source)
$stagedPath = Join-Path $IntegrationRoot 'codex-config.toml'
if (-not (Test-Path -LiteralPath $stagedPath -PathType Leaf)) { throw 'Staged codex-config.toml is missing.' }
$staged = [IO.File]::ReadAllText($stagedPath)
$configDirectory = Join-Path $ProjectRoot '.codex'
$configPath = Join-Path $configDirectory 'config.toml'
$existing = ''
if (Test-Path -LiteralPath $configPath) { $existing = [IO.File]::ReadAllText($configPath) }
# Credentials must be referenced by environment variable name, never embedded.
$literalSecretPattern = '(?im)^\s*(?:api_key|access_token|token|password|secret|authorization)\s*=\s*["'']'
if ($staged -match $literalSecretPattern -or $existing -match $literalSecretPattern) { throw 'Possible embedded credential detected. Configuration and backup were not written.' }
$wanted = Read-Sections $staged
$current = Read-Sections $existing
$additions = New-Object System.Collections.Generic.List[string]
$conflicts = New-Object System.Collections.Generic.List[string]
foreach ($name in $wanted.Keys) {
    if ($name -eq '__preamble__') {
        if (@(($wanted[$name] -split "`r?`n") | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') }).Count -gt 0) { throw 'Staged root settings are prohibited; default provider will not be changed.' }
        continue
    }
    if ($name -notmatch '^(profiles|model_providers|mcp_servers)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$') { throw 'Staged section is outside the allowed integration configuration.' }
    if ($current.Contains($name)) {
        if ((Normalize-Section $current[$name]) -ne (Normalize-Section $wanted[$name])) { $conflicts.Add($name) }
    } else { $additions.Add($wanted[$name]) }
}
if ($conflicts.Count -gt 0) {
    Write-Output ('Configuration conflict sections: ' + ($conflicts -join ', ') + '. Entire configuration left unchanged.')
    throw 'Resolve configuration conflicts before installation.'
}
if ($additions.Count -gt 0) {
    Protect-Directory $configDirectory
    $backupDirectory = Join-Path $IntegrationRoot 'backups'
    Protect-Directory $backupDirectory
    if (Test-Path -LiteralPath $configPath) {
        $backupPath = Join-Path $backupDirectory ('codex-config-' + [guid]::NewGuid().ToString('N') + '.toml')
        [IO.File]::WriteAllText($backupPath, $existing, (New-Object Text.UTF8Encoding($false)))
        Write-Output ('Configuration backup: ' + $backupPath)
    }
    $newText = $existing.TrimEnd() + "`r`n`r`n" + ($additions -join "`r`n")
    $temporary = Join-Path $configDirectory ([guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $newText, (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $configPath) { [IO.File]::Replace($temporary, $configPath, $null) }
        else { [IO.File]::Move($temporary, $configPath) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
    Write-Output ('Configuration updated: ' + $configPath)
} else { Write-Output 'Integration configuration already matches; no changes.' }
if ($InstallOmniRoute) {
    $npm = Get-Command npm.cmd -CommandType Application -ErrorAction Stop
    $runtime = Join-Path $IntegrationRoot 'runtime'
    Protect-Directory $runtime
    $savedErrorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $npmOutput = @(& $npm.Source install --prefix $runtime --no-audit --no-fund --save-exact omniroute@3.8.51 2>&1)
        $npmCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedErrorPreference }
    $npmOutput = $null
    Write-Output ('OmniRoute install exit code: ' + $npmCode)
    if ($npmCode -ne 0) { throw 'OmniRoute installation failed; logs were not exposed.' }
    $packagePath = Join-Path $runtime 'node_modules\omniroute\package.json'
    $package = [IO.File]::ReadAllText($packagePath) | ConvertFrom-Json
    if ($package.version -ne '3.8.51') { throw 'Installed OmniRoute version does not match the pinned version.' }
    $packageDirectory = Split-Path -Parent $packagePath
    if ($package.bin -is [string]) { $binValues = @($package.bin) }
    else { $binValues = @($package.bin.PSObject.Properties | ForEach-Object { $_.Value }) }
    foreach ($bin in $binValues) {
        $resolvedBin = [IO.Path]::GetFullPath((Join-Path $packageDirectory $bin))
        if (-not $resolvedBin.StartsWith($packageDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid package executable path.' }
        Write-Output ('OmniRoute 3.8.51 executable: ' + $resolvedBin)
    }
    Write-Output 'OmniRoute was not started.'
}
if ($DownloadOrca) {
    $downloads = Join-Path $IntegrationRoot 'downloads'
    Protect-Directory $downloads
    $installer = Join-Path $downloads 'orca-windows-setup.exe'
    if (Test-Path -LiteralPath $installer) { throw 'Orca installer already exists; it was not overwritten.' }
    $source = 'https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $source -OutFile $installer -UseBasicParsing
    $hash = Get-FileHash -LiteralPath $installer -Algorithm SHA256
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    Write-Output ('Orca source: ' + $source)
    Write-Output ('Orca installer: ' + $installer)
    Write-Output ('SHA256: ' + $hash.Hash)
    Write-Output ('Authenticode status: ' + $signature.Status)
    Write-Output 'Orca installer was not executed; source and signature require review.'
}
