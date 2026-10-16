# Masaüstü sürümü kabul kaydı — 16 Ekim 2026

Windows x64 üzerinde proje kökündeki son kaynak ve bu kaynaktan üretilen paket doğrulandı.

| Kontrol | Sonuç |
| --- | --- |
| `node --test test/*.test.cjs` | 53 başarılı, 0 başarısız |
| JavaScript ve başlatıcı PowerShell sözdizimi | Başarılı |
| `npm run build:win` | Başarılı; klasör ve ZIP üretildi |
| `VIBE_SMOKE_EXECUTABLE` ile paketlenmiş EXE testi | Başarılı |
| Codex mevcut hesap | Gerçek veri, iki kota penceresi |
| Claude | İki bağımsız profil, toplam beş kota kaydı |
| Cursor mevcut hesap | Gerçek veri, beş ayrı kullanım kaydı |
| Antigravity | Uygulama kapalı; kaynak yokken kota üretilmedi |
| Hesap seçimi, sabitleme, ayar kaydı | Başarılı |
| Pencereyi kapatınca sistem tepsisinde kalma | Başarılı |
| Renderer hatası / snapshot içinde token alanı | Görülmedi |

Canlı test yalnız mevcut oturumların kota bilgisini okudu. Model işi, giriş/çıkış veya token yenileme yapılmadı. Test ayarları `artifacts/smoke-*` içinde ayrıldı. Ekran görüntüsü `artifacts/desktop-live.png` altında; yüzdeler uygulamaya gömülmedi.

Ana hesap önceliği, dolu hesabı atlama, eski/bilinmeyen veriyi otomatik seçime uygun saymama ve Fable kapsamı fixture testleriyle sınandı. Gerçek hesabın kotasını tüketerek kesintisiz iş devri testi yapılmadı; bu sürüm zaten çalışan işi başka hesaba devretmiyor. CLI yalnız yeni süreç için hesap seçer, masaüstü seçilen profille yeni terminal açar.

macOS Keychain seçimi, yerel süreç/port keşfi ve komut kaçışları fixture testlerinden geçti. Gerçek Mac üzerinde çalıştırma ve macOS paketi üretimi bu ortamda yapılmadı. GitHub Actions paketleme iş akışı hazır; uzakta çalıştırıldığı iddia edilmez. Windows paketi imzasızdır.
