import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [platform, outputDirectory = "update-artifacts"] = process.argv.slice(2);

if (!platform || !["windows", "linux", "macos"].includes(platform)) {
  console.error("Uso: node scripts/prepare-update-artifacts.mjs windows|linux|macos [pasta]");
  process.exit(2);
}

const bundleDirectory = path.resolve("src-tauri", "target", "release", "bundle");
const outputPath = path.resolve(outputDirectory);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
    } else {
      files.push(entryPath);
    }
  }

  return files;
}

function hasExtension(filePath, extension) {
  return filePath.toLowerCase().endsWith(extension.toLowerCase());
}

function prefer(files, folderName) {
  return [...files].sort((first, second) => {
    const firstPreferred = first.toLowerCase().includes(`${path.sep}${folderName}${path.sep}`);
    const secondPreferred = second.toLowerCase().includes(`${path.sep}${folderName}${path.sep}`);
    return Number(secondPreferred) - Number(firstPreferred);
  });
}

async function copyArtifact(sourcePath, destinationName, { requireSignature = false } = {}) {
  const signaturePath = `${sourcePath}.sig`;

  if (requireSignature) {
    await stat(signaturePath);
  }

  await copyFile(sourcePath, path.join(outputPath, destinationName));

  if (requireSignature) {
    await copyFile(signaturePath, path.join(outputPath, `${destinationName}.sig`));
  }
}

try {
  const bundleFiles = await walk(bundleDirectory);
  await mkdir(outputPath, { recursive: true });

  if (platform === "windows") {
    const executables = prefer(
      bundleFiles.filter((filePath) => hasExtension(filePath, ".exe") && !filePath.endsWith(".sig")),
      "nsis",
    ).filter((filePath) => bundleFiles.includes(`${filePath}.sig`));

    if (!executables[0]) {
      throw new Error("Nenhum instalador NSIS assinado foi encontrado.");
    }

    await copyArtifact(executables[0], "GitLuna-windows-x86_64.exe", { requireSignature: true });

    const msi = bundleFiles.find((filePath) => hasExtension(filePath, ".msi"));
    if (msi) {
      await copyArtifact(msi, "GitLuna-windows-x86_64.msi");
    }
  }

  if (platform === "linux") {
    const appImages = bundleFiles
      .filter((filePath) => hasExtension(filePath, ".appimage"))
      .filter((filePath) => bundleFiles.includes(`${filePath}.sig`));

    if (!appImages[0]) {
      throw new Error("Nenhum AppImage assinado foi encontrado.");
    }

    await copyArtifact(appImages[0], "GitLuna-linux-x86_64.AppImage", { requireSignature: true });

    const deb = bundleFiles.find((filePath) => hasExtension(filePath, ".deb"));
    const rpm = bundleFiles.find((filePath) => hasExtension(filePath, ".rpm"));

    if (deb) {
      await copyArtifact(deb, "GitLuna-linux-x86_64.deb");
    }

    if (rpm) {
      await copyArtifact(rpm, "GitLuna-linux-x86_64.rpm");
    }
  }

  if (platform === "macos") {
    const archives = bundleFiles
      .filter((filePath) => hasExtension(filePath, ".app.tar.gz"))
      .filter((filePath) => bundleFiles.includes(`${filePath}.sig`));

    if (!archives[0]) {
      throw new Error("Nenhum pacote macOS assinado foi encontrado.");
    }

    const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    await copyArtifact(archives[0], `GitLuna-macos-${architecture}.app.tar.gz`, { requireSignature: true });

    const dmg = bundleFiles.find((filePath) => hasExtension(filePath, ".dmg"));
    if (dmg) {
      await copyArtifact(dmg, `GitLuna-macos-${architecture}.dmg`);
    }
  }

  console.log(`Artefatos preparados em ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
