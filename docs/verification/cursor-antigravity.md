# Cursor ve Antigravity: gerçek doğrulama

Tarih: 16 Ekim 2026. Windows makinesinde salt okunur komutlar, mevcut oturumla sınırlı kota istekleri ve izin verilen Antigravity tanılama başlangıcı çalıştırıldı. macOS cihazına erişilmedi. Belgelenen özellik, yerelde görülen özellik ve uçtan uca denenmeyen davranış ayrı tutulmuştur.

## Sonuç ve ürünün sunabileceği davranış

| Yetenek | Cursor | Antigravity |
| --- | --- | --- |
| Windows'ta gerçek kota okuma | **Doğrulandı:** mevcut Agent oturumuyla kullanım özeti HTTP 200 | **Doğrulandı:** yüklü masaüstü uygulamasının yerel servisi, özet ve kullanıcı durumu HTTP 200 |
| Native Windows AI CLI | **Kurulu ve çalıştı:** Agent `2026.10.14-0f9edde` | **Resmen destekleniyor**, ancak `agy` PATH'te veya belgelenen varsayılan kurulum dizininde bulunamadı |
| Hesap başına yeni CLI süreci seçmek | `CURSOR_API_KEY` / `--api-key` belgede ve kurulu yardımda var; ikinci anahtarla gerçek iş denenmedi | Google abonelik hesabı seçen belgelenmiş süreç parametresi doğrulanmadı; Gemini API anahtarı ayrı kullanım yoludur |
| Ayrı GUI örneklerinde farklı oturumlar | Destek yanıtı ayrı `--user-data-dir` örnekleri öneriyor; yardım bayrağı doğrulandı; iki gerçek hesapla denenmedi | IDE yardımında aynı genel bayrak var; ortak kimlik katmanını ayırdığı kanıtlanmadı |
| Çalışan GUI görüşmesini başka hesaba kesintisiz geçirmek | Doğrulanmış destek/API yok | Doğrulanmış destek/API yok |
| Kota bitince otomatik hesap geçişi | Kendi başlatıcımızın **yeni** işi farklı Cursor anahtarıyla açması bir uygulama yönüdür; gerçek çok hesaplı failover henüz denenmedi | Yerel kota okuyabilmek başka abonelik hesabını seçebilmeyi kanıtlamaz; otomatik geçiş tamamlandı denemez |
| macOS | Resmi belgeler/açık kaynak kodu incelendi; yerel çalışma testi yok | Resmi belgeler/açık kaynak kodu incelendi; yerel çalışma testi yok |

Bu sonuçlar kota gösteren bir prototipi destekler. Her sağlayıcıda otomatik hesap değiştiren, çalışan görüşmeyi taşıyan ürün tamamlandı anlamına gelmez. Ana hesaba geri dönüş yalnızca sonraki işler için tasarlanabilir; çalışan dosya değiştiren işin başka hesapla otomatik yeniden oynatılması doğrulanmadı.

## Cursor: yerel komut kanıtı

Çalıştırılan komutlar (yalnızca bu belgede kısaltılmış yollar kullanıldı):

```powershell
Get-Command cursor,cursor-agent,agent,antigravity,agy -ErrorAction SilentlyContinue
& "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd" --version
& "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd" --help
& "$env:LOCALAPPDATA\cursor-agent\cursor-agent.ps1" --version
& "$env:LOCALAPPDATA\cursor-agent\cursor-agent.ps1" --help
& "$env:LOCALAPPDATA\cursor-agent\cursor-agent.ps1" status --help
```

Sonuçlar:

- Cursor IDE `3.22.7`, `x64`. IDE yardımında `--user-data-dir`, `--profile`, `--new-window` var.
- Ayrı Agent CLI `2026.10.14-0f9edde`. Yardımında `--api-key` ve `CURSOR_API_KEY`; `status|whoami --format json`; `--resume`, `--continue` var.
- `status --format json` çıktısı bellekte ayrıştırıldı. Sadece alan adları ve boole değerleri yayımlandı: `isAuthenticated=true`, `hasAccessToken=true`, `hasRefreshToken=true`; çıkış kodu `0`. Hesap bilgisi/ham mesaj yayımlanmadı.
- IDE sürüm/yardım komutları sandbox içinde kurulum dizinine `chdir` için `EPERM` uyarısı da verdi, ardından yukarıdaki sürüm ve yardım metnini üretti. Bu gözlemden GUI oturumu izolasyonu sonucu çıkarılmadı.
- Başlangıçta çalışan Cursor süreci bulunmadı. Cursor GUI başlatılmadı; hesap geçişi denenmedi.

