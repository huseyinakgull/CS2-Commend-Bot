@echo off

if not defined CS2DIR set "CS2DIR=C:\cs2server"
set "GI=%CS2DIR%\game\csgo\gameinfo.gi"
set "SCFG=%CS2DIR%\game\csgo\cfg\server.cfg"

echo [%TIME%] Kontrol ediliyor...

findstr /C:"csgo/addons/metamod" "%GI%" >nul 2>&1
if errorlevel 1 (
    echo [%TIME%] gameinfo.gi BOZUK - duzeltiliyor...
    powershell -Command "(gc '%GI%') -replace '(\tGame\tcsgo)', \"`tGame`tcsgo/addons/metamod`r`n`$1\" | sc '%GI%'"
    echo [%TIME%] gameinfo.gi DUZELTILDI
) else (
    echo [%TIME%] gameinfo.gi OK
)

findstr /C:"exec autoexec" "%SCFG%" >nul 2>&1
if errorlevel 1 (
    echo exec autoexec.cfg >> "%SCFG%"
    echo [%TIME%] server.cfg DUZELTILDI
) else (
    echo [%TIME%] server.cfg OK
)

echo [%TIME%] Bitti.
