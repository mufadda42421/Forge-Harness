// Prepares installer/staging/ from source, then you run ISCC on ForgeHarness.iss.
// Steps: clean → bundle server to one CJS file → copy migrations + native
// better-sqlite3 (with its two runtime deps) → copy dashboard build → copy node.exe.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(root, "installer", "staging");
const appDir = path.join(staging, "app");

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const cp = (src, dest) => fs.cpSync(src, dest, { recursive: true });

console.log("[installer] cleaning staging…");
rm(staging);
mkdir(appDir);

console.log("[installer] bundling server (esbuild → bundle.cjs)…");
execFileSync(process.execPath, [path.join(root, "scripts", "build-bundle.mjs")], { stdio: "inherit" });

console.log("[installer] copying drizzle migrations…");
cp(path.join(root, "packages", "database", "drizzle"), path.join(appDir, "drizzle"));

console.log("[installer] copying native better-sqlite3 + deps…");
const rootPnpm = path.join(root, "node_modules", ".pnpm");
const findPkg = (prefix) => {
  const entry = fs.readdirSync(rootPnpm).find((name) => name.startsWith(prefix));
  if (!entry) throw new Error(`could not locate ${prefix} in ${rootPnpm} — run \`pnpm install\` first`);
  return path.join(rootPnpm, entry, "node_modules");
};
const modulesDir = path.join(appDir, "node_modules");
mkdir(modulesDir);
for (const [prefix, pkg] of [["better-sqlite3@12.", "better-sqlite3"], ["bindings@", "bindings"], ["file-uri-to-path@", "file-uri-to-path"]]) {
  cp(path.join(findPkg(prefix), pkg), path.join(modulesDir, pkg));
}

console.log("[installer] copying dashboard build…");
const dashboardDist = path.join(root, "apps", "dashboard", "dist");
if (!fs.existsSync(path.join(dashboardDist, "index.html"))) {
  throw new Error("apps/dashboard/dist not built — run `pnpm --filter @forge/dashboard build` first");
}
cp(dashboardDist, path.join(staging, "dashboard-dist"));

console.log("[installer] copying node runtime…");
mkdir(path.join(staging, "runtime"));
fs.copyFileSync(process.execPath, path.join(staging, "runtime", "node.exe"));

// bundle is self-contained; drop any stale deploy artifacts
rm(path.join(appDir, "package.json"));
rm(path.join(appDir, "drizzle-kit"));

console.log("[installer] staging ready:", staging);
console.log("[installer] now run: iscc installer/ForgeHarness.iss");
