Context7 izni verilmedi, bu yüzden Claude Code hook ayrıntılarını doğrulayamadım. Aşağıda bunları "doğrulanmalı" diye işaretledim. Geri kalan her şey sunduğun diff ve test çıktısından geliyor. Depoyu ben çalıştırmadım ve bu oturumda dosya okuma aracım yok.

## Özet

Mimari yön doğru: kota ölçümü ve keşif otomatik, hesap veya sağlayıcı değişimi kullanıcının tetiklemesiyle. Ama sunum iki yerde yanlış:

1. "Otomatik" tarafı olduğundan geniş anlatıyor.
2. "Çapraz sağlayıcı devir" büyük ölçüde henüz yok.

## 1. Otomatik / manuel matrisi doğru değil

**A.3, A.4 ve A.5 otomatik değil.** Üçü de kullanıcı tıklamasıyla veya CLI komutuyla çalışıyor. Hiçbiri arka planda kendi kendine tetiklenmiyor.
- "Ana hesaba otomatik döner" ifadesi yanıltıcı. Aslında kullanıcı bir sonraki başlatmayı yaptığında seçim yeniden hesaplanıyor.
- Durum tutan bir mekanizma yok, her seferinde anlık görüntüden hesap yapılıyor.
- Gerçekten otomatik olanlar: ölçüm ve keşif.

**"Kill etmiyoruz" gerekçesi zayıf.** Kota bittiğinde Claude zaten turu durdurmuş ve istem satırında bekliyor. Yarım `rm -rf` veya onay bekleyen komut senaryosu o noktada genelde geçerli değil.
- Otomasyonun yapması gereken şey eskiyi öldürmek değil. Yeni terminali yanına açmak.
- Eski oturum limit sıfırlanınca devam edebilir.
- Asıl risk veri kaybı değil. İki ajanın aynı çalışma ağacına aynı anda yazması. Bu yüzden devirde eski oturumun "devredildi" diye işaretlenmesi ve kullanıcının uyarılması gerekir. Daha ağır çözüm: ayrı `git worktree`.

**Önerdiğim kademeli otomasyon:**
- **Seviye 0 (tam otomatik, yan etkisiz):** %15, %5 ve %0 eşiklerinde OS bildirimi ("Claude A: %5, sıfırlanma 15:20, Codex'te %89 var").
- **Seviye 1 (otomatik hazırlık):** Brifing bir tur sınırında önceden üretilir. Claude Code'un `Stop` hook'u buna uygun olabilir, ama sürümünde doğrulanmalı. Kota bittiği an devir tek tık olur.
- **Seviye 2 (kullanıcı onaylı):** `vibe run` PTY'yi sahiplenir, boşta kalınca "Hesap B'ye geçelim mi?" diye sorar.
- **Tam otomatik yalnızca yeni oturumlar için.** Ücretli sağlayıcıya (Cursor on-demand, Claude kredisi) geçiş sağlayıcı bazında opt-in olmalı.

## 2. Çapraz devir: iddia ile kod örtüşmüyor

**"Kaynaklar: Claude, Codex, Cursor" doğru değil.** `buildHandoverPrompt` yalnızca `~/.claude/projects/<slug>` okuyor.
- `--from codex` verirsen Claude günlüğü okunup brifing "Kaynak: CODEX" diye etiketleniyor.
- Cursor sohbet geçmişi `state.vscdb` içinde, okunması kırılgan. Antigravity için de okuyucu yok.
- N×N simetri yok. Gerçekçi tasarım şu: kaynak olarak Claude ve Codex (`~/.codex/sessions/…`) okuyucuları, hedef olarak her biri için bir yazıcı, ortada nötr bir format.

