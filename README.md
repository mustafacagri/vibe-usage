# Vibe Usage

Windows sistem tepsisi ve macOS menü çubuğu için yerel AI abonelik kullanım izleyicisi. Claude Code, Codex, Cursor ve Antigravity kotalarını bu cihazdaki mevcut oturumlardan okur; kalan yüzdeyi ve sıfırlanmaya kalan süreyi gösterir. Bilinmeyen veri tam kota sayılmaz, eksik değer uydurulmaz.

Arayüz 13 dilde çalışır (Ayarlar → Dil).

## Özellikler

- **Kota kartları:** her sağlayıcı için hesap bazında zaman pencereleri ve model kapsamları. Başarısız okumada son ölçüm **eski veri** etiketiyle tutulur.
- **Çoklu hesap:** Claude için birden fazla profil (`~/.claude`, `~/.claude-secondary`, `~/.claude-*` ve ayarlardan eklenen klasörler); Antigravity için çalışan uygulamalardaki e-posta hesapları. Ana hesap ayarlardan seçilir.
- **Akıllı başlatma:** sağlayıcı sıranızda doğrulanmış kotası olan ilk aracı seçilen proje klasöründe yeni bir terminalde açar. Hiçbir aracın kotası doğrulanamazsa bunu açıkça söyler.
- **Görev devri:** seçilen oturumu (Claude Code, Codex, Cursor CLI veya Antigravity) proje klasörüne `VIBE_HANDOVER.md` olarak özetler ve hedef aracı bu brifingi okuyacak bir istemle başlatır. Liste yalnızca o klasörde başlatılmış oturumları gösterir.

Uygulama yalnız mevcut oturumları okur: şifre veya token istemez, token yenilemez, başka uygulamalardan çıkış yaptırmaz ve devam eden işleri değiştirmez. Ayarlar `%APPDATA%/Vibe Usage/settings.json` (Windows) veya `~/Library/Application Support/Vibe Usage/settings.json` (macOS) altında tutulur; gizli bilgi yazılmaz, kotalar yalnız bellekte durur.

## Sağlayıcılar

