import { spawnSync } from "node:child_process";

const targets = {
  windows: {
    platform: "win32",
    bundles: "nsis,msi",
  },
  linux: {
    platform: "linux",
    bundles: "appimage,deb,rpm",
  },
  macos: {
    platform: "darwin",
    bundles: "app,dmg",
  },
  mac: {
    platform: "darwin",
    bundles: "app,dmg",
  },
};

const currentTarget = {
  win32: "windows",
  linux: "linux",
  darwin: "macos",
}[process.platform];

const requestedTarget = process.argv[2] ?? currentTarget;
const target = targets[requestedTarget];

if (!target) {
  console.error(
    "Destino inválido. Use: npm run build:desktop, build:windows, build:linux ou build:mac.",
  );
  process.exit(2);
}

if (process.platform !== target.platform) {
  const platformNames = {
    win32: "Windows",
    linux: "Linux",
    darwin: "macOS",
  };

  console.error(
    `O build de ${requestedTarget} precisa ser executado no ${platformNames[target.platform]}. ` +
      "Use o workflow do GitHub Actions para gerar os três sistemas automaticamente.",
  );
  process.exit(2);
}

console.log(`Gerando instaladores para ${requestedTarget}: ${target.bundles}`);

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmCommand,
  ["run", "tauri", "--", "build", "--bundles", target.bundles],
  {
    stdio: "inherit",
    // Arquivos .cmd precisam ser executados pelo shell no Windows.
    shell: process.platform === "win32",
  },
);

if (result.error) {
  console.error(`Não foi possível iniciar o build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
