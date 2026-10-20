<div align="center">

[English](../../README.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · **日本語** · [한국어](README.ko.md) · [简体中文](README.zh.md) · [Русский](README.ru.md)

<img src="../../assets/icon.png" width="96" alt="" />

# Vibe Usage

**契約しているすべての AI コーディングサブスクリプションを、ひとつのメニューバーウィンドウで。**

Claude Code、Codex、Cursor、Antigravity の残りクォータを確認し、まだ余裕のあるツールを起動して、作業途中のタスクを説明し直すことなく別のツールへ引き継げます。

Windows タスクトレイ · macOS メニューバー · 13 言語 · パスワード不要、トークンは保存しません

**[Windows・macOS 版をダウンロード](https://github.com/mustafacagri/vibe-usage/releases/latest)** · ターミナル: [`npm install -g vibe-usage-cli`](https://www.npmjs.com/package/vibe-usage-cli)

<img src="../media/demo.gif" width="400" alt="Vibe Usage の操作デモ: アカウントの切り替え、全アカウントの並列表示、コンパクト表示、スマート起動、引き継ぎ" />

<sub>[フル解像度で見る (MP4)](../media/demo.mp4)</sub>

</div>

> この翻訳は英語版 README より古い場合があります。[英語版](../../README.md)が正となります。

## なぜ必要か

複数の AI ツールでコーディングしていると、同じ壁に何度もぶつかります。作業の途中で 5 時間の上限に達し、別のツールを開いて、タスクを最初から説明し直すことになります。使用量の表示場所はサービスごとにばらばらで、表示されないものもあります。

Vibe Usage は、お使いのマシンですでにサインインしているセッションを読み取り、すべての上限を並べて表示します。残りがどれだけあり、いつリセットされるかがわかります。あるツールが残り少なくなると、クォータが確認できた次のツールをプロジェクトフォルダーで起動し、現在のセッションの要約を書き出します。新しいツールは前のツールが止まったところから作業を続けられます。

## 機能

<table>
<tr>
<td width="50%" valign="top">

### クォータをひと目で

すべてのアカウントのすべての上限: 5 時間枠と週間枠、モデル別の枠、利用額の枠。カウントダウンで各枠のリセットまでの時間がわかります。更新に失敗しても最後の計測値は表示されたままで、古いデータであることがはっきり示されます。不明な値が満タンのクォータとして表示されることはありません。トレイアイコンにポインターを合わせると各ツールの残りが表示されます。希望すれば、上限が少なくなったときや再び使えるようになったときに通知します。ログイン時に起動することもできます。

</td>
<td width="50%" valign="top">

<img src="../media/main.png" width="100%" alt="Claude、Codex、Cursor、Antigravity のクォータカード（各ツールのアカウントを並べて表示）" />

<img src="../media/compact.png" width="100%" alt="コンパクト表示: アカウントごとに 1 行" />

</td>
</tr>
<tr>
<td valign="top">

### スマート起動

優先順位の中で、クォータに余裕があることが**確認できた**最初のツールを選び、指定したプロジェクトフォルダーで新しいターミナルを開いて起動します。どのツールも確認できない場合は、推測せずにそう伝えます。

</td>
<td valign="top">

<img src="../media/smart-launch.png" width="100%" alt="Claude の 5 時間枠がほぼ尽きているため Codex を勧めるスマート起動" />

</td>
</tr>
<tr>
<td valign="top">

### 引き継ぎ

Claude Code、Codex、Cursor Agent、Antigravity のセッションを選びます。`VIBE_HANDOVER.md` には目的、最新の依頼、最近の会話、ファイル参照、Git のブランチ/HEAD 情報が入ります。作業ツリーは走査しません。プレビューは実際の保存元、アカウント、バージョンを固定し、元データが変わると再プレビューが必要です。worktree に移動したセッションは対応するプロジェクトに表示されます。

</td>
<td valign="top">

<img src="../media/handover.png" width="100%" alt="Claude のセッションを Codex に引き継ぐダイアログ" />

</td>
</tr>
<tr>
<td valign="top">

### 複数アカウント

Claude と Codex はプロファイルフォルダーごとに 1 つのサインインを保持します。**アカウントを追加** は新しいフォルダーを作成し、そこでツールのサインインを開きます。自分で作成した `~/.claude-*` と `~/.codex-*` のフォルダーも自動で見つかります。各アカウントはサインインしているメールアドレスで表示され、サインイン済みの各 Antigravity アカウントも個別に追跡します。メインアカウントの選択、特定のアカウントでの Claude Code の起動、ツールごとの代替順序と優先モデルの設定ができます。10 分以内にサインインが終わらなければアカウントは再び外され、次のアカウントがそのフォルダーを使います。

</td>
<td valign="top">

<img src="../media/settings.png" width="100%" alt="設定: 接続済みアカウント（Claude と Codex に 2 つずつ）" />

</td>
</tr>
</table>

### 設定・履歴・診断

<table>
<tr>
<td width="33%" valign="top"><img src="../media/settings-general.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-continue.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-order.png" width="100%" alt="" /></td>
</tr>
<tr>
<td valign="top"><b>一般:</b> ログイン時に起動、残量が少ないときの通知、通知しない時間帯、アカウントの横並び表示、更新の確認。</td>
<td valign="top"><b>上限に達したとき:</b> 提案のみ、同じツールの別アカウントで続行、さらにフォールバック順で他のツールへ。プロジェクトごとにも設定できます。</td>
<td valign="top"><b>順序とモデル:</b> ツールの表示順、次に引き継ぐツール、各ツールが起動時に使うモデル、クォータを読む間隔。</td>
</tr>
<tr>
<td width="33%" valign="top"><img src="../media/history.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/diagnostics.png" width="100%" alt="" /></td>
<td></td>
</tr>
<tr>
<td valign="top"><b>引き継ぎ履歴:</b> どの作業がどのアカウントからどこへ移ったか。失敗したものはワンクリックで再試行できます。</td>
<td valign="top"><b>診断:</b> 各ツールがインストールされているか、各アカウントの状態。名前やフォルダーを含まないレポートをコピー・保存できます。</td>
<td></td>
</tr>
</table>

## 対応ツール

| ツール      | クォータの取得元                                              | 引き継ぎ用のセッション                     | 起動                                 |
| ----------- | ------------------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| Claude Code | プロファイルの OAuth 使用量エンドポイント (macOS ではキーチェーン) | `~/.claude/projects`                    | 選んだプロファイルで `claude` CLI    |
| Codex       | インストール済み CLI の app-server のレート制限メソッド       | `~/.codex/sessions`                        | `codex` CLI                          |
| Cursor      | サインイン中のセッションの使用量サマリー                      | Cursor Agent CLI のチャット (`~/.cursor/chats`) | `cursor-agent`、なければアプリ  |
| Antigravity | 起動中アプリのローカルサービス (プロセスとポートの所有者を検証) | `~/.gemini/antigravity-ide`              | Antigravity アプリ                   |

モデルの一覧は各ツール自身のデータから取得します: Claude Code のエイリアスと使用したモデル、Codex のモデルキャッシュ、`cursor-agent --list-models` (24 時間キャッシュ)。

## プライバシーと安全性

既存の認証情報をメモリ上で読みます。その文書にはアクセストークンと更新トークンが含まれる場合があります。アプリは更新トークンの有無を確認しますが、自身のデータには保存しません。更新は Claude Code が行います。

設定、アカウント名、パス、クォータ履歴と最新の測定値はローカルディスクに保存されます。別アカウントで続行すると会話全体がコピーされます。`VIBE_HANDOVER.md` は機密情報を伏せた会話の文脈を含みますが、すべての秘密情報の形式を検出できる保証はありません。引き継ぐ前にプレビューを確認してください。Git が追跡中のファイルや Git からの除外失敗は引き継ぎを停止します。Cursor 独自の信頼確認は維持されます。

クォータは提供元のエンドポイント、バージョン確認は GitHub を利用します。更新のダウンロードとインストールは別々のユーザー操作です。詳しくは[プライバシーとローカルデータ](../PRIVACY.md)をご覧ください。

## インストール

### Windows

[最新リリース](https://github.com/mustafacagri/vibe-usage/releases/latest) から `Vibe-Usage-<バージョン>-win-setup.exe` をダウンロードして実行します。現在のユーザーにだけインストールされ、管理者権限は不要です。ポータブル版の `Vibe-Usage-<バージョン>-win-x64.zip` (または `-arm64`) を展開して `Vibe Usage.exe` を実行することもできます。対応する署名付きインストール版は、**ダウンロード** を押すと更新を取得し、**再起動して更新** を選ぶとインストールします。ポータブル版は新しいバージョンのリンクを表示します。アプリはタスクトレイに常駐します。

アプリはコード署名されていないため、初回起動時に Windows SmartScreen が「**Windows によって PC が保護されました**」と表示することがあります。**詳細情報**をクリックし、**実行**を選んでください。

### macOS

[最新リリース](https://github.com/mustafacagri/vibe-usage/releases/latest) から `Vibe-Usage-<バージョン>-mac-arm64.dmg` (Apple シリコン。Intel は `-mac-x64.dmg`) をダウンロードして開き、**Vibe Usage** をアプリケーションフォルダーにドラッグします。アプリはまだ Apple Developer ID で署名されていないため、初回起動は Gatekeeper にブロックされます。**システム設定 › プライバシーとセキュリティ** を開いて **このまま開く** をクリックするか、次を実行します:

```sh
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

この手順を省きたい場合は自分でビルドします。必要なのは Node.js 24 だけです:

```sh
git clone https://github.com/mustafacagri/vibe-usage.git && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

Intel Mac ではフォルダー名が `release/mac` になります。自分でビルドしたアプリは隔離されず、そのまま開きます。macOS では署名済みのアプリしか自分自身を置き換えられないため、新しいバージョンも同じ方法でインストールします。アプリの **ダウンロード** ボタンでお使いの Mac 用のディスクイメージを取得できます。

## コマンドライン

同じデータはターミナルでも見られます。Windows と macOS で、デスクトップアプリの有無にかかわらず動きます。Node.js 24 以降が必要で、アプリと同じサインイン済みセッションを読みます。両方をインストールしている場合は設定と言語を共有します。

```sh
npm install -g vibe-usage-cli
vibe-usage status
```

<img src="../media/cli.png" width="640" alt="ターミナルでの vibe-usage status: Claude 2 件、Codex 2 件、Cursor 1 件、Antigravity 2 件のアカウントのすべてのウィンドウ" />

```sh
vibe-usage status [--json]   # 全アカウントのクォータを 1 回表示。スクリプト向けに --json
vibe-usage watch             # 同じ内容を Ctrl+C まで更新し続ける
vibe-usage run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
vibe-usage handover [--from TOOL] [--to TOOL] [--session ID] [--cwd PATH]
vibe-usage help
```

インストールせずに試すには `npx vibe-usage-cli status` を実行します。

`run` はクォータが確認できたアカウントでツールをこのターミナルで起動します。そうでない場合は `--account` でアカウントを指定してください (ID は `status --json` に出ます)。`--dry-run` は何も起動せずにアカウントとコマンドを表示します。`handover` はフォルダーの最新セッション (または `--session`) の `VIBE_HANDOVER.md` を書き、それを使って移行先のツールを開きます。

## 開発

コマンド、プロジェクト構成、環境変数については[英語版 README の「Development」](../../README.md#development)を参照してください。

## 制限事項

- macOS 版は公証 (notarization) されていません ([macOS](#macos) を参照)。
- Antigravity のセッションのモデルは非公開のローカル記録から読み取ります。読み取れない場合、モデルは空欄になります。
- Cursor IDE (Composer) のチャットは引き継げません。読み取るのは Cursor Agent CLI のセッションだけです。

## ライセンス

[MIT](../../LICENSE)
