# Platformlar arası kullanım ve birden fazla hesap

> Canlı doğrulama eklendi: [Windows ölçümleri ve özellik destek matrisi](../verification/README.md). Dört hizmetin kota okuması Windows'ta doğrulandı. Claude'da kullanıcı ikinci profile giriş yaptıktan sonra iki farklı kullanıcı kimliği, A/B/A durum seçimi ve iki ayrı kota okuması da geçti. A→B otomatik iş devri ve macOS henüz sınanmadı.

16 Ekim 2026. Kullanıcı, Windows'a ek olarak macOS kullandığını; sağlayıcı başına birden fazla hesabı, ana hesap önceliğini ve hem açık uygulamalarda hem başlattığımız CLI işlerinde mümkünse otomatik geçişi istedi. Windows'a özel WPF uygulamasının geliştirilmesine başlanmadı. Önceki plan bu kapsam için geçersiz işaretlendi.

## Platform kararı

Terminal arayüzü iki platformda çalışabilir, ancak sürekli masaüstünde görünen widget deneyimi için zorunlu veya tek seçenek değil. [Tauri](https://v2.tauri.app/) aynı kaynak tabanıyla Windows ve macOS uygulamasını destekliyor. [Electron](https://www.electronjs.org/docs/latest) da iki platformu destekliyor; Chromium ve Node'u paketine dahil ediyor. Bu ürün için önerilen yön ortak kota/hesap çekirdeği, Tauri masaüstü görünümü ve gerektiğinde aynı çekirdeğe bağlı CLI başlatıcıdır. Önceki dikey tasarım korunabilir. Yerel kimlik depoları ve uygulama keşfi işletim sistemine göre adaptör gerektirir; aynı kaynak kodu her platformda test gereksinimini kaldırmaz.

## Tekrar giriş gereksinimi

Her hesap cihazda ilk kez bağlanır. Desteklenen ayrı oturum/kimlik deposu seçilebildiğinde her hesap değişiminde çıkış-giriş yapmak gerekmez. Süresi dolan/iptal edilen oturum veya sağlayıcının doğrulama istemesi yeniden giriş gerektirebilir. Masaüstü uygulamasında otomatik değişiklik için ayrıca desteklenen bir entegrasyon gerekir; kota okuyabilmek, o uygulamanın aktif hesabını değiştirebilmek demek değildir.

## Belgelerle doğrulanan yollar

- **Claude Code:** [Resmi çok hesap bölümü](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts), her claude.ai hesabı için ayrı `CLAUDE_CONFIG_DIR` ile aynı anda oturum açık tutmayı belgeliyor. Dizin seçimi süreç başlangıcında yapılır; çalışan görüşmeyi başka hesapla canlı devam ettirmeyi garanti etmez. Console'un API anahtarsız oturumları için istisna belgededir.
- **Codex CLI:** [Kimlik doğrulama](https://learn.chatgpt.com/docs/auth) dosya kimliğinin `CODEX_HOME` altında, alternatif olarak OS kimlik deposunda tutulduğunu açıklıyor. [CLI referansındaki](https://learn.chatgpt.com/docs/cli/reference) `--profile` ayar katmanıdır; hesap seçici değildir. Ayrı kimlik dizinleri/depolarıyla hesap başına başlatma bu altyapıdan çıkarılan öneridir; kurulu sürüm ve kimlik deposu kipinde doğrulanacak. Açık masaüstü uygulamasında kesintisiz hesap değişimi için genel bir arayüz doğrulanmadı.
- **Cursor CLI:** [Resmi kimlik doğrulama belgesi](https://cursor.com/docs/cli/reference/authentication), otomasyon için kullanıcı API anahtarı ve süreç ortam değişkenini destekliyor. Bu, hesap başına kimlikle süreç başlatma yönünü sağlar; ücretlendirme/abonelik kapsamı ilgili hesapta doğrulanmalı. Bu anahtar, Models ayarlarındaki harici model sağlayıcısı anahtarıyla karıştırılmaz.
- **Cursor IDE:** [Cursor destek yanıtı](https://forum.cursor.com/t/feature-request-multi-account-support-fast-account-switching/166689/5), ayrı `--user-data-dir` dizinleriyle farklı uygulama örnekleri öneriyor. Bu, aynı açık pencerenin hesabını ve görüşmesini kesintisiz değiştirme API'si değildir. Her profilin ilk girişi ve kurulu sürüm davranışı iki platformda doğrulanacak.
- **Antigravity:** [Resmi kimlik belgesi](https://www.antigravity.google/docs/install/) uygulama/CLI/IDE arasında ortak kimlik katmanını açıklıyor. Bu paylaşım nedeniyle bir değişikliğin diğer yüzeylere etkisi değerlendirilmeden bağımsız profil veya otomatik hesap rotasyonu vaat edilmeyecek.

## Önerilen hesap politikası

Sağlayıcı başına sıralı hesaplar ve bir ana hesap. Yeni iş/istekte seçilen model için ilgili bütün ortak ve model kapsamlı sınırlar kontrol edilir. Ana hesap uygunsa o kullanılır; gerçek kota engeli varsa sıradaki uygun hesaba geçilir. Örneğin Fable sınırı bitmiş bir Claude hesabı Fable işi için atlanabilir; bu, o hesabın bütün diğer modeller için bitmiş olduğu anlamına gelmez. Hiç uygun hesap yoksa bekleme ve yenilenme gösterilir; sonsuz tekrar veya otomatik ücretli kullanıma geçiş yapılmaz.

Ana hesap yenilendiğinde yeni işler tekrar ona yönelir; çalışan iş sırf öncelik değişti diye kesilmez. Geçici bağlantı hatası veya her 429 yanıtı hesap kotasının tükendiği diye yorumlanmaz. Görüşme/iş ortasında geçiş desteklenmiyorsa o iş için devamlılık garanti edilmez; dosya değiştiren bir görevi otomatik baştan tekrar çalıştırmak varsayılan değildir.

Çift cihazda aynı hesabın kullanım hakları ortak olabilir. Yerel öncelik listesi iki cihazda da ana hesabı seçebilir; kota ölçümleri gecikebildiğinden hatasız ortak rezervasyon varsayılmaz. İlk sürümde gizli kimlikleri cihazlar arasında otomatik eşitlemek gerekmiyor; her cihaz kendi OS güvenli deposuyla bağlanabilir.

## Tasarımda gereken ekler

Sağlayıcı altında hesap satırları; ana hesap işareti; aktif hesap; öncelik sırası; seçilen modele göre kullanılabilirlik; otomatik geçiş açık/kapalı; sağlayıcıya göre “CLI geçişi”, “ayrı pencere başlatma” veya “elle giriş gerekiyor” yetenek durumu. Kullanıcıya desteklenmeyen bir uygulama için aynı otomatik geçiş düğmesi sunulmamalı.
