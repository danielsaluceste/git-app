import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// GitLuna em modo dev roda direto do target/debug e, no Linux (CEF), expõe
// WM_CLASS "GitLuna". Para o GNOME associar a janela a um ícone real ele exige
// um .desktop correspondente — o bundle gera isso, o `tauri dev` não.
//
// Uso:
//   node scripts/install-dev-desktop.mjs            # instala ~/.local/share/applications/GitLuna.desktop
//   node scripts/install-dev-desktop.mjs --uninstall # remove a entrada

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const applicationsDirectory = path.join(os.homedir(), ".local", "share", "applications");
const desktopFile = path.join(applicationsDirectory, "GitLuna.desktop");
const uninstall = process.argv.includes("--uninstall");

if (uninstall) {
  await unlink(desktopFile).catch(() => {});
  await refreshDesktopDatabase();
  console.log(`Entrada removida: ${desktopFile}`);
  process.exit(0);
}

const binary = process.env.GITLUNA_BIN?.trim()
  ? path.resolve(process.env.GITLUNA_BIN.trim())
  : path.join(rootDirectory, "src-tauri", "target", "debug", "GitLuna");
const icon = path.join(rootDirectory, "src-tauri", "icons", "128x128.png");

const content = `[Desktop Entry]
Type=Application
Version=1.5
Name=GitLuna
Comment=Cliente Git para desktop (build de desenvolvimento)
Exec="${binary}" %U
TryExec=${binary}
Icon=${icon}
Terminal=false
Categories=Development;RevisionControl;
Keywords=git;gitluna;
StartupNotify=true
StartupWMClass=GitLuna
`;

await mkdir(applicationsDirectory, { recursive: true });
await writeFile(desktopFile, content, "utf8");
await chmod(desktopFile, 0o644);
await refreshDesktopDatabase();

console.log(`Entrada instalada: ${desktopFile}`);
console.log(`  Exec: "${binary}"`);
console.log(`  Icon: ${icon}`);
console.log("Se o ícone ainda não aparecer na barra, reinicie o GitLuna.");

async function refreshDesktopDatabase() {
  try {
    await execFileAsync("update-desktop-database", [applicationsDirectory]);
  } catch {
    // update-desktop-database é opcional; sem ele o GNOME ainda lê a entrada.
  }
}
