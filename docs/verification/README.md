# Kullanım widget'ı: doğrulama sonucu ve ürün kapsamı

> Bu dosya geliştirme öncesindeki araştırma ölçümlerinin tarihsel kaydıdır. Çalışan ilk sürümün kullanımı için [uygulama README'sine](../../README.md), son test sonuçları için [masaüstü kabul kaydına](desktop-acceptance.md) bakın.

16 Ekim 2026. Bu rapor önceki kavramsal araştırmanın yerine **canlı gözlem / belge / henüz sınanmayan özellik** ayrımını koyar. Üretim uygulaması henüz geliştirilmedi. Önceden onaylanan dikey görünüm korunacak; Windows'a özel WPF planı uygulanmayacak.

## Windows'ta gerçekten ölçülenler

Codex, Cursor ve Antigravity değerleri yaklaşık **12:45–12:50 Türkiye** saatindeki ayrı ölçümlerdir. İki Claude hesabı **13:03:16**'da tekrar ölçüldü. Bunlar canlı dashboard veya aynı anda alınmış toplu snapshot değildir.

| Hizmet | Gerçek veri yolu | Ölçülen sonuç | Önemli sınır |
| --- | --- | --- | --- |
| Codex CLI 0.147.0 | Kurulu App Server; account/read + account/rateLimits/read | Plus; 5 saatte **%47 kalan**, haftalıkta **%58 kalan** | İki ayrı ölçüm penceresi; başka hesap/model için aynı şema varsayılmaz |
| Claude Code 2.1.301 / A | Ayrı oturumla OAuth usage GET, HTTP 200 | Team; son ölçümde 5 saatte **%10 kalan**. Fable kapsamlı haftalık kayıtta **%0 kullanılmış**, `is_active=false` | Genel haftalık alan sayısal veri vermedi. Fable kaydı erişim/ücretsiz kullanım testi değildir |
| Claude Code 2.1.301 / B | İkinci profil oturumuyla OAuth usage GET, HTTP 200 | Pro; 5 saatte **%100 kalan**, haftalıkta **%86 kalan** | 5 saatlik reset null; Fable ölçümü bildirilmedi. Eksik reset ve kapsam uydurulmayacak |
| Cursor IDE 3.22.7 / Agent 2026.10.14-0f9edde | Mevcut Agent oturumuyla usage-summary GET, HTTP 200 | Pro; plan used/limit=2000/2000, API %100, Auto %14.54, toplam %22.37 kullanılmış; bonus alanı da var | **“Hesap tamamen bitti” denemez.** Havuzların model ve ücretlendirme anlamları korunmalı |
| Antigravity App 2.4.3 / IDE product 2.5.5 | Kurulu Antigravity uygulamasının kendi PID'sine ait loopback servisinden RetrieveUserQuotaSummary, HTTP 200 | **Claude and GPT models** grubunda 5 saatlik **%100 kalan**, haftalık **%100 kalan** | Bu yanıtta Gemini grubu görülmedi; Gemini kotası uydurulamaz. Okuma yerel servisin çalışmasını gerektirdi |

Claude A Fable yenilenmesi `2026-10-18 16:00 +03:00`; A'da sayısal genel haftalık ölçüm yok. B'nin haftalık yenilenmesi `2026-10-18 17:00:00.083343 +03:00`. Antigravity 5 saatlik yenilenmesi `2026-10-16 17:50:40 +03:00`, haftalık yenilenmesi `2026-10-23 12:50:40 +03:00`. Bunlar kaynağın bildirdiği zamanlar; geçen zamandan kota dolduğu varsayılmayacak.

İlk Claude A ölçümünde 12:44'te %19 kalan vardı; ikinci okumada 13:03'te %10 kaldı. Aradaki tüketimin kaynağı bu testte ölçülmedi. Eski %19 değeri güncel sonuç diye sunulmayacak.

Antigravity testindeki her başlangıcın ardından yalnızca o denemenin başlattığı 6 süreç kapatıldı; önce çalışan uygulama yoktu. Sağlayıcılara model isteği gönderilmedi, kota kasıtlı tüketilmedi, mevcut oturumdan çıkılmadı. Gizli kimlik ve ham hesap yanıtları raporlara alınmadı. Dört hizmette başarılı kota okuması, üretim paketinden ve macOS'tan aynı erişimin çalıştığını kanıtlamaz.

## Hangi geçiş gerçekten destekleniyor?

| Yüzey | Kanıtlanan / belgelenen mekanizma | Gerçek iki hesapla otomatik devam |
| --- | --- | --- |
| Claude Code CLI | Resmi `CLAUDE_CONFIG_DIR`: hesap başına ayrı giriş. Kullanıcı B'ye bir kez giriş yaptı; iki farklı kullanıcı/kuruluş kimliği HTTP 200 profil yanıtlarıyla bellekte doğrulandı. A/B/A oturum seçimi ve iki ayrı kota okuması geçti | **Sınanmadı.** Bu test auth/kota okumasıdır; model işi, kota reddi ve görüşme devri yok |
| Codex CLI | `CODEX_HOME` ve kimlik deposu. Boş home negatif kontrolü geçti; `--profile` hesap seçici değil | **Sınanmadı.** İkinci giriş yok; çalışan sürecin devamı ve resume ayrıca sınanmalı |
| Cursor Agent CLI | Kurulu native Windows Agent doğrulandı; kullanıcı API anahtarı/ortam değişkeni belgeli | **Sınanmadı.** API anahtarının hesap/abonelik kotasıyla ilişkisi iki hesapta ölçülmeli |
| Cursor IDE | `--user-data-dir` kurulu yardımda var; resmi destek ayrı girişli uygulama örneklerini öneriyor | **Sınanmadı.** Ayrı pencere açmak açık görüşmeyi başka hesaba taşımıyor |
| Antigravity | Resmi ortak kimlik katmanı; App/CLI/IDE kimliği paylaşabiliyor. Bu makinede ayrı `agy` CLI bulunmadı | Bağımsız hesap izolasyonu ve otomatik rotasyon **doğrulanmadı** |
| Açık Codex / Claude Desktop / Cursor / Antigravity penceresi | Mevcut kanıtlar evrensel bir dışarıdan hesap değiştirme/görüşme taşıma arayüzü göstermiyor | Kesintisiz otomatik geçiş **özellik olarak vaat edilmeyecek** |

Claude'un `--fallback-model` seçeneği model değiştirir; rate-limit/auth/billing sorunları hesap rotasyonu tetikleyicisi değildir. Codex App Server'ın dış auth protokolü kendi istemcimiz için teknik bir yüzey sağlar; resmi açık GUI'yi kontrol ettiği sonucu çıkmaz.

[CC Switch](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/4-proxy/4.3-failover.md) failover kuyruğunda resmi hesapları dışarıda tutuyor. [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) çoklu OAuth hesap yönlendirmesini belgeliyor; bu, proxy üzerinden giden uyumlu API istekleri için ayrı bir yaklaşım. Yerel resmi uygulama hesabını değiştirdiği veya akmakta olan işi kesintisiz taşıdığı doğrulanmadı. Bu projeler kurulmadı/çalıştırılmadı.

## Önerilen kullanım biçimi

Ana ürün **Windows sistem tepsisi / macOS menü çubuğundan açılan, sabitlenebilir dikey masaüstü penceresi**. Sürekli terminal açık tutmak gerekmiyor. Ortak kota çekirdeğine bağlı isteğe bağlı terminal görünümü ve desteklenen CLI'ler için başlatıcı eklenebilir. Windows için EXE/installer; macOS için ayrı `.app`/DMG paketi. Tek kaynak tabanı iki ayrı platform doğrulaması gerektirir. Tauri 2 önerisi [tray](https://v2.tauri.app/learn/system-tray/), [Windows dağıtımı](https://v2.tauri.app/distribute/windows-installer/) ve [Mac bundle](https://v2.tauri.app/distribute/macos-application-bundle/) belgelerine dayanır; henüz build spike yapılmadı.

Windows'un [Widgets Board](https://learn.microsoft.com/windows/apps/design/widgets/) altyapısı ve macOS'un [WidgetKit](https://developer.apple.com/documentation/widgetkit) altyapısı var. Bunlar ayrı yerel entegrasyonlardır. Onaylanan görünümü ilk aşamada bağımsız masaüstü penceresi olarak sunmak, iki cihazdaki kullanımı ortaklaştırır.

Önerilen kullanıcı akışı:

1. Her cihazda mevcut oturumu bağla; ikinci hesap için sağlayıcı destekliyorsa ayrı profilde bir kez giriş yap.
2. Sağlayıcı altında ana hesabı ve yedek sırasını seç; bütün zaman/model pencerelerini gör.
3. İzlemek için pencereyi sabitle veya tepsiye gizle. Normal IDE/desktop kullanımına devam et.
4. Başlatıcıdan CLI çalıştırılacaksa proje ve model seç. Yeni süreç, doğrulaması tamamlanmış profil mekanizmasıyla uygun hesaptan açılır; terminalde sağlayıcının normal arayüzü görünür.
5. İsteğe bağlı terminal dashboard'u aynı verileri gösterir. Bu görünümün kapatılması takip hizmetini veya ayrı agent işini otomatik kapatmaz; bu ürün davranışı uygulamada ayrıca doğrulanacak.

`vibe watch`, `vibe run claude` gibi isimler yalnızca **önerilen komut tasarımıdır; şu an kurulu/çalışan komutlar değildir**. İlk sürümde dış terminal kullanmak yeterli. Gömülü terminal seçilirse [xterm.js](https://xtermjs.org/) + [PTY](https://github.com/microsoft/node-pty) katmanı ayrıca gerekir.

## Ana hesap politikası

Bu bir tasarım önerisidir, çalışan özellik değildir. Yeni işte önce ana hesap değerlendirilir. Seçili model için ilgili bütün limitler uygun değilse sıradaki doğrulanmış hesap seçilir. Fable sınırı biten hesap diğer modeller için otomatik olarak bitmiş sayılmaz. Ana hesap yenilenince **yeni işler** tekrar ona döner; süren iş kesilmez. Eksik/eski kota verisi tam hak kabul edilmez. Başarısız isteği körlemesine tekrar oynatıp dosya işlemlerini iki kez yapma davranışı eklenmez. API ücretli kullanımına sessizce geçilmez.

## Son test durumu ve açık noktalar

- **İki gerçek Claude hesabı artık doğrulandı:** ilk keşifte bir profil vardı; kullanıcı `.claude-secondary` için ilk girişi tamamladı. Sonraki A/B/A signed-in kontrolü team/pro/team döndü; profil endpoint'i iki farklı kullanıcı ve kuruluşu doğruladı; her iki quota GET'i HTTP 200. İki credential dosyası kontrol boyunca aynı kaldı. **Yenileme ve model işi ayrıca sınanmadı.**
- **Gerçek failover:** doğal olarak model kotasında olan A ve uygun B, yapılandırılmış başlatıcı, tanınan kota hata sinyali ve güvenli resume testi gerekir. Bu koşullar oluşmadan “A bitti → B ile devam” başarılı deneme sayılamaz. Hiçbir sağlayıcıda bu uçtan uca deney yapılmadı.
- **macOS:** bu sohbetten erişilebilir bir Mac bulunmadı. Hazırlanan `check-macos.sh` yalnızca komut bulunabilirliğini kontrol eder; Mac kota/Keychain/iki hesap testi yerine geçmez. Windows üzerindeki Bash çalıştırma denemesi başlatma hatası verdi; Mac betiğinin çalıştığı iddia edilmiyor.
- **Üretim paketleri:** widget/başlatıcı henüz yazılmadı; Tauri imzalama, tray davranışı, Finder'dan CLI keşfi ve paket içi kimlik erişimi sınanmadı.

## Ayrıntılı kanıtlar

- [Codex](codex.md): kurulu sürüm, RPC, negatif kontroller ve auth dosyasının korunması.
- [Claude](claude.md): Fable dahil gerçek yanıt, çoklu hesap resmi belgeleri ve ikinci profil keşfi.
- [Cursor ve Antigravity](cursor-antigravity.md): gerçek havuzlar, loopback servis doğrulaması ve süreç temizliği.
- [Platform ve araçlar](platform-and-tools.md): terminal/GUI farkı, üçüncü taraf çözümler, paketleme ve Mac kontrolünün sınırı.

Bu rapor araştırma, mevcut Windows veri yolları ve iki Claude hesabının ayrı oturum/kota okumasını kapsar; iki hesapla otomatik iş devri ve macOS doğrulamasını tamamlanmış saymaz.
