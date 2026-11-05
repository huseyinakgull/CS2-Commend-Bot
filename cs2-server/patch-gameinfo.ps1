$gi = Join-Path $PSScriptRoot 'game\csgo\gameinfo.gi'
$scfg = Join-Path $PSScriptRoot 'game\csgo\cfg\server.cfg'

if (Test-Path $gi) {
    $content = Get-Content $gi -Raw
    if ($content -notmatch 'csgo/addons/metamod') {
        $content = $content -replace '(\tGame\tcsgo)', "`tGame`tcsgo/addons/metamod`r`n`$1"
        Set-Content -Path $gi -Value $content -NoNewline
        Write-Host 'gameinfo.gi patched'
    }
}

if (Test-Path $scfg) {
    if (-not (Select-String -Path $scfg -Pattern 'exec autoexec' -Quiet)) {
        Add-Content -Path $scfg -Value 'exec autoexec.cfg'
        Write-Host 'server.cfg patched'
    }
}
