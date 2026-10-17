#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "===================================================="
echo "            maziPanel Linux Kurulum Aracı"
echo "===================================================="
echo ""

if ! command -v node >/dev/null 2>&1; then
    echo "[HATA] Node.js sisteminizde bulunamadı!"
    echo "Lütfen Node.js v18 veya üzeri bir sürüm kurun (Örn: NodeSource LTS):"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
fi

NODE_PATH_BIN="$(command -v node)"
echo "[*] Node.js sürümü: $(node -v) ($NODE_PATH_BIN)"

if ! command -v npm >/dev/null 2>&1; then
    echo "[HATA] npm sisteminizde bulunamadı!"
    exit 1
fi

echo "[*] 1/3 Sunucu (Backend) bağımlılıkları yükleniyor..."
cd "$SCRIPT_DIR/server"
npm install --no-audit

echo "[*] 2/3 Arayüz (Frontend) bağımlılıkları yükleniyor..."
cd "$SCRIPT_DIR/client"
npm install --no-audit

echo "[*] 3/3 Arayüz (Frontend) derleniyor (Production Build)..."
npm run build

cd "$SCRIPT_DIR"
chmod +x "$SCRIPT_DIR/start.sh" "$SCRIPT_DIR/uninstall.sh" 2>/dev/null || true

echo ""
echo "----------------------------------------------------"
read -r -p "[?] maziPanel arka plan servisi (systemd) olarak otomatik yapılandırılıp başlatılsın mı? [E/h]: " SETUP_SERVICE
SETUP_SERVICE="${SETUP_SERVICE:-E}"

if [[ "$SETUP_SERVICE" =~ ^[EeYy]$ ]]; then
    echo "[*] Arka plan servisi yapılandırılıyor..."
    SERVICE_PORT="${PORT:-8080}"

    cat > "$SCRIPT_DIR/server/mazipanel.service" <<EOF
[Unit]
Description=maziPanel Backend Daemon & API Engine
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR/serve
ExecStart=$NODE_PATH_BIN $SCRIPT_DIR/server/server.js
Restart=always
RestartSec=3
KillMode=process
Environment=NODE_ENV=production
Environment=PORT=$SERVICE_PORT
LimitNOFILE=65536
TimeoutStopSec=60

[Install]
WantedBy=default.target multi-user.target
EOF

    if [ "$(id -u)" -ne 0 ] && systemctl --user status >/dev/null 2>&1; then
        echo "[*] Kullanıcı seviyesi systemd servisi kaydediliyor..."
        mkdir -p "$HOME/.config/systemd/user"
        cp "$SCRIPT_DIR/server/mazipanel.service" "$HOME/.config/systemd/user/mazipanel.service"
        systemctl --user daemon-reload
        systemctl --user enable mazipanel.service
        systemctl --user restart mazipanel.service

        if command -v loginctl >/dev/null 2>&1; then
            LingerState="$(loginctl show-user "$USER" -p Linger 2>/dev/null | cut -d= -f2 || true)"
            if [ "$LingerState" != "yes" ]; then
                echo "[*] Oturum kapandığında servisin kapanmaması için linger etkinleştiriliyor (sudo şifresi gerekebilir)..."
                sudo loginctl enable-linger "$USER" || echo "[UYARI] Linger etkinleştirilemedi, ancak kullanıcı servisi başlatıldı."
            fi
        fi
        echo "[OK] maziPanel arka plan servisi (kullanıcı kapsamı) etkinleştirildi ve başlatıldı."
    else
        echo "[*] Sistem seviyesi systemd servisi kaydediliyor (sudo şifresi gerekebilir)..."
        RUN_USER="${SUDO_USER:-$(whoami)}"
        SYS_TMP_SERVICE="/tmp/mazipanel.service.$$"
        cat > "$SYS_TMP_SERVICE" <<EOF
[Unit]
Description=maziPanel Backend Daemon & API Engine
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$SCRIPT_DIR/serve
ExecStart=$NODE_PATH_BIN $SCRIPT_DIR/server/server.js
Restart=always
RestartSec=3
KillMode=process
Environment=NODE_ENV=production
Environment=PORT=$SERVICE_PORT
LimitNOFILE=65536
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
        sudo mv "$SYS_TMP_SERVICE" /etc/systemd/system/mazipanel.service
        sudo chmod 644 /etc/systemd/system/mazipanel.service
        sudo systemctl daemon-reload
        sudo systemctl enable mazipanel.service
        sudo systemctl restart mazipanel.service
        echo "[OK] maziPanel arka plan servisi (sistem kapsamı) etkinleştirildi ve başlatıldı."
    fi
else
    echo "[BİLGİ] Arka plan servisi kurulumu atlandı. Paneli './start.sh' ile manuel başlatabilirsiniz."
fi

echo ""
echo "===================================================="
echo "[BAŞARILI] maziPanel kurulumu tamamlandı!"
echo ""
echo "Tarayıcı erişim adresi: http://localhost:${PORT:-8080}"
echo "Manuel başlatmak için : ./start.sh"
echo "Sistemi kaldırmak için: ./uninstall.sh"
echo "===================================================="
