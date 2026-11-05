# Arquitetura

O projeto é dividido em duas aplicações:

- `src/`: interface Angular e estado da aplicação.
- `src-tauri/`: comandos Tauri e operações Git executadas em Rust.

As telas ficam em `src/app/features`. Serviços compartilhados ficam em `src/app/core` e componentes reutilizáveis ficam em `src/app/shared`.

## Janela principal

A janela é criada em código (`create_main_window` em `src-tauri/src/lib.rs`), não
pelo `tauri.conf.json` (a lista de janelas da configuração fica vazia). O motivo
é o diretório de dados do WebView2:

- **desenvolvimento** (`debug_assertions`): perfil em
  `src-tauri/target/webview-profile`;
- **produção**: diretório padrão do sistema (`%LOCALAPPDATA%/<identifier>`).

Sem isso, o app depende de escrever em `%LOCALAPPDATA%` para abrir a janela. Em
ambientes com escrita restrita (sandbox de agentes, CI, containers) esse acesso
é negado, o WebView2 falha com `HRESULT(0x8000FFFF)` e **nenhuma janela
aparece**. Se precisar mudar tamanho, título ou decoração da janela, altere
`create_main_window`.

## Conexões com o GitHub

O GitHub pode ser conectado de duas formas, e a escolha é feita na hora de
conectar (tela de Integrações):

- **GitHub App (`mode: "app"`)**: autorização por Device Flow. O token fica no
  armazenamento seguro do sistema (`keyring`) e é usado pela API do GitHub e
  pelas operações de rede do Git.
- **Chave SSH (`mode: "ssh"`)**: usa o OpenSSH do computador. Nenhum token é
  criado; o GitLuna lista as chaves de `~/.ssh`, pode gerar uma chave dedicada
  (`gitluna_github_ed25519`) e confirma a autenticação com `ssh -T git@github.com`.
  A chave nunca sai do computador.

As conexões ficam em `src/app/core/services/github.service.ts` e são salvas em
`localStorage`. Cada conexão tem `mode`, e a mesma conta pode ter as duas.

### Autenticação das operações Git

O repositório guarda `authenticationSource` (`system`, `github` ou `ssh`) e
`githubConnectionId`. `RepositoryService.syncCredentials()` traduz isso para:

- `github`: `workspaceId` + `githubUserId` (o token é lido do keyring no Rust).
- `ssh`: `sshKeyPath` da conexão (ausente quando a configuração SSH do
  computador é usada).
- `system`: nada é enviado e o Git usa a configuração do computador.

No Rust, `commands/repository.rs` resolve essas opções em `NetworkAuth`
(`Token`, `Ssh` ou `System`) e aplica em clone, fetch, pull e push. No modo SSH
o comando Git recebe `GIT_SSH_COMMAND` com `-i <chave>`, `IdentitiesOnly=yes`,
`BatchMode=yes` e `StrictHostKeyChecking=accept-new`.

### Chaves SSH

`commands/github_ssh.rs` expõe `list_ssh_keys`, `generate_ssh_key`,
`probe_github_ssh` e `delete_ssh_key`. Só chaves criadas pelo GitLuna (prefixo
`gitluna_`) e dentro de `~/.ssh` podem ser removidas pelo app. Execuções de
processos externos passam por `commands/process.rs`, que lê stdout e stderr em
threads paralelas e aplica limite de tempo.
