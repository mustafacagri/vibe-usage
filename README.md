# Vibe Usage

> 0.1.1: Claude/Cursor bağlantısını bozan TLS güveni sorunu [düzeltildi ve terminal/EXE üzerinde doğrulandı](docs/verification/tls-fix-2026-10-16.md). [Eleştirel denetimdeki](docs/verification/principal-audit-2026-10-16.md) Antigravity kaynak ayrımı, Windows CLI hesap seçimi ve diğer açık bulgular nedeniyle sürüm hâlâ üretime hazır sayılmaz.

Windows sistem tepsisi ve macOS menü çubuğu için yerel AI abonelik kullanım izleyicisi. Kota pencerelerini ve model kapsamlarını ayrı gösterir; eksik veriyi tam hak saymaz.

## Windows'ta açma

`release/win-unpacked/Vibe Usage.exe` dosyasını açın. Klasördeki diğer dosyalar gereklidir; EXE'yi tek başına taşımayın. Başka bilgisayara taşımak için `release/Vibe Usage-0.1.1-win.zip` dosyasını çıkarıp içindeki EXE'yi açın. Paket kod imzalı değildir.

Üstteki elmas düğmesi pencereyi sabitler. Eksi düğmesi veya pencereyi kapatma uygulamayı sistem tepsisine gizler. Tepsi menüsündeki **Çıkış** uygulamayı kapatır. Ayarlardan yenileme aralığı, Claude hesap adları ve ana hesap seçilir. Varsayılan yenileme aralığı iki dakikadır.

Uygulama mevcut oturumları okur; hesap şifresi/token istemez veya diğer uygulamalardan çıkış yaptırmaz. Hesap ayarları `%APPDATA%/Vibe Usage/settings.json` altında, Mac'te `~/Library/Application Support/Vibe Usage/settings.json` altında tutulur. Gizli kimlik bilgileri bu dosyaya yazılmaz. Kotalar yalnız bellekte tutulur.

## Sağlayıcılar

| Hizmet | Veri kaynağı | Bu sürümün kapsamı |
| --- | --- | --- |
| Codex | Kurulu CLI App Server hesap/kota metotları | Mevcut hesap; zaman pencereleri ve kaynakta bildirilen ek limitler |
| Claude | Mevcut profilin OAuth kullanım yanıtı | `.claude`, `.claude-secondary` ve geçerli `.claude-*` profilleri; genel/model kapsamlı pencereler, Fable dahil |
| Cursor | Mevcut oturumun kullanım özeti | Auto/API/toplam havuzları ve ayrı tutar alanları; tek aktif hesap |
| Antigravity | Çalışan uygulamanın aynı OS kullanıcısına ait, PID ve IPv4 adresi doğrulanmış yerel servisi | Kaynağın bildirdiği grup/zaman pencereleri; uygulama kapalıysa durum mesajı |

Claude profilleri bağımsız seçilir; ayarlardaki klasör seçiciyle başka kayıtlı profil eklenebilir. İlk giriş sağlayıcının CLI'sinde yapılır. Mac'te Keychain erişim izni gerekebilir; profilin Keychain seçicisi ilk girişte kullanılan config diziniyle eşleşmelidir. Uygulama token yenilemez; süre dolarsa sağlayıcıda yeniden giriş gerekir.

Cursor API kapsamının dolması bütün hesabın dolduğu anlamına gelmez. Fable'ın pasif kapsam kaydı ücretsiz model erişimi garantisi değildir. Eksik haftalık/reset verisi uydurulmaz. Başarısız okumada son başarılı ölçüm açıkça **eski veri** etiketiyle tutulur.

## Terminal ve başlatıcı

Node.js 22.15+ (22.x) veya 24+ ile proje klasöründe:

```text
npm run watch
npm run cli -- status --json
npm run cli -- run claude --account claude:secondary --cwd C:\proje
npm run cli -- run claude --model sonnet --dry-run
```

`watch` terminal dashboard'udur; Ctrl+C bu görünümü kapatır. Masaüstü uygulamasıyla veri modelini ve ayarları paylaşır; ayrı açık izleyiciler kendi yenilemelerini yapar. JSON çıktısı token içermez; yerel profil yollarını ve kota verisini içerir.

Başlatıcı yalnız **yeni Claude Code süreci** açar. Açık hesap seçilmezse ana hesap önceliklidir; eksik/eski veya dolu ilgili limitler otomatik uygunluk sayılmaz. Belirsizlikte açık hesap seçimi istenir. `--dry-run` kota okur ve seçimi bildirir, terminal/model işi açmaz. Masaüstündeki başlat düğmesi seçilen hesap için proje klasörünü sorar ve ayrı terminal açar. CLI'nin model/kredi tercihleri kendi arayüzünde geçerlidir.

**Bu sürüm çalışan görüşmeyi başka hesaba devretmez, başka IDE'nin hesabını değiştirmez ve işi otomatik tekrar oynatmaz.** Codex/Cursor/Antigravity için çoklu hesaplı iş devri sunulmaz.

## Geliştirme ve paketleme

```text
npm ci
npm test
npm start
npm run build:win
```

Mac üzerinde `npm run build:mac` çalıştırılır. GitHub Actions Windows ve macOS paketleme işlerini içerir. **macOS kod yolları fixture testleriyle sınandı; gerçek Mac çalıştırması ve imzalama/notarizasyon henüz yapılmadı.**

`npm run smoke`, mevcut gerçek oturumlarla Electron penceresinde salt okunur test yapar. Bu makineye özel iki Claude profili bekler; ayarları `artifacts/smoke-*` altında tutar, model çağrısı yapmaz. Test sırasında pencere kısa süre görünür; sonunda kapanır. `VIBE_SMOKE_EXECUTABLE` ile paketlenmiş EXE aynı testten geçirilir.

`VIBE_DATA_DIR`, uygulamanın kendi ayar konumunu test için değiştirir. `VIBE_CODEX_BINARY` ve `VIBE_CLAUDE_BINARY` yalnız yerel kurulu ikililerin açık yolları için desteklenir. Sağlayıcı kullanım adresleri sabittir; yönlendirme takip edilmez. Antigravity için PowerShell 7 gerekmez; Windows'un yerleşik PowerShell'i keşif için, Node ise yerel HTTPS için kullanılır.

Claude/Cursor HTTPS istekleri Node'un varsayılan CA'larıyla işletim sisteminin mevcut güvenilir CA'larını birlikte kullanır. Sertifika zinciri ve alan adı doğrulaması açıktır; uygulama sertifika yüklemez, sistem deposunu veya global TLS ayarlarını değiştirmez. Depo okunamazsa veya sertifika doğrulanamazsa açık hata gösterilir.

Tasarım ve araştırma kanıtları [docs/verification](docs/verification/README.md) altında. Araştırma raporlarındaki yüzdeler tarihsel ölçümlerdir; uygulama içine gömülmemiştir.
