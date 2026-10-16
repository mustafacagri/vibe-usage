# Vibe Usage: onaylanan kapsamın uygulama karşılığı

Kullanıcı dikey tasarımı ve platformlar arası öneriyi gördükten sonra “ok geliştir” diyerek uygulamayı yetkilendirdi. Önceki WPF planı geçersiz. Windows'ta Rust/C++ build ortamı bulunmadığından Electron 44.8.0 kullanılacak; macOS hedefi korunacak.

İlk sürüm gerçek kota okuyan bir masaüstü uygulaması, isteğe bağlı terminal dashboard'u ve Claude için hesap seçerek yeni CLI süreci başlatma sunar. Açık sağlayıcı GUI'sini veya devam eden işi başka hesaba taşıyan özellik sunmaz. Görseldeki örnek yüzdeler üretime kopyalanmaz.

Uygulama dört sağlayıcıyı ve hesap başına bütün zaman/model kapsamlarını gösterir. Claude varsayılan ve `.claude-secondary` profilleri otomatik keşfedilir; başka config dizinleri kullanıcı tarafından eklenebilir. Hesap adı ve ana hesap tercihi yalnız uygulamanın ayarlarında tutulur. Provider kimlik dosyaları yazılmaz. Tokenlar renderer'a, loga veya uygulama ayarlarına gönderilmez.

Her yenileme sağlayıcı bazında bağımsızdır. Son başarılı değer ve zamanı korunur; hata sonrası eski değer güncelmiş gibi sunulmaz. Eksik haftalık, Fable, reset veya model grubu uydurulmaz. Cursor havuzları birbirine eklenmez. Fable'ın pasif kapsam kaydı erişim hakkı diye yorumlanmaz. Antigravity yalnız çalışan, aynı kullanıcıya ait uygulamanın doğrulanmış loopback servisine bağlanır; izleyici uygulamayı kendiliğinden başlatmaz.

Pencere sabitlenebilir, sürüklenebilir, küçültülebilir ve tepsiye gizlenebilir. Tepsi menüsünden aç/yenile/çıkış bulunur. Ayarlar yenileme aralığı, hesap etiketleri ve ana hesap sırasını saklar. Ağ çağrıları süre/yanıt sınırına ve HTTP 429 sonrası beklemeye sahiptir. İstekler sabit sağlayıcı URL'lerine gider, yönlendirme takip edilmez. Oturum süresi dolduğunda oturum yenileme gerektiği gösterilir; uygulama token refresh veya satın alma yapmaz.

`npm run watch` aynı çekirdeği terminalde gösterir; `npm run cli -- run claude` yeni Claude süreci için doğrulanmış profiller arasından seçim yapar. Otomatik seçim yalnız yeni iş öncesinde tüm ilgili ölçümleri yeterli ve güncel görünen hesaplara uygulanır; genel haftalık veri eksikse otomatik uygunluk varsayılmaz. Açık hesap seçimi mümkün, ancak eksik veri/ücretli model sınırı açıkça gösterilir. Failover ve resume yoktur.

Windows paketi burada üretilip gerçek veriyle çalıştırılacak. Mac için yapılandırma, adaptörler, build komutları ve CI sağlanacak; Mac runtime testi yapılmadan macOS doğrulandı denmeyecek.
