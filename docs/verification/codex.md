# Codex: Windows üzerinde gerçek doğrulama

16 Ekim 2026. Kurulu CLI: **codex-cli 0.147.0**. Bu çalışma bir üretim uygulaması veya iki hesap arasında geçiş deneyi değildir.

## Canlı sonuçlar

`scripts/verification/check-codex.cjs` kurulu ikiliyi çalıştırdı. Son başarılı çıktının dosya zamanı **09:45:54 UTC / 12:45:54 Türkiye**. Bu, ölçümün tamamlandığı zamandır; sunucunun ayrı bir veri üretim zamanı olarak yorumlanmaz.

| Kontrol | Gözlem |
| --- | --- |
| Varsayılan `login status` | Çıkış 0; ChatGPT oturumu açık |
| İki yeni, boş `CODEX_HOME` | İkisi de çıkış 1; oturum kapalı |
| Boş home ile App Server | initialize ve account/read başarılı; account yok |
| Mevcut hesapla App Server | initialize, account/read ve account/rateLimits/read başarılı |
| Hesap türü / plan | chatgpt / plus |
| `codex` kotası, primary | 300 dakika; %53 kullanılmış, **%47 kalmış** |
| `codex` kotası, secondary | 10080 dakika; %42 kullanılmış, **%58 kalmış** |
| Reset alanları | Her iki pencerede sayısal reset zamanı var; bu kontrol çıktısına değerleri alınmadı |
| Kredi alanları | Var; bakiye bu kontrolde çıkarılmadı |
| Başlatılan App Server süreçleri | İki kontrolün kendi süreçleri kapandı |
| Mevcut auth.json | Önce/sonra SHA-256 karşılaştırması aynı; hash ve içerik yazdırılmadı |

`primary` veya `secondary` etiketinden süre tahmin edilmedi; yanıttaki `windowDurationMins` kullanıldı. Limit haritası `rateLimitsByLimitId`, yoksa eski `rateLimits` alanı üzerinden okunuyor. Bu hesaptaki tek bucket başka hesaplarda veya modellerde de tek bucket olacağını kanıtlamaz.

Kısıtlı sandbox denemesinde App Server başlatımı erişim hatasına takıldı. Yetkilendirilmiş sandbox dışı aynı kontrol başarılı oldu. Bu nedenle ilk hata hesap veya kota reddi diye raporlanmıyor.

## Hesap seçimi ve otomatik geçiş sınırı

[Resmi auth belgesi](https://learn.chatgpt.com/docs/auth), `CODEX_HOME` ve dosya/OS kimlik deposunu açıklar. Kurulu sürüm yardımında `--profile` ayar katmanı olarak tanımlıdır; hesap seçici değildir. Boş home negatif kontrolü varsayılan hesabın o test dizinine taşınmadığını gösterdi. **İki ayrı girişin korunması, yenilenmesi veya A/B/A kimlik testi yapılmadı.**

[App Server belgesi](https://learn.chatgpt.com/docs/app-server) hesap okuma, kota okuma ve auth akışlarını sunuyor. Kurulu sürümden `app-server generate-ts --experimental` ile üretilen şema ayrıca incelendi:

- `GetAccountParams.refreshToken` isteğe bağlı; bu kontrolde **false** verildi.
- `LoginAccountParams`, `apiKey`, `chatgpt`, `chatgptDeviceCode`, `chatgptAuthTokens` ve Bedrock biçimlerini içeriyor.
- Dış kimlik yönetiminde istemci token yenileyip `chatgptAuthTokens` ile sağlayabilir. Bu bizim yazacağımız App Server istemcisi için bir entegrasyon yüzeyidir; çalışan resmi Codex masaüstü uygulamasının hesabını dışarıdan değiştirme kanıtı değildir.
- `CodexErrorInfo` içinde `usageLimitExceeded`, `unauthorized`, `serverOverloaded` ayrı değerler. Kota reddini genel ağ/429 hatasından ayırabilecek yapı var; gerçek kota reddi bu kontrolde üretilmedi.

Bu şemalar bir model isteği veya auth değişikliği yapılmadan üretildi. Yeni dokümanlardaki tüm bayrakların kurulu sürümde bulunduğu varsayılmadı; örneğin `--ignore-user-config` kurulu yardımda yoktu.

## Tekrar çalıştırma ve sınırlar

```powershell
node scripts/verification/check-codex.cjs
```

Betik kurulu Windows ikilisini kullanır; `VIBE_CODEX_BINARY` ile açık ikili yolu verilebilir. Göreve ait `artifacts/verification` altında iki boş home ve temizlenmiş sonuç JSON'u oluşturur. Negatif kontrol dizininde auth.json varsa devam etmez. Anahtar ortam değişkenleri alt süreçten çıkarılır, değerleri yazdırılmaz. Ham RPC çıktısı, kimlik veya token kaydedilmez. Tokenın dosyada süresinin dolduğu görülürse mevcut hesap probe'u yenileme yaptırmamak için atlanır.

İzin verilen RPC'ler initialize, initialized, account/read ve account/rateLimits/read ile sınırlı. Login/logout, thread/turn başlatma, model isteği ve kasıtlı kota tüketimi yok. App Server kendi normal log/geçici dosyalarını yazabilir; sıfır dosya yazımı iddiası yok.

Eksik kabul testleri: ikinci gerçek hesabın ayrı kimlik deposu, A/B/A kimlik doğrulaması, doğal olarak kota sınırındaki hesapla yeni iş yönlendirme, başka hesapla resume, çalışan desktop/CLI oturumunda geçiş ve macOS. **Hiçbir sağlayıcı için gerçek A→B otomatik devam bu rapordan çıkarılamaz.**
