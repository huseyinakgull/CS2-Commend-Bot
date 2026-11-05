@echo off
title CS2 Ovgu Bot Sunucusu
color 0A

cd /d "%~dp0"

:START
echo [CS2] Ovgu Sunucusu baslatiliyor...

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch-gameinfo.ps1"

"game\bin\win64\cs2.exe" -dedicated -nohltv -maxfps 30 -condebug +con_logfile cs2-console.log +exec server.cfg +map de_dust2 -nocrashdialog 1>>"%~dp0cs2-stdout.log" 2>&1
echo [CS2] Sunucu durdu veya coktu! 5 saniye icinde otomatik olarak yeniden baslatiliyor...
timeout /t 5 >nul
goto START