# Claude Code: hesap, kota ve geçiş doğrulaması

Tarih: 16 Ekim 2026. Platform: bu çalışma ortamındaki Windows. Kurulu CLI: `C:\Users\musta\.local\bin\claude.exe`, **2.1.301**. **Güncel durum (10:03 UTC): kullanıcı ikinci profilin girişini tamamladı; iki farklı Claude kullanıcı hesabı salt okunur kontrollerle doğrulandı ve her ikisinin kotası HTTP 200 ile okundu.** Varsayılan `.claude` Team; `.claude-secondary` Pro. Kullanıcı/kuruluş kimlikleri yalnızca bellekte karşılaştırıldı, iki kimlik dosyasının hashleri kontrol öncesi/sonrası aynı kaldı. macOS, kimlik yenileme ve limitte otomatik geçiş çalıştırılmadı. Üretim widget/başlatıcı kodu geliştirilmedi.

Giriş kullanıcı tarafından yapıldı. Bot giriş/çıkış, token yenileme veya model isteği çalıştırmadı. Rapordaki “tek profil” keşfi ve 09:44 kota ölçümü girişten önceki tarihsel durumu anlatır; güncel iki hesap kanıtı aşağıdaki son bölümde bulunur.

Etiketler: **Belge** = sağlayıcının yayımladığı davranış; **Windows canlı** = aşağıdaki komutla burada gözlenen sonuç; **Kaynak** = entegrasyonun kendi kodunun incelenmesi; **Doğrulanmadı** = çalıştırma veya hesap kanıtı yok. Bunlar birbirinin yerine geçmez.

## Kanıt matrisi

