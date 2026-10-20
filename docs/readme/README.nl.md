<div align="center">

[English](../../README.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Português](README.pt.md) · **Nederlands** · [Polski](README.pl.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [Русский](README.ru.md)

<img src="../../assets/icon.png" width="96" alt="" />

# Vibe Usage

**Al je betaalde AI-codeerabonnementen in één menubalkvenster.**

Zie hoeveel quotum Claude Code, Codex, Cursor en Antigravity nog hebben, start de tool die nog ruimte heeft en geef een
half afgemaakte taak door aan een andere tool zonder alles opnieuw uit te leggen.

Windows-systeemvak · macOS-menubalk · 13 talen · geen wachtwoorden, geen opgeslagen tokens

**[Downloaden voor Windows en macOS](https://github.com/mustafacagri/vibe-usage/releases/latest)** · Terminal: [`npm install -g vibe-usage-cli`](https://www.npmjs.com/package/vibe-usage-cli)

<img src="../media/demo.gif" width="400" alt="Rondleiding door Vibe Usage: wisselen tussen accounts, alle accounts naast elkaar, de compacte weergave, Slimme Start en Overdragen" />

<sub>[Bekijk in volle resolutie (MP4)](../media/demo.mp4)</sub>

</div>

> Deze vertaling kan achterlopen op de Engelse README; de [Engelse versie](../../README.md) is leidend.

## Waarom

Wie met meerdere AI-tools programmeert, loopt steeds tegen dezelfde muur: de limiet van 5 uur raakt midden in een taak
op, je opent een andere tool en begint alles opnieuw uit te leggen. Elke aanbieder toont het gebruik op een andere
plek, en sommige helemaal niet.

Vibe Usage leest de sessies die al op je computer zijn aangemeld en toont alle limieten naast elkaar: hoeveel er over is
en wanneer het wordt gereset. Raakt een tool bijna op, dan start het de volgende met geverifieerd quotum in je
projectmap en schrijft het een samenvatting van de huidige sessie, zodat de nieuwe tool verdergaat waar de oude stopte.

## Functies

<table>
<tr>
<td width="50%" valign="top">

### Quota in één oogopslag

Elke limiet van elk account: vensters van 5 uur en per week, quota per model, bestedingsbudgetten. Aftellers tonen
wanneer elk wordt gereset. Mislukt een verversing, dan blijft de laatste meting zichtbaar en wordt duidelijk als
verouderd gemarkeerd. Onbekende waarden worden nooit als vol quotum getoond. Beweeg over het systeemvakpictogram om te
zien wat elke tool nog heeft; kies desgewenst voor een melding wanneer een limiet bijna op is of weer beschikbaar wordt.
De app kan openen bij aanmelden.

</td>
<td width="50%" valign="top">

<img src="../media/main.png" width="100%" alt="Quotumkaarten voor Claude, Codex, Cursor en Antigravity, met de accounts van elke tool naast elkaar" />

<img src="../media/compact.png" width="100%" alt="De compacte weergave: één regel per account" />

</td>
</tr>
<tr>
<td valign="top">

### Slimme Start

Kiest de eerste tool in je prioriteitsvolgorde waarvan het quotum **geverifieerd** ruimte heeft en opent die in een
nieuwe terminal in de gekozen projectmap. Kan geen enkele tool worden geverifieerd, dan zegt het dat in plaats van te
gokken.

</td>
<td valign="top">

<img src="../media/smart-launch.png" width="100%" alt="Slimme Start raadt Codex aan omdat de limiet van 5 uur van Claude bijna op is" />

</td>
</tr>
<tr>
<td valign="top">

### Overdragen

Kies een sessie uit Claude Code, Codex, Cursor Agent of Antigravity. `VIBE_HANDOVER.md` bevat doel, laatste verzoek, recent gesprek, bestandsverwijzingen en Git-branch/HEAD-metadata; de werkboom wordt niet gescand. De voorvertoning legt de fysieke bron, het account en de versie vast. Een gewijzigde bron vraagt een nieuwe voorvertoning. Sessies die naar een worktree zijn verplaatst staan bij het juiste project.

</td>
<td valign="top">

<img src="../media/handover.png" width="100%" alt="Overdrachtsvenster dat een Claude-sessie naar Codex verplaatst" />

</td>
</tr>
<tr>
<td valign="top">

### Meerdere accounts

Claude en Codex bewaren één aanmelding per profielmap. **Account toevoegen** maakt een nieuwe map en opent daar de
aanmelding van de tool; `~/.claude-*`- en `~/.codex-*`-mappen die je zelf hebt gemaakt, worden automatisch gevonden. Elk
account wordt getoond met het e-mailadres waarmee het is aangemeld, en ook elk aangemeld Antigravity-account wordt apart
gevolgd. Kies het hoofdaccount, start Claude Code met een bepaald account en stel per tool de terugvalvolgorde en het
voorkeursmodel in.
Een aanmelding die niet binnen tien minuten klaar is, haalt het account weer weg; het volgende account hergebruikt de map.

</td>
<td valign="top">

<img src="../media/settings.png" width="100%" alt="Instellingen: gekoppelde accounts, twee voor Claude en twee voor Codex" />

</td>
</tr>
</table>

### Instellingen, geschiedenis en diagnose

<table>
<tr>
<td width="33%" valign="top"><img src="../media/settings-general.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-continue.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-order.png" width="100%" alt="" /></td>
</tr>
<tr>
<td valign="top"><b>Algemeen:</b> openen bij aanmelden, meldingen bij je lage-quotumgrens, stille uren, accounts naast elkaar en de updatecontrole.</td>
<td valign="top"><b>Als een limiet op is:</b> alleen voorstellen, doorgaan op de andere accounts van de tool, of daarna op de andere tools in reservevolgorde; ook per project.</td>
<td valign="top"><b>Volgorde en modellen:</b> hoe tools worden getoond, welke het daarna overneemt, met welk model elk start en hoe vaak het quotum wordt gelezen.</td>
</tr>
<tr>
<td width="33%" valign="top"><img src="../media/history.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/diagnostics.png" width="100%" alt="" /></td>
<td></td>
</tr>
<tr>
<td valign="top"><b>Overdrachtsgeschiedenis:</b> welk werk van welk account naar welk ging; probeer een mislukte met één klik opnieuw.</td>
<td valign="top"><b>Diagnose:</b> of elke tool is geïnstalleerd en hoe elk account ervoor staat; een rapport zonder namen of mappen om te kopiëren of op te slaan.</td>
<td></td>
</tr>
</table>

## Ondersteunde tools

| Tool        | Waar het quotum vandaan komt                                              | Sessies om over te dragen                      | Starten                                  |
| ----------- | ------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Claude Code | OAuth-gebruiksendpoint van het profiel (Sleutelhanger op macOS)           | `~/.claude/projects`                           | `claude` CLI met het gekozen profiel     |
| Codex       | Limietmethoden van de app-server van de geïnstalleerde CLI                | `~/.codex/sessions`                            | `codex` CLI                              |
| Cursor      | Gebruiksoverzicht van de aangemelde sessie                                | Cursor Agent CLI-chats (`~/.cursor/chats`)     | `cursor-agent`, anders de app            |
| Antigravity | Lokale dienst van de draaiende app (proces en poort geverifieerd)         | `~/.gemini/antigravity-ide`                    | Antigravity-app                          |

Modellijsten komen uit de eigen gegevens van elke tool: Claude Code-aliassen en de modellen die je gebruikte, de
modelcache van Codex en `cursor-agent --list-models` (24 uur gecachet).

## Privacy en veiligheid

Bestaande aanmeldgegevens worden in het geheugen gelezen; de documenten kunnen toegangs- en vernieuwingstokens bevatten. De app controleert of er een vernieuwingstoken is, maar slaat het niet op in eigen gegevens. Claude Code voert de vernieuwing uit.

Instellingen, accountlabels, paden, quotumgeschiedenis en laatste metingen blijven op de lokale schijf. Doorgaan met een ander account kopieert het volledige gesprek. `VIBE_HANDOVER.md` bevat opgeschoonde gesprekscontext; niet elk geheim formaat kan worden herkend. Bekijk de voorvertoning vóór de overdracht. Een bestand dat Git al volgt of een mislukte Git-uitsluiting stopt de overdracht. Cursor behoudt zijn eigen vertrouwensvragen.

Quotumverzoeken gaan naar de aanbieder en versiecontroles naar GitHub. Downloaden en installeren zijn afzonderlijke gebruikersacties. Zie [Privacy en lokale gegevens](../PRIVACY.md).

## Installatie

### Windows

Download `Vibe-Usage-<versie>-win-setup.exe` uit de [nieuwste release](https://github.com/mustafacagri/vibe-usage/releases/latest) en voer het uit: het installeert alleen voor jouw gebruiker, zonder beheerdersrechten. Of neem de draagbare `Vibe-Usage-<versie>-win-x64.zip` (of `-arm64`), pak hem uit en start `Vibe Usage.exe`. Een ondersteunde ondertekende installatie downloadt een update na een klik op **Downloaden** en installeert die met **Herstarten om bij te werken**. De draagbare kopie linkt naar elke nieuwe versie. De app staat in het systeemvak.

De app is niet ondertekend, dus bij de eerste start kan Windows SmartScreen **Uw pc is beveiligd door Windows** tonen. Klik op **Meer informatie** en daarna op **Toch uitvoeren**.

### macOS

Download `Vibe-Usage-<versie>-mac-arm64.dmg` (Apple silicon; Intel: `-mac-x64.dmg`) uit de [nieuwste release](https://github.com/mustafacagri/vibe-usage/releases/latest), open hem en sleep **Vibe Usage** naar Apps. De app is nog niet ondertekend met een Apple Developer ID, dus Gatekeeper blokkeert de eerste start: open **Systeeminstellingen › Privacy en beveiliging** en klik op **Open toch**, of voer uit:

```sh
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

Om die stap over te slaan, bouw je hem zelf. Je hebt alleen Node.js 24 nodig:

```sh
git clone https://github.com/mustafacagri/vibe-usage.git && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

Op een Intel-Mac heet de map `release/mac`. Een app die je zelf bouwt, staat niet in quarantaine en opent direct. macOS laat alleen een ondertekende app zichzelf vervangen, dus een nieuwe versie installeer je op dezelfde manier: de knop **Downloaden** in de app haalt de schijfkopie voor jouw Mac op.

## Opdrachtregel

Dezelfde gegevens zijn beschikbaar in de terminal, op Windows en macOS, met of zonder de desktop-app. Je hebt Node.js 24 of nieuwer nodig; de CLI leest dezelfde aangemelde sessies als de app en als beide zijn geïnstalleerd, delen ze instellingen en taal.

```sh
npm install -g vibe-usage-cli
vibe-usage status
```

<img src="../media/cli.png" width="640" alt="vibe-usage status in een terminal: alle vensters van twee Claude-, twee Codex-, één Cursor- en twee Antigravity-accounts" />

```sh
vibe-usage status [--json]   # het quotum van alle accounts, één keer; --json voor scripts
vibe-usage watch             # hetzelfde, ververst tot Ctrl+C
vibe-usage run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
vibe-usage handover [--from TOOL] [--to TOOL] [--session ID] [--cwd PATH]
vibe-usage help
```

Probeer het zonder installatie met `npx vibe-usage-cli status`.

`run` start de tool in deze terminal met een account met geverifieerd quotum; noem anders een account met `--account` (de ID’s staan in `status --json`). `--dry-run` toont account en opdracht zonder iets te starten. `handover` schrijft `VIBE_HANDOVER.md` voor de nieuwste sessie van de map (of `--session`) en opent daarmee de doeltool.

## Ontwikkeling

Opdrachten, projectstructuur en omgevingsvariabelen staan in de
[sectie "Development" van de Engelse README](../../README.md#development).

## Beperkingen

- De macOS-build is niet genotariseerd (zie [macOS](#macos)).
- Het model van een Antigravity-sessie komt uit een ongedocumenteerd lokaal record; als dat niet leesbaar is, blijft het
  model leeg.
- Chats uit Cursor IDE (Composer) kunnen niet worden overgedragen; alleen sessies van Cursor Agent CLI worden gelezen.

## Licentie

[MIT](../../LICENSE)
