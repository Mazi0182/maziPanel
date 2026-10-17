#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "[HATA] Node.js bulunamadı! Lütfen Node.js kurun."
    exit 1
fi

if [ ! -d "$SCRIPT_DIR/server/node_modules" ]; then
    echo "[UYARI] Sunucu bağımlılıkları yüklenmemiş. Lütfen önce './install.sh' çalıştırın."
    exit 1
fi

if [ ! -d "$SCRIPT_DIR/client/dist" ]; then
    echo "[BİLGİ] Arayüz derlemesi bulunamadı, derleniyor..."
    cd "$SCRIPT_DIR/client"
    npm run build
    cd "$SCRIPT_DIR"
fi

echo "[*] maziPanel başlatılıyor..."
echo "[*] Erişim: http://localhost:${PORT:-8080}"
echo "[*] Durdurmak için Ctrl+C tuşlarına basabilirsiniz."
echo ""

cd "$SCRIPT_DIR/server"
exec node server.js