| Konu | Kanıt ve sonuç | Sınır |
| --- | --- | --- |
| CLI kurulumu | **Windows canlı:** `--version` → `2.1.301 (Claude Code)`; çıkış 0. | macOS sürümü/kurulumu sınanmadı. |
| Ayrı hesap seçimi | **Belge:** başlangıçta hesap başına `CLAUDE_CONFIG_DIR`; ayrı ayarlar, geçmiş ve claude.ai girişleri. [Çok hesap](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts). **Windows canlı:** A/B/A signed-in bayrakları true; iki profil GET'inde kullanıcı UUID'leri farklı. | Kimlik yenileme, macOS ve model isteğiyle doğru hesaba yönlendirme sınanmadı. |
| Yeniden giriş | **Belge:** yeni dizinde ilk çalıştırma giriş ve kurulum ister. Aynı dizini tekrar seçmek her geçişte `/logout` gerektiren bir iş akışı değildir. [Kimlik doğrulama](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts). | Süresi dolan/iptal edilen girişin yenilenmesi sınanmadı. |
| Windows kimlik deposu | **Belge:** varsayılan `.credentials.json` kullanıcı profilinde; `CLAUDE_CONFIG_DIR` dosyanın konumunu değiştirir. [Kimlik deposu](https://code.claude.com/docs/en/authentication#credential-management). **Windows canlı:** boş dizin signed-out; sonrasında iki gerçek profilde A/B/A durum ve ayrı kimlik/kota okuması başarılı. | İki dosyanın hashleri değişmedi; refresh veya giriş yazımı bot tarafından sınanmadı. |
| macOS kimlik deposu | **Belge:** Keychain girdisi config dizinine göre ayrılır; Keychain yazımı başarısızsa aynı dizinde dosya geri dönüşü bulunur. [Kimlik deposu](https://code.claude.com/docs/en/authentication#credential-management). | Keychain izinleri, ilk giriş ve iki hesap bir Mac'te sınanmadı. |
| Console istisnası | **Belge:** API anahtarı oluşturmayan Console girişleri config dışında tutulur; iki böyle giriş dizinlerle ayrılmaz. [Çok hesap](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts). | claude.ai abonelik profilleriyle aynı destek etiketi verilmemeli. |
| Güncel oturum | **Windows canlı:** A/B/A loggedIn=true/true/true; planlar team/pro/team. Profil API'sinde distinctUserAccounts=true ve distinctOrganizations=true. | Plan farkı veya token farkı tek başına farklı kullanıcı kanıtı sayılmadı; kullanıcı UUID'si karşılaştırıldı. |
| İkinci hesap | **Windows canlı:** ilk keşifte yoktu; kullanıcı girişinden sonra `.claude-secondary` mevcut, signed-in ve varsayılandan farklı kullanıcıya ait. | İlk keşif sonucu bugünkü son durum olarak sunulmamalı. |
| Gerçek kota okuması | **Windows canlı:** iki profilin mevcut erişim bilgileriyle birer GET; ikisi HTTP 200. [Tekrar çalıştırılabilir kontrol](../../scripts/verification/claude-usage-readonly.ps1). | Bu iki hesabın anlık yanıtları; genel API kararlılığı veya otomatik geçiş garantisi değil. |
| Fable | **Windows canlı:** `limits` içinde `weekly_scoped`, Fable model kapsamı, percent=0, is_active=false. **Kaynak:** aynı şekil [parser testinde](https://github.com/steipete/CodexBar/blob/main/Tests/CodexBarTests/ClaudeOAuthTests.swift#L170) de mevcut. | Fable kaydının bulunması model erişiminin/ücretsiz kullanımın uçtan uca sınandığı anlamına gelmez. |
| Statusline | **Belge:** `five_hour`/`seven_day` yüzdeleri ve reset alanları; alanlar ilk API yanıtından sonra, Pro/Max veya uygun gateway'de gelebilir. [Statusline](https://code.claude.com/docs/en/statusline#available-data). | Model kapsamlı Fable kaydı belgelenen şemada yok; mevcut Team hesabında statusline sınanmadı. |
| Kota dolunca hesap rotasyonu | **Belge:** `--fallback-model` modeli değiştirir; rate-limit, auth ve billing hataları bu geçişi tetiklemez. [Fallback zincirleri](https://code.claude.com/docs/en/model-config#fallback-model-chains). **Doğrulanmadı:** hesaplar arası otomatik rotasyon. | Yardım çıktısının başarılı olması veya HTTP 200 kotanın bitişinde geçişi kanıtlamaz. |
| Çalışan terminalin hesabı | **Belge:** config seçimi başlatırken yapılır. İncelenen auth/CLI belgelerinde çalışan süreci başka hesaba otomatik devreden bir arayüz doğrulanmadı. | Canlı görüşmeye kesintisiz hesap değiştirme vaat edilmemeli; teknik olarak imkânsız olduğu da iddia edilmiyor. |
| Görüşmeyi sürdürme | **Belge:** `--continue`, `--resume`, `--fork-session`; `--resume` mutlak `.jsonl` yolu kabul eder. [CLI referansı](https://code.claude.com/docs/en/cli-reference#cli-flags). | Ayrı config dizininde başka hesabın geçmişini bulma ve o hesapla sürdürme çalıştırılmadı. Girdi biçiminin belgelenmesi taşınabilirlik testi değildir. |

## Çalıştırılan güvenli kontroller

Bot kimlik, ayar veya token değiştiren komut kullanmadı. Bot giriş/çıkış, token yenileme, çıkarım isteği veya kota tüketme çalıştırmadı; doğrulama alt süreçlerinde config seçildi ve süreç ortamı sonunda geri yüklendi. Kullanıcı daha sonra ikinci profilin girişini kendisi tamamladı. `auth status` ham çıktısı dosyaya yazılmadı; bellekte ayrıştırılıp yalnızca aşağıdaki alanlar yazdırıldı. İlk boş config denemesi yeni geçici dizinde yapıldı; komut orada iki geçici öğe oluşturdu. Bu kontrolün sıfır dosya yazdığı iddia edilmiyor.

### Kurulum ve komut yüzeyi

```powershell
& 'C:\Users\musta\.local\bin\claude.exe' --version
& 'C:\Users\musta\.local\bin\claude.exe' --help
& 'C:\Users\musta\.local\bin\claude.exe' auth --help
& 'C:\Users\musta\.local\bin\claude.exe' auth status --help
& 'C:\Users\musta\.local\bin\claude.exe' auth login --help
```

Hepsi çıkış 0. `auth` yardımında login/logout/status; status yardımında varsayılan JSON ile `--text` mevcut. Ana yardımda `--continue`, `--resume`, `--fork-session`, `--fallback-model`, `--name` bulundu. `--name` terminal başlığında ve oturum seçicide görünmek için tanımlanıyor. Bu yardım kontrolleri kimlik izolasyonunu veya geçişi sınamaz.

Ek dar kontrolde `auth login --help`, `Usage: claude auth login [options]` ve “Sign in to your Anthropic account” açıklamasını verdi. Seçenekler: `--claudeai` (abonelik, varsayılan), `--console` (API kullanım ücretlendirmesi), `--email <email>` (giriş sayfasındaki e-posta alanını önceden doldurma), `--sso` (SSO akışını zorunlu tutma), `-h/--help`. Yalnızca yardım çalıştırıldı; OAuth/giriş veya model isteği başlatılmadı.

### Mevcut hesabın durumunu kimlik bilgisi yazdırmadan okuma

```powershell
$claudePath = 'C:\Users\musta\.local\bin\claude.exe'
$rawStatus = & $claudePath auth status --json 2>$null
$statusExit = $LASTEXITCODE
try {
    $authStatus = ($rawStatus -join [Environment]::NewLine) | ConvertFrom-Json
    [pscustomobject]@{
        exitCode = $statusExit
        loggedIn = $authStatus.loggedIn
        authMethod = $authStatus.authMethod
        apiProvider = $authStatus.apiProvider
        subscriptionType = $authStatus.subscriptionType
    } | ConvertTo-Json -Compress
} finally {
    Remove-Variable rawStatus,authStatus -ErrorAction SilentlyContinue
}
```

Sonuç:

```json
{"exitCode":0,"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"team"}
```

Ayrı boolean kontrolde süreç ortamındaki `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` ve `ANTHROPIC_PROFILE` geçersiz kılmaları **false** çıktı. Değerleri yazdırılmadı. Bu kontrol bütün olası kurumsal kimlik yapılandırmalarının yokluğunu kanıtlamaz.

### Boş profil, sonra varsayılan profil

```powershell
$scratchConfig = Join-Path ([IO.Path]::GetTempPath()) ('claude-verification-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $scratchConfig)
$savedConfigOverride = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR','Process')
try {
    $env:CLAUDE_CONFIG_DIR = $scratchConfig
    $rawStatus = & $claudePath auth status --json 2>$null
    $statusExit = $LASTEXITCODE
    $authStatus = ($rawStatus -join [Environment]::NewLine) | ConvertFrom-Json
    [pscustomobject]@{
        scenario = 'new-empty-config-directory'
        exitCode = $statusExit
        loggedIn = $authStatus.loggedIn
        authMethod = $authStatus.authMethod
        apiProvider = $authStatus.apiProvider
        subscriptionType = $authStatus.subscriptionType
        scratchEntryCount = @(Get-ChildItem -LiteralPath $scratchConfig -Force).Count
    } | ConvertTo-Json -Compress
} finally {
    [Environment]::SetEnvironmentVariable('CLAUDE_CONFIG_DIR',$savedConfigOverride,'Process')
    if (@(Get-ChildItem -LiteralPath $scratchConfig -Force).Count -eq 0) {
        Remove-Item -LiteralPath $scratchConfig
    }
    Remove-Variable rawStatus,authStatus -ErrorAction SilentlyContinue
}
# Ardından önceki bölümdeki varsayılan profil allowlist kontrolü tekrar çalıştırıldı.
```

Boş dizin sonucu: çıkış **1**, loggedIn=false, authMethod=none, apiProvider=firstParty, subscriptionType=null. Varsayılan dizine dönüldüğünde önceki signed-in sonucu tekrar alındı. Aktif hesabın dışarı taşınmadığına dair bu dar negatif kontrol başarılı; ikinci bir hesabın girişini ve refresh davranışını kapsamaz.

### İlk yetkili gerçek kota GET'i (09:44 UTC; tarihsel)

```powershell
& '.\scripts\verification\claude-usage-readonly.ps1'
```

Betik mevcut `.credentials.json` içindeki claude.ai erişim bilgisini yalnızca bellekte kullanır; yalnızca `https://api.anthropic.com/api/oauth/usage` adresine tek GET gönderir. HTTPS yönlendirmeleri kapalı, zaman aşımı 15 saniye, yanıt sınırı 1 MiB; tekrar deneme ve token yenileme yok. Çıktı allowlist ile sınırlı; ham yanıt, token, e-posta veya kurum kimliği kaydedilmez.

| Deneme | Gözlem | Yorum |
| --- | --- | --- |
| Kısıtlı sandbox, 09:44:09 UTC | HTTP durumu yok; HttpRequestException. | Sunucu yanıtı alınmadı. |
| Hata sınıfını daraltan tekrar, 09:44:26 UTC | İç hata SocketException / HostNotFound. | Kısıtlı ortamın DNS/ağ erişimi; kota veya kimlik reddi değil. |
| Onaylı sandbox dışı tekrar, **09:44:34 UTC** | **HTTP 200**, outcome=quota_read_succeeded. | Gerçek oturumla kota okundu. |

İlk başarılı yanıttan güvenli sayısal alanlar (09:44:34 UTC; daha sonraki iki hesap ölçümü son bölümde):

| Alan | Ölçüm |
| --- | --- |
| `five_hour.utilization` | 81.0 kullanılan; aynı payda için 19.0 kalan hesaplanabilir |
| `five_hour.resets_at` | `2026-10-16T13:59:59.680502+03:00` |
| `limits` kayıt sayısı | 2 |
| Kayıt türleri | session: 1; weekly_scoped: 1 |
| Fable model kapsamlı kayıt | Var |
| Fable `percent` | 0 |
| Fable `resets_at` | `2026-10-18T16:00:00+03:00` |
| Fable `is_active` | false |
| `extra_usage` | Nesne mevcut; bakiye/harcama değeri bu kontrolde çıkarılmadı |

Bu yanıtta `seven_day`, `seven_day_opus`, `seven_day_sonnet` anahtarları bulunmasına rağmen standardWindows listesine ölçüm vermediler. Yalnızca anahtarın bulunmasını dolu kota kabul etmek hatalı olur. `limits` içindeki Fable kaydı ayrıca incelendi. Kaydedilen değerler bu zaman damgasına ait, güncel widget verisi değildir. HTTP 429 ile karşılaşılsaydı kota okuma uç noktasının kısıtlanması ile model kullanım hakkının bitmesi ayrı değerlendirilmeliydi.

## Kota şemasının kapsamı

[Resmi statusline şeması](https://code.claude.com/docs/en/statusline#available-data), kullanılan yüzde ve reset zamanını açıklar. Dönemler birbirinden bağımsız eksik kalabilir; reset geçince alan kaldırılabilir. Bağlam penceresi doluluğu hesap kotası değildir. Burada ilk model isteği gönderilmediğinden statusline çıktısı yakalanmadı.

[CodexBar'ın kendi entegrasyon belgesi](https://github.com/steipete/CodexBar/blob/main/docs/claude.md#oauth-api-preferred) OAuth usage uç noktasını ve gerekli profil kapsamını açıklıyor; bu, Anthropic'in kararlı genel kota API'si taahhüdü değil. [Fetcher kaynağı](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift#L992) model adı/id, yüzde ve reset alanlarını dinamik kayıtlardan eşliyor ve `is_active` alanını filtre olarak kullanmıyor. Kod ve [fixture](https://github.com/steipete/CodexBar/blob/main/Tests/CodexBarTests/ClaudeOAuthTests.swift#L170) incelendi; Swift test paketi burada çalıştırılmadı. Windows'ta alınan gerçek yanıt aynı model kapsamı biçimini bağımsız olarak doğruladı.

[Resmi Fable açıklamasına](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan) göre Max ve belirtilen premium koltuklarda Fable ortak haftalığın bir kısmını kullanır; Pro ve belirtilen standart koltuklarda kullanım kredileri gerekir. Ortak haftalık ile Fable yüzdesi toplanıp yeni bir toplam oluşturulmaz. Buradaki `team` plan etiketi premium/standart ayrımını göstermediğinden ücretsiz Fable erişimi sonucu çıkarılmadı.

## Üründe uygulanabilir davranış ve açık kanıtlar

Başlatıcının yeni bir Claude Code sürecine seçilen config dizinini vermesi belgelenmiş entegrasyon yolu. Hesaplar ilk kez her cihazda ayrı bağlanır; kullanıcı etiketleri ve öncelik sırası saklanabilir. Mevcut doğrulama widget'ta bu iki Windows hesabının dinamik kota kayıtlarını ayrı göstermek için veri yolunun çalıştığını kanıtlıyor. Bu erişimin üretim uygulamasından, imzalı paket içinden ve macOS Keychain üzerinden çalışması ayrıca doğrulanmalı.

Önerilen başlatıcı politikası: yeni işe başlamadan önce seçili model için mevcut bütün ilgili kayıtları değerlendir; veri eksik/eskiyse “kapsam doğrulanamadı” göster. İlk uygun hesabı seçerek yeni terminal süreci başlatma, uygulama tarafından geliştirilecek bir davranış. Gerçek kota reddinden sonra bir görevi otomatik yeniden oynatma, dosya işlemlerini iki kez yapabileceğinden bu doğrulama kapsamına alınmadı. Ana hesap yenilenince yeni işleri ona yönlendirme de henüz üretim kodu veya uçtan uca test değildir.

Terminalde mevcut Claude Code arayüzü çalışabilir; hesap etiketi başlatıcının kısa başlangıç satırında ve `--name` ile oturum başlığında gösterilebilir. Widget bu terminalden ayrı bir pencere olabilir. Örnek yalnızca önerilen görünüm:

```text
Vibe · Claude · İş hesabı · Fable · ölçüm 2 dakika önce
Claude Code başlatılıyor…
[Kurulu Claude Code'un normal etkileşimli arayüzü]
```

Doğrulamayı tamamlamak için eksik olan kanıtlar:

1. **Kimlik yenileme:** Windows'ta iki farklı hesabın A/B/A durumu ve ayrı kota okuması artık doğrulandı. Süresi dolan kimliğin doğru profil kapsamında yenilenmesi sınanmadı; bot token yenilemedi.
2. **macOS:** aynı A/B/A testi, Keychain erişimi ve yeniden başlatma; mevcut belgeler işletim sisteminde çalıştırılmış test yerine geçmez.
3. **Görüşme sürekliliği:** kullanıcı tarafından seçilen zararsız bir oturumun diğer hesapla `--resume` davranışı; erişim, araç izni ve dosya işlemlerinin tekrarlanmaması. Bu turda oturum başlatılmadı.
4. **Gerçek geçiş:** zaten doğal olarak limitte olan A ve uygun B ile yeni iş yönlendirme; model isteği/harcama için açık kapsam. Kota kasıtlı tüketilmedi; otomatik rotasyon başarı iddiası yok.
5. **Uygulama yüzeyi:** Claude Desktop'ın açık penceresinin hesabını bu başlatıcıdan canlı değiştiren destekli entegrasyon doğrulanmadı. CLI hesabı seçebilmek Desktop hesabını değiştirdiğini kanıtlamaz.

Raporun kontrolü: betik PowerShell parser'ında sıfır hata verdi ve gerçek GET ile çalıştırıldı. Yanıt hataları betikte güvenli `outcome`/`httpStatus` alanlarıyla raporlanır; PowerShell sürecinin sıfır çıkışı tek başına kota okuma başarısı sayılmaz.

## İkinci hesap için ilk hedefli yerel keşif (kullanıcı girişinden önce)

Kullanıcı iki Claude hesabının bulunduğunu, burada ayrı profil olarak tutulup tutulmadığını bilmediğini belirttikten sonra yapılan ek kontrol. Yalnızca sağlayıcıya ait bilinen yerel konumların varlığı ve üst düzey dizin metadata'sı incelendi. Kişisel belgeler, proje geçmişleri, tarayıcı çerezleri ve yedek kimlik bilgileri açılmadı; genel dosya sistemi araması yapılmadı.

| Hedef | Gerçek sonuç |
| --- | --- |
| Kullanıcı ana dizinindeki hemen alt `.claude*` dizinleri | Yalnızca `.claude` |
| `.claude` içinde `.credentials.json`, `settings.json`, `projects` | Üçü de mevcut; bu kontrolde içerikleri açılmadı |
| Süreçte `CLAUDE_CONFIG_DIR` | Ayarlanmamış |
| `.claude/profiles` | Yok |
| `.claude/accounts` | Yok |
| `.claude-swap-backup` | Yok |
| `.claude-swap-backup/sessions` | Yok; dolayısıyla alt profil bulunmadı |
| PATH'te `claude-swap`, `claude-switch`, `cc-switch`, `ccs` | Hiçbiri bulunmadı; program çalıştırılmadı |
| Keşif sonrası varsayılan `auth status --json` | Çıkış 0; loggedIn=true, authMethod=claude.ai, subscriptionType=team |

Kullanılan salt okunur keşif komutları:

```powershell
$profileRoots = @(Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Force -Filter '.claude*' -ErrorAction SilentlyContinue)
$profileRoots | ForEach-Object {
    [pscustomobject]@{
        alias = $_.Name
        hasCredentialFile = Test-Path -LiteralPath (Join-Path $_.FullName '.credentials.json') -PathType Leaf
        hasSettingsFile = Test-Path -LiteralPath (Join-Path $_.FullName 'settings.json') -PathType Leaf
        hasProjectsDirectory = Test-Path -LiteralPath (Join-Path $_.FullName 'projects') -PathType Container
    }
} | ConvertTo-Json -Compress

$sessionRoot = Join-Path $env:USERPROFILE '.claude-swap-backup\sessions'
Test-Path -LiteralPath $sessionRoot -PathType Container

@('.claude\profiles', '.claude\accounts', '.claude-swap-backup') | ForEach-Object {
    [pscustomobject]@{
        alias = $_
        exists = Test-Path -LiteralPath (Join-Path $env:USERPROFILE $_) -PathType Container
    }
} | ConvertTo-Json -Compress

@('claude-swap', 'claude-switch', 'cc-switch', 'ccs') | ForEach-Object {
    [pscustomobject]@{
        command = $_
        available = [bool](Get-Command -Name $_ -ErrorAction SilentlyContinue)
    }
} | ConvertTo-Json -Compress
```

Bu sınırlı ilk keşifte **bir kaydedilmiş ve giriş yapılmış CLI profili** bulunmuştu. O anda karşılaştırılacak ikinci meşru config/kimlik kaynağı bulunmadığından iki farklı hesabın hazır olduğu doğrulanamamıştı. Aynı hesabın yedek kopyasını ikinci hesap saymak veya tarayıcı hesabını CLI profili kabul etmek doğru olmaz. Kullanıcı daha sonra aşağıdaki ayrı profil girişini tamamladı; sonraki bölüm güncel doğrulamadır.

İlk keşif sonrasında önerilen en küçük kurulum, ayrı bir terminalde ikinci hesaba ait config diziniyle `auth login --claudeai` kullanmaktı. Etkileşimli görüşmeyi açan yalın `claude` yerine kurulu sürümün yardımında doğrulanan giriş komutu kullanılıyor. Varsayılan hesaptan çıkış gerekmez. Aşağıdaki komutları **bot çalıştırmadı**; kullanıcı ayrı profilin girişini tamamladığını bildirdi ve sonrasında gerçek kontrol yapıldı:

```powershell
# Yeni ve ayrı bir terminalde; mevcut varsayılan Claude terminalinde değil.
$env:CLAUDE_CONFIG_DIR = Join-Path $env:USERPROFILE '.claude-secondary'
& 'C:\Users\musta\.local\bin\claude.exe' auth login --claudeai
```

Planlanan kontrol A/B/A durum okuması, kimlikleri yalnızca bellekte karşılaştırma ve iki ayrı kota GET'iydi. Bunlar kullanıcı girişinden sonra aşağıda tamamlandı. Bot giriş/çıkış, token yenileme veya çıkarım çalıştırmadı. İki hesabın bağlanması otomatik geçiş deneyinin tamamlandığı anlamına gelmez.

## Kullanıcı girişinden sonra iki gerçek hesap doğrulaması (10:02–10:03 UTC)

Yalnızca `C:\Users\musta\.claude` ve `C:\Users\musta\.claude-secondary` kontrol edildi. A/B/A alt süreç ortamında sırasıyla bu dizinleri seçerek `auth status --json` çalıştırıldı; süreçteki önceki `CLAUDE_CONFIG_DIR` sonunda geri yüklendi. Ham durum JSON'u ve kimlikler yazdırılmadı. Sonuç:

```json
{"a1LoggedIn":true,"bLoggedIn":true,"a2LoggedIn":true,"a1Plan":"team","bPlan":"pro","a2Plan":"team","defaultCredentialUnchanged":true,"secondaryCredentialUnchanged":true}
```

`auth status` şemasında e-posta/kuruluş alanları vardı ancak karşılaştırılabilir kullanıcı kimliği doldurulmamıştı. Dolayısıyla ilk denemedeki `distinctAccounts=false`, “aynı hesap” sonucu değildi; yanında `identityComparisonAvailable=false` vardı. Planların Team/Pro olması veya tokenların farklı olması kullanıcı ayrımı için yeterli kabul edilmedi.

Bu boşluğu kapatmak için [profil karşılaştırma betiği](../../scripts/verification/claude-profile-compare.ps1) çalıştırıldı. Her config için mevcut kimlik bilgisiyle **bir GET**, tam `https://api.anthropic.com/api/oauth/profile` adresine gönderildi; yönlendirmeler kapalı, 15 saniye/1 MiB sınırı, token yenileme yok. Yanıtlar bellekte tutuldu; `account.uuid` değerleri kullanıcı ayrımı, `organization.uuid` değerleri ayrı kuruluş ayrımı için karşılaştırıldı. UUID/e-posta/token veya ham yanıt çıktısı yok. 10:02:40 UTC sonucu:

```json
{"defaultHttpStatus":200,"secondaryHttpStatus":200,"userIdentityComparisonAvailable":true,"distinctUserAccounts":true,"organizationComparisonAvailable":true,"distinctOrganizations":true,"defaultCredentialUnchanged":true,"secondaryCredentialUnchanged":true,"outcome":"profile_comparison_completed"}
```

Bu sonuç iki farklı Claude kullanıcı hesabını ve farklı kuruluş bağlamlarını doğrular. Yalnızca farklı kuruluşta bulunan aynı kullanıcıya “iki farklı kullanıcı” denmedi. Profil GET yolu [entegrasyonun kendi kaynak açıklamasında](https://github.com/steipete/CodexBar/blob/main/docs/claude.md#oauth-api-preferred) da mevcut; canlı başarı, sağlayıcının kararlı genel API taahhüdü olarak sunulmuyor.

Sonrasında her configte mevcut [salt okunur kota betiği](../../scripts/verification/claude-usage-readonly.ps1) birer kez çalıştırıldı. Ortam sonunda geri yüklendi; iki `.credentials.json` dosyasının SHA-256 değerleri bellekte önce/sonra karşılaştırıldı ve yalnızca `unchanged=true` sonuçları yazdırıldı. 10:03:16 UTC ölçümleri:

| Ölçüm | A: varsayılan / Team | B: secondary / Pro |
| --- | --- | --- |
| HTTP | 200 | 200 |
| `five_hour.utilization` | %90 kullanılan; %10 kalan | %0 kullanılan; %100 kalan |
| `five_hour.resets_at` | `2026-10-16T14:00:00.489069+03:00` | `null`; yenilenme zamanı çıkarılmadı |
| `seven_day.utilization` | Ölçüm yok | %14 kullanılan; %86 kalan |
| `seven_day.resets_at` | Ölçüm yok | `2026-10-18T17:00:00.083343+03:00` |
| Dinamik kayıtlar | 2: session + weekly_scoped | 2: session + weekly_all |
| Fable kapsamlı kayıt | Var; percent=0, is_active=false | Yanıtta yok |
| Fable reset | `2026-10-18T16:00:00+03:00` | Yok |
| `extra_usage` nesnesi | Var; tutarlar bu kontrolde okunmadı | Var; tutarlar bu kontrolde okunmadı |
| Kimlik dosyası değişmedi | true | true |

Pro yanıtında Fable kaydının bulunmaması %0 veya sınırsız Fable kotası olarak gösterilmez. Resmi plan açıklamasındaki kullanım kredileri ayrımı korunur; kredi tutarları bu denemede doğrulanmadı. Varsayılan hesabın genel haftalık ölçümü eksik olduğundan uydurma ortak haftalık yüzde üretilmez. İki ölçüm aynı anda bütün hesapların limitini rezerve etmez; bunlar belirtilen andaki gözlemlerdir.

**Doğrulanan sınır:** iki farklı Windows CLI hesabının birlikte kaydedilmiş olması, A/B/A durum okuması, ayrı kullanıcı/kuruluş kimlikleri ve iki ayrı gerçek kota okuması. **Hâlâ doğrulanmayan:** macOS, OAuth refresh izolasyonu, model isteğinin faturalama yönlendirmesi, hesaplar arası görüşme sürdürme, çalışan terminalin canlı hesap değişimi ve limitte otomatik rotasyon. Kullanıcı girişini yaptı; bot yalnızca durum/kimlik/kota okudu.
