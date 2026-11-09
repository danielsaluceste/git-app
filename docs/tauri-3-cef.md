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
- `src-tauri/src/lib.rs` — `.runtime(cef_runtime::configure(...))`.
- `src-tauri/src/cef_runtime.rs` — bootstrap do Linux (veja abaixo).
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

## Limitações conhecidas

- O runtime CEF do Tauri 3 é **alpha**: as APIs podem mudar antes do 3.0 estável.
- No Linux o CEF força X11 (`GDK_BACKEND=x11`, `--ozone-platform=x11`), então a
  janela roda via XWayland. O frame pacing continua a 144 Hz, mas não é Wayland nativo.
- A janela não tem decoração nativa (`decorations: false` no `tauri.conf.json`), como
  já era o caso no `main`.
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
