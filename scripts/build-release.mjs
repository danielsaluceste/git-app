import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

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
const releaseVersion = process.env.TAURI_RELEASE_VERSION?.trim().replace(/^v/, "");
const tauriArguments = ["run", "tauri", "--", "build", "--bundles", target.bundles];
let releaseConfigPath;

if (releaseVersion) {
  releaseConfigPath = path.resolve("src-tauri", ".tauri-release-config.json");
  writeFileSync(releaseConfigPath, `${JSON.stringify({ version: releaseVersion })}\n`, "utf8");
  tauriArguments.push("--config", releaseConfigPath);
}

const result = spawnSync(
  npmCommand,
  tauriArguments,
  {
    stdio: "inherit",
    // Arquivos .cmd precisam ser executados pelo shell no Windows.
    shell: process.platform === "win32",
  },
);

if (releaseConfigPath) {
  try {
    unlinkSync(releaseConfigPath);
  } catch {
    // O arquivo temporário não impede o resultado do build.
  }
}

if (result.error) {
  console.error(`Não foi possível iniciar o build: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
