<div align="center">

[English](../../README.md) · **Türkçe** · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [Русский](README.ru.md)

<img src="../../assets/icon.png" width="96" alt="" />

# Vibe Usage

**Ödediğin tüm AI kodlama abonelikleri, tek bir menü çubuğu penceresinde.**

Claude Code, Codex, Cursor ve Antigravity'de ne kadar kota kaldığını gör, hâlâ yeri olan aracı başlat ve yarım kalan
bir işi baştan anlatmadan bir araçtan diğerine devret.

Windows sistem tepsisi · macOS menü çubuğu · 13 dil · şifre yok, token saklanmaz

**[Windows ve macOS için indir](https://github.com/mustafacagri/vibe-usage/releases/latest)** · Terminal: [`npm install -g vibe-usage-cli`](https://www.npmjs.com/package/vibe-usage-cli)

<img src="../media/demo.gif" width="400" alt="Vibe Usage tanıtımı: hesaplar arasında geçiş, tüm hesaplar yan yana, kompakt görünüm, Akıllı Başlat ve Görev Devret" />

<sub>[Tam çözünürlükte izle (MP4)](../media/demo.mp4)</sub>

</div>

> Bu çeviri İngilizce README'nin gerisinde kalabilir; [İngilizce sürüm](../../README.md) esastır.

## Neden

Birden fazla AI aracıyla kod yazıyorsan hep aynı duvara çarparsın: 5 saatlik limit işin ortasında biter, başka bir
araç açarsın ve işi en baştan anlatmaya başlarsın. Her sağlayıcı kullanımını farklı bir yerde gösterir, bazıları hiç
göstermez.

Vibe Usage bilgisayarında zaten açık olan oturumları okur ve tüm limitleri yan yana gösterir: ne kadar kaldığını ve ne
zaman sıfırlanacağını. Bir aracın kotası azaldığında, kotası doğrulanmış bir sonrakini proje klasöründe başlatır ve
mevcut oturumun bir özetini yazar; böylece yeni araç eskisinin bıraktığı yerden devam eder.

## Özellikler

<table>
<tr>
<td width="50%" valign="top">

### Kotalar tek bakışta

Her hesabın her limiti: 5 saatlik ve haftalık pencereler, model bazlı kapsamlar, harcama havuzları. Geri sayımlar her
birinin ne zaman sıfırlanacağını gösterir. Bir yenileme başarısız olursa son ölçüm görünür kalır ve açıkça eski veri
olarak işaretlenir. Bilinmeyen değerler asla tam kota gibi gösterilmez. Tepsi simgesinin üzerine gelince her aracın
kalan kotası görünür; isterseniz bir limit azaldığında ya da yeniden kullanılabilir olduğunda bildirim alırsınız.
Uygulama oturum açılışında başlayabilir.

</td>
<td width="50%" valign="top">

<img src="../media/main.png" width="100%" alt="Claude, Codex, Cursor ve Antigravity kota kartları; her aracın hesapları yan yana" />

<img src="../media/compact.png" width="100%" alt="Kompakt görünüm: her hesap için bir satır" />

</td>
</tr>
<tr>
<td valign="top">

### Akıllı Başlat

Öncelik sıranda kotasında yer olduğu **doğrulanmış** ilk aracı seçer ve seçtiğin proje klasöründe yeni bir terminalde
açar. Hiçbir aracın kotası doğrulanamazsa tahmin yürütmek yerine bunu söyler.

</td>
<td valign="top">

<img src="../media/smart-launch.png" width="100%" alt="Claude'un 5 saatlik limiti bitmek üzere olduğu için Codex'i öneren Akıllı Başlat" />

</td>
</tr>
<tr>
<td valign="top">

### Görev Devret

Claude Code, Codex, Cursor Agent veya Antigravity’den bir oturum seç. `VIBE_HANDOVER.md`; hedefi, son isteği, yakın konuşmaları, dosya referanslarını ve Git dalı/HEAD bilgisini içerir; çalışma ağacı taranmaz. Önizleme gerçek oturum kaynağını, hesabı ve sürümü sabitler; kaynak değişirse yeniden önizleme gerekir. Worktree’ye taşınan oturumlar doğru proje altında listelenir.

</td>
<td valign="top">

<img src="../media/handover.png" width="100%" alt="Bir Claude oturumunu Codex'e devreden pencere" />

</td>
</tr>
<tr>
<td valign="top">

### Çoklu hesap

Claude ve Codex her profil klasöründe bir oturum tutar. **Hesap ekle** yeni bir klasör oluşturur ve aracın girişini
orada açar; kendi oluşturduğun `~/.claude-*` ve `~/.codex-*` klasörleri de otomatik bulunur. Her hesap giriş yaptığı
e-postayla gösterilir; oturum açılmış her Antigravity hesabı da ayrı izlenir. Ana hesabı seç, Claude Code'u belirli bir
hesapla başlat, yedek araç sırasını ve her araç için tercih edilen modeli belirle.
On dakika içinde tamamlanmayan bir giriş hesabı yeniden kaldırır; sonraki hesap onun klasörünü kullanır.

</td>
<td valign="top">

<img src="../media/settings.png" width="100%" alt="Ayarlar: bağlı hesaplar, Claude ve Codex için ikişer hesap" />

</td>
</tr>
</table>

### Ayarlar, geçmiş ve tanılama

<table>
<tr>
<td width="33%" valign="top"><img src="../media/settings-general.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-continue.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-order.png" width="100%" alt="" /></td>
</tr>
<tr>
<td valign="top"><b>Genel:</b> oturum açınca başlatma, düşük kota sınırında bildirim, sessiz saatler, hesapları yan yana gösterme ve güncelleme kontrolü.</td>
<td valign="top"><b>Limit dolunca:</b> sadece öner, aracın diğer hesaplarında devam et ya da yedek sırasıyla diğer araçlara geç; proje bazında da ayarlanır.</td>
<td valign="top"><b>Sıra ve modeller:</b> araçların listelenme sırası, sıradaki yedek araç, her aracın başlayacağı model ve kotanın ne sıklıkla okunacağı.</td>
</tr>
<tr>
<td width="33%" valign="top"><img src="../media/history.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/diagnostics.png" width="100%" alt="" /></td>
<td></td>
</tr>
<tr>
<td valign="top"><b>Görev devir geçmişi:</b> hangi işin hangi hesaptan hangisine geçtiği; başarısız olanı tek tıkla yeniden dene.</td>
<td valign="top"><b>Tanılama:</b> her araç kurulu mu, her hesap ne durumda; isim ve klasör içermeyen raporu kopyala ya da kaydet.</td>
<td></td>
</tr>
</table>

## Desteklenen araçlar

| Araç        | Kota nereden okunur                                                  | Devir için oturumlar                         | Başlatma                         |
| ----------- | -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------- |
| Claude Code | Profilin OAuth kullanım yanıtı (macOS'ta Keychain)                   | `~/.claude/projects`                         | Seçilen profille `claude` CLI    |
| Codex       | Kurulu CLI'nin app-server kota metotları                             | `~/.codex/sessions`                          | `codex` CLI                      |
| Cursor      | Açık oturumun kullanım özeti                                         | Cursor Agent CLI sohbetleri (`~/.cursor/chats`) | `cursor-agent`, yoksa uygulama |
| Antigravity | Çalışan uygulamanın yerel servisi (süreç ve port sahipliği doğrulanır) | `~/.gemini/antigravity-ide`                  | Antigravity uygulaması           |

Model listeleri her aracın kendi verisinden gelir: Claude Code takma adları ve kullandığın modeller, Codex model
önbelleği ve `cursor-agent --list-models` (24 saat önbelleklenir).

## Gizlilik ve güvenlik

Var olan kimlik bilgileri bellekte okunur; bu belgeler erişim ve yenileme token’ları içerebilir. Uygulama yenileme token’ının varlığını kontrol eder, kendi verilerine kaydetmez; yenilemeyi Claude Code yapar.

Ayarlar, hesap etiketleri ve yollar; kota geçmişi ve son ölçümler yerel diskte tutulur. Hesaplar arasında devam ederken tam konuşma kopyalanır. `VIBE_HANDOVER.md` ise temizlenmiş konuşma bağlamı içerir; bilinmeyen sır biçimleri için garanti yoktur. Devir öncesi önizlemeyi incele. Git’in izlediği dosyalar veya başarısız Git hariç tutma işlemi devri durdurur; Cursor kendi güven sorularını korur.

Kota istekleri sağlayıcı uç noktalarını, sürüm kontrolü GitHub’ı kullanır. Güncelleme indirme ve kurulum ayrı kullanıcı eylemleridir. Saklanan veriler ve paylaşım sınırları için [ayrıntılı gizlilik belgesine](../PRIVACY.md) bak.

## Kurulum

### Windows

[Son sürümden](https://github.com/mustafacagri/vibe-usage/releases/latest) `Vibe-Usage-<sürüm>-win-setup.exe` dosyasını indirip çalıştır: yalnızca senin kullanıcın için kurulur, yönetici yetkisi gerekmez. Ya da taşınabilir `Vibe-Usage-<sürüm>-win-x64.zip` (veya `-arm64`) dosyasını indir, zip'i aç ve `Vibe Usage.exe`'yi çalıştır. Desteklenen imzalı kurulumda güncelleme **İndir** düğmesiyle alınır ve ancak **Güncellemek için yeniden başlat** seçilince kurulur. Taşınabilir kopya yeni sürüm için bağlantı verir. Uygulama sistem tepsisinde durur.

Uygulama kod imzalı olmadığından ilk açılışta Windows SmartScreen **Windows bilgisayarınızı korudu** diyebilir. **Ek bilgi**'ye, ardından **Yine de çalıştır**'a tıkla.

### macOS

[Son sürümden](https://github.com/mustafacagri/vibe-usage/releases/latest) `Vibe-Usage-<sürüm>-mac-arm64.dmg` dosyasını (Apple silicon; Intel için `-mac-x64.dmg`) indir, aç ve **Vibe Usage**'ı Uygulamalar klasörüne sürükle. Uygulama henüz Apple Developer ID ile imzalı olmadığından Gatekeeper ilk açılışı engeller: **Sistem Ayarları › Gizlilik ve Güvenlik**'i açıp **Yine de Aç**'a tıkla ya da şunu çalıştır:

```sh
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

Bu adımı atlamak için kendin derle. Yalnızca Node.js 24 gerekir:

```sh
git clone https://github.com/mustafacagri/vibe-usage.git && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

Intel Mac'te klasör adı `release/mac` olur. Kendi derlediğin uygulama karantinaya alınmaz ve doğrudan açılır. macOS yalnızca imzalı bir uygulamanın kendini güncellemesine izin verir; bu yüzden yeni sürüm de aynı şekilde kurulur: uygulamadaki **İndir** düğmesi Mac'ine uygun disk görüntüsünü indirir.

## Komut satırı

Aynı veriler terminalde de var; Windows ve macOS’ta, masaüstü uygulamasıyla ya da onsuz çalışır. Node.js 24 veya üstü gerekir ve uygulamanın okuduğu, oturumu açık aynı hesapları okur; ikisi birlikte kuruluysa ayarları ve dili paylaşırlar.

```sh
npm install -g vibe-usage-cli
vibe-usage status
```

<img src="../media/cli.png" width="640" alt="Terminalde vibe-usage status: iki Claude, iki Codex, bir Cursor ve iki Antigravity hesabının tüm pencereleri" />

```sh
vibe-usage status [--json]   # tüm hesapların kotası bir kez; betikler için --json
vibe-usage watch             # aynısı, Ctrl+C’ye kadar yenilenir
vibe-usage run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
vibe-usage handover [--from TOOL] [--to TOOL] [--session ID] [--cwd PATH]
vibe-usage help
```

Kurmadan denemek için `npx vibe-usage-cli status` çalıştır.

`run`, aracı bu terminalde kotası doğrulanmış bir hesapla başlatır; yoksa `--account` ile birini belirt (kimlikler `status --json` çıktısında). `--dry-run` hiçbir şey başlatmadan hesabı ve komutu yazdırır. `handover`, klasörün en son oturumu (ya da `--session`) için `VIBE_HANDOVER.md` yazar ve hedef aracı onunla açar.

## Geliştirme

Komutlar, proje yapısı ve ortam değişkenleri için [İngilizce README'deki Development bölümüne](../../README.md#development)
bak.

## Sınırlar

- macOS paketi notarize edilmemiştir (bkz. [macOS](#macos)).
- Antigravity oturum modeli belgelenmemiş yerel bir kayıttan okunur; okunamazsa model boş bırakılır.
- Cursor IDE (Composer) sohbetleri devredilemez; yalnızca Cursor Agent CLI oturumları okunur.

## Lisans

[MIT](../../LICENSE)
