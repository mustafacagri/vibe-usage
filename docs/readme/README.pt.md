<div align="center">

[English](../../README.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [Italiano](README.it.md) · **Português** · [Nederlands](README.nl.md) · [Polski](README.pl.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh.md) · [Русский](README.ru.md)

<img src="../../assets/icon.png" width="96" alt="" />

# Vibe Usage

**Todas as assinaturas de programação com IA que você paga, em uma única janela da barra de menus.**

Veja quanta cota ainda resta no Claude Code, Codex, Cursor e Antigravity, abra a ferramenta que ainda tem folga e passe
uma tarefa pela metade de uma ferramenta para outra sem precisar explicá-la de novo.

Bandeja do Windows · barra de menus do macOS · 13 idiomas · sem senhas, sem tokens armazenados

**[Baixar para Windows e macOS](https://github.com/mustafacagri/vibe-usage/releases/latest)** · Terminal: [`npm install -g vibe-usage-cli`](https://www.npmjs.com/package/vibe-usage-cli)

<img src="../media/demo.gif" width="400" alt="Demonstração do Vibe Usage: troca de contas, todas as contas lado a lado, a vista compacta, Início Inteligente e Transferir" />

<sub>[Assistir em resolução total (MP4)](../media/demo.mp4)</sub>

</div>

> Esta tradução pode estar atrás do README em inglês; a [versão em inglês](../../README.md) é a referência.

## Por quê

Se você programa com várias ferramentas de IA, bate sempre na mesma parede: o limite de 5 horas acaba no meio da tarefa,
você abre outra ferramenta e começa a explicar tudo do zero. Cada provedor mostra o uso em um lugar diferente, quando
mostra.

O Vibe Usage lê as sessões já conectadas no seu computador e mostra todos os limites lado a lado: quanto resta e quando
reinicia. Quando uma ferramenta está acabando, ele abre a próxima com cota verificada na pasta do projeto e escreve um
resumo da sessão atual, para que a nova ferramenta continue de onde a anterior parou.

## Recursos

<table>
<tr>
<td width="50%" valign="top">

### Cotas num relance

Todos os limites de todas as contas: janelas de 5 horas e semanais, cotas por modelo, verbas de gasto. Contagens
regressivas mostram quando cada uma reinicia. Se uma atualização falhar, a última leitura continua visível e é marcada
claramente como desatualizada. Valores desconhecidos nunca aparecem como cota cheia. Passe o cursor sobre o ícone da
bandeja para ver o que resta em cada ferramenta; se quiser, receba uma notificação quando um limite estiver a acabar ou
voltar a ficar disponível. A app pode abrir ao iniciar sessão.

</td>
<td width="50%" valign="top">

<img src="../media/main.png" width="100%" alt="Cartões de cota do Claude, Codex, Cursor e Antigravity, com as contas de cada ferramenta lado a lado" />

<img src="../media/compact.png" width="100%" alt="A vista compacta: uma linha por conta" />

</td>
</tr>
<tr>
<td valign="top">

### Início Inteligente

Escolhe a primeira ferramenta na sua ordem de prioridade cuja cota tem folga **verificada** e a abre em um novo
terminal na pasta de projeto escolhida. Se nenhuma ferramenta puder ser verificada, ele avisa em vez de adivinhar.

</td>
<td valign="top">

<img src="../media/smart-launch.png" width="100%" alt="O Início Inteligente recomenda o Codex porque o limite de 5 horas do Claude está quase no fim" />

</td>
</tr>
<tr>
<td valign="top">

### Transferir

Escolha uma sessão do Claude Code, Codex, Cursor Agent ou Antigravity. `VIBE_HANDOVER.md` contém objetivo, último pedido, conversa recente, referências a arquivos e metadados de branch/HEAD do Git; a árvore de trabalho não é examinada. A prévia fixa a fonte física, a conta e a versão. Uma fonte alterada exige nova prévia. Sessões movidas para um worktree aparecem no projeto correto.

</td>
<td valign="top">

<img src="../media/handover.png" width="100%" alt="Janela de transferência passando uma sessão do Claude para o Codex" />

</td>
</tr>
<tr>
<td valign="top">

### Várias contas

O Claude e o Codex guardam uma sessão por pasta de perfil. **Adicionar conta** cria uma pasta nova e abre nela o início
de sessão da ferramenta; as pastas `~/.claude-*` e `~/.codex-*` que você mesmo criou são encontradas automaticamente.
Cada conta aparece com o e-mail da sua sessão, e cada conta conectada do Antigravity também é acompanhada separadamente.
Escolha a conta principal, abra o Claude Code com uma conta específica e defina a ordem de reserva e o modelo preferido
de cada ferramenta.
Um login não concluído em dez minutos remove a conta outra vez, e a próxima conta reutiliza a pasta dela.

</td>
<td valign="top">

<img src="../media/settings.png" width="100%" alt="Configurações: contas conectadas, duas do Claude e duas do Codex" />

</td>
</tr>
</table>

### Configurações, histórico e diagnóstico

<table>
<tr>
<td width="33%" valign="top"><img src="../media/settings-general.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-continue.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/settings-order.png" width="100%" alt="" /></td>
</tr>
<tr>
<td valign="top"><b>Geral:</b> abrir ao iniciar sessão, avisos no seu limite de cota baixa, horas de silêncio, contas lado a lado e a verificação de atualizações.</td>
<td valign="top"><b>Quando um limite acaba:</b> só sugerir, continuar nas outras contas da ferramenta ou depois nas outras ferramentas pela ordem de reserva; também por projeto.</td>
<td valign="top"><b>Ordem e modelos:</b> como as ferramentas são listadas, qual assume em seguida, com que modelo cada uma começa e a frequência de leitura da cota.</td>
</tr>
<tr>
<td width="33%" valign="top"><img src="../media/history.png" width="100%" alt="" /></td>
<td width="33%" valign="top"><img src="../media/diagnostics.png" width="100%" alt="" /></td>
<td></td>
</tr>
<tr>
<td valign="top"><b>Histórico de transferências:</b> que trabalho passou de qual conta para qual; tente de novo um que falhou com um clique.</td>
<td valign="top"><b>Diagnóstico:</b> se cada ferramenta está instalada e como está cada conta; um relatório sem nomes nem pastas para copiar ou salvar.</td>
<td></td>
</tr>
</table>

## Ferramentas compatíveis

| Ferramenta  | De onde vem a cota                                                         | Sessões para transferir                        | Início                                   |
| ----------- | -------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Claude Code | Endpoint de uso OAuth do perfil (Keychain no macOS)                        | `~/.claude/projects`                           | CLI `claude` com o perfil escolhido      |
| Codex       | Métodos de limite do app-server da CLI instalada                           | `~/.codex/sessions`                            | CLI `codex`                              |
| Cursor      | Resumo de uso da sessão conectada                                          | Chats do Cursor Agent CLI (`~/.cursor/chats`)  | `cursor-agent`; senão, o app             |
| Antigravity | Serviço local do app em execução (processo e porta verificados)            | `~/.gemini/antigravity-ide`                    | App Antigravity                          |

As listas de modelos vêm dos dados de cada ferramenta: os apelidos do Claude Code e os modelos que você usou, o cache
de modelos do Codex e `cursor-agent --list-models` (em cache por 24 horas).

## Privacidade e segurança

As credenciais existentes são lidas na memória; os documentos podem conter tokens de acesso e atualização. O app verifica se existe um token de atualização, mas não o salva nos próprios dados. A renovação é feita pelo Claude Code.

Configurações, nomes de contas, caminhos, histórico de cotas e últimas medições ficam no disco local. Continuar em outra conta copia a conversa inteira. `VIBE_HANDOVER.md` contém contexto com informações sensíveis ocultadas, mas não é possível garantir a detecção de todos os formatos de segredos. Confira a prévia antes da transferência. Um arquivo já rastreado pelo Git ou uma falha de exclusão do Git impede a transferência. O Cursor mantém suas próprias perguntas de confiança.

As cotas usam os endpoints dos provedores e a verificação de versões usa o GitHub. Baixar e instalar uma atualização são ações separadas do usuário. Veja [Privacidade e dados locais](../PRIVACY.md).

## Instalação

### Windows

Baixe `Vibe-Usage-<versão>-win-setup.exe` da [versão mais recente](https://github.com/mustafacagri/vibe-usage/releases/latest) e execute: instala só para o seu usuário, sem direitos de administrador. Ou use o portátil `Vibe-Usage-<versão>-win-x64.zip` (ou `-arm64`), descompacte e execute `Vibe Usage.exe`. Uma instalação assinada compatível baixa a atualização ao clicar em **Baixar** e a instala com **Reiniciar para atualizar**. A cópia portátil indica cada nova versão. O app fica na bandeja do sistema.

O app não é assinado, então na primeira abertura o Windows SmartScreen pode mostrar **O Windows protegeu o computador**. Clique em **Mais informações** e depois em **Executar assim mesmo**.

### macOS

Baixe `Vibe-Usage-<versão>-mac-arm64.dmg` (Apple silicon; Intel: `-mac-x64.dmg`) da [versão mais recente](https://github.com/mustafacagri/vibe-usage/releases/latest), abra e arraste **Vibe Usage** para Aplicativos. O app ainda não é assinado com um Apple Developer ID, então o Gatekeeper bloqueia a primeira abertura: abra **Ajustes do Sistema › Privacidade e Segurança** e clique em **Abrir Mesmo Assim**, ou execute:

```sh
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

Para pular esse passo, compile você mesmo. Só é preciso Node.js 24:

```sh
git clone https://github.com/mustafacagri/vibe-usage.git && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

Em um Mac Intel a pasta é `release/mac`. Um app compilado por você não fica em quarentena e abre direto. O macOS só deixa um app assinado se substituir sozinho, então cada nova versão se instala da mesma forma: o botão **Transferir** do app baixa a imagem de disco certa para o seu Mac.

## Linha de comando

Os mesmos dados estão disponíveis no terminal, no Windows e no macOS, com ou sem o app de desktop. É preciso Node.js 24 ou posterior; a CLI lê as mesmas sessões conectadas que o app e, se ambos estiverem instalados, compartilham configurações e idioma.

```sh
npm install -g vibe-usage-cli
vibe-usage status
```

<img src="../media/cli.png" width="640" alt="vibe-usage status em um terminal: todas as janelas de duas contas Claude, duas Codex, uma Cursor e duas Antigravity" />

```sh
vibe-usage status [--json]   # a cota de todas as contas, uma vez; --json para scripts
vibe-usage watch             # o mesmo, atualizado até Ctrl+C
vibe-usage run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
vibe-usage handover [--from TOOL] [--to TOOL] [--session ID] [--cwd PATH]
vibe-usage help
```

Para experimentar sem instalar, execute `npx vibe-usage-cli status`.

`run` inicia a ferramenta neste terminal com uma conta de cota verificada; caso contrário, indique uma com `--account` (os IDs estão em `status --json`). `--dry-run` mostra a conta e o comando sem iniciar nada. `handover` grava `VIBE_HANDOVER.md` para a sessão mais recente da pasta (ou `--session`) e abre com ele a ferramenta de destino.

## Desenvolvimento

Comandos, estrutura do projeto e variáveis de ambiente estão na
[seção "Development" do README em inglês](../../README.md#development).

## Limitações

- A versão para macOS não é notarizada (veja [macOS](#macos)).
- O modelo de uma sessão do Antigravity vem de um registro local não documentado; se não puder ser lido, fica em branco.
- Chats do Cursor IDE (Composer) não podem ser transferidos; só as sessões do Cursor Agent CLI são lidas.

## Licença

[MIT](../../LICENSE)
