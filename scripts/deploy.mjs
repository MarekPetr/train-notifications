import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function gitShort() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return "nogit";
  }
}

const deployId = `${Date.now()}-${gitShort()}`;
console.log(`Building web UI…`);
execFileSync("pnpm", ["build:web"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

console.log(`Deploying with DEPLOY_ID=${deployId}`);
execFileSync(
  "pnpm",
  ["exec", "wrangler", "deploy", "--var", `DEPLOY_ID:${deployId}`],
  { cwd: root, stdio: "inherit", shell: true },
);
