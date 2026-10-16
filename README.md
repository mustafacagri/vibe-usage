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

## Geliştirme

Node.js 24 gerekir (Electron 44'ün gömülü sürümü).

```text
npm ci
npm run lint      # ESLint
npm run format    # Prettier (CI: npm run format:check)
npm test          # birim ve entegrasyon testleri
npm run ui-check  # gerçek arayüzü 13 dilde örnek veriyle çizer; konsol/CSP hatası,
                  # ekranda kalan çeviri anahtarı ve taşan değerleri yakalar
npm start
npm run build:win
npm run build:mac
```

`ui-check` ekran görüntülerini `artifacts/ui-check/` altına yazar; `--width=340` ile en dar pencere denenir. Testler gerçek uygulama veya ajan başlatmaz.

`VIBE_DATA_DIR` uygulamanın ayar klasörünü değiştirir. `VIBE_CLAUDE_BINARY`, `VIBE_CODEX_BINARY`, `VIBE_CURSOR_AGENT_BINARY` yerel kurulu ikililerin açık yollarıdır. Kota istekleri yalnız sabit iki adrese gider (Anthropic ve Cursor kullanım uçları); TLS doğrulaması açıktır ve sistem sertifika deposu Node'un varsayılanlarıyla birlikte kullanılır.

Paketlenmiş uygulamada Electron fuse'ları açıktır (`runAsNode`, `NODE_OPTIONS` ve inspector kapalı; ASAR bütünlük doğrulaması açık). Fuse'lar Electron ikilisini değiştirdiği için macOS paketi yeniden imzalanmalıdır; geliştirici sertifikası olmadığından imza ad-hoc'tur (`mac.identity: "-"`).

## Sınırlar

- Paket Developer ID ile imzalı değildir (yalnız ad-hoc imza); macOS notarizasyonu yapılmadı, bu yüzden başka bir Mac'te ilk açılışta Gizlilik ve Güvenlik onayı gerekir.
- Windows'ta terminal başlatma ve Cursor/Antigravity uygulama yolları (`%LOCALAPPDATA%\Programs`) kod düzeyinde desteklenir, bu sürümde Windows cihazında yeniden doğrulanmadı.
- Antigravity oturum modeli belgelenmemiş yerel bir kayıttan okunur; okunamazsa model boş gösterilir.
- Cursor IDE (Composer) sohbetleri devredilmez; yalnız Cursor Agent CLI oturumları okunur.
