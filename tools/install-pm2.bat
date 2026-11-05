@echo off

echo.
echo [1/5] PM2 global yukleniyor...
call npm install -g pm2
if %errorlevel% neq 0 (
    echo HATA: PM2 yuklenemedi. npm yetkisi var mi?
    exit /b 1
)

echo.
echo [2/5] pm2-windows-startup yukleniyor (boot'ta otomatik baslama)...
call npm install -g pm2-windows-startup
call pm2-startup install

echo.
echo [3/5] Mevcut node service.js process'leri durduruluyor...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*service.js*' -and $_.CommandLine -notlike '*commend-single*' -and $_.CommandLine -notlike '*pm2*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output ('Killed PID=' + $_.ProcessId) }"

echo.
echo [4/5] PM2 ile cscommends baslatiliyor...
cd /d %~dp0..
call pm2 start ecosystem.config.js

echo.
echo [5/5] PM2 process listesi save (boot'ta restore edilir)...
call pm2 save

echo.
echo ================================================
echo  KURULUM TAMAM
echo ================================================
echo.
echo  Komutlar:
echo    pm2 status                    Tum process'lerin durumu
echo    pm2 logs cscommends           Canli log
echo    pm2 restart cscommends        Manuel restart
echo    pm2 reload cscommends         Zero-downtime reload
echo    pm2 stop cscommends           Durdur
echo    pm2 delete cscommends         Process listesinden kaldir
echo    pm2 monit                     Real-time monitoring TUI
echo.
echo  Sunucu yeniden baslatildiginda PM2 cscommends'i otomatik baslatir.
echo.
pause
