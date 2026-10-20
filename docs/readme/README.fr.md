<div align="center">

[English](../../README.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · **Français** · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [Русский](README.ru.md)

<img src="../../assets/icon.png" width="96" alt="" />

# Vibe Usage

**Tous vos abonnements de code par IA, dans une seule fenêtre de la barre des menus.**

Voyez le quota restant sur Claude Code, Codex, Cursor et Antigravity, lancez l'outil qui a encore de la marge et passez
une tâche à moitié faite d'un outil à l'autre sans avoir à la réexpliquer.

Zone de notification Windows · barre des menus macOS · 13 langues · aucun mot de passe, aucun jeton conservé

**[Télécharger pour Windows et macOS](https://github.com/mustafacagri/vibe-usage/releases/latest)** · Terminal: [`npm install -g vibe-usage-cli`](https://www.npmjs.com/package/vibe-usage-cli)

<img src="../media/demo.gif" width="400" alt="Démonstration de Vibe Usage : changement de compte, tous les comptes côte à côte, la vue compacte, Lancement Intelligent et Transférer" />

<sub>[Voir en pleine résolution (MP4)](../media/demo.mp4)</sub>

</div>

> Cette traduction peut être en retard sur le README anglais ; la [version anglaise](../../README.md) fait foi.

## Pourquoi

Si vous codez avec plusieurs outils d'IA, vous butez sans cesse sur le même mur : la limite de 5 heures s'épuise en
pleine tâche, vous ouvrez un autre outil et vous réexpliquez tout depuis le début. Chaque fournisseur affiche son usage à
un endroit différent, quand il l'affiche.

Vibe Usage lit les sessions déjà connectées sur votre machine et affiche toutes les limites côte à côte : ce qui reste et
quand cela se réinitialise. Quand un outil arrive à court, il lance le suivant dont le quota est vérifié dans votre
dossier de projet, et rédige un résumé de la session en cours pour que le nouvel outil reprenne là où l'ancien s'est
arrêté.

## Fonctionnalités

<table>
<tr>
<td width="50%" valign="top">

### Les quotas d'un coup d'œil

Chaque limite de chaque compte : fenêtres de 5 heures et hebdomadaires, quotas par modèle, enveloppes de dépenses. Des
comptes à rebours indiquent quand chacune se réinitialise. Si une actualisation échoue, la dernière mesure reste visible
et est clairement marquée comme périmée. Une valeur inconnue n'est jamais affichée comme un quota plein. Survolez
l’icône de la barre pour voir ce qu’il reste à chaque outil ; activez si vous le souhaitez une notification quand une
limite s’épuise ou redevient disponible. L’app peut s’ouvrir à l’ouverture de session.

</td>
<td width="50%" valign="top">

<img src="../media/main.png" width="100%" alt="Cartes de quota pour Claude, Codex, Cursor et Antigravity, les comptes de chaque outil côte à côte" />

<img src="../media/compact.png" width="100%" alt="La vue compacte : une ligne par compte" />

</td>
</tr>
<tr>
<td valign="top">

### Lancement Intelligent

Choisit le premier outil de votre ordre de priorité dont le quota a une marge **vérifiée**, puis l'ouvre dans un
nouveau terminal dans le dossier de projet choisi. Si aucun outil ne peut être vérifié, il le dit au lieu de deviner.

</td>
<td valign="top">

<img src="../media/smart-launch.png" width="100%" alt="Le Lancement Intelligent recommande Codex car la limite de 5 heures de Claude est presque épuisée" />

</td>
</tr>
<tr>
<td valign="top">

### Transférer

Choisissez une session Claude Code, Codex, Cursor Agent ou Antigravity. `VIBE_HANDOVER.md` contient l’objectif, la dernière demande, les échanges récents, les références aux fichiers et les métadonnées de branche/HEAD Git ; l’arbre de travail n’est pas analysé. L’aperçu fixe la source physique, le compte et la version. Toute modification de la source nécessite un nouvel aperçu. Les sessions déplacées dans un worktree figurent sous le bon projet.

</td>
<td valign="top">

<img src="../media/handover.png" width="100%" alt="Fenêtre de transfert d'une session Claude vers Codex" />

</td>
</tr>
<tr>
<td valign="top">

### Plusieurs comptes

Claude et Codex gardent une connexion par dossier de profil. **Ajouter un compte** crée un nouveau dossier et y ouvre la
connexion de l'outil ; les dossiers `~/.claude-*` et `~/.codex-*` que vous avez créés vous-même sont détectés
automatiquement. Chaque compte est affiché avec l'e-mail de sa connexion, et chaque compte Antigravity connecté est
aussi suivi séparément. Choisissez le compte principal, lancez Claude Code avec un compte précis, et définissez l'ordre
de repli et le modèle préféré de chaque outil.
Une connexion non terminée en dix minutes retire de nouveau le compte, et le compte suivant réutilise son dossier.

</td>
<td valign="top">

<img src="../media/settings.png" width="100%" alt="Paramètres : comptes connectés, deux pour Claude et deux pour Codex" />

</td>
</tr>
</table>

### Réglages, historique et diagnostic

<table>
<tr>
<td width="33%" valign="top"><img src="../media/settings-general.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-continue.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-order.png" width="100%" alt="" /></td>
</tr>
<tr>
<td valign="top"><b>Général :</b> ouverture à la connexion, notifications à votre seuil de quota bas, heures calmes, comptes côte à côte et recherche de mises à jour.</td>
<td valign="top"><b>Quand une limite est atteinte :</b> seulement le suggérer, continuer sur les autres comptes de l’outil, ou ensuite sur les autres outils par ordre de relais ; aussi par projet.</td>
<td valign="top"><b>Ordre et modèles :</b> l’ordre d’affichage des outils, celui qui prend le relais, le modèle de départ de chacun et la fréquence de lecture du quota.</td>
</tr>
<tr>
<td width="33%" valign="top"><img src="../media/history.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/diagnostics.png" width="100%" alt="" /></td>
<td></td>
</tr>
<tr>
<td valign="top"><b>Historique des transferts :</b> quel travail est passé de quel compte à quel autre ; relancez un échec en un clic.</td>
<td valign="top"><b>Diagnostic :</b> si chaque outil est installé et l’état de chaque compte ; un rapport sans noms ni dossiers à copier ou enregistrer.</td>
<td></td>
</tr>
</table>

## Outils pris en charge

| Outil       | Origine du quota                                                          | Sessions à transférer                         | Lancement                              |
| ----------- | ------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| Claude Code | Point d'accès d'usage OAuth du profil (Trousseau sur macOS)               | `~/.claude/projects`                          | CLI `claude` avec le profil choisi     |
| Codex       | Méthodes de limites de l'app-server de la CLI installée                   | `~/.codex/sessions`                           | CLI `codex`                            |
| Cursor      | Résumé d'usage de la session connectée                                    | Discussions Cursor Agent CLI (`~/.cursor/chats`) | `cursor-agent`, sinon l'application |
| Antigravity | Service local de l'application en cours (processus et port vérifiés)      | `~/.gemini/antigravity-ide`                   | Application Antigravity                |

Les listes de modèles viennent des données propres à chaque outil : les alias de Claude Code et les modèles que vous avez
utilisés, le cache de modèles de Codex et `cursor-agent --list-models` (mis en cache 24 heures).

## Confidentialité et sécurité

Les identifiants existants sont lus en mémoire ; leurs documents peuvent contenir des jetons d’accès et d’actualisation. L’app vérifie la présence d’un jeton d’actualisation sans l’enregistrer dans ses propres données. Le renouvellement est effectué par Claude Code.

Les réglages, noms de comptes, chemins, historique des quotas et dernières mesures restent sur le disque local. Continuer sur un autre compte copie la conversation complète. `VIBE_HANDOVER.md` contient du contexte expurgé ; tous les formats de secrets ne peuvent pas être reconnus. Vérifiez l’aperçu avant le transfert. Un fichier déjà suivi par Git ou un échec d’exclusion bloque le transfert. Cursor conserve ses propres demandes de confiance.

Les quotas utilisent les points d’accès des fournisseurs, les versions sont vérifiées sur GitHub. Le téléchargement et l’installation sont deux actions distinctes de l’utilisateur. Consultez [Confidentialité et données locales](../PRIVACY.md).

## Installation

### Windows

Téléchargez `Vibe-Usage-<version>-win-setup.exe` depuis la [dernière version](https://github.com/mustafacagri/vibe-usage/releases/latest) et lancez-le : il s’installe pour votre seul utilisateur, sans droits d’administrateur. Ou prenez le portable `Vibe-Usage-<version>-win-x64.zip` (ou `-arm64`), décompressez-le et lancez `Vibe Usage.exe`. Une installation signée compatible télécharge la mise à jour après un clic sur **Télécharger**, puis l’installe avec **Redémarrer pour mettre à jour**. La copie portable renvoie vers chaque nouvelle version. L’app vit dans la zone de notification.

L'application n'est pas signée ; au premier lancement, Windows SmartScreen peut afficher **Windows a protégé votre ordinateur**. Cliquez sur **Informations complémentaires**, puis sur **Exécuter quand même**.

### macOS

Téléchargez `Vibe-Usage-<version>-mac-arm64.dmg` (Apple silicon ; Intel : `-mac-x64.dmg`) depuis la [dernière version](https://github.com/mustafacagri/vibe-usage/releases/latest), ouvrez-le et glissez **Vibe Usage** dans Applications. L’app n’est pas encore signée avec un Apple Developer ID, donc Gatekeeper bloque le premier lancement : ouvrez **Réglages Système › Confidentialité et sécurité** et cliquez sur **Ouvrir quand même**, ou exécutez :

```sh
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

Pour éviter cette étape, compilez-la vous-même. Il suffit de Node.js 24 :

```sh
git clone https://github.com/mustafacagri/vibe-usage.git && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

Sur un Mac Intel, le dossier est `release/mac`. Une app compilée par vous n’est pas mise en quarantaine et s’ouvre directement. macOS ne laisse qu’une app signée se remplacer elle-même ; chaque nouvelle version s’installe donc de la même façon : le bouton **Télécharger** de l’app récupère l’image disque adaptée à votre Mac.

## Ligne de commande

Les mêmes données sont disponibles dans le terminal, sous Windows et macOS, avec ou sans l’app de bureau. Il faut Node.js 24 ou plus récent ; la CLI lit les mêmes sessions connectées que l’app et, si les deux sont installées, elles partagent réglages et langue.

```sh
npm install -g vibe-usage-cli
vibe-usage status
```

<img src="../media/cli.png" width="640" alt="vibe-usage status dans un terminal : toutes les fenêtres de deux comptes Claude, deux Codex, un Cursor et deux Antigravity" />

```sh
vibe-usage status [--json]   # le quota de tous les comptes, une fois ; --json pour les scripts
vibe-usage watch             # la même chose, actualisée jusqu’à Ctrl+C
vibe-usage run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
vibe-usage handover [--from TOOL] [--to TOOL] [--session ID] [--cwd PATH]
vibe-usage help
```

Pour l’essayer sans l’installer : `npx vibe-usage-cli status`.

`run` lance l’outil dans ce terminal avec un compte dont le quota est vérifié ; sinon, indiquez-en un avec `--account` (les ID figurent dans `status --json`). `--dry-run` affiche le compte et la commande sans rien lancer. `handover` écrit `VIBE_HANDOVER.md` pour la session la plus récente du dossier (ou `--session`) et ouvre l’outil cible avec.

## Développement

Les commandes, la structure du projet et les variables d'environnement sont dans la
[section « Development » du README anglais](../../README.md#development).

## Limites

- La version macOS n'est pas notarisée (voir [macOS](#macos)).
- Le modèle d'une session Antigravity provient d'un enregistrement local non documenté ; s'il est illisible, le modèle
  reste vide.
- Les discussions de Cursor IDE (Composer) ne peuvent pas être transférées ; seules les sessions Cursor Agent CLI sont
  lues.

## Licence

[MIT](../../LICENSE)
