@echo off
chcp 65001 >nul
title maziPanel Sunucu ve Arayuz Motoru

cd /d "%~dp0"

echo ====================================================
echo             maziPanel Baslatiliyor...
echo ====================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [HATA] Node.js bulunamadi! Lutfen once Node.js kurun.
    pause
    exit /b 1
)

if not exist "%~dp0server\node_modules" (
    echo [UYARI] Sunucu bagimliliklari henuz yuklenmemis.
    echo Lutfen once "setup.bat" dosyasini calistirin.
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0client\dist" (
    echo [BILGI] Arayuz derlemesi bulunamadi, derleme baslatiliyor...
    cd /d "%~dp0client"
    call npm run build
    cd /d "%~dp0"
)

echo [*] maziPanel baslatiliyor: http://localhost:8080
echo [*] Paneli durdurmak icin pencereyi kapatabilir veya Ctrl+C tuslarina basabilirsiniz.
echo.

start "" "http://localhost:8080"
node "%~dp0server\server.js"

pause