**Brifing hedefe hiç iletilmiyor.**
- Codex ve Claude yalnızca `exec <binary>` ile açılıyor, istem verilmiyor. Kullanıcı elle "VIBE_HANDOVER.md'yi oku" yazmak zorunda.
- Cursor ve Antigravity için sadece `open -a`, yani klasör açılıyor.
- Kısa ve sabit bir başlangıç istemini argüman olarak geçirmek mümkün olmalı (`claude "…"`, `codex "…"`). İçeriği değil, "VIBE_HANDOVER.md'yi oku" gibi sabit bir cümleyi geçir.

**Yanlış başarı mesajları ve geç doğrulama:**
- Codex dalında macOS ve Windows dışında (Linux) hiçbir şey başlatılmıyor ama `success: true` dönüyor.
- Cursor ve Antigravity Windows'ta sona düşüp "desteklenmeyen hedef" fırlatıyor, ama dosyalar o noktaya kadar yazılmış oluyor.
- `--from` ve `--to` beyaz listeyle doğrulanmıyor.
- `fromLabel`, macOS `.command` betiğine ve Windows `cmd /k` dizgisine kaçışsız giriyor. Kullanıcı kendi makinesinde kendine saldırdığı için düşük risk, ama beyaz liste tek satırda çözer.

**Brifing üretiminde gerçek hatalar:**
- **`<system-reminder>` filtresi gerçek mesajları atıyor.** Claude Code'da hatırlatmalar çoğu zaman kullanıcı mesajının içine eklenir. `includes('<system-reminder>')` ile atılan mesaj, gerçek isteğin kendisi olabilir. Bu mesajın kendisi bunun örneği. Etiketi çıkar, mesajı tut.
- **Son asistan mesajı büyük olasılıkla limit hatası.** Kota bitince Claude Code transkripte "limit reached ∙ resets 3pm" benzeri bir sentetik asistan girdisi yazar. Bölüm 3 ("son durum / plan") bu cümleyi taşıyabilir. `isApiErrorMessage` benzeri alanlara göre filtrele. Alan adını gerçek bir transkriptte doğrula.
- **Slug kuralı eksik.** Yalnızca `/ \ :` değiştiriliyor. Claude Code'un tüm alfasayısal olmayan karakterleri `-` yaptığına inanıyorum. Bunu kendi `~/.claude/projects` dizininde bir `my_app` veya `foo.bar` klasörüyle doğrula. Doğruysa noktalı veya alt çizgili projelerde oturum sessizce bulunmaz.
- **Hesap B görünmez.** Yol `~/.claude` olarak sabit, `CLAUDE_CONFIG_DIR` / `.claude-secondary` yok sayılıyor. Hesap B'de çalışan oturumun devri hiç bulunmaz.
- **Dosya listesi "dokunulan dosyalar" değil.** Satırın tamamına yapılan regex, URL parçalarını, araç çıktılarını, tek seviyeli yolları yakalıyor. `package.json` gibi kökteki dosyaları kaçırıyor. `slice(-10)` de Set ekleme sırasında ilk görülenleri alıyor, en son değiştirilenleri değil. Doğru kaynak `Edit`/`Write`/`MultiEdit` `tool_use.input.file_path` alanları.
- **Başka sorunlar:**
  - Elektron ana sürecinde tüm `.jsonl` bellekte okunuyor. Yüzlerce MB olabilir, UI donar.
  - "En yeni mtime" paralel veya başka oturumu seçebilir.
  - Alt ajan (sidechain), `/compact` özeti ve slash komut çıktıları `lastUserMsg` olarak sayılabilir.

**Boş oturumda iyi brifingi eziyor.** `hasSession=false` ise "Belirtilmedi" içeren bir `VIBE_HANDOVER.md`, önceki iyi bir brifingin üstüne yazılıyor. `smartLaunch` de her fallback'te bunu çalıştırıyor.

**Dosya yazma yan etkileri:**
- `VIBE_HANDOVER.md` ve `CLAUDE_HANDOVER.md` proje köküne yazılıyor ve git'e girebilir.
- `CLAUDE_HANDOVER.md` hiçbir şey tarafından otomatik okunmuyor, gereksiz. Kaldır.
- Brifing `.vibe/` altına yazılmalı ve `.git/info/exclude`'a eklenmeli.

