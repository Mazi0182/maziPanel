<div align="center">
  <img src="logo.png" alt="maziPanel Logo" width="160" />
  <h1>maziPanel</h1>
  <p><strong>Yüksek performanslı ve modern Minecraft sunucu yönetim paneli.</strong></p>

  [![Çekirdek](https://img.shields.io/badge/%C3%87ekirdek-Paper%20%7C%20Purpur-blue.svg)](#temel-%C3%B6zellikler)
  [![Java](https://img.shields.io/badge/Java-8%20--%2025%2B-orange.svg)](#sistem-gereksinimleri)
  [![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Windows-lightgrey.svg)](#sistem-gereksinimleri)
</div>

---

## Genel Bakış

maziPanel; bağımsız, hafif ve modern web teknolojileriyle geliştirilmiş bir Minecraft sunucu yönetim, gözetim ve P2P tünel orkestrasyon platformudur. Debian headless sunucular başta olmak üzere Linux ve Windows ortamlarında tam uyumlu olarak çalışır.

### Temel Özellikler

- **Çoklu Çekirdek Desteği:** Paper ve Purpur sunucu türleri için kurulum sihirbazı ve tam uyumluluk.
- **Gerçek Zamanlı Web Konsolu:** Renkli ANSI çıktı desteği, komut geçmişi ve anlık WebSocket bağlantısı.
- **Kesintisiz Süreç Yönetimi:** Panel yeniden başlatılsa bile çalışan Minecraft sunucularını kapatmadan devralan ayrık süreç (IPC) mimarisi.
- **Java Yönetimi:** Sistemdeki Java sürümlerini (Java 8, 11, 17, 21, 25+) otomatik tespit etme, tek tıkla yeni JDK indirme/kurma, uyumluluk analizi ve sunucuya özel Java seçimi.
- **P2P Tünel Entegrasyonu:** CGNAT arkasındaki sunuculara port yönlendirme veya statik IP gerektirmeden bağlanmayı sağlayan P2P Tunnel servisi için yerleşik yönetim, HWID yasaklama ve oturum izleme merkezi.
- **Performans ve Enerji Tüketim Analizi:** CPU ve RAM kullanımının yanı sıra donanım profiline ve EPDK güncel elektrik tarifelerine dayalı anlık tüketim ve maliyet hesabı.
- **Yedekleme ve Arşiv Yöneticisi:** Tek tıkla yedekleme, zamanlanmış otomatik yedeklemeler (Cron), artımlı (incremental) tek dosya yedekleme, arşiv içi tarayıcı ve doğrudan ZIP içe aktarma motoru.
- **Güvenli Dosya Yöneticisi:** Gelişmiş kod düzenleyici, dosya/dizin oluşturma, yeniden adlandırma, arşivden çıkarma, sıkıştırma ve symlink/path traversal korumaları.
- **Oyuncu Yönetimi:** Çevrim içi/çevrim dışı oyuncu listesi, operatör (OP) yetkilendirme, whitelist yönetimi, oyuncu atma (kick) ve uzaklaştırma (ban).
- **Discord Botu ve Webhook Entegrasyonu:** Sunucu durum değişikliklerini, ses kanalı durumunu ve bildirimleri yöneten dahili Discord botu ile SSRF korumalı webhook altyapısı.
- **Güçlendirilmiş Güvenlik:** HttpOnly JWT oturumları, çoklu kullanıcı ve rol tabanlı yetkilendirme (RBAC), istek sınırlama (rate limiting), brute-force koruması ve sıkılaştırılmış CORS kontrolleri.

---

## Arayüzden Görseller

### Ana Ekran
<img width="1757" height="961" alt="Ana Ekran" src="https://github.com/user-attachments/assets/40666924-1147-4c20-b324-2dafcb0cd59c" />

### Kurulum Sihirbazı
<img width="1753" height="957" alt="Kurulum Sihirbazı" src="https://github.com/user-attachments/assets/833e60fa-8a85-4861-96fc-29691c0bf6ac" />

### Kurulum Sonu ve Yapılandırma Özeti
<img width="1756" height="961" alt="Kurulum Sonu" src="https://github.com/user-attachments/assets/6165ff17-f2c5-44ad-af97-377b2d1b0312" />

### Sunucu Yönetim Paneli Ekranı
<img width="1744" height="956" alt="Panel Ekranı" src="https://github.com/user-attachments/assets/14a15fac-95c9-464a-b28a-14de1b83c97b" />

---

## Sistem Gereksinimleri

- **İşletim Sistemi:** Linux (Debian 11/12, Ubuntu 20.04+, RHEL vb.) veya Windows 10/11 / Windows Server
- **Node.js:** v18.0.0 veya üzeri (LTS v20 önerilir)
- **Java:** Minecraft sunucu sürümlerinize uygun Java sürümleri (panel içerisinden de otomatik indirilebilir)
- **Ağ:** Panel için varsayılan `8080` portu, Minecraft sunucuları için `25565` ve üzeri portlar.

---

## Kurulum ve Arka Plan Servisi

Hem Linux hem de Windows kurulum araçları bağımlılıkları yükler, üretim arayüzünü derler ve isteğinize bağlı olarak **arka plan servisini** otomatik yapılandırıp başlatır (gerekli durumlarda `sudo` şifresi veya Windows Yönetici Onayı / UAC ister; manuel servis tanımlaması yapmanıza gerek kalmaz).

### Linux Kurulumu

1. Depoyu klonlayın:
   ```bash
   git clone https://github.com/Mazi0182/maziPanel.git
   cd maziPanel
   ```

2. Kurulum aracını çalıştırılabilir yapın ve başlatın:
   ```bash
   chmod +x install.sh start.sh uninstall.sh
   ./install.sh
   ```

3. Kurulum sırasında arka plan servisi (`systemd`) sorusuna `E` yanıtını verdiğinizde servis otomatik olarak kaydedilir, oturum kapansa dahi çalışmaya devam etmesi için `loginctl enable-linger` (veya sistem servisi) yapılandırılır ve panel başlatılır.
4. Tarayıcınızdan sunucu IP adresine bağlanın: `http://SUNUCU_IP_ADRESI:8080`

> Arka plan servisi kurmadan yalnızca manuel başlatmak isterseniz `./start.sh` komutunu kullanabilirsiniz.

### Windows Kurulumu

1. Projeyi klonlayın veya ZIP olarak indirip çıkartın:
   ```powershell
   git clone https://github.com/Mazi0182/maziPanel.git
   cd maziPanel
   ```
2. Klasör içindeki `setup.bat` dosyasını çalıştırın.
3. Kurulum sonunda arka plan servisi sorusuna `E` yanıtını verdiğinizde Windows Görev Zamanlayıcı ve Başlangıç görevi otomatik olarak oluşturulur (gerekirse Yönetici izni istenir) ve panel arka planda penceresiz olarak başlatılır.
4. Tarayıcınızda `http://localhost:8080` adresine gidin.

> Paneli manuel olarak konsol penceresiyle başlatmak için `start.bat` dosyasını kullanabilirsiniz.

---

## İlk Başlatma ve Yönetici Hesabı

Panel ilk defa başlatıldığında tarayıcı otomatik olarak **Master Kurulum Sihirbazı** ekranına yönlendirir:
1. Yönetici kullanıcı adı ve güçlü bir şifre belirleyin.
2. Kurulum tamamlandıktan sonra panele giriş yaparak ilk Minecraft sunucunuzu oluşturabilirsiniz.

---

## Kaldırma (Uninstall)

Sistemi kaldırmak için hem Linux hem de Windows üzerinde tam kapsamlı kaldırma betikleri mevcuttur. Kaldırma araçları çalışırken:
- Arka plan servislerini (`systemd` kullanıcı/sistem servislerini, Windows Görev Zamanlayıcı kayıtlarını ve başlangıç betiklerini) tamamen durdurur ve siler.
- Açık olan maziPanel süreçlerini sonlandırır.
- **Minecraft sunucu dosyalarınızın (`servers/`), yedeklerinizin (`backups/`) ve verilerinizin (`data/`) silinip silinmeyeceğini size sorar:**
  - **Evet (`E`)** seçilirse: Açık Minecraft sunucu süreçleri de kapatılır; sunucu dosyaları, yedekler, yapılandırmalar, arka plan servisi ve uygulama dosyaları kalıntı bırakmadan tamamen kaldırılır.
  - **Hayır (`H`)** seçilirse: Arka plan servisi ve panel uygulama dosyaları kaldırılır; oluşturduğunuz Minecraft sunucuları ve yedek arşivleri korunur.

- **Linux üzerinde kaldırmak için:**
  ```bash
  ./uninstall.sh
  ```
- **Windows üzerinde kaldırmak için:**
  `uninstall.bat` dosyasını çalıştırın.

---

## Proje Mimarisi

```text
├── client/                        # React 18, Vite, Tailwind CSS tabanlı ön yüz
│   ├── src/                       # Arayüz bileşenleri, kancalar ve sayfalar
│   └── dist/                      # Üretim derlemesi (server tarafından sunulur)
├── server/                        # Node.js, Express ve WebSocket arka uç motoru
│   ├── config.js                  # Ortam değişkenleri ve yol yapılandırması
│   ├── server.js                  # Ana API ve WebSocket sunucusu
│   └── src/                       # Kimlik doğrulama, sunucu, P2P, yedekleme ve metrik modülleri
├── data/                          # Dinamik çalışma zamanı verileri (Git tarafından yok sayılır)
├── servers/                       # Oluşturulan Minecraft sunucu örnekleri
├── backups/                       # Otomatik ve manuel sunucu yedekleri
├── setup.bat / start.bat          # Windows kurulum ve başlatma araçları
├── uninstall.bat                  # Windows tam kapsamlı kaldırma aracı
├── install.sh / start.sh          # Linux kurulum ve başlatma araçları
├── uninstall.sh                   # Linux tam kapsamlı kaldırma aracı
└── README.md
```

---

## Lisans

Bu proje [MIT Lisansı](LICENSE) altında lisanslanmıştır.

