# Kullanım hakları: araştırma ve ekran kararları

Araştırma tarihi: 16 Ekim 2026. Durum: tasarım incelemesi; uygulama henüz geliştirilmedi.

## Sonuç

Her sağlayıcının hesabından dönen kota kayıtlarını göstermek gerekiyor. Sabit bir `oturum + haftalık` arayüzü yeterli değil. Model, model grubu, ürün yüzeyi, hesap ve dönem kotanın kimliğinin parçası olmalı. Abonelik kotası, ek kullanım bütçesi, satın alınmış kredi ve bağlam penceresi farklı kavramlar.

Kaynaklar iki sınıfta değerlendirildi: ürünün resmi belgeleri ve çalışan açık kaynak entegrasyonların kendi kodları. İkincisi bir alanın gözlemlendiğine kanıt sağlar; sağlayıcının desteklediği, kalıcı bir genel API taahhüdü değildir.

Bu turda yalnızca Codex için mevcut uygulamanın salt okunur kullanım aracıyla canlı yanıt kontrol edildi. 300 ve 10080 dakikalık iki dönem, kullanılan yüzde, yenilenme zamanı ve kredi alanları gerçekten mevcut. Claude, Cursor ve Antigravity hesaplarına bağlanılmadı. Önizlemedeki bütün sayılar örnektir; kullanıcıya ait güncel bakiyeler değildir. Yerel kurulum metadata kontrolü Claude Code 2.1.301 ve Cursor 3.22.7 buldu; Antigravity'nin PATH üzerinde bulunmaması kurulu olmadığını kanıtlamaz. Hiçbir kimlik bilgisi okunmadı veya saklanmadı.

## Sağlayıcı matrisi

| Sağlayıcı | Gösterilecek kayıtlar | Veri yolu | Önemli sınır |
| --- | --- | --- | --- |
| Codex | Sunucunun gönderdiği her limit kümesinin birincil/ikincil dönemleri; varsa kredi, sınırsızlık ve yenileme hakkı sayısı | Resmi App Server hesap metotları | Dönem süresi yanıttan gelir; bütün hesapları 5 saat/7 gün diye sabitleme |
| Claude | Ortak oturum ve haftalık sınır; Fable/Opus/Sonnet gibi model kapsamlı sınırlar; başka ürün kapsamları; varsa ek kullanım ve kredi | Resmi statusline temel alanları; daha kapsamlı hesap yanıtları veya `/usage` için ek adaptör | Statusline tek başına Fable kapsamını garanti etmez |
| Cursor | Plana göre aylık ayrı model havuzları veya haftalık dahil kullanım; verilen para birimiyle harcama/bakiye; varsa ek kullanım limiti | Resmi ekip Admin API; bireysel hesap için dashboard oturumuyla çalışan dahili uçlar | Ekip API'si bireysel hesabın genel kota API'si gibi sunulmamalı |
| Antigravity | Gönderilen model/model grubu başına oturum ve haftalık kayıtlar; varsa AI kredi bakiyesi ve ek kullanım tercihi | Resmi CLI statusline; daha zengin grup özeti için yerel uygulama servisi | CLI verisi ve yerel servis sürüme/çalışan oturuma bağlı; tek model yüzdesi hesap toplamı değildir |

## Codex

