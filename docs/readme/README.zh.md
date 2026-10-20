<div align="center">

[English](../../README.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Português](README.pt.md) · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **简体中文** · [Русский](README.ru.md)

<img src="../../assets/icon.png" width="96" alt="" />

# Vibe Usage

**你付费的所有 AI 编程订阅，尽在一个菜单栏窗口中。**

查看 Claude Code、Codex、Cursor 和 Antigravity 还剩多少额度，启动仍有余量的工具，并把做到一半的任务交给另一个工具，无需重新解释。

Windows 托盘 · macOS 菜单栏 · 13 种语言 · 无需密码，不保存令牌

**[下载 Windows 和 macOS 版](https://github.com/mustafacagri/vibe-usage/releases/latest)** · 终端: [`npm install -g vibe-usage-cli`](https://www.npmjs.com/package/vibe-usage-cli)

<img src="../media/demo.gif" width="400" alt="Vibe Usage 演示：切换账户、所有账户并排显示、紧凑视图、智能启动和移交任务" />

<sub>[观看全分辨率视频 (MP4)](../media/demo.mp4)</sub>

</div>

> 本译文可能落后于英文 README，请以[英文版](../../README.md)为准。

## 为什么需要它

如果你同时使用多个 AI 工具编程，总会一次次撞上同一堵墙：5 小时额度在任务进行到一半时用完，你打开另一个工具，又得从头解释任务。每家服务商显示用量的位置都不一样，有的干脆不显示。

Vibe Usage 读取你电脑上已经登录的会话，把所有额度并排展示：还剩多少、何时重置。当某个工具额度不足时，它会在你的项目文件夹中启动下一个额度已验证的工具，并写下当前会话的摘要，让新工具从旧工具停下的地方继续。

## 功能

<table>
<tr>
<td width="50%" valign="top">

### 额度一目了然

每个账户的每项额度：5 小时和每周窗口、按模型划分的额度、消费额度。倒计时显示每项额度何时重置。如果刷新失败，上一次的读数仍会显示，并明确标记为过期数据。未知数值绝不会显示为满额。将鼠标悬停在托盘图标上即可查看每个工具的剩余额度；还可以选择在额度不足或重新可用时收到通知。应用可以在登录时自动打开。

</td>
<td width="50%" valign="top">

<img src="../media/main.png" width="100%" alt="Claude、Codex、Cursor 和 Antigravity 的额度卡片，各工具的账户并排显示" />

<img src="../media/compact.png" width="100%" alt="紧凑视图：每个账户一行" />

</td>
</tr>
<tr>
<td valign="top">

### 智能启动

按你的优先顺序，选出第一个额度余量**已验证**的工具，并在你选择的项目文件夹中以新终端打开它。如果没有任何工具能够验证，它会如实告知，而不是猜测。

</td>
<td valign="top">

<img src="../media/smart-launch.png" width="100%" alt="由于 Claude 的 5 小时额度即将用尽，智能启动推荐了 Codex" />

</td>
</tr>
<tr>
<td valign="top">

### 移交任务

选择 Claude Code、Codex、Cursor Agent 或 Antigravity 会话。`VIBE_HANDOVER.md` 包含目标、最近请求、近期对话、文件引用和 Git 分支/HEAD 元数据，不扫描工作树。预览会固定实际来源、账号和版本；来源变化后必须重新预览。移入 worktree 的会话会显示在正确的项目下。

</td>
<td valign="top">

<img src="../media/handover.png" width="100%" alt="将 Claude 会话移交给 Codex 的对话框" />

</td>
</tr>
<tr>
<td valign="top">

### 多账户

Claude 和 Codex 每个配置文件文件夹保存一个登录。**添加账户** 会新建一个文件夹并在其中打开该工具的登录；你自己创建的 `~/.claude-*` 和 `~/.codex-*` 文件夹也会被自动发现。每个账户都以其登录邮箱显示，每个已登录的 Antigravity 账户也会分别跟踪。你可以选择主账户、用指定账户启动 Claude Code，并为每个工具设置备用顺序和首选模型。十分钟内未完成登录，该账户会被再次移除，下一个账户会复用它的文件夹。

</td>
<td valign="top">

<img src="../media/settings.png" width="100%" alt="设置：已连接的账户，Claude 和 Codex 各两个" />

</td>
</tr>
</table>

### 设置、历史与诊断

<table>
<tr>
<td width="33%" valign="top"><img src="../media/settings-general.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-continue.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-order.png" width="100%" alt="" /></td>
</tr>
<tr>
<td valign="top"><b>常规：</b>登录时启动、在你设定的低额度线发出通知、免打扰时段、账户并排显示以及检查更新。</td>
<td valign="top"><b>额度用完时：</b>仅提示、在该工具的其他账户上继续，或再按备用顺序交给其他工具；也可按项目设置。</td>
<td valign="top"><b>顺序与模型：</b>工具的显示顺序、下一个接手的工具、每个工具启动时使用的模型，以及读取额度的频率。</td>
</tr>
<tr>
<td width="33%" valign="top"><img src="../media/history.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/diagnostics.png" width="100%" alt="" /></td>
<td></td>
</tr>
<tr>
<td valign="top"><b>交接历史：</b>哪项工作从哪个账户转到了哪里；失败的可一键重试。</td>
<td valign="top"><b>诊断：</b>每个工具是否已安装、每个账户的状态；可复制或保存不含名称和文件夹的报告。</td>
<td></td>
</tr>
</table>

## 支持的工具

| 工具        | 额度来源                                         | 可移交的会话                            | 启动方式                         |
| ----------- | ------------------------------------------------ | --------------------------------------- | -------------------------------- |
| Claude Code | 配置文件的 OAuth 用量接口（macOS 上使用钥匙串）  | `~/.claude/projects`                    | 用所选配置文件运行 `claude` CLI  |
| Codex       | 已安装 CLI 的 app-server 速率限制方法            | `~/.codex/sessions`                     | `codex` CLI                      |
| Cursor      | 已登录会话的用量摘要                             | Cursor Agent CLI 对话（`~/.cursor/chats`） | `cursor-agent`，否则使用应用  |
| Antigravity | 正在运行的应用的本地服务（验证进程和端口归属）   | `~/.gemini/antigravity-ide`             | Antigravity 应用                 |

模型列表来自各工具自身的数据：Claude Code 的别名和你用过的模型、Codex 的模型缓存，以及 `cursor-agent --list-models`（缓存 24 小时）。

## 隐私与安全

现有凭据会在内存中读取，文档可能同时包含访问令牌和刷新令牌。应用检查刷新令牌是否存在，但不会将其保存到自身数据中。续期由 Claude Code 完成。

设置、账号标签、路径、额度历史和最近测量结果保存在本地磁盘。使用另一账号继续时会复制完整对话。`VIBE_HANDOVER.md` 包含经过遮盖的对话上下文，但无法保证识别所有秘密格式。移交前请检查预览。Git 已跟踪的文件或 Git 排除失败会阻止移交。Cursor 保留自身的信任确认。

额度请求使用提供商端点，版本检查使用 GitHub。下载和安装更新是两次独立的用户操作。详情见[隐私与本地数据](../PRIVACY.md)。

## 安装

### Windows

从[最新版本](https://github.com/mustafacagri/vibe-usage/releases/latest)下载 `Vibe-Usage-<版本>-win-setup.exe` 并运行：只为当前用户安装，无需管理员权限。也可以下载便携版 `Vibe-Usage-<版本>-win-x64.zip`（或 `-arm64`），解压后运行 `Vibe Usage.exe`。受支持的签名安装版会在点按 **下载** 后获取更新，再点按 **重启以更新** 才会安装。便携版会给出新版本的链接。应用常驻在系统托盘中。

由于应用未经代码签名，首次启动时 Windows SmartScreen 可能会显示“**Windows 已保护你的电脑**”。点击**更多信息**，然后点击**仍要运行**。

### macOS

从[最新版本](https://github.com/mustafacagri/vibe-usage/releases/latest)下载 `Vibe-Usage-<版本>-mac-arm64.dmg`（Apple 芯片；Intel 为 `-mac-x64.dmg`），打开后把 **Vibe Usage** 拖到"应用程序"。应用尚未使用 Apple Developer ID 签名，因此 Gatekeeper 会阻止首次启动：打开 **系统设置 › 隐私与安全性** 并点按 **仍要打开**，或运行：

```sh
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

想跳过这一步，可以自己构建。只需要 Node.js 24：

```sh
git clone https://github.com/mustafacagri/vibe-usage.git && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

在 Intel Mac 上文件夹是 `release/mac`。自己构建的应用不会被隔离，可以直接打开。macOS 只允许已签名的应用自行替换，因此新版本也用同样的方式安装：应用中的 **下载** 按钮会下载适合你的 Mac 的磁盘映像。

## 命令行

同样的数据也可以在终端中查看，支持 Windows 和 macOS，无论是否安装桌面应用。需要 Node.js 24 或更高版本，读取的是与应用相同的已登录会话；两者都安装时共享设置和语言。

```sh
npm install -g vibe-usage-cli
vibe-usage status
```

<img src="../media/cli.png" width="640" alt="终端中的 vibe-usage status：两个 Claude、两个 Codex、一个 Cursor 和两个 Antigravity 账户的所有窗口" />

```sh
vibe-usage status [--json]   # 显示一次所有账户的额度；脚本可用 --json
vibe-usage watch             # 同上，持续刷新直到 Ctrl+C
vibe-usage run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
vibe-usage handover [--from TOOL] [--to TOOL] [--session ID] [--cwd PATH]
vibe-usage help
```

不安装也可以试用：`npx vibe-usage-cli status`。

`run` 会用额度已验证的账户在当前终端启动工具；否则请用 `--account` 指定一个（ID 见 `status --json`）。`--dry-run` 只打印账户和命令，不启动任何程序。`handover` 为文件夹中最新的会话（或 `--session`）写入 `VIBE_HANDOVER.md`，并用它打开目标工具。

## 开发

命令、项目结构和环境变量请参阅[英文 README 的 “Development” 部分](../../README.md#development)。

## 限制

- macOS 版本未经公证（参见 [macOS](#macos)）。
- Antigravity 会话的模型来自未公开的本地记录；如果无法读取，模型留空。
- 无法移交 Cursor IDE（Composer）对话；只读取 Cursor Agent CLI 会话。

## 许可证

[MIT](../../LICENSE)
