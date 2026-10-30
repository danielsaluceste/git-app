import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { TRANSLATIONS } from "./translation.service";

const APP_ROOT = join(process.cwd(), "src", "app");
const KEY_USAGE = /["']([a-z][\w]*(?:\.[\w]+)+)["']\s*\|\s*translate/g;

function collectFiles(directory: string, extension: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectFiles(path, extension));
    } else if (path.endsWith(extension)) {
      files.push(path);
    }
  }

  return files;
}

function usedTranslationKeys(): Map<string, string> {
  const keys = new Map<string, string>();

  for (const path of [
    ...collectFiles(APP_ROOT, ".html"),
    ...collectFiles(APP_ROOT, ".ts"),
  ]) {
    if (path.endsWith(".spec.ts")) {
      continue;
    }

    const content = readFileSync(path, "utf8");
    for (const match of content.matchAll(KEY_USAGE)) {
      if (!keys.has(match[1])) {
        keys.set(match[1], relative(process.cwd(), path));
      }
    }
  }

  return keys;
}

describe("traduções", () => {
  it("define todas as chaves usadas nos templates e componentes", () => {
    const missing: string[] = [];

    for (const [key, origin] of usedTranslationKeys()) {
      for (const language of ["pt-BR", "en"] as const) {
        if (!(key in TRANSLATIONS[language])) {
          missing.push(`${key} (${language}) em ${origin}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("mantém pt-BR e en com o mesmo conjunto de chaves", () => {
    const portuguese = Object.keys(TRANSLATIONS["pt-BR"]).sort();
    const english = Object.keys(TRANSLATIONS["en"]).sort();

    expect(english).toEqual(portuguese);
  });
});