| Hizmet | Kota kaynağı | Oturum kaynağı (görev devri) | Başlatma |
| --- | --- | --- | --- |
| Claude Code | Profilin OAuth kullanım yanıtı (macOS'ta Keychain) | `~/.claude/projects` | `claude` CLI, seçilen profille |
| Codex | Kurulu CLI'nin app-server kota metotları | `~/.codex/sessions` (sıkıştırılmış kayıtlar dahil, alt ajanlar hariç) | `codex` CLI |
| Cursor | Mevcut oturumun kullanım özeti | Cursor Agent CLI sohbetleri (`~/.cursor/chats`) | `cursor-agent`; yoksa Cursor uygulaması |
| Antigravity | Çalışan uygulamanın yerel servisi (PID ve port sahipliği doğrulanır) | `~/.gemini/antigravity-ide` konuşmaları | Antigravity uygulaması |

Model listeleri araçların kendi verisinden gelir: Claude Code takma adları ve kullanılan modeller, Codex model önbelleği, `cursor-agent --list-models` (24 saat önbelleklenir). Antigravity model argümanı almadığından model seçilmez.

## Terminal

```text
npm run cli -- status [--json]
npm run watch
npm run cli -- run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
npm run cli -- handover [--from SAĞLAYICI] [--to SAĞLAYICI] [--session ID] [--cwd PATH]
```

`run`, doğrulanmış kotası olan hesabı kullanır; yoksa `--account` ile açıkça seçmeniz gerekir. `--dry-run` hangi hesabın ve komutun kullanılacağını gösterir, süreç başlatmaz. CLI, masaüstü uygulamasıyla aynı ayarları ve dili kullanır.

## macOS'ta kurulum

Paket Apple Developer ID ile imzalı olmadığından en sorunsuz yol kaynaktan derlemektir. Gereken tek şey Node.js 24'tür:

```text
git clone <depo adresi> vibe-usage && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

Kendi makinenizde derlenen uygulama karantina işareti taşımaz, doğrudan açılır. Başka bir yerden indirilen `.zip` veya `.dmg` ise ilk açılışta Gatekeeper tarafından engellenir. Bu durumda uygulamaya sağ tıklayıp **Aç**'ı seçin ya da şu komutu çalıştırın:

```text
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

Intel Mac'te klasör adı `release/mac` olur.

## Geliştirme

Kod TypeScript'tir (katı mod, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). Node.js 24 gerekir; bu, Electron 44'ün gömülü sürümüdür. Testler, CLI ve betikler derleme beklemeden Node'un tip ayıklamasıyla doğrudan `.ts` kaynaktan çalışır. Uygulama ise `tsc -b` ile `build/` klasörüne derlenir.

```text
npm ci
npm run lint          # ESLint, tip bilgisiyle (typescript-eslint strictTypeChecked)
npm run format        # Prettier (CI: npm run format:check)
npm run build         # tip denetimi ve sıfırdan build/ çıktısı
npm test              # birim ve entegrasyon testleri, kaynaktan
npm run ui-check      # derlenen arayüzü gerçek preload ve sandbox ile 13 dilde çizer
npm start
npm run build:win
npm run build:mac
```

Kod dört TypeScript projesine ayrılır; her biri yalnız kendi ortamının tiplerini görür:

| Klasör | Ortam | İçerik |
| --- | --- | --- |
| `src/shared` | ortamdan bağımsız | katalog, alan tipleri, IPC sözleşmesi, i18n, biçimlendirme |
| `src/ui` | tarayıcı (DOM) | arayüz; ES modülü olarak yüklenir |
| `src/core`, `src/providers`, `src/main`, `src/cli.ts` | Node / Electron | servis, sağlayıcılar, ana süreç, CLI |
| `test`, `scripts` | Node | yalnız tip denetimi, derlenmez |

Ana süreçteki IPC işleyicileri (`src/main/handlers.ts`) Electron'a bağlı olmadan yazılmıştır; pencere, iletişim kutusu ve zamanlayıcıyı dışarıdan alır ve doğrudan test edilir. Sandbox'lı preload yalnız `electron` modülünü yükleyebildiği için `src/main/preload.cts` CommonJS olarak derlenir; IPC sözleşmesini yalnız tip olarak içe aktarır.

`ui-check` ekran görüntülerini `artifacts/ui-check/` altına yazar; `-- --width=340` ile en dar pencere denenir. Testler gerçek uygulama veya ajan başlatmaz.

`VIBE_DATA_DIR` uygulamanın ayar klasörünü değiştirir. `VIBE_CLAUDE_BINARY`, `VIBE_CODEX_BINARY`, `VIBE_CURSOR_AGENT_BINARY` yerel kurulu ikililerin açık yollarıdır. Kota istekleri yalnız sabit iki adrese gider (Anthropic ve Cursor kullanım uçları); TLS doğrulaması açıktır ve sistem sertifika deposu Node'un varsayılanlarıyla birlikte kullanılır.

Paketlenmiş uygulamada Electron fuse'ları açıktır: `runAsNode`, `NODE_OPTIONS` ve inspector kapalı, ASAR bütünlük doğrulaması açık. Fuse'lar Electron ikilisini değiştirdiği için macOS paketi yeniden imzalanır; geliştirici sertifikası olmadığından imza ad-hoc'tur (`mac.identity: "-"`).

## Sınırlar

- macOS paketi Developer ID ile imzalı ve notarize edilmiş değildir (bkz. [macOS'ta kurulum](#macosta-kurulum)).
- Antigravity oturum modeli belgelenmemiş yerel bir kayıttan okunur; okunamazsa model boş gösterilir.
- Cursor IDE (Composer) sohbetleri devredilmez; yalnız Cursor Agent CLI oturumları okunur.
