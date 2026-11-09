# GitLuna com Tauri 3 + CEF (144 Hz)

Esta branch (`feat/tauri-3-gtk4`) troca o WebView do sistema (WebKitGTK) pelo
**Chromium Embedded Framework (CEF)**, via `tauri-runtime-cef`, para que a interface
rode na taxa real do monitor em vez de ficar limitada a 60/72 fps no Linux.

`main` não foi alterada: todas as mudanças estão concentradas nesta branch.

## Por que não bastou migrar para GTK 4

Medições feitas nesta máquina (Fedora, GNOME/Wayland, painel eDP-1 AUO a 144,149 Hz):

| Runtime | `requestAnimationFrame` |
| --- | --- |
| WebKitGTK 4.1 (GTK 3) — configuração padrão | 36 fps |
| WebKitGTK 4.1 (GTK 3) — `PreferPageRenderingUpdatesNear60FPS` desativado | 60 fps |
| WebKitGTK 6.0 (GTK 4) — configuração padrão | 36 fps |
| WebKitGTK 6.0 (GTK 4) — `PreferPageRenderingUpdatesNear60FPS` desativado | 72 fps |
| Chromium / CEF | 143–144 fps |

O Tauri 3 com o runtime `wry` continua usando GTK 3 (`tauri = 3.0.0-alpha.5` com
`gtk 0.18` / `webkit2gtk 2.0`), então migrar só o Tauri **não** destrava nada. O
WebKitGTK também tem um limite interno de atualização de página (o *feature*
`PreferPageRenderingUpdatesNear60FPS`, ligado por padrão). Mesmo desligando-o, o teto
medido foi 72 fps no GTK 4 — ou seja, não existe caminho para 144 fps com WebKit.

Por isso o runtime escolhido é o `tauri-runtime-cef`: ele embute um Chromium completo
(com GTK 4 para as janelas) e entrega a mesma fluidez que o Chromium/Chrome apresenta
no mesmo monitor.

No app real (GitLuna com a UI Angular carregada), a medição com CEF deu
**144,36 fps** (média de 6,93 ms entre quadros; p90 de 7,10 ms).

## O que mudou

- `src-tauri/Cargo.toml`
  - `tauri-build` / `tauri` / plugins nas versões `3.0.0-alpha.*`;
  - `tauri-runtime-cef` (com `devtools`) no lugar do runtime `wry`;
  - `tauri-plugin-dialog` com `default-features = false, features = ["xdg-portal"]`,
    para não linkar GTK 3 junto com o GTK 4 do CEF (`rfd` usa GTK 3 por padrão).
- `src-tauri/src/main.rs` — atributo `#[tauri_runtime_cef::cef_entry_point]`, que faz
  o mesmo executável atuar como processo de renderização/GPU/rede do Chromium.
- `src-tauri/src/lib.rs` — `.runtime(tauri_runtime_cef::Cef::default())` e o
  `enable_features(["Vulkan"])` que habilita o WebGPU (veja a seção de IA).
- `src-tauri/src/cef_runtime.rs` — bootstrap do Linux (veja abaixo).
- `src-tauri/src/window_x11.rs` — `WM_CLASS` via X11 e arrasto manual da janela
  (veja as seções específicas abaixo).
- `src-tauri/tauri.conf.json` — schema do Tauri 3.
- `package.json` — `@tauri-apps/api` e plugins nas versões `3.0.0-alpha.*`.

## O problema do `close symbol missing` (Linux)

Durante o ajuste de OOM score, o Chromium resolve `close` com
`dlsym(RTLD_NEXT, "close")`. Isso só funciona se `libcef.so` estiver **antes** da
`libc.so.6` na ordem de carregamento. Num binário Rust a `libc` aparece primeiro
(`DT_NEEDED`), então a busca falha e o processo aborta com `close symbol missing`.

A solução usada é carregar `libcef.so` via `LD_PRELOAD`, que o loader mapeia antes de
todas as dependências. Como `LD_PRELOAD` separa caminhos por espaço, e o projeto pode
estar em um diretório com espaços (`~/Área de trabalho/...`), `cef_runtime.rs`:

1. cria um diretório sem espaços (`/tmp/gitluna-cef-preload/`) com symlinks para o
   `libcef.so` e para os demais arquivos de runtime (`icudtl.dat`, `*.pak`,
   `locales/`, `v8_context_snapshot.bin`, `chrome-sandbox`);
2. reexecuta o próprio binário com `LD_PRELOAD` apontando para esse symlink
   (usando `exec`, então o PID é preservado e `tauri dev` continua funcionando).

Nada disso é necessário no Windows/macOS.

## Pré-requisitos

O CEF precisa de GTK 4, Vulkan e um toolchain C++ para compilar o
`libcef_dll_wrapper`. No Fedora:

```bash
sudo dnf install gcc-c++ cmake ninja-build gtk4-devel vulkan-loader-devel
```

O primeiro build baixa a distribuição do CEF (~530 MB) para `~/.cache/tauri-cef` e
compila o wrapper. O `target/debug` desta branch fica em torno de 14 GB (build de
debug com símbolos do Chromium); builds de release são bem menores, mas o app
empacotado ainda carrega o runtime do Chromium (centenas de MB).

## Como rodar

```bash
npm install
npx tauri dev
```

O `beforeDevCommand` já sobe o servidor Angular (`npm start`).

Para gerar o pacote:

```bash
npx tauri build
```

