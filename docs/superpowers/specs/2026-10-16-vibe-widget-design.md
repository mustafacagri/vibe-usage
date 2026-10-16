# Vibe Windows kullanım widget'ı — onaylanan tasarım

> Kapsam yeniden açıldı: kullanıcı Windows + macOS ve birden fazla hesapta ana/yedek önceliği istedi. Dikey görsel yerleşim onaylıdır; aşağıdaki WPF/Windows teknik seçimi artık uygulama için geçerli değildir. Platformlar arası yaklaşım ve açık uygulamalarda hesap geçişi için yeni değerlendirme: `docs/research/2026-10-16-cross-platform-accounts.md`.

Kullanıcı 16 Ekim 2026'da dikey widget tasarımını onayladı. Görsel referans, bu sohbetin `vibe-usage-design.html` önizlemesindeki **Dikey widget** çeşididir. Araştırma: `docs/research/2026-10-16-usage-limits.md`.

## Teslimat

Windows üzerinde çalışan, taşınabilir bir EXE. Başlıksız ve taşınabilir dikey pencere; her zaman üstte seçeneği; sistem tepsisine gizleme/açma; dört sağlayıcı için bağımsız yenileme. Kullanıcı ayarları yalnızca uygulamanın kendi veri klasöründe tutulur. Başlangıçta otomatik açılış, satın alma veya hesap değiştirme yok.

## Görünüm

Yaklaşık 410 DIP genişliğinde, ekranın çalışma alanına sığan pencere. İçerik gerektiğinde kaydırılır. Başlık, kalan/yeni dönem sütunları ve sırasıyla Codex, Claude, Cursor, Antigravity bölümleri. Model kapsamlı bütün ölçümler ana listede görünür; Fable ayrıntı ekranına gizlenmez. Kredi/harcama satırları ayrı gösterilir. Açık/koyu görünüm Windows temasını izler. Bağlantı detayları bilgi düğmesinde; teknik endpoint ve gizli kimlik bilgileri ana ekrana konmaz.

## Veri davranışı

Veriler hesap yanıtından dinamik gelir. Sabit iki kota, sabit model listesi veya sabit fatura dönemi yok. Her satır kaynak kimliği, model/ürün kapsamı, dönem ve yenilenme zamanıyla ayırt edilir. Kullanılan yüzde veya kalan oran doğru yönde normalize edilir; çakışan havuzlar toplanmaz. Fable'ın ortak haftalık kullanımdan da düştüğü açıklanır. Bilinmeyen alanlar tam kota sayılmaz. Bağlam penceresi ve yerel token tahmini abonelik kotası değildir.

Son başarılı ölçüm ve yaşı korunur; bağlantı başarısızsa güncelmiş gibi gösterilmez. Hesap değişince eski hesaptan değer taşınmaz. Daha önce görülen model kotası sonraki kısmi yanıtta sessizce kaybolmaz. Yenilenme zamanı geçince kota yerelde doldurulmaz; yeni okuma beklenir. Sıfır, sınırsız, eksik, eski veri ve oturum gereksinimi ayrıdır.

## Bağlantılar

Codex: kurulu CLI'nin App Server hesap/kota metotları; model çağrısı yapılmaz. Claude: mevcut yerel oturumla salt okunur hesap kullanım isteği; dinamik model kapsamları dahil. Cursor: mevcut uygulama oturumuyla dashboard kullanım özeti, salt okunur SQLite erişimi. Antigravity: çalışan yerel uygulamanın kota özeti; eski model biçimi için uyumluluk. Belgelenmemiş kaynaklar erişilemediğinde açık durum mesajı gösterilir.

Kimlik bilgileri loglanmaz, ham yanıtlar diske dökülmez, diğer uygulamaların oturum dosyaları değiştirilmez. Erişim tokenı yalnızca sağlayıcının doğrulanmış HTTPS alan adına veya ilgili uygulamanın doğrulanmış loopback servisine gider. Arka planda token yenileme/satın alma yok. Hata çıktıları temizlenir. Ağ isteklerinin süre sınırı ve hız sınırlamasında beklemesi vardır.

## Yapı ve doğrulama

C#/.NET, bağımlılıksız JSON ayrıştırıcı çekirdeği, Windows bağlantı adaptörleri ve WPF arayüzü. .NET SDK 9.0.100 ve masaüstü başvuru paketleri mevcut; Rust bulunmadığı için WPF seçildi. Uygulama çekirdeği NuGet paketi gerektirmez. Ürün yayını imzalanmamış yerel geliştirme EXE'sidir.

Kabul kontrolleri: parser testleri (Fable kapsamı, eksik/0/sınırsız, eski/yeni Cursor, Antigravity grupları), kimlik temelli eski veri birleştirme, gerçek hesapların sır içermeyen salt okunur teşhisi, Release derlemesi, EXE çalıştırma ve pencere kontrolleri. Erişilemeyen sağlayıcı bir örnek değerle doldurulmaz; sınırlama sonuçta belirtilir.
