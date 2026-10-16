# Eleştirel kabul denetimi — 16 Ekim 2026

> Sonraki düzeltme: aşağıdaki TLS bulgusu 0.1.1'de kapatıldı. [Kök neden ve düzeltme doğrulaması](tls-fix-2026-10-16.md). Diğer bulgular açık; aşağıdaki tablo 0.1.0'ın tarihsel denetim sonucudur.

**Karar: üretime hazır değil. Mevcut kaynak bir MVP; tüm yerel AI uygulamalarının ve hesaplarının doğru izlendiği kanıtlanmadı. Aşağıdaki canlı başarısızlıklar ve kod karşı örnekleri önceki kabul kaydını sınırlar.**

İncelenen kaynak: `b166b2c`. Üretim kodu bu denetimde değiştirilmedi. Mevcut 53 test yeniden geçti; aşağıdaki karşı örnekler bu testlerin kapsamadığı davranışlardır.

## Canlı EXE sonucu

16 Ekim 2026 13:30 UTC / 16:30 Türkiye. Projedeki `release/win-unpacked/Vibe Usage.exe`, ayrı test ayarlarıyla çalıştırıldı; açık kullanıcı Vibe süreci kapatılmadı. Yalnız mevcut oturumların kota okumaları yapıldı. Kurulu Antigravity App 2.4.3 ve IDE 2.5.5 açıldı; giriş/çıkış, model işi veya token yenileme yapılmadı.

| Kaynak | Gözlem | Kapsam kararı |
| --- | --- | --- |
| Codex | 5 saat %22, haftalık %38 kalan | Mevcut CLI kaynağı okunuyor; ek hesap envanteri yok |
| Claude CLI | İki profil bulundu; ikisinde de `transport_error` | Bu testte Fable dahil limitler yüklenmedi |
| Cursor | `transport_error` | IDE ve Agent tokenlarının hesap öznesi bellekte karşılaştırıldı: aynı, ikisi de süresi dolmamış. Kota yine okunamadı |
| Antigravity App | Claude/GPT grubunda iki pencere, %100 kalan | Kaynak okunuyor |
| Antigravity IDE | Ayrı servis kontrolünde Gemini haftalık %93,74845, 5 saat %86,912304 kalan; ayrıca Claude/GPT pencereleri var | Widget ilk App kaynağında döndüğü için Gemini pencereleri kayıp |
| Claude Desktop | Ayrı yerel uygulama çalışıyor | CLI profilleriyle hesap eşleşmesi uygulanmamış |
| Gemini / ChatGPT | Başlat menüsünde kurulu uygulamalar bulundu | Dört sabit adaptörün kapsamı dışında |

Son EXE ekran görüntüleri ve public snapshot: `artifacts/principal-audit-1792157397457/`. Bunlar gerçek renderer görüntüleridir; tasarım/mockup değildir. `claude-default.png` ve `claude-secondary.png` ayrı profilleri gösterir. `actual-window.png` gerçek 430×900 viewport'tur; tam sayfa 977 piksel yüksekliğinde, yatay taşma yoktur.

## Engelleyici bulgular

1. **P1 — Platform sertifika güveniyle uyumsuz ağ katmanı.** `src/providers/common.cjs:21` Node HTTPS kullanıyor. Claude ve Cursor adreslerine kimliksiz Node istekleri `SELF_SIGNED_CERT_IN_CHAIN` verdi. Windows'un standart HTTPS istemcisi aynı Cursor adresine TLS doğrulamasından geçerek HTTP 401 aldı. Ek CA/proxy/Node seçenek ortam değişkenleri ayarlı değildi. Ürün tümünü genel bağlantı hatasına indirgedi. TLS doğrulaması kapatılmadı; CA ekleme, ortam bayrağı veya alternatif kota değeriyle sonuç düzeltilmedi. Kalıcı düzeltme platform güven/proxy sözleşmesini açıkça uygulamalı ve test etmelidir.

2. **P1 — Windows CLI hesap/ücretlendirme seçimi garanti değil.** `src/core/launcher.cjs:6` ve `src/providers/common.cjs:68` ortamı case-sensitive JS nesnesinde temizliyor; Windows ortam adları case-insensitive. Sentetik `anthropic_api_key` ve `claude_config_dir` silinmeden kaldı; gerçek alt Node süreci büyük harfli okumada ikisini de gördü. Böylece CLI açık hesap seçimine rağmen başka profil veya API kimlik bilgisi kullanabilir. Desktop PowerShell yardımcısının sonradan yaptığı temizlik CLI yolundaki kusuru gidermiyor.