O CLI do Tauri 3 detecta o `tauri-runtime-cef` no manifesto e inclui os arquivos do
CEF (`libcef.so`, `icudtl.dat`, `*.pak`, `locales/`, `v8_context_snapshot.bin`, …)
ao lado do executável.

## Ícone no painel do GNOME

O GNOME **não** usa `_NET_WM_ICON` para o ícone de aplicativos com janela: ele pede
o ícone ao `GDesktopAppInfo`, ou seja, procura um arquivo `.desktop` cujo
`StartupWMClass` (ou o nome do arquivo) corresponda à classe da janela. Sem esse
arquivo, a janela recebe o ícone genérico `application-x-executable`.

Dois ajustes são necessários no Linux:

1. **`WM_CLASS` correto.** O `GtkApplication` criado pelo `tauri-runtime-cef` é
   anônimo, então o GTK deixa o `WM_CLASS` vazio. `src-tauri/src/window_x11.rs`
   define `WM_CLASS = ("GitLuna", "GitLuna")` depois do carregamento da página
   (via `x11rb`, sem dependência do GTK).
2. **Um `.desktop` correspondente.** O pacote gerado pelo bundler
   (`tauri-bundler` 3.x) já cria `GitLuna.desktop` com
   `StartupWMClass = GitLuna`, então `.rpm`/`.deb`/AppImage funcionam sem passo
   extra.

No modo de desenvolvimento (`npx tauri dev`) não existe `.desktop` nenhum, por isso
o ícone continua genérico. Para instalar uma entrada temporária que aponta para o
binário de debug:

```bash
npm run dev:icon
```

Isso grava `~/.local/share/applications/GitLuna.desktop` com
`Exec="…/src-tauri/target/debug/GitLuna"`, `Icon=…/src-tauri/icons/128x128.png` e
`StartupWMClass=GitLuna`. Para remover:

```bash
npm run dev:icon:remove
```

Se o ícone não aparecer com o app já aberto, reinicie o GitLuna: o GNOME resolve a
associação da janela no momento em que ela é mapeada.

## Arrastar a janela (sem decoração)

A janela usa `decorations: false`, então o arrasto é feito pela barra superior do
app. No Linux, `Window::start_dragging()` do `tauri-winit-gtk4` chama
`gtk_window_drag()` (GTK 4) e exige um `pointer_button_press` registrado pelo GTK.
Com o CEF, o clique acontece na janela filha X11 do Chromium e o GTK nunca vê esse
evento — o resultado é `NotSupportedError("window dragging requires a pointer button
press")`.

O comando `start_window_drag` (`src-tauri/src/commands/window.rs`) contorna isso:
`window_x11.rs` lê a posição do ponteiro a cada 8 ms e envia
`_NET_MOVERESIZE_WINDOW` para o Mutter, reproduzindo o movimento até soltar o botão
(timeout de segurança de 60 s). No Windows/macOS o caminho continua sendo o
`startDragging()` nativo do Tauri.

## Geração por IA (WebGPU)

A geração de mensagens usa `@mlc-ai/web-llm`, que depende de WebGPU. No CEF/Chromium
do Linux o adaptador só aparece se o backend Vulkan estiver habilitado: sem isso
`navigator.gpu.requestAdapter()` devolve `null` e o `web-llm` falha com
`Unable to find a compatible GPU` (o console do Chromium registra
`No available adapters`).

A correção fica em `src-tauri/src/lib.rs`:

```rust
tauri_runtime_cef::Cef::default().enable_features(["Vulkan"])
```

`enable_features` é encaminhado aos processos filhos (é a mesma lista
`--enable-features` que o Chromium repassa ao processo de GPU). Já
`Cef::command_line_arg("enable-unsafe-webgpu")` **não** resolve: a documentação do
runtime diz que os argumentos são aplicados só ao processo do navegador, e o
processo de GPU não os recebe.

Medido nesta máquina após a mudança:

| Item | Resultado |
| --- | --- |
| Adaptador | NVIDIA Lovelace (hardware, `isFallbackAdapter: false`) |
| `requestDevice()` | ok |
| `requestAnimationFrame` | 144,59 fps |

Sem o `Vulkan`, o Chromium oferece no máximo o SwiftShader
(`vendor: google`, `isFallbackAdapter: true`) — e, na configuração padrão do app,
nem isso.

## Limitações conhecidas

- O runtime CEF do Tauri 3 é **alpha**: as APIs podem mudar antes do 3.0 estável.
- No Linux o CEF força X11 (`GDK_BACKEND=x11`, `--ozone-platform=x11`), então a
  janela roda via XWayland. O frame pacing continua a 144 Hz, mas não é Wayland nativo.
- A janela não tem decoração nativa (`decorations: false` no `tauri.conf.json`), como
  já era o caso no `main`.
- Em `npx tauri dev` o ícone do app no painel do GNOME só aparece depois de
  `npm run dev:icon` (o pacote final já traz o `.desktop`).
- Diálogos usam o `xdg-desktop-portal` (não GTK 3).
- O `chrome-sandbox` precisa de modo setuid (4755) para o sandbox do Chromium em
  pacotes `.deb`/`.rpm`; em AppImage o sandbox depende de user namespaces.

## Como voltar para o `main`

```bash
git switch main
```

Os arquivos do CEF em `~/.cache/tauri-cef` podem ser removidos depois:

```bash
rm -rf ~/.cache/tauri-cef
```
