@echo off
set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
if not defined CS2DIR set "CS2DIR=C:\cs2server"
if not defined CS2BAT set "CS2BAT=%CS2DIR%\baslat.bat"
if not defined CADDYDIR set "CADDYDIR=C:\Caddy"
if not defined CADDYEXE set "CADDYEXE=%CADDYDIR%\caddy.exe"
if not defined CADDYFILE set "CADDYFILE=Caddyfile"

echo [1/4] gameinfo.gi kontrol ediliyor...
call "%APP%\patch-gameinfo.bat" <nul

echo [2/4] CS2 sunucusu...
tasklist | findstr /i "cs2.exe" >nul
if %errorlevel%==0 (
  echo CS2 zaten calisiyor, atlandi.
) else (
  if exist "%CS2BAT%" (
    start "cs2server" /d "%CS2DIR%" "%CS2BAT%"
    echo CS2 baslatildi, 90 sn bekleniyor...
    timeout /t 90 /nobreak >nul
  ) else (
    echo HATA: %CS2BAT% bulunamadi, CS2 baslatilamadi.
  )
)

echo [3/4] cscommends...
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if %errorlevel%==0 (
  echo cscommends zaten 3000 portunda calisiyor, atlandi.
) else (
  start "cscommends" /d "%APP%" node service.js
  echo cscommends baslatildi. Acilan pencereyi KAPATMA.
)

echo [4/4] Caddy...
tasklist | findstr /i "caddy.exe" >nul
if %errorlevel%==0 (
  echo Caddy zaten calisiyor, atlandi.
) else (
  sc query caddy >nul 2>&1
  if %errorlevel%==0 (
    net start caddy
  ) else (
    if exist "%CADDYEXE%" (
      start "caddy" /d "%CADDYDIR%" "%CADDYEXE%" run --config "%CADDYFILE%"
    ) else (
      echo UYARI: Caddy servis degil ve %CADDYEXE% bulunamadi. CADDYDIR / CADDYEXE degiskenlerini ayarla.
    )
  )
)

echo.
echo Bitti. Kontrol:
netstat -ano | findstr /r /c:":3000 .*LISTENING" /c:":443 .*LISTENING" /c:":27015"
