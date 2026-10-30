import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("installer copies runtime hooks and dependency manifest, skips tests, and reports missing dependencies", async () => {
  const root = await fs.mkdtemp(path.join(pluginRoot, ".installer-test-"));
  try {
    await fs.mkdir(path.join(root, ".opencode"), {recursive: true});
    const originalPackage = JSON.stringify({name: "my-opencode-project", dependencies: {"my-existing-dependency": "1.0.0"}}, null, 2) + "\n";
    await fs.writeFile(path.join(root, ".opencode/package.json"), originalPackage);
    const install = spawnSync("bash", [path.join(pluginRoot, "install.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {...process.env, ART_BUNDLE_PLUGIN_DIR: pluginRoot},
    });
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    assert.equal(await fs.readFile(path.join(root, ".opencode/package.json"), "utf8"), originalPackage);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(root, ".opencode/plugin-dependencies.json"), "utf8")),
      JSON.parse(await fs.readFile(path.join(pluginRoot, ".opencode/plugin-dependencies.json"), "utf8")),
    );
    assert.equal(await fs.stat(path.join(root, ".opencode/hooks/art-sync.ts")).then(() => true, () => false), true);
    assert.equal(await fs.stat(path.join(root, ".opencode/hooks/art-sync.test.ts")).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(root, ".opencode/plugins/art-mcp-plugin.test.ts")).then(() => true, () => false), false);
    assert.match(install.stdout, /@opencode-ai\/plugin/);
    assert.match(install.stdout, /yaml/);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});
