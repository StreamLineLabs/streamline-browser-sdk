import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmCommand,
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  },
);

if (result.error) {
  throw new Error("Unable to run npm pack --dry-run", {
    cause: result.error,
  });
}
if (result.status !== 0) {
  throw new Error(
    `npm pack --dry-run failed with exit code ${result.status}\n${result.stderr}`,
  );
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  throw new Error("npm pack --dry-run did not return valid JSON", {
    cause: error,
  });
}

if (!Array.isArray(report) || report.length !== 1) {
  throw new Error("npm pack --dry-run returned an unexpected package report");
}

const packed = report[0];
if (packed.name !== packageJson.name || packed.version !== packageJson.version) {
  throw new Error(
    `Packed identity ${packed.name}@${packed.version} does not match package.json`,
  );
}

const files = new Set(packed.files.map((file) => file.path));
const requiredFiles = [
  "LICENSE",
  "README.md",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
];
for (const requiredFile of requiredFiles) {
  if (!files.has(requiredFile)) {
    throw new Error(`Published package is missing ${requiredFile}`);
  }
}

const forbiddenFiles = packed.files
  .map((file) => file.path)
  .filter(
    (path) =>
      /(^|\/)(?:src|test|tests|examples|scripts|\.github)\//.test(path) ||
      /(^|\/)test-setup\.(?:d\.ts|js)$/.test(path) ||
      /\.test\.(?:d\.ts|js|ts)$/.test(path),
  );
if (forbiddenFiles.length > 0) {
  throw new Error(
    `Published package contains development-only files: ${forbiddenFiles.join(", ")}`,
  );
}

console.log(
  `Verified ${packed.name}@${packed.version}: ${packed.entryCount} files, ${packed.unpackedSize} unpacked bytes.`,
);
