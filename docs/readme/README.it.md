<div align="center">

[English](../../README.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · **Italiano** · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [Русский](README.ru.md)

<img src="../../assets/icon.png" width="96" alt="" />

# Vibe Usage

**Tutti gli abbonamenti di programmazione con IA che paghi, in un'unica finestra della barra dei menu.**

Guarda quanta quota resta a Claude Code, Codex, Cursor e Antigravity, avvia lo strumento che ha ancora margine e passa un
lavoro a metà da uno strumento all'altro senza doverlo rispiegare.

Area di notifica di Windows · barra dei menu di macOS · 13 lingue · nessuna password, nessun token salvato

**[Scarica per Windows e macOS](https://github.com/mustafacagri/vibe-usage/releases/latest)** · Terminale: [`npm install -g vibe-usage-cli`](https://www.npmjs.com/package/vibe-usage-cli)

<img src="../media/demo.gif" width="400" alt="Panoramica di Vibe Usage: cambio di account, tutti gli account affiancati, la vista compatta, Avvio Intelligente e Trasferisci" />

<sub>[Guarda a piena risoluzione (MP4)](../media/demo.mp4)</sub>

</div>

> Questa traduzione può essere indietro rispetto al README in inglese; fa fede la [versione inglese](../../README.md).

## Perché

Se programmi con più strumenti di IA, sbatti sempre contro lo stesso muro: il limite di 5 ore finisce a metà lavoro,
apri un altro strumento e ricominci a spiegare tutto da capo. Ogni fornitore mostra l'utilizzo in un posto diverso, e
alcuni non lo mostrano affatto.

Vibe Usage legge le sessioni già attive sul tuo computer e mostra tutti i limiti fianco a fianco: quanto resta e quando
si azzera. Quando uno strumento sta per esaurirsi, avvia il successivo con quota verificata nella cartella del progetto
e scrive un riepilogo della sessione corrente, così il nuovo strumento riprende da dove si era fermato il precedente.

## Funzionalità

<table>
<tr>
<td width="50%" valign="top">

### Quote a colpo d'occhio

Ogni limite di ogni account: finestre di 5 ore e settimanali, quote per modello, budget di spesa. I conti alla rovescia
indicano quando ciascuno si azzera. Se un aggiornamento fallisce, l'ultima lettura resta visibile ed è chiaramente
segnata come non aggiornata. I valori sconosciuti non vengono mai mostrati come quota piena. Passa sopra l’icona nella
barra per vedere quanto resta a ogni strumento; se vuoi, ricevi una notifica quando un limite sta per esaurirsi o torna
disponibile. L’app può aprirsi all’accesso.

</td>
<td width="50%" valign="top">

<img src="../media/main.png" width="100%" alt="Schede delle quote di Claude, Codex, Cursor e Antigravity, con gli account di ogni strumento affiancati" />

<img src="../media/compact.png" width="100%" alt="La vista compatta: una riga per account" />

</td>
</tr>
<tr>
<td valign="top">

### Avvio Intelligente

Sceglie il primo strumento nel tuo ordine di priorità con margine **verificato** sulla quota e lo apre in un nuovo
terminale nella cartella di progetto scelta. Se nessuno strumento può essere verificato, lo dice invece di tirare a
indovinare.

</td>
<td valign="top">

<img src="../media/smart-launch.png" width="100%" alt="L'Avvio Intelligente consiglia Codex perché il limite di 5 ore di Claude è quasi esaurito" />

</td>
</tr>
<tr>
<td valign="top">

### Trasferisci

Scegli una sessione Claude Code, Codex, Cursor Agent o Antigravity. `VIBE_HANDOVER.md` contiene obiettivo, ultima richiesta, conversazione recente, riferimenti ai file e metadati di ramo/HEAD Git; l’albero di lavoro non viene analizzato. L’anteprima fissa sorgente fisica, account e versione. Se la sorgente cambia serve una nuova anteprima. Le sessioni spostate in un worktree appaiono nel progetto corretto.

</td>
<td valign="top">

<img src="../media/handover.png" width="100%" alt="Finestra di trasferimento di una sessione Claude a Codex" />

</td>
</tr>
<tr>
<td valign="top">

### Più account

Claude e Codex conservano un accesso per cartella del profilo. **Aggiungi account** crea una nuova cartella e vi apre
l'accesso dello strumento; le cartelle `~/.claude-*` e `~/.codex-*` create da te vengono trovate automaticamente. Ogni
account è mostrato con l'e-mail con cui ha effettuato l'accesso, e anche ogni account Antigravity connesso viene seguito
separatamente. Scegli l'account principale, avvia Claude Code con un account specifico e imposta l'ordine di riserva e
il modello preferito per ogni strumento.
Un accesso non completato entro dieci minuti rimuove di nuovo l'account, e l'account successivo ne riusa la cartella.

</td>
<td valign="top">

<img src="../media/settings.png" width="100%" alt="Impostazioni: account collegati, due per Claude e due per Codex" />

</td>
</tr>
</table>

### Impostazioni, cronologia e diagnostica

<table>
<tr>
<td width="33%" valign="top"><img src="../media/settings-general.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-continue.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-order.png" width="100%" alt="" /></td>
</tr>
<tr>
<td valign="top"><b>Generale:</b> avvio all’accesso, notifiche alla tua soglia di quota bassa, ore silenziose, account affiancati e controllo degli aggiornamenti.</td>
<td valign="top"><b>Quando un limite si esaurisce:</b> solo suggerirlo, continuare sugli altri account dello strumento o poi sugli altri strumenti in ordine di riserva; anche per progetto.</td>
<td valign="top"><b>Ordine e modelli:</b> come sono elencati gli strumenti, quale subentra dopo, con quale modello parte ciascuno e ogni quanto si legge la quota.</td>
</tr>
<tr>
<td width="33%" valign="top"><img src="../media/history.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/diagnostics.png" width="100%" alt="" /></td>
<td></td>
</tr>
<tr>
<td valign="top"><b>Cronologia dei passaggi:</b> quale lavoro è passato da quale account a quale; riprova uno fallito con un clic.</td>
<td valign="top"><b>Diagnostica:</b> se ogni strumento è installato e come sta ogni account; un report senza nomi né cartelle da copiare o salvare.</td>
<td></td>
</tr>
</table>

## Strumenti supportati

| Strumento   | Da dove arriva la quota                                                    | Sessioni da trasferire                         | Avvio                                    |
| ----------- | -------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Claude Code | Endpoint di utilizzo OAuth del profilo (Portachiavi su macOS)              | `~/.claude/projects`                           | CLI `claude` con il profilo scelto       |
| Codex       | Metodi dei limiti dell'app-server della CLI installata                     | `~/.codex/sessions`                            | CLI `codex`                              |
| Cursor      | Riepilogo di utilizzo della sessione connessa                              | Chat di Cursor Agent CLI (`~/.cursor/chats`)   | `cursor-agent`, altrimenti l'app         |
| Antigravity | Servizio locale dell'app in esecuzione (processo e porta verificati)       | `~/.gemini/antigravity-ide`                    | App Antigravity                          |

Gli elenchi dei modelli vengono dai dati di ogni strumento: gli alias di Claude Code e i modelli che hai usato, la cache
dei modelli di Codex e `cursor-agent --list-models` (in cache per 24 ore).

## Privacy e sicurezza

Le credenziali esistenti vengono lette in memoria; i documenti possono contenere token di accesso e aggiornamento. L’app verifica la presenza del token di aggiornamento, senza salvarlo nei propri dati. Il rinnovo viene eseguito da Claude Code.

Impostazioni, etichette degli account, percorsi, cronologia delle quote e ultime misurazioni restano sul disco locale. Continuare su un altro account copia l’intera conversazione. `VIBE_HANDOVER.md` contiene contesto ripulito, ma non è possibile riconoscere ogni formato di segreto. Controlla l’anteprima prima del trasferimento. Un file già tracciato da Git o un’esclusione fallita bloccano il trasferimento. Cursor conserva le proprie richieste di fiducia.

Le quote usano gli endpoint del fornitore e le versioni vengono controllate su GitHub. Download e installazione sono azioni separate dell’utente. Vedi [Privacy e dati locali](../PRIVACY.md).

## Installazione

### Windows

Scarica `Vibe-Usage-<versione>-win-setup.exe` dall’[ultima versione](https://github.com/mustafacagri/vibe-usage/releases/latest) ed eseguilo: si installa solo per il tuo utente, senza diritti di amministratore. Oppure usa il portatile `Vibe-Usage-<versione>-win-x64.zip` (o `-arm64`), estrailo ed esegui `Vibe Usage.exe`. Un’installazione firmata supportata scarica l’aggiornamento quando premi **Scarica** e lo installa con **Riavvia per aggiornare**. La copia portatile rimanda a ogni nuova versione. L’app vive nell’area di notifica.

L'app non è firmata, quindi al primo avvio Windows SmartScreen può mostrare **PC protetto da Windows**. Fai clic su **Ulteriori informazioni** e poi su **Esegui comunque**.

### macOS

Scarica `Vibe-Usage-<versione>-mac-arm64.dmg` (Apple silicon; Intel: `-mac-x64.dmg`) dall’[ultima versione](https://github.com/mustafacagri/vibe-usage/releases/latest), aprilo e trascina **Vibe Usage** in Applicazioni. L’app non è ancora firmata con un Apple Developer ID, quindi Gatekeeper blocca il primo avvio: apri **Impostazioni di Sistema › Privacy e sicurezza** e fai clic su **Apri comunque**, oppure esegui:

```sh
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

Per saltare questo passaggio, compilala tu. Serve solo Node.js 24:

```sh
git clone https://github.com/mustafacagri/vibe-usage.git && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

Su un Mac Intel la cartella è `release/mac`. Un’app compilata da te non finisce in quarantena e si apre direttamente. macOS lascia sostituirsi da sola solo un’app firmata, quindi ogni nuova versione si installa allo stesso modo: il pulsante **Scarica** dell’app scarica l’immagine disco adatta al tuo Mac.

## Riga di comando

Gli stessi dati sono disponibili nel terminale, su Windows e macOS, con o senza l’app desktop. Serve Node.js 24 o successivo; la CLI legge le stesse sessioni connesse dell’app e, se sono installate entrambe, condividono impostazioni e lingua.

```sh
npm install -g vibe-usage-cli
vibe-usage status
```

<img src="../media/cli.png" width="640" alt="vibe-usage status in un terminale: tutte le finestre di due account Claude, due Codex, uno Cursor e due Antigravity" />

```sh
vibe-usage status [--json]   # la quota di tutti gli account, una volta; --json per gli script
vibe-usage watch             # lo stesso, aggiornato fino a Ctrl+C
vibe-usage run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
vibe-usage handover [--from TOOL] [--to TOOL] [--session ID] [--cwd PATH]
vibe-usage help
```

Per provarlo senza installarlo, esegui `npx vibe-usage-cli status`.

`run` avvia lo strumento in questo terminale con un account con quota verificata; altrimenti indicane uno con `--account` (gli ID sono in `status --json`). `--dry-run` mostra l’account e il comando senza avviare nulla. `handover` scrive `VIBE_HANDOVER.md` per la sessione più recente della cartella (o `--session`) e apre con esso lo strumento di destinazione.

## Sviluppo

Comandi, struttura del progetto e variabili d'ambiente sono nella
[sezione "Development" del README in inglese](../../README.md#development).

## Limitazioni

- La build per macOS non è notarizzata (vedi [macOS](#macos)).
- Il modello di una sessione Antigravity viene da un record locale non documentato; se non è leggibile, resta vuoto.
- Le chat di Cursor IDE (Composer) non possono essere trasferite; vengono lette solo le sessioni di Cursor Agent CLI.

## Licenza

[MIT](../../LICENSE)
