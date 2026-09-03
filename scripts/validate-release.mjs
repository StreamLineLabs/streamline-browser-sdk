import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function validatePackageMetadata(packageJson, packageLock) {
  const errors = [];
  const { name, version } = packageJson;
  const lockRoot = packageLock.packages?.[""];

  if (typeof name !== "string" || name.length === 0) {
    errors.push("package.json name must be a non-empty string");
  }
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    errors.push("package.json version must be a valid semantic version");
  }
  if (packageJson.private === true) {
    errors.push("package.json is marked private and cannot be published");
  }
  if (packageLock.name !== name) {
    errors.push(
      `package-lock.json name ${String(packageLock.name)} does not match ${String(name)}`,
    );
  }
  if (packageLock.version !== version) {
    errors.push(
      `package-lock.json version ${String(packageLock.version)} does not match ${String(version)}`,
    );
  }
  if (lockRoot?.name !== name) {
    errors.push(
      `package-lock.json root package name ${String(lockRoot?.name)} does not match ${String(name)}`,
    );
  }
  if (lockRoot?.version !== version) {
    errors.push(
      `package-lock.json root package version ${String(lockRoot?.version)} does not match ${String(version)}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(`Invalid package metadata:\n- ${errors.join("\n- ")}`);
  }

  return { name, version };
}

export function validateReleaseTag(tag, version) {
  if (!tag) {
    throw new Error(
      "A release tag is required via a command argument or GITHUB_REF_NAME",
    );
  }

  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(
      `Release tag ${tag} does not match package version ${version}; expected ${expected}`,
    );
  }
}

export async function validateRelease({
  root,
  tag,
  requireTag = true,
}) {
  const packageJson = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  const packageLock = JSON.parse(
    await readFile(resolve(root, "package-lock.json"), "utf8"),
  );
  const identity = validatePackageMetadata(packageJson, packageLock);

  if (requireTag) {
    validateReleaseTag(tag, identity.version);
  }

  return identity;
}

const scriptPath = process.argv[1]
  ? resolve(process.argv[1])
  : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const packageOnly = process.argv.includes("--package-only");
  const tagArgument = process.argv
    .slice(2)
    .find((argument) => !argument.startsWith("--"));
  const identity = await validateRelease({
    root,
    tag: tagArgument ?? process.env.GITHUB_REF_NAME,
    requireTag: !packageOnly,
  });

  console.log(
    packageOnly
      ? `Validated package metadata for ${identity.name}@${identity.version}.`
      : `Validated release ${identity.name}@${identity.version} with tag v${identity.version}.`,
  );
}
