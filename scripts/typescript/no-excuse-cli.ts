import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkSource } from "./no-excuse-core";

const SOURCE_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];
const IGNORED_DIRS: readonly string[] = [
  ".git",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
];

export function runCli(args: readonly string[]): number {
  if (args.length === 0) {
    console.error("Usage: bun run scripts/typescript/check-no-excuse-rules.ts <file-or-dir> [...]");
    return 2;
  }

  const files = collectSourceFiles(args);
  const violations = files.flatMap((filePath) =>
    checkSource(filePath, readFileSync(filePath, "utf8")),
  );
  for (const violation of violations) {
    console.error(
      `${violation.filePath}:${violation.line}:${violation.column} ${violation.ruleId} ${violation.message}`,
    );
  }
  return violations.length === 0 ? 0 : 1;
}

function collectSourceFiles(paths: readonly string[]): readonly string[] {
  const files: string[] = [];
  for (const path of paths) {
    addSourcePath(path, files);
  }
  return files.sort();
}

function addSourcePath(path: string, files: string[]): void {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (isSourceFile(path)) files.push(path);
    return;
  }
  if (!stat.isDirectory() || isIgnoredPath(path)) return;

  for (const child of readdirSync(path)) {
    addSourcePath(join(path, child), files);
  }
}

function isSourceFile(filePath: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension)) &&
    !filePath.endsWith(".d.ts")
  );
}

function isIgnoredPath(path: string): boolean {
  return path.split("/").some((part) => IGNORED_DIRS.includes(part));
}
