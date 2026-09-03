import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmCommand,
  ["sbom", "--sbom-format=cyclonedx", "--omit=dev"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  },
);

if (result.error) {
  throw new Error("Unable to run npm sbom", { cause: result.error });
}
if (result.status !== 0) {
  throw new Error(
    `npm sbom failed with exit code ${result.status}\n${result.stderr}`,
  );
}

let sbom;
try {
  sbom = JSON.parse(result.stdout);
} catch (error) {
  throw new Error("npm sbom did not return valid JSON", { cause: error });
}

if (sbom.bomFormat !== "CycloneDX") {
  throw new Error(`Unexpected SBOM format: ${String(sbom.bomFormat)}`);
}
const expectedReference = `${packageJson.name}@${packageJson.version}`;
if (
  sbom.metadata?.component?.["bom-ref"] !== expectedReference ||
  sbom.metadata?.component?.version !== packageJson.version
) {
  throw new Error(
    "SBOM root component does not match the package name and version",
  );
}

console.log(
  `Validated CycloneDX SBOM for ${packageJson.name}@${packageJson.version}.`,
);
