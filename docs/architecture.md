# Arquitetura

O projeto é dividido em duas aplicações:

- `src/`: interface Angular e estado da aplicação.
- `src-tauri/`: comandos Tauri e operações Git executadas em Rust.

As telas ficam em `src/app/features`. Serviços compartilhados ficam em `src/app/core` e componentes reutilizáveis ficam em `src/app/shared`.
