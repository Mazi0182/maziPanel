@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title maziPanel Kaldirma Araci

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"

echo ====================================================
echo             maziPanel Windows Kaldirma Araci
echo ====================================================
echo.
echo Bu islem maziPanel uygulamasini ve arka plan servislerini
echo sisteminizden kaldiracaktir.
echo.

set "CONFIRM_UNINSTALL=H"
set /p "CONFIRM_UNINSTALL=[?] Kaldirma islemine devam etmek istiyor musunuz? [e/H]: "
if /i not "%CONFIRM_UNINSTALL%"=="E" if /i not "%CONFIRM_UNINSTALL%"=="Y" (
    echo [IPTAL] Kaldirma islemi iptal edildi.
    echo.
    pause
    exit /b 0
)

echo.
echo Olusturdugunuz Minecraft sunucu dosyalari ^(servers\^), yedekler ^(backups\^)
echo ve panel yapilandirma verileri ^(data\^) da tamamen silinsin mi?
echo   [E] Evet, sunucu dosyalari ve yedekler dahil her seyi tamamen sil
echo   [H] Hayir, sunucu dosyalarini ve yedekleri koru ^(yalnizca uygulamayi ve servisi kaldir^)
set "DELETE_DATA=H"
set /p "DELETE_DATA=Seciminiz [e/H]: "

echo.
echo [*] 1/4 Arka plan servisleri ve zamanlanmis gorevler kaldiriliyor...

:: Windows Startup kisayolunu / betigini sil
set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\maziPanel_Background.vbs"
if exist "%STARTUP_VBS%" del /f /q "%STARTUP_VBS%" >nul 2>nul

:: Zamanlanmis gorevi ve olasi Windows servisini kaldir
schtasks /query /tn "maziPanel" >nul 2>nul
if %errorlevel% equ 0 (
    schtasks /delete /tn "maziPanel" /f >nul 2>nul
    if !errorlevel! neq 0 (
        echo [*] Arka plan gorevini silmek icin Yonetici izni isteniyor...
        powershell -NoProfile -Command "Start-Process schtasks -ArgumentList '/delete /tn \"maziPanel\" /f' -Verb RunAs -Wait" >nul 2>nul
    )
)

sc query "maziPanel" >nul 2>nul
if %errorlevel% equ 0 (
    sc stop "maziPanel" >nul 2>nul
    sc delete "maziPanel" >nul 2>nul
    if !errorlevel! neq 0 (
        powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c sc stop maziPanel & sc delete maziPanel' -Verb RunAs -Wait" >nul 2>nul
    )
)

if exist "%ROOT_DIR%\server\background_runner.vbs" del /f /q "%ROOT_DIR%\server\background_runner.vbs" >nul 2>nul

echo [*] 2/4 Acik maziPanel surecleri sonlandiriliyor...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -like '*%ROOT_DIR%*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

if /i "%DELETE_DATA%"=="E" goto :kill_runners
if /i "%DELETE_DATA%"=="Y" goto :kill_runners
goto :clean_app

:kill_runners
echo [*] Acik Minecraft alt surecleri ^(serverRunner^) sonlandiriliyor...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*serverRunner.js*' -and $_.CommandLine -like '*%ROOT_DIR%*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
timeout /t 1 /nobreak >nul

:clean_app
echo [*] 3/4 Uygulama bagimliliklari ve derleme dosyalari temizleniyor...
if exist "%ROOT_DIR%\server\node_modules" rmdir /s /q "%ROOT_DIR%\server\node_modules"
if exist "%ROOT_DIR%\client\node_modules" rmdir /s /q "%ROOT_DIR%\client\node_modules"
if exist "%ROOT_DIR%\client\dist" rmdir /s /q "%ROOT_DIR%\client\dist"
if exist "%ROOT_DIR%\temp" rmdir /s /q "%ROOT_DIR%\temp"

if /i "%DELETE_DATA%"=="E" goto :full_wipe
if /i "%DELETE_DATA%"=="Y" goto :full_wipe

echo [*] 4/4 Uygulama bilesenleri kaldirildi; sunucu dosyalari ve yedekler korundu.
if exist "%ROOT_DIR%\client" rmdir /s /q "%ROOT_DIR%\client"
if exist "%ROOT_DIR%\server" rmdir /s /q "%ROOT_DIR%\server"
if exist "%ROOT_DIR%\start.bat" del /f /q "%ROOT_DIR%\start.bat"
if exist "%ROOT_DIR%\start.sh" del /f /q "%ROOT_DIR%\start.sh"

echo.
echo ====================================================
echo [BASARILI] maziPanel uygulamasi ve arka plan servisi kaldirildi.
echo Korunan dizinler:
if exist "%ROOT_DIR%\servers" echo   - %ROOT_DIR%\servers
if exist "%ROOT_DIR%\backups" echo   - %ROOT_DIR%\backups
if exist "%ROOT_DIR%\data" echo   - %ROOT_DIR%\data
echo ====================================================
echo.
pause
exit /b 0

:full_wipe
echo [*] 4/4 Sunucu dosyalari, yedekler, veriler ve uygulama dizini tamamen siliniyor...
if exist "%ROOT_DIR%\servers" rmdir /s /q "%ROOT_DIR%\servers"
if exist "%ROOT_DIR%\backups" rmdir /s /q "%ROOT_DIR%\backups"
if exist "%ROOT_DIR%\data" rmdir /s /q "%ROOT_DIR%\data"
if exist "%ROOT_DIR%\client" rmdir /s /q "%ROOT_DIR%\client"
if exist "%ROOT_DIR%\server" rmdir /s /q "%ROOT_DIR%\server"
if exist "%ROOT_DIR%\.git" rmdir /s /q "%ROOT_DIR%\.git"
del /f /q "%ROOT_DIR%\start.bat" "%ROOT_DIR%\setup.bat" "%ROOT_DIR%\install.sh" "%ROOT_DIR%\start.sh" "%ROOT_DIR%\uninstall.sh" "%ROOT_DIR%\README.md" "%ROOT_DIR%\LICENSE" "%ROOT_DIR%\logo.png" "%ROOT_DIR%\logo.jpg" "%ROOT_DIR%\.gitignore" >nul 2>nul

echo.
echo ====================================================
echo [BASARILI] maziPanel, arka plan servisi, tum sunucu
echo dosyalari ve yedekler sistemden tamamen kaldirildi.
echo ====================================================
echo.
pause
cd /d "%ROOT_DIR%\.."
start /b "" cmd /c del /f /q "%ROOT_DIR%\uninstall.bat" ^& rmdir "%ROOT_DIR%" 2^>nul
exit /b 0
