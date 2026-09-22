import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = new Map();
for (let index = 0; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument?.startsWith("--")) {
    args.set(argument.slice(2), process.argv[index + 1] ?? "");
  }
}

const version = args.get("version");
const baseUrl = (args.get("base-url") || "").replace(/\/$/, "");
const artifactsDirectory = path.resolve(args.get("artifacts-dir") || "update-artifacts");
const notes = process.env.RELEASE_NOTES || "Atualização do GitLuna.";

if (!version || !baseUrl) {
  console.error("Uso: node scripts/create-update-manifest.mjs --version 0.1.1 --base-url https://... [--artifacts-dir pasta]");
  process.exit(2);
}

const targets = [
  ["windows-x86_64", "GitLuna-windows-x86_64.exe"],
  ["linux-x86_64", "GitLuna-linux-x86_64.AppImage"],
  ["darwin-x86_64", "GitLuna-macos-x86_64.app.tar.gz"],
  ["darwin-aarch64", "GitLuna-macos-aarch64.app.tar.gz"],
];

const availableFiles = new Set(await readdir(artifactsDirectory));
const platforms = {};

for (const [target, fileName] of targets) {
  const signatureName = `${fileName}.sig`;

  if (!availableFiles.has(fileName) || !availableFiles.has(signatureName)) {
    continue;
  }

  platforms[target] = {
    signature: await readFile(path.join(artifactsDirectory, signatureName), "utf8"),
    url: `${baseUrl}/${fileName}`,
  };
}

if (Object.keys(platforms).length === 0) {
  throw new Error("Nenhum artefato assinado foi encontrado para montar o latest.json.");
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

await mkdir(artifactsDirectory, { recursive: true });
await writeFile(
  path.join(artifactsDirectory, "latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`latest.json criado com: ${Object.keys(platforms).join(", ")}`);