3. **P1 — Antigravity App/IDE kaynağı ve hesap kimliği ayrılmıyor.** `src/providers/antigravity.cjs:190` tek `antigravity:current` hesabı üretip ilk başarılı serviste dönüyor. Bu makinede üç yerel servis bulundu; App iki, IDE dört pencere verdi. Widget IDE'nin gerçek Gemini kotalarını göstermedi. Servis sırasına göre sonucun değişmesi kaynak seçimi sözleşmesinin eksikliğidir. Birleştirme de hesap eşitliği kanıtlanmadan yapılamaz.

## Diğer doğrulanmış kusurlar

- **P2 — Tam yenileme bazı sağlayıcıları atlayabiliyor.** `src/core/service.cjs:20`: devam eden `refresh('claude')` sırasında `refresh()` başlatılınca ikincisi yalnız Claude isteğini bekleyip dönüyor. Enjekte adaptörlerle Codex fetch sayısı 0, Claude 1; Codex `pending` kaldı.
- **P2 — Yenileme hesap keşfi yapmıyor.** `src/core/service.cjs:12`: keşif yalnız servis oluşturulurken çağrılıyor. Sonradan eklenen standart Claude profili iki yenilemeden sonra da görünmedi. Silinen keşif kayıtları otomatik uzlaştırılmıyor.
- **P2 — Şema bozulması taze başarı gibi görünebiliyor.** `parseCursorUsage({})` ve `parseCodexRateLimits(null)` boş pencere döndürüyor; servis `ok` durumunu ve `fetchedAt` zamanını güncelliyor. Önceki pencereler satır bazında eski olarak taşınsa da hesap alt bilgisi taze başarı gösteriyor. Boş/geçersiz yanıt ile gerçek ölçüm sözleşmesi ayrılmalı.
- **P2 — Mac varsayılan profil Keychain seçicisi eksik temsil ediliyor.** `src/providers/claude.cjs:72` explicit/unset ayrımını hesap ID'sinden türetiyor. Alt helper testleri bu iki girişin farklı servis adları kullandığını kanıtlarken gerçek provider explicit-default durumunu temsil edemiyor. Mac cihaz testi yok.

## Principal seviyesini engelleyen tasarım borcu

- UI'deki “4 hizmet” kurulu uygulama sayısı değil; sabit adaptör sayısı. Kurulum, çalışan süreç, oturum, hesap kimliği ve okunabilir kota ayrı durumlar olarak modellenmiyor.
- Codex/Cursor/Antigravity çoklu hesap keşfi yok; Claude profil klasörü keşfi de farklı hesap kimliklerini doğrulamıyor. Claude Desktop bağımsız kalıyor.
- Windows Cursor yalnız Agent auth dosyasını okuyor. Bugün IDE ile aynı hesap olduğu ayrıca doğrulandı; IDE-only ve farklı hesap senaryosu ürün tarafından çözülmüş değil.
- Async servis ve arayüz kodu çok sıkıştırılmış. Yaşam döngüsü/sahiplik kurallarını incelemek zor; uygunluk politikası iki yerde tekrarlanıyor.
- İmza, macOS cihaz testi ve kalıcı hata teşhisi eksik. Önceki canlı smoke bir makineye, iki Claude profilinin adlarına ve dar bir başarılı yola bağlıydı.
- Mevcut açık Vibe örneği dört süreçte yaklaşık 192,9 MiB private bellek, toplam 345,3 MiB working set kullandı; working set paylaşılan sayfaları çifte sayabilir. ZIP 146,3 MiB. Küçük widget için kaynak bütçesi tanımlanmış veya optimize edilmiş değil.

Renderer sandbox'ı, dar IPC, sabit uç noktalar, metinle render, gizli değerleri saklamama ve PID/OS sahibi doğrulaması iyi temellerdir. Bunlar yukarıdaki veri doğruluğu ve yaşam döngüsü sorunlarının yerine geçmez. Bu denetim sonrası sürümün üretim kabulü **başarısızdır**.
