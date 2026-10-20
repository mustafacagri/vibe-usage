<div align="center">

[English](../../README.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · **Polski** · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [Русский](README.ru.md)

<img src="../../assets/icon.png" width="96" alt="" />

# Vibe Usage

**Wszystkie opłacane subskrypcje AI do programowania w jednym oknie paska menu.**

Sprawdź, ile limitu zostało w Claude Code, Codex, Cursor i Antigravity, uruchom narzędzie, które ma jeszcze zapas, i
przekaż niedokończone zadanie z jednego narzędzia do drugiego bez tłumaczenia go od nowa.

Zasobnik systemowy Windows · pasek menu macOS · 13 języków · bez haseł, bez zapisanych tokenów

**[Pobierz dla Windows i macOS](https://github.com/mustafacagri/vibe-usage/releases/latest)** · Terminal: [`npm install -g vibe-usage-cli`](https://www.npmjs.com/package/vibe-usage-cli)

<img src="../media/demo.gif" width="400" alt="Prezentacja Vibe Usage: przełączanie kont, wszystkie konta obok siebie, widok kompaktowy, Inteligentny Start i przekazanie zadania" />

<sub>[Obejrzyj w pełnej rozdzielczości (MP4)](../media/demo.mp4)</sub>

</div>

> To tłumaczenie może być opóźnione względem angielskiego README; wiążąca jest [wersja angielska](../../README.md).

## Dlaczego

Jeśli programujesz z kilkoma narzędziami AI, wciąż uderzasz w ten sam mur: 5-godzinny limit kończy się w połowie
zadania, otwierasz inne narzędzie i zaczynasz wszystko tłumaczyć od zera. Każdy dostawca pokazuje zużycie w innym
miejscu, a niektórzy wcale.

Vibe Usage odczytuje sesje, które są już zalogowane na Twoim komputerze, i pokazuje wszystkie limity obok siebie: ile
zostało i kiedy nastąpi reset. Gdy w jednym narzędziu zaczyna brakować limitu, uruchamia kolejne ze zweryfikowanym
limitem w folderze projektu i zapisuje podsumowanie bieżącej sesji, aby nowe narzędzie kontynuowało tam, gdzie
poprzednie skończyło.

## Funkcje

<table>
<tr>
<td width="50%" valign="top">

### Limity w jednym spojrzeniu

Każdy limit każdego konta: okna 5-godzinne i tygodniowe, limity dla poszczególnych modeli, pule wydatków. Odliczanie
pokazuje, kiedy każdy z nich się zresetuje. Jeśli odświeżenie się nie powiedzie, ostatni odczyt pozostaje widoczny i
jest wyraźnie oznaczony jako nieaktualny. Nieznane wartości nigdy nie są pokazywane jako pełny limit. Najedź na ikonę w
zasobniku, aby zobaczyć, ile zostało w każdym narzędziu; opcjonalnie otrzymasz powiadomienie, gdy limit się kończy lub
znów jest dostępny. Aplikacja może uruchamiać się po zalogowaniu.

</td>
<td width="50%" valign="top">

<img src="../media/main.png" width="100%" alt="Karty limitów dla Claude, Codex, Cursor i Antigravity, z kontami każdego narzędzia obok siebie" />

<img src="../media/compact.png" width="100%" alt="Widok kompaktowy: jeden wiersz na konto" />

</td>
</tr>
<tr>
<td valign="top">

### Inteligentny Start

Wybiera pierwsze narzędzie w Twojej kolejności priorytetów, którego limit ma **zweryfikowany** zapas, i otwiera je w
nowym terminalu w wybranym folderze projektu. Jeśli nie da się zweryfikować żadnego narzędzia, mówi o tym zamiast
zgadywać.

</td>
<td valign="top">

<img src="../media/smart-launch.png" width="100%" alt="Inteligentny Start poleca Codex, bo 5-godzinny limit Claude jest prawie wyczerpany" />

</td>
</tr>
<tr>
<td valign="top">

### Przekaż zadanie

Wybierz sesję Claude Code, Codex, Cursor Agent lub Antigravity. `VIBE_HANDOVER.md` zawiera cel, ostatnie żądanie, ostatnie rozmowy, odwołania do plików i metadane gałęzi/HEAD Git; drzewo robocze nie jest skanowane. Podgląd przypina fizyczne źródło, konto i wersję. Zmiana źródła wymaga nowego podglądu. Sesje przeniesione do worktree pojawiają się przy właściwym projekcie.

</td>
<td valign="top">

<img src="../media/handover.png" width="100%" alt="Okno przekazania sesji Claude do Codex" />

</td>
</tr>
<tr>
<td valign="top">

### Wiele kont

Claude i Codex przechowują jedno logowanie na folder profilu. **Dodaj konto** tworzy nowy folder i otwiera w nim
logowanie narzędzia; foldery `~/.claude-*` i `~/.codex-*` utworzone samodzielnie są wykrywane automatycznie. Każde konto
jest pokazywane z adresem e-mail, którym się zalogowano, a każde zalogowane konto Antigravity również jest śledzone
osobno. Wybierz konto główne, uruchom Claude Code z konkretnym kontem i ustaw kolejność zapasową oraz preferowany model
dla każdego narzędzia.
Logowanie nieukończone w ciągu dziesięciu minut ponownie usuwa konto, a następne konto używa jego folderu.

</td>
<td valign="top">

<img src="../media/settings.png" width="100%" alt="Ustawienia: połączone konta, po dwa dla Claude i Codex" />

</td>
</tr>
</table>

### Ustawienia, historia i diagnostyka

<table>
<tr>
<td width="33%" valign="top"><img src="../media/settings-general.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-continue.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-order.png" width="100%" alt="" /></td>
</tr>
<tr>
<td valign="top"><b>Ogólne:</b> uruchamianie przy logowaniu, powiadomienia przy Twoim progu niskiego limitu, godziny ciszy, konta obok siebie i sprawdzanie aktualizacji.</td>
<td valign="top"><b>Gdy limit się wyczerpie:</b> tylko zasugeruj, kontynuuj na innych kontach narzędzia albo potem na innych narzędziach w kolejności zapasowej; także dla projektu.</td>
<td valign="top"><b>Kolejność i modele:</b> jak narzędzia są wyświetlane, które przejmuje pracę, z jakim modelem startuje każde i jak często odczytywany jest limit.</td>
</tr>
<tr>
<td width="33%" valign="top"><img src="../media/history.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/diagnostics.png" width="100%" alt="" /></td>
<td></td>
</tr>
<tr>
<td valign="top"><b>Historia przekazań:</b> jaka praca przeszła z którego konta na które; ponów nieudaną jednym kliknięciem.</td>
<td valign="top"><b>Diagnostyka:</b> czy każde narzędzie jest zainstalowane i w jakim stanie jest każde konto; raport bez nazw i folderów do skopiowania lub zapisania.</td>
<td></td>
</tr>
</table>

## Obsługiwane narzędzia

| Narzędzie   | Skąd pochodzi limit                                                       | Sesje do przekazania                           | Uruchamianie                             |
| ----------- | ------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Claude Code | Punkt końcowy użycia OAuth profilu (Pęk kluczy w macOS)                   | `~/.claude/projects`                           | CLI `claude` z wybranym profilem         |
| Codex       | Metody limitów app-servera zainstalowanego CLI                            | `~/.codex/sessions`                            | CLI `codex`                              |
| Cursor      | Podsumowanie użycia zalogowanej sesji                                     | Czaty Cursor Agent CLI (`~/.cursor/chats`)     | `cursor-agent`, w przeciwnym razie aplikacja |
| Antigravity | Lokalna usługa działającej aplikacji (proces i port zweryfikowane)        | `~/.gemini/antigravity-ide`                    | Aplikacja Antigravity                    |

Listy modeli pochodzą z danych każdego narzędzia: aliasy Claude Code i używane przez Ciebie modele, pamięć podręczna
modeli Codex oraz `cursor-agent --list-models` (przechowywane przez 24 godziny).

## Prywatność i bezpieczeństwo

Istniejące dane logowania są odczytywane w pamięci; dokumenty mogą zawierać tokeny dostępu i odświeżania. Aplikacja sprawdza obecność tokenu odświeżania, ale nie zapisuje go we własnych danych. Odnowienie wykonuje Claude Code.

Ustawienia, etykiety kont, ścieżki, historia limitów i ostatnie pomiary pozostają na lokalnym dysku. Kontynuacja na innym koncie kopiuje całą rozmowę. `VIBE_HANDOVER.md` zawiera oczyszczony kontekst rozmowy; nie da się zagwarantować rozpoznania wszystkich formatów sekretów. Sprawdź podgląd przed przekazaniem. Plik już śledzony przez Git lub błąd wykluczenia z Git wstrzymuje przekazanie. Cursor zachowuje własne pytania o zaufanie.

Limity są pobierane z usług dostawców, a wersje sprawdzane w GitHub. Pobranie i instalacja aktualizacji to osobne działania użytkownika. Zobacz [Prywatność i dane lokalne](../PRIVACY.md).

## Instalacja

### Windows

Pobierz `Vibe-Usage-<wersja>-win-setup.exe` z [najnowszego wydania](https://github.com/mustafacagri/vibe-usage/releases/latest) i uruchom: instaluje się tylko dla Twojego użytkownika, bez uprawnień administratora. Albo weź przenośny `Vibe-Usage-<wersja>-win-x64.zip` (lub `-arm64`), rozpakuj i uruchom `Vibe Usage.exe`. Obsługiwana podpisana instalacja pobiera aktualizację po kliknięciu **Pobierz**, a instaluje ją po wybraniu **Uruchom ponownie, aby zaktualizować**. Wersja przenośna wskazuje każdą nową wersję. Aplikacja działa w zasobniku systemowym.

Aplikacja nie jest podpisana, więc przy pierwszym uruchomieniu Windows SmartScreen może wyświetlić **System Windows ochronił ten komputer**. Kliknij **Więcej informacji**, a potem **Uruchom mimo to**.

### macOS

Pobierz `Vibe-Usage-<wersja>-mac-arm64.dmg` (Apple silicon; Intel: `-mac-x64.dmg`) z [najnowszego wydania](https://github.com/mustafacagri/vibe-usage/releases/latest), otwórz i przeciągnij **Vibe Usage** do Aplikacji. Aplikacja nie jest jeszcze podpisana Apple Developer ID, więc Gatekeeper blokuje pierwsze uruchomienie: otwórz **Ustawienia systemowe › Prywatność i ochrona** i kliknij **Otwórz mimo to** albo uruchom:

```sh
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

Aby pominąć ten krok, zbuduj ją sam. Wystarczy Node.js 24:

```sh
git clone https://github.com/mustafacagri/vibe-usage.git && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

Na Macu z procesorem Intel folder to `release/mac`. Samodzielnie zbudowana aplikacja nie trafia do kwarantanny i otwiera się od razu. macOS pozwala zastąpić się tylko podpisanej aplikacji, więc nową wersję instaluje się tak samo: przycisk **Pobierz** w aplikacji pobiera obraz dysku dla Twojego Maca.

## Wiersz poleceń

Te same dane są dostępne w terminalu, w systemach Windows i macOS, z aplikacją desktopową lub bez niej. Wymaga Node.js 24 lub nowszego; CLI czyta te same zalogowane sesje co aplikacja, a gdy obie są zainstalowane, dzielą ustawienia i język.

```sh
npm install -g vibe-usage-cli
vibe-usage status
```

<img src="../media/cli.png" width="640" alt="vibe-usage status w terminalu: wszystkie okna dwóch kont Claude, dwóch Codex, jednego Cursor i dwóch Antigravity" />

```sh
vibe-usage status [--json]   # limit wszystkich kont, jednorazowo; --json dla skryptów
vibe-usage watch             # to samo, odświeżane do Ctrl+C
vibe-usage run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
vibe-usage handover [--from TOOL] [--to TOOL] [--session ID] [--cwd PATH]
vibe-usage help
```

Aby wypróbować bez instalacji, uruchom `npx vibe-usage-cli status`.

`run` uruchamia narzędzie w tym terminalu na koncie ze zweryfikowanym limitem; w przeciwnym razie wskaż konto przez `--account` (identyfikatory są w `status --json`). `--dry-run` wypisuje konto i polecenie, niczego nie uruchamiając. `handover` zapisuje `VIBE_HANDOVER.md` dla najnowszej sesji folderu (lub `--session`) i otwiera z nim narzędzie docelowe.

## Rozwój

Polecenia, strukturę projektu i zmienne środowiskowe opisuje
[sekcja „Development” angielskiego README](../../README.md#development).

## Ograniczenia

- Wersja na macOS nie jest notaryzowana (zobacz [macOS](#macos)).
- Model sesji Antigravity pochodzi z nieudokumentowanego lokalnego zapisu; jeśli nie da się go odczytać, pozostaje pusty.
- Czatów z Cursor IDE (Composer) nie można przekazać; odczytywane są tylko sesje Cursor Agent CLI.

## Licencja

[MIT](../../LICENSE)