**Test kapsamı zayıf.** Devirle ilgili yalnızca iki test var, biri ayrıştırma, biri seçim. `executeHandover`, CLI bayrakları ve platform dalları sıfır testli. "99 geçti" bu özellik için güven vermiyor.

## 3. Semantik kayıp ve güvenlik

**Kaybolanlar:**
- **Gerekçeler:** neden bu yaklaşım seçildi, hangisi denenip reddedildi.
- **Kanıtlar:** araç çıktıları, test hataları.
- **Bağlam dosyaları:** Claude `CLAUDE.md`, Codex `AGENTS.md`, Cursor `.cursor/rules` okur. Proje talimatları araçlar arasında taşınmıyor.
- **Yetenekler:** MCP, skill, hook ve izin geçmişi farklı.
- **Orta tur kararları:** brifing yalnızca ilk mesaj, son mesaj ve son asistan metnini taşıyor. 4 saatlik bir oturumda ilk hedef çoğu zaman bayat, ve ilk mesaj 3000 karakterde kesiliyor.

**En kritik tasarım önerim: kaynağı transkript yapma, çalışma ağacını yap.** Araçtan bağımsız, her kaynakta (Cursor ve Antigravity dahil) çalışan deterministik bilgi şunlar:
- `git status`, `git diff --stat`, mevcut dal ve son birkaç commit
- son test sonucu (varsa)
- Claude'un son `TodoWrite` durumu (transkriptte deterministik duruyor)
- `Edit`/`Write` ile gerçekten dokunulan dosyalar

Transkript yalnızca zenginleştirme olsun: "kullanıcının son isteği" ve "son plan". Bu hem kaynak simetrisi sorununu hem de `-from` yalanını çözer.

**Gizlilik: asıl sessiz risk.** Brifing, kullanıcı mesajlarını ve model çıktısını başka bir sağlayıcıya (OpenAI, Cursor, Google) taşıyor. Yapıştırılmış sırlar, token'lar ve özel kod dahil.
- Gönderimden önce önizleme ve onay iste.
- Bilinen sır kalıplarını (`sk-…`, `ghp_…`, `AKIA…`, `.env` satırları) maskele.
- Bu, "veriler yerel kalır" mesajıyla da çelişmemeli.

**Enjeksiyon:** Transkriptteki web veya araç çıktısı kaynaklı metin, hedef modele talimat gibi gidiyor. Brifingin son satırı ("kesintisiz devam et") bunu güçlendiriyor. Öneri: brifingi açıkça "güvenilmeyen bağlam" olarak çerçevele, "önce `git status` ile doğrula, yıkıcı işlemden önce sor" yaz.

## 4. A → B → A rotasyonu

**Gerçek hata: `executeHandover` Claude hedefinde `accounts[0]` seçiyor.** `smartSelectProvider` kararındaki hesabı atıyor, ana hesaba da bakmıyor. Yani tükenmiş hesaba geri atabilir. `launchWarnings` da çağrılmıyor.

**Test edilmiş politikayı baypas ediyor.** Mevcut `selectClaudeAccount` zaten "bilinmeyen/eski haftalık veri asla otomatik uygun sayılmaz" kuralını (testli) uyguluyor. `smartSelectProvider` ise yalnızca `five_hour`'a bakıyor:
- Haftalık %0 ama 5 saatlik %92 olan hesap seçilir.
- Fable/Sonnet kapsamlı pencereler yok sayılır.
- `five_hour` kimliği sabit kodlu. Claude adaptöründeki gerçek `id` ile eşleştiğini doğrula.

Çözüm: iki yolu birleştir, tek uygunluk fonksiyonu kullan.