[Resmi kurulum belgesi](https://cursor.com/docs/cli/installation) hem macOS/Linux/WSL hem native Windows PowerShell kurulumunu belgeliyor. Bu sürüm için “Cursor Agent yalnızca WSL'de çalışır” sonucu yanlıştır.

[Resmi kimlik belgesi](https://cursor.com/docs/cli/reference/authentication) kullanıcı API anahtarını süreç ortamı veya komut bayrağıyla vermeyi destekliyor. Bu, Models ayarlarındaki harici model sağlayıcısı anahtarıyla aynı kavram değildir. [Cursor destek yanıtı](https://forum.cursor.com/t/feature-request-multi-account-support-fast-account-switching/166689/5) ayrı kullanıcı veri dizinlerinde farklı girişleri koruyan örnekleri öneriyor; aynı açık pencereyi değiştiren native hesap seçici sunulduğunu söylemiyor. `--profile` tek başına hesap izolasyonunun kanıtı değildir.

## Cursor: canlı kullanım yanıtı

Tekrarlanabilir tanılama: [cursor-readonly-quota.ps1](../../scripts/verification/cursor-readonly-quota.ps1).

```powershell
& .\scripts\verification\cursor-readonly-quota.ps1
```

Kurulu Agent kaynak kodunda Windows kimlik yolu `%APPDATA%\Cursor\auth.json` olarak doğrulandı: `versions\2026.10.14-0f9edde\index.js`, `getAuthFilePath`. İlgili mevcut `accessToken` yalnızca bellekte okundu. JWT biçimi, konu alanı ve en az 60 saniye geçerlilik denetlendi; yenileme yapılmadı. [CodexBar'ın kimlik kodu](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Cursor/CursorAppAuth.swift) mevcut tokenı Cursor oturum çerezine dönüştüren biçimi; [kullanım kodu](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Cursor/CursorStatusProbe.swift) kullanım özeti yolu ve alanlarını sağlıyor. Bu özel dashboard yolu, resmi genel bireysel kota API taahhüdü değildir.

İstek yalnızca `GET https://cursor.com/api/usage-summary` hedefine gitti. Yönlendirmeler ve otomatik çerez deposu kapatıldı; zaman aşımı 20 saniye, yanıt sınırı 1 MiB. Kimlik ve ham yanıt yayımlanmadı/kaydedilmedi. Sandbox DNS denemesi `NameResolutionError/HostNotFound` verdi; onaylanan ağ erişimiyle aynı tanılama başarılı oldu. İlk başarılı istek `09:45:43 UTC`; tarih dönüşümünü doğrulayan son istek `09:46:31 UTC`; ikisi de HTTP `200`.

Son başarılı istekte gözlenen alanlar:

| Alan | Tür | Değer |
| --- | --- | --- |
| `membershipType` | string | `pro` |
| `limitType` | string | `user` |
| `isUnlimited` | boolean | `false` |
| `billingCycleStart` | tarih | `2026-10-07T20:30:22Z` |
| `billingCycleEnd` | tarih | `2026-11-07T20:30:22Z` |
| `individualUsage.plan.enabled` | boolean | `true` |
| `individualUsage.plan.used / limit / remaining` | number | `2000 / 2000 / 0` |
| `individualUsage.plan.autoPercentUsed` | number | `14.544444444444443` |
| `individualUsage.plan.apiPercentUsed` | number | `100` |
| `individualUsage.plan.totalPercentUsed` | number | `22.373737373737374` |
| `individualUsage.plan.breakdown.included / bonus / total` | number | `2000 / 9075 / 11075` |
| `individualUsage.onDemand.enabled / used` | boolean / number | `false / 0` |
| `individualUsage.onDemand.limit / remaining` | null | `null / null` |

Görülen tutar alanlarının cents birimi yukarıdaki kullanım kodunda açıklanıyor; yüzdeler tutar alanlarıyla karıştırılmamalı. `remaining=0`, API kapsamı `%100`, Auto kapsamı yaklaşık `%14.54`, toplam kapsam yaklaşık `%22.37` aynı yanıtta birlikte var. Bu yüzden **bütün hesap/model hakları bitti** çıkarımı yapılamaz. Ayrı kapsamlar ve null değerler korunmalı. Bu denemede model bazlı ayrı liste, Grok Bot, ekip bütçesi ve legacy istek uçları sorgulanmadı; tamamının kapsandığı iddia edilmiyor. [Resmi Admin API](https://cursor.com/docs/account/teams/admin-api) ekip yönetim verisidir; bireysel oturum sorgusunun yerine geçmez.

## Antigravity: kurulum ve CLI ayrımı

Yerel dosya/metadata kontrolü:

- `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe`: ürün `2.4.3.0`, dosya `2.4.3`.
- `%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe`: ürün/dosya `2.5.5`; VS Code tabanı ve IDE CLI yardım etiketi `1.107.0`, `x64`.
- `antigravity-ide.cmd --version` ve `--help` çalıştırıldı. Yardımda `--user-data-dir` ve `--profile` var; bu komut ayrı `agy` AI CLI değildir. Aynı sandbox `chdir EPERM` uyarısı görüldü.
- `agy` PATH'te bulunmadı; resmi Windows varsayılanı `%LOCALAPPDATA%\agy\bin` mevcut değil. İlgili `%LOCALAPPDATA%`, `Programs`, `.local\bin` ve Program Files üst dizinleri dar ad filtresiyle kontrol edildi. Diskte başka özel bir konum olmadığı iddia edilmez.
- IDE'nin paketlenmiş `dist\extension.js` kaynağında `getUserStatus`, `--csrf_token`, `--app_data_dir` simgeleri mevcut; aynı dosyada `retrieveUserQuotaSummary` bulunmadı. Sembol varlığı çalışma kanıtı olarak sunulmadı.

[Resmi başlangıç belgesi](https://www.antigravity.google/docs/getting-started/) `agy` için native Windows PowerShell/CMD kurulumunu ve varsayılan dizini, ayrıca macOS kurulumunu açıklıyor. Kurulum yapılmadı. [Resmi kimlik belgesi](https://www.antigravity.google/docs/install/) App/CLI/IDE/SDK arasında ortak giriş ve OS güvenli kimlik deposu kullanımını açıklıyor. Bu nedenle genel IDE profil bayrağının abonelik hesabını bağımsız tuttuğu varsayılamaz.

Aynı kimlik belgesindeki `modelProvider=gemini` + `GEMINI_API_KEY` yolu doğrudan Gemini API kullanımına gider ve Google hesap oturumu kurmaz. Bunu Antigravity abonelik kotaları arasında geçiş veya aynı Claude/GPT erişimi diye sunmak doğru değildir.

## Antigravity: gerçek masaüstü yerel servis denemesi

Tekrarlanabilir tanılama: [antigravity-readonly-quota.ps1](../../scripts/verification/antigravity-readonly-quota.ps1).

```powershell
# Uygulama açıksa yalnızca mevcut servisi arar:
& .\scripts\verification\antigravity-readonly-quota.ps1
# Bu doğrulamada ayrıca açıkça yetkilendirilmiş gizli tanılama başlangıcı:
& .\scripts\verification\antigravity-readonly-quota.ps1 -LaunchApp
```

İlk kontrolde uygulama/IDE/dil sunucusu çalışmıyordu. İzin verilen tanılamada tam doğrulanmış `Antigravity.exe`, `Start-Process -WindowStyle Hidden` ile açıldı. Yalnızca bu kökün yeni alt süreçleri izlenip sabit kurulum yolundaki dil sunucusu seçildi. Komut satırındaki CSRF değeri bellekte kaldı; ham argüman yazdırılmadı. Portlar Windows TCP tablosunda **aynı PID'ye ait dinleyicilerden** bulundu. İstekler sabit `127.0.0.1` adresiyle sınırlı; yönlendirmeler kapalı, 1 MiB yanıt ve kısa süre sınırları var. Yerel kendinden imzalı TLS sertifikası yalnızca bu loopback bağlantısı için kabul edildi.

[CodexBar yerel servis kodu](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Antigravity/AntigravityStatusProbe.swift) aşağıdaki salt okunur yöntemleri ve CSRF başlığını kullanıyor. Bunlar Antigravity'nin belgelenmiş kararlı genel API'si değildir. [Özet parserı](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Antigravity/AntigravityQuotaSummaryParser.swift) doğrudan, iç içe ve oneof oran biçimlerini destekliyor.

İki sınırlı başlangıç yapıldı: `09:48:52 UTC` ilk denemesinde özet HTTP 200 verdi; ilk parser yalnızca iç içe oranı aradığı için ölçüm doğrulanmadı. Parser düz alanı da kapsayacak şekilde düzeltildi. `09:50:37 UTC` son denemesinde:

- Başlangıçta ilgili süreç sayısı `0`; uygulama altında doğrulanan yeni süreç sayısı `6`; CSRF bayrağı mevcut; dil sunucusuna ait dinleyici sayısı `2`.
- Bir dinleyicide HTTPS protokol denemeleri başarısız oldu; diğerinde `RetrieveUserQuotaSummary` ve `GetUserStatus` ayrı ayrı HTTP `200` döndü.
- Gerçek özet yolu `response.groups[0].buckets[0/1].remainingFraction`: tür `number`, doğrudan alan. Yanıtta **bir grup, iki kova** gözlendi.

| Kaynaktan gelen grup | Kaynaktan gelen dönem | Kalan oran | Reset (UTC) |
| --- | --- | --- | --- |
| `Claude and GPT models` | `weekly` | `1` (%100) | `2026-10-23T09:50:40Z` |
| `Claude and GPT models` | `5h` | `1` (%100) | `2026-10-16T14:50:40Z` |

`GetUserStatus` aynı serviste hesap kimlik alanı içeriyordu; değeri bastırıldı. `userStatus.cascadeModelConfigData.clientModelConfigs[0..2].quotaInfo.remainingFraction` üç sayısal kayıtla `1` döndü ve her kayıtta reset vardı. Özet ile model kayıtları üst üste eklenip yeni hak yaratılmadı. Bu yanıtta Gemini grubu görülmedi; uydurma Gemini satırı eklenemez. Bunlar gerçek ölçüm alanlarıdır; geçmiş tüketim, tükenme veya failover denemesi değildir.

Her denemenin sonunda yalnızca tanılamanın başlattığı, PID + başlangıç zamanı + tam çalıştırılabilir dosyası yeniden doğrulanan altı süreç kapatıldı. Sonrasında kalan ilgili süreç kontrolü yapıldı. Başkalarına ait süreç kapatılmadı. Tanılama kimlik dosyası yazmadı; native uygulama normal başlangıcında kendi cache/oturum işlemlerini yapabilir, bunların değişmediği ayrıca kanıtlanmış değildir. Giriş/çıkış, hesap değiştirme, model promptu ve kota tüketen inference gönderilmedi.

[Resmi statusline belgesi](https://antigravity.google/docs/cli/statusline/) model/kova anahtarlı `quota` alanını, kalan oranı ve reset alanlarını belgeliyor; [resmi `/usage` belgesi](https://www.antigravity.google/docs/cli/commands/usage) kota panelinin backend verisini yenilediğini açıklıyor. Kurulu `agy` bulunmadığı için bu iki CLI arayüzünün Windows çalışma davranışı burada test edilmedi. [CodexBar notlarındaki](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md) CLI sürümüne bağlı CSRF ve kapsam farkları da genel API garantisi değildir.

## Açık doğrulama sınırları

1. İkinci Cursor/Antigravity hesabıyla kota okuma, hesap izolasyonu ve ana hesap önceliği denenmedi. Tek hesapta çalışan kota isteği çok hesaplı ürünü kanıtlamaz.
2. Gerçek kota tükettirme, model isteği ve 429 üretme yapılmadı. Sağlayıcının hata sınıfları ve geçişte ücretlendirme devamı doğrulanmadı.
3. Cursor API anahtarını yeni süreçte seçme mekanizması belgelidir; iki hesapla başlatma, otomatik failover ve görüşme taşıma uçtan uca denenmedi.
4. Antigravity'de mevcut masaüstü hesabının kotaları okunabildi. Farklı abonelik hesaplarını paralel seçen kararlı bir resmi CLI/GUI arayüzü doğrulanmadı.
5. Açık GUI'nin hesabını veya devam eden görüşmesini değiştirmenin güvenli, kesintisiz bir yolu gösterilmedi. Veri dosyası/kimlik deposu kopyalamak veya üzerine yazmak çözüm olarak denenmedi/önerilmedi.
6. macOS'ta kurulum, güvenli depo, izinler, yerel port keşfi, çok hesap ve failover testleri yapılmadı. İki platformda uçtan uca tamamlandı denemez.

Bağlantılar 16 Ekim 2026 tarihinde incelendi. GitHub `main` bağlantıları değişebilir; bu dosyadaki kurulu sürüm ve canlı yanıt bilgileri bu çalışmanın zamanına aittir.
