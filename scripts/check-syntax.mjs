import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directories = [
  ["src", (name) => name.endsWith(".js")],
  ["test", (name) => name.endsWith(".test.js")],
  ["bench", (name) => name.endsWith(".mjs")],
  ["scripts", (name) => name.endsWith(".mjs")],
];
let checked = 0;
for (const [directory, accepts] of directories) {
  for (const name of readdirSync(directory).filter(accepts).sort()) {
    const path = join(directory, name);
    const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    checked++;
  }
}
console.log(`Syntax verified for ${checked} source, test, benchmark and script files.`);