**"En yüksek kotalı sağlayıcı" iddiası yanlış.** Sıra sabit: Claude, Codex, Cursor, Antigravity.
- Codex, Cursor ve Antigravity için yalnızca `provider.status === 'ok'` bakılıyor, kalan kota değil.
- Codex %0 olsa bile seçilir. Cursor'da bu çıktıda "API kapsamı %0" zaten var.
- Claude de yalnızca `status==='ok'` iken seçiliyor. Tek bir ağ hatasında hesap `stale` olur ve Claude'da kota varken Codex'e düşersin. Geçici hata yüzünden sağlayıcı değiştirmek tehlikeli. Burada `stale`, "kota yok" ile aynı muamele görmemeli.
- `preferredProvider` bloğu bir sonraki bloğun kopyası ve `preferredProvider` hiç geçirilmiyor. Ölü kod.

**Yarış ve köşe durumları:**
- **Bayat anlık görüntü.** UI `smartLaunch`, klasör seçme diyaloğundan sonra `service.snapshot()` kullanıyor, yenileme yok. Kullanıcı dakikalarca bekleyebilir. CLI doğru yapıyor (`refresh()` çağırıyor). Seçim anında yeniden yenile ve `fetchedAt` yaşını kontrol et (`launchWarnings` 300 sn kuralını biliyor, `smartSelect` bilmiyor).
- **Salınım.** `remaining > 0` eşiği %1'i "uygun" sayıyor. Ana hesap %1'den başlatılıp birkaç dakikada tükenir. Rezerv eşiği (örn. %5–10) ve histerezis ekle. Seçimi, pencerenin sıfırlanma zamanıyla da birlikte değerlendir: 10 dakikada sıfırlanıyorsa beklemek devretmekten ucuzdur.
- **Hesap A'ya dönüşte haftalık engel.** 5 saatlik pencere açıldı diye A seçilir ama haftalık %0 ise engellenirsin. Yukarıdaki birleştirme bunu da çözer.
- **Oturum sürekliliği.** A→B'de transkript A'nın yapılandırma dizininde kalıyor. Daha yüksek doğruluklu seçenek: transkripti B'nin `projects/<slug>/` altına kopyalayıp `claude --resume <id>` ile açmak. Bu kayıpsız olurdu, ama başka profile yazmak demek. Salt-okunur felsefeyle çeliştiği için açık opt-in olmalı ve elle denenmeli.
- **Kullanım koşulları.** İki hesapla limit aşımı için rotasyon yapmak, sağlayıcının hesap paylaşımı/limit atlama koşullarıyla çelişebilir. Kendi iki hesabın için de koşulları kontrol et. Ürün olarak dağıtacaksan belgelendir.

## Öncelik sırası

1. `executeHandover`: `accounts[0]` düzelt, yanlış `from` etiketini ve Linux'taki sahte `success: true`'yu kaldır, `from`/`to` doğrulamasını dosya yazmadan önce yap.
2. `<system-reminder>` filtresini ve limit-hatası mesajı filtrelemesini düzelt, slug kuralını doğrula, `CLAUDE_CONFIG_DIR`'ı destekle.
3. Tek uygunluk fonksiyonu: haftalık ve kapsamlı pencereler, `stale` ≠ tükenmiş, rezerv eşiği, Codex/Cursor/Antigravity için gerçek kota karşılaştırması.
4. Brifing kaynağını git durumu + `TodoWrite` + `tool_use` dosyaları yap. Dosyayı `.vibe/` altına yaz, önizleme ve sır maskeleme ekle.
5. Başlangıç istemini hedefe ilet.
6. Bildirimler (Seviye 0), sonra hook veya PTY tabanlı onaylı devir.
7. `executeHandover` ve CLI için testler. Mevcut iki test bu özelliği korumuyor.

İstersen 1–3'ü şimdi uygulayıp test ekleyeyim. Depoya yazma ve komut çalıştırma için araç iznine ihtiyacım olacak.
