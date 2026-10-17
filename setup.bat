@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title maziPanel Kurulum Sihirbazi

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"

echo ====================================================
echo             maziPanel Kurulum Sihirbazi
echo ====================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Node.js sisteminizde bulunamadi!
    echo Lutfen Node.js v18 veya uzeri bir surumu indirip kurun:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%i in ('where node') do (
    set "NODE_BIN=%%i"
    goto :node_found
)
:node_found

echo [*] Node.js surumu kontrol ediliyor...
node -v
echo.

where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] npm sisteminizde bulunamadi!
    echo Lutfen Node.js kurulumunuzu dogrulayin.
    echo.
    pause
    exit /b 1
)

echo [*] 1/3 Sunucu (Backend) bagimliliklari yukleniyor...
cd /d "%ROOT_DIR%\server"
call npm install --no-audit
if %errorlevel% neq 0 (
    echo [HATA] Sunucu paketleri yuklenirken bir sorun olustu.
    pause
    exit /b %errorlevel%
)
echo [OK] Sunucu bagimliliklari tamamlandi.
echo.

echo [*] 2/3 Arayuz (Frontend) bagimliliklari yukleniyor...
cd /d "%ROOT_DIR%\client"
call npm install --no-audit
if %errorlevel% neq 0 (
    echo [HATA] Arayuz paketleri yuklenirken bir sorun olustu.
    pause
    exit /b %errorlevel%
)
echo [OK] Arayuz bagimliliklari tamamlandi.
echo.

echo [*] 3/3 Arayuz (Frontend) derleniyor (Production Build)...
call npm run build
if %errorlevel% neq 0 (
    echo [HATA] Arayuz derleme islemi basarisiz oldu.
    pause
    exit /b %errorlevel%
)
echo [OK] Arayuz basariyla derlendi.
echo.

cd /d "%ROOT_DIR%"
echo ----------------------------------------------------
set "SETUP_BG=E"
set /p "SETUP_BG=[?] maziPanel Windows arka plan servisi olarak otomatik yapilandirilsin ve baslatilsin mi? [E/h]: "
if /i "%SETUP_BG%"=="E" goto :configure_bg
if /i "%SETUP_BG%"=="Y" goto :configure_bg
echo [BILGI] Arka plan servisi kurulumu atlandi. Paneli "start.bat" ile manuel baslatabilirsiniz.
goto :finish_setup

:configure_bg
echo [*] Arka plan calistiricisi ve baslangic gorevi olusturuluyor...

set "VBS_LAUNCHER=%ROOT_DIR%\server\background_runner.vbs"
(
    echo Set WshShell = CreateObject^("WScript.Shell"^)
    echo WshShell.CurrentDirectory = "%ROOT_DIR%\server"
    echo WshShell.Run """%NODE_BIN%"" ""%ROOT_DIR%\server\server.js""", 0, False
) > "%VBS_LAUNCHER%"

:: Windows Baslangic (Startup) klasorune arka plan baslaticisini kaydet
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\maziPanel_Background.vbs"
copy /y "%VBS_LAUNCHER%" "%STARTUP_VBS%" >nul 2>nul

:: Windows Gorev Zamanlayici (Task Scheduler) kaydi (Gerekirse Yonetici Onayi / UAC ister)
schtasks /create /tn "maziPanel" /tr "wscript.exe \"%VBS_LAUNCHER%\"" /sc onlogon /rl highest /f >nul 2>nul
if %errorlevel% neq 0 (
    echo [*] Sistem baslangic gorevi icin Yonetici izni isteniyor...
    powershell -NoProfile -Command "Start-Process schtasks -ArgumentList '/create /tn \"maziPanel\" /tr \"wscript.exe `\"%VBS_LAUNCHER%`\"\" /sc onlogon /rl highest /f' -Verb RunAs -Wait" >nul 2>nul
)

:: Eger onceden calisan panel sureci varsa yeniden baslatmak uzere kapat
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -like '*%ROOT_DIR%*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

echo [*] maziPanel arka planda baslatiliyor...
wscript.exe "%VBS_LAUNCHER%"
echo [OK] maziPanel arka plan servisi etkinlestirildi ve baslatildi.

:finish_setup
echo.
echo ====================================================
echo [BASARILI] maziPanel kurulumu tamamlandi!
echo.
echo Tarayici erisim adresi: http://localhost:8080
echo Manuel baslatmak icin : start.bat
echo Sistemi kaldirmak icin: uninstall.bat
echo ====================================================
echo.
pause
