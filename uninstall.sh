#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "===================================================="
echo "            maziPanel Linux Kaldırma Aracı"
echo "===================================================="
echo ""
echo "Bu işlem maziPanel uygulamasını ve arka plan servislerini"
echo "sisteminizden kaldıracaktır."
echo ""

read -r -p "[?] Kaldırma işlemine devam etmek istiyor musunuz? [e/H]: " CONFIRM_UNINSTALL
if [[ ! "$CONFIRM_UNINSTALL" =~ ^[EeYy]$ ]]; then
    echo "[İPTAL] Kaldırma işlemi iptal edildi."
    exit 0
fi

echo ""
echo "Oluşturduğunuz Minecraft sunucu dosyaları (servers/), yedekler (backups/)"
echo "ve panel yapılandırma verileri (data/) da tamamen silinsin mi?"
echo "  [E] Evet, sunucu dosyaları ve yedekler dahil her şeyi tamamen sil"
echo "  [H] Hayır, sunucu dosyalarını ve yedekleri koru (yalnızca uygulamayı ve servisi kaldır)"
read -r -p "Seçiminiz [e/H]: " DELETE_DATA
DELETE_DATA="${DELETE_DATA:-H}"

echo ""
echo "[*] 1/4 Arka plan servisleri kontrol ediliyor ve kaldırılıyor..."

# Kullanıcı seviyesi systemd servisini kontrol et ve kaldı
if systemctl --user list-unit-files mazipanel.service >/dev/null 2>&1 || [ -f "$HOME/.config/systemd/user/mazipanel.service" ]; then
    echo "[*] Kullanıcı seviyesi systemd servisi durduruluyor ve siliniyor..."
    systemctl --user stop mazipanel.service 2>/dev/null || true
    systemctl --user disable mazipanel.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/mazipanel.service"
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user reset-failed 2>/dev/null || true
fi

# Sistem seviyesi systemd servisini kontrol et ve kaldı
if [ -f "/etc/systemd/system/mazipanel.service" ]; then
    echo "[*] Sistem seviyesi systemd servisi kaldırılıyor (sudo şifresi gerekebilir)..."
    sudo systemctl stop mazipanel.service 2>/dev/null || true
    sudo systemctl disable mazipanel.service 2>/dev/null || true
    sudo rm -f /etc/systemd/system/mazipanel.service
    sudo systemctl daemon-reload 2>/dev/null || true
    sudo systemctl reset-failed 2>/dev/null || true
fi

echo "[*] 2/4 Açık maziPanel süreçleri sonlandırılıyor..."
pkill -TERM -f "$SCRIPT_DIR/server/server.js" 2>/dev/null || true

if [[ "$DELETE_DATA" =~ ^[EeYy]$ ]]; then
    echo "[*] Açık Minecraft alt süreçleri (serverRunner) sonlandırılıyor..."
    pkill -TERM -f "$SCRIPT_DIR/server/src/servers/serverRunner.js" 2>/dev/null || true
    sleep 1
fi

echo "[*] 3/4 Uygulama bağımlılıkları ve derleme dosyaları temizleniyor..."
rm -rf "$SCRIPT_DIR/server/node_modules"
rm -rf "$SCRIPT_DIR/server/node_modules_dc"
rm -rf "$SCRIPT_DIR/client/node_modules"
rm -rf "$SCRIPT_DIR/client/dist"
rm -rf "$SCRIPT_DIR/temp"

if [[ "$DELETE_DATA" =~ ^[EeYy]$ ]]; then
    echo "[*] 4/4 Sunucu dosyaları, yedekler, veriler ve uygulama dizini tamamen siliniyor..."
    rm -rf "$SCRIPT_DIR/servers"
    rm -rf "$SCRIPT_DIR/backups"
    rm -rf "$SCRIPT_DIR/data"
    rm -rf "$SCRIPT_DIR/client"
    rm -rf "$SCRIPT_DIR/server"
    rm -f "$SCRIPT_DIR/start.sh" "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/setup.bat" "$SCRIPT_DIR/start.bat" "$SCRIPT_DIR/uninstall.bat" "$SCRIPT_DIR/README.md" "$SCRIPT_DIR/LICENSE" "$SCRIPT_DIR/logo.png" "$SCRIPT_DIR/logo.jpg" "$SCRIPT_DIR/.gitignore" 2>/dev/null || true
    rm -rf "$SCRIPT_DIR/.git" 2>/dev/null || true

    echo ""
    echo "===================================================="
    echo "[BAŞARILI] maziPanel, arka plan servisi, tüm sunucu"
    echo "dosyaları ve yedekler sistemden tamamen kaldırıldı."
    echo "===================================================="

    SELF_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
    rm -f "$SELF_PATH" 2>/dev/null || true
    rmdir "$SCRIPT_DIR" 2>/dev/null || true
else
    echo "[*] 4/4 Uygulama bileşenleri kaldırıldı; sunucu dosyaları ve yedekler korundu."
    rm -rf "$SCRIPT_DIR/client"
    rm -rf "$SCRIPT_DIR/server"
    rm -f "$SCRIPT_DIR/start.sh" "$SCRIPT_DIR/start.bat" 2>/dev/null || true

    echo ""
    echo "===================================================="
    echo "[BAŞARILI] maziPanel uygulaması ve arka plan servisi kaldırıldı."
    echo "Korunan dizinler:"
    [ -d "$SCRIPT_DIR/servers" ] && echo "  - $SCRIPT_DIR/servers"
    [ -d "$SCRIPT_DIR/backups" ] && echo "  - $SCRIPT_DIR/backups"
    [ -d "$SCRIPT_DIR/data" ] && echo "  - $SCRIPT_DIR/data"
    echo "===================================================="
fi
