import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function createReadmeExamplePattern() {
  return /<!--\s*example:\s*([^\s]+)\s*-->\s*```(?:ts|typescript)\r?\n([\s\S]*?)\r?\n```/g;
}

export function normalizeExampleText(value) {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

export async function checkReadmeExamples(root) {
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  let count = 0;
  const seen = new Set();

  for (const match of readme.matchAll(createReadmeExamplePattern())) {
    const [, relativePath, snippet] = match;
    if (!relativePath || snippet === undefined) {
      throw new Error("README example marker is malformed");
    }
    if (seen.has(relativePath)) {
      throw new Error(`README example is duplicated: ${relativePath}`);
    }

    const examplePath = resolve(root, relativePath);
    const examplesRoot = `${resolve(root, "examples")}${sep}`;
    if (!examplePath.startsWith(examplesRoot)) {
      throw new Error(`README example must be under examples/: ${relativePath}`);
    }

    const source = await readFile(examplePath, "utf8");
    if (normalizeExampleText(source) !== normalizeExampleText(snippet)) {
      throw new Error(
        `README snippet does not match ${relativePath}; update both together`,
      );
    }

    seen.add(relativePath);
    count += 1;
  }

  if (count === 0) {
    throw new Error("README contains no linked TypeScript examples");
  }

  return count;
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const count = await checkReadmeExamples(root);
  console.log(`Verified ${count} README TypeScript examples.`);
}