[Resmi App Server belgesi](https://learn.chatgpt.com/docs/app-server) çoklu limit kümelerini, her dönem için kullanım yüzdesi ve süreyi, yenilenme zamanını, isteğe bağlı plan/kredi alanlarını ve kullanılabilir yenileme haklarını tanımlıyor. Bildirimle güncelleme de var. Yeni bir limit kimliği geldiğinde yeni satır/grup oluşmalı. Eski tek-küme görünümü ile çoklu görünüm iki ayrı hak olarak sayılmamalı. Kredi birimi kaynak tarafından belirtilmeden USD kabul edilmemeli.

Mevcut uygulamadaki araçtan veri okumak, bağımsız EXE'nin bu araca erişebildiği anlamına gelmez. Ürün entegrasyonu App Server üzerinden ayrıca doğrulanacak. Salt okunur izleyici; satın alma, limit yenileme hakkı tüketme veya hesap değiştirme işlemi yapmayacak.

## Claude ve Fable

[Resmi Fable plan açıklaması](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan) Fable'ın Max ve bazı premium koltuklarda ortak haftalık kullanımın bir kısmı içinde yer aldığını, Pro ve bazı standart koltuklarda ise kullanım kredileriyle çalıştığını açıklıyor. Fable için ayrılmış sınır ortak haftalık kullanımın üzerine eklenen yeni kapasite değil. Bu nedenle iki yüzdeden tek bir toplam türetmek doğru değil; farklı paydaları olabilir. Arayüz ortak haftalığı ve Fable haftalığını yan yana veya alt alta, ilişki notuyla gösterecek.

[Resmi statusline belgesi](https://code.claude.com/docs/en/statusline), oturum ve haftalık kullanım/yeni dönem zamanlarını belgeliyor; veri ancak uygun oturumda ve ilk yanıttan sonra gelebiliyor, dönemler bağımsız eksik kalabiliyor. Bağlam doluluğu ayrı bir alan. [Anthropic deposundaki Fable alanı talebi](https://github.com/anthropics/claude-code/issues/88137), statusline'ın kapsam açığını kullanıcı raporu olarak destekliyor; bu rapor bütün sürümlerin davranışını kanıtlamaz.

[CodexBar'ın parser testindeki gerçek yanıt biçimi](https://github.com/steipete/CodexBar/blob/main/Tests/CodexBarTests/ClaudeOAuthTests.swift) model sınırlarının dinamik liste içinde tür, kapsam ve model görünen adıyla gelebildiğini gösteriyor. Fable'a özel düz bir anahtar beklemek yeterli değil. Etkinlik bayrağı kapalı olan satırın da ölçümü var; bu bayrak yetki yokluğu diye yorumlanmamalı. Aynı yüzdeleri taşıyan farklı model kayıtları birleştirilmemeli.

[Entegrasyonun kendi kaynak açıklaması](https://github.com/steipete/CodexBar/blob/main/docs/claude.md), OAuth/web/CLI yollarını, model kapsamlarını, isteğe bağlı rutin kotalarını ve ek kullanım harcamasını ayırıyor. Bunlar resmi genel kota API'si olarak belgelenmiş değil. Windows hesabında erişim, kapsam ve sürüm doğrulanmadan Fable için kesintisiz otomatik okuma tamamlandı sayılmayacak.

Özel kurallar: yeni model adını kaynaktan al; bilinen Fable satırı sonraki eksik okumada sessizce kaybolmasın; son ölçümü yaşıyla koru veya ölçüm alınamadığını göster. Pro örneğinde Fable'a uydurma haftalık yüzde verme: doğrulanmışsa “Krediyle kullanım”, doğrulanmamışsa “Kapsam doğrulanamadı” göster.

## Cursor

[Resmi kullanım sayfası](https://cursor.com/help/models-and-usage/usage-limits) mevcut plan ailesinde haftalık ortak kullanım, eski Cursor planlarında ise ayrı aylık Cursor ve diğer model havuzları olduğunu açıklıyor. Yenilenme fatura dönemine veya haftalık döneme bağlı; bütün planları aylık veya tek USD bakiyesi olarak tasarlamamak gerekiyor.

[Resmi Admin API](https://cursor.com/docs/account/teams/admin-api) ekip verileri, harcama ve kullanım olayları için var. Olay verileri saatlik toplandığından bu kaynaktan saniyelik canlılık izlenimi verilmeyecek. [CodexBar'ın bireysel entegrasyon kaynağı](https://github.com/steipete/CodexBar/blob/main/docs/cursor.md), dashboard kullanım özeti, fatura dönemi, dahil kullanım, model havuzları ve ek kullanım verilerini mevcut oturumla okuyabildiğini belgeliyor. Bu özel uçlar ve Windows oturum edinme yolu ayrıca doğrulanmalı.

Kalan tutar ancak kaynak tutar/üst sınır sağlarsa hesaplanır. Modelin liste fiyatından hesaplanan tahmini token maliyeti abonelikten düşen gerçek tutar gibi gösterilmez. Ortak havuz ile alt havuzları toplayarak yeni toplam üretilmez.

## Antigravity

[Resmi CLI statusline şeması](https://antigravity.google/docs/cli/statusline/) kota kaydını model/kova kimliklerine göre, kalan oran ve yenilenme bilgisiyle tanımlıyor. [Resmi plan sayfası](https://antigravity.google/docs/plans) plan bazında oturum/haftalık sınırları ve ek kredi seçeneğini ayırıyor. [Resmi kredi açıklaması](https://antigravity.google/docs/cli/credits) AI kredi bakiyesini ayrı ele alıyor.

[Çalışan entegrasyonun yerel servis açıklaması](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md), yeni yanıtta adlandırılmış gruplar ve kovalar; eski yanıtta model başına kota bilgisi olduğunu gösteriyor. Güncel grup örneği Gemini ve Claude+GPT için oturum/haftalık ayrımı içeriyor. Yeni biçim varsa iki modele aynı paylaşılan havuz için iki bağımsız hak çizilmez. Model adından veya reset zamanına uzaklıktan dönem tahmin edilmez; kaynak dönemi yoksa genel etiket korunur. Yerel servis yolu kararlı genel API olarak sunulmaz; Windows sürümünde doğrulama gerektirir.

## Arayüz ve veri sözleşmesi kararları

1. Hesap başına değişken uzunluklu kota listesi. Her kayıt kaynak kimliği, kapsam, dönem, ölçüm birimi, yenilenme zamanı, gözlem zamanı ve kaynak bilgisi taşır. Bilinmeyen fakat geçerli yeni kayıtlar kaybolmaz.
2. Birincil gösterim **kalan**. Kullanılan yüzde verildiyse dönüştürülebilir; oran zaten kalan olarak geldiyse ikinci kez ters çevrilmez. Rakamlar kendi kotasının yüzdesidir.
3. Kapsamı çakışan haklar toplanmaz; toplam sağlayıcı puanı yapılmaz. Fable ve ortak haftalığın yüzdeleri kullanılarak sahte kullanılabilir token sayısı veya yüzde üretilmez.
4. Ana ekranda sağlayıcı ve her ölçüm için kapsam/dönem, kalan, sonraki yenilenme. Para/kredi bilgisi ayrı kısa satırda. Her sağlayıcının son başarılı güncellemesi görünür.
5. Eksik, sıfır, sınırsız, desteklenmiyor, pakete dahil değil, eski veri, oturum gerekli ve dönem yenilenmesi bekleniyor farklı durumlardır. `null` hiçbir zaman %100 olmaz. Önceki dönem dolduğu için yerelde %100'e doldurulmaz.
6. Ana ekran endpoint, OAuth veya token açıklaması göstermez. İsteğe bağlı bağlantı ayrıntısında veri kaynağı ve kapsam eksikliği açıklanır. Gizli bilgiler, hesap kimliği ve ham erişim tokenları tanılama kaydına girmez.
7. Hesap kimliği değişince eski hesabın verisi yeni hesaba taşınmaz. Veriler sağlayıcı ve hesap kapsamında tutulur. Yerel kimlik bilgileri diğer uygulamaların dosyalarına yazılarak değiştirilmez.
8. Yenileme sıklığı sağlayıcıya göre belirlenir. Bildirim/yerel olay varsa onlardan yararlanılır. 429 yanıtında sunucunun bekleme önerisine uyulur. Eski veri son başarılı zamanıyla kalır; başarısız deneme onu güncel yapmaz.

## İnceleme için iki yerleşim

- **Dikey widget (öneri):** dar, taşınabilir pencere; dört sağlayıcı, mevcut bütün temel/model kotaları; satır başına kalan ve yenilenme. Gün boyu kenarda kalmak için daha az yatay alan.
- **Geniş panel:** aynı veri, iki sütunda sağlayıcı bölümleri; daha rahat karşılaştırma ve daha büyük detay alanı, daha fazla masaüstü alanı.

Önizlemede Claude Max/Pro, eksik Fable ölçümü, Cursor aylık/haftalık hesap ailesi ve veri eskiliği denenebilir. Bu kontroller tasarım senaryosudur; hesap değiştirmez ve ağa bağlanmaz. Uygulama geliştirmesi kullanıcı yerleşim ve davranışı onayladıktan sonra başlayacak.

## Sonraki uygulama aşamasının kabul koşulları

- Her sağlayıcının kullanıcı hesabında salt okunur bağlantı denemesi; sırları içermeyen alan envanteri.
- Fable'ın dinamik model kapsamından görünmesi; etkinlik bayrağı kapalıyken kaybolmaması; gelecekteki başka modellerin de aynı yoldan çıkması.
- Eski/yeni Cursor plan biçimlerinin ve Antigravity gruplarının ayrı örneklerle doğrulanması.
- Sıfır, null, eksik reset, değişen hesap, zaman aşımı ve dönem sınırı senaryoları.
- Bildirilen bir kaynak bütün kotaları vermiyorsa kapsam eksikliğinin görünmesi; tahmini token maliyetinden eksik abonelik kotası üretilmemesi.

## İş akışı

- [x] Proje ve kaynakları incele (başlangıç deposu boş).
- [x] Genel kota araştırması ve kaynakları kaydet.
- [x] Veri odaklı ekran alternatiflerini hazırla.
- [ ] Kullanıcıdan yerleşim/davranış geri bildirimi al.
- [ ] Onaylanan tasarımı nihai tasarım belgesine dönüştür ve uygulama planını çıkar.
- [ ] Bağlantıları doğrula ve uygulamayı geliştir.
