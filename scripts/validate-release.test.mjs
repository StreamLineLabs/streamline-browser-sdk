import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validatePackageMetadata,
  validateReleaseTag,
} from "./validate-release.mjs";
import {
  createReadmeExamplePattern,
  normalizeExampleText,
} from "./check-readme-examples.mjs";

function metadata(version = "0.4.0") {
  return {
    packageJson: {
      name: "@streamlinelabs/browser-sdk",
      version,
    },
    packageLock: {
      name: "@streamlinelabs/browser-sdk",
      version,
      packages: {
        "": {
          name: "@streamlinelabs/browser-sdk",
          version,
        },
      },
    },
  };
}

test("accepts matching package and lockfile metadata", () => {
  const { packageJson, packageLock } = metadata();
  assert.deepEqual(validatePackageMetadata(packageJson, packageLock), {
    name: "@streamlinelabs/browser-sdk",
    version: "0.4.0",
  });
});

test("rejects a package-lock version mismatch", () => {
  const { packageJson, packageLock } = metadata();
  packageLock.packages[""].version = "0.2.0";

  assert.throws(
    () => validatePackageMetadata(packageJson, packageLock),
    /root package version 0\.2\.0 does not match 0\.4\.0/,
  );
});

test("accepts a v-prefixed tag matching the package version", () => {
  assert.doesNotThrow(() => validateReleaseTag("v0.4.0", "0.4.0"));
});

test("rejects missing and mismatched release tags", () => {
  assert.throws(() => validateReleaseTag(undefined, "0.4.0"), /required/);
  assert.throws(
    () => validateReleaseTag("0.4.0", "0.4.0"),
    /expected v0\.4\.0/,
  );
  assert.throws(
    () => validateReleaseTag("v0.4.1", "0.4.0"),
    /does not match package version/,
  );
});

test("live integration remains fail-closed without a validated suite", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./run-live-integration.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        STREAMLINE_BROWSER_WS_URL: "wss://untrusted.example.invalid/browser",
        STREAMLINE_BROWSER_TOKEN: "must-not-be-sent",
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Live integration is blocked/);
  assert.match(result.stderr, /no browser-protocol Streamline fixture/);
});

test("README example matching accepts and normalizes CRLF", () => {
  const readme = [
    "<!-- example: examples/quick-start.ts -->",
    "```typescript",
    'console.log("example");',
    "```",
  ].join("\r\n");
  const matches = [...readme.matchAll(createReadmeExamplePattern())];

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.[1], "examples/quick-start.ts");
  assert.equal(
    normalizeExampleText(matches[0]?.[2] ?? ""),
    'console.log("example");',
  );
});
