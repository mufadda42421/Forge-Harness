// Builds the native Forge Harness desktop app:
//   installer/staging-electron/ForgeHarness.exe (+ full Electron runtime + app)
// Consumes the already-built server bundle from installer/staging (build-installer.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staging = path.join(root, "installer", "staging");           // produced by build-installer.mjs
const out = path.join(root, "installer", "staging-electron");      // Electron app root (input to .iss)
const appDir = path.join(out, "resources", "app");

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const cp = (src, dest) => fs.cpSync(src, dest, { recursive: true });
const exists = (p) => fs.existsSync(p);

// 1. Ensure the engine staging exists (bundle, native modules, dashboard, runtime)
if (!exists(path.join(staging, "app", "bundle.cjs"))) {
  console.log("[desktop] engine staging missing — running scripts/build-installer.mjs");
  execFileSync(process.execPath, [path.join(root, "scripts", "build-installer.mjs")], { stdio: "inherit" });
}

console.log("[desktop] cleaning staging-electron…");
rm(out);
mkdir(appDir);
mkdir(out);

// 2. Copy the Electron runtime (all DLLs, locales, resources scaffold)
const electronDist = path.join(root, "node_modules", "electron", "dist");
if (!exists(path.join(electronDist, "electron.exe"))) {
  throw new Error("electron runtime not found at node_modules/electron/dist — run `pnpm install`");
}
console.log("[desktop] copying Electron runtime (~90 MB)…");
cp(electronDist, out);

// 3. Rename electron.exe → ForgeHarness.exe
const renamed = path.join(out, "ForgeHarness.exe");
fs.renameSync(path.join(out, "electron.exe"), renamed);
// drop the default-app placeholder; our resources/app takes over
rm(path.join(out, "resources", "default_app.asar"));

// 4. App payload: manifest + shell + engine + dashboard + icon + runtime
const pkgManifest = {
  name: "forge-harness",
  productName: "Forge Harness",
  version: "0.1.0",
  description: "Forge Harness — your AI infrastructure. Your models. Your rules.",
  main: "main.cjs",
  author: "Forge Harness",
  license: "Proprietary",
};
fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify(pkgManifest, null, 2));
cp(path.join(root, "apps", "desktop", "main.cjs"), path.join(appDir, "main.cjs"));
mkdir(path.join(appDir, "assets"));
cp(path.join(root, "installer", "assets", "icon.ico"), path.join(appDir, "assets", "icon.ico"));
mkdir(path.join(appDir, "server"));
cp(path.join(staging, "app", "bundle.cjs"), path.join(appDir, "server", "bundle.cjs"));
cp(path.join(staging, "app", "drizzle"), path.join(appDir, "server", "drizzle"));
cp(path.join(staging, "app", "node_modules"), path.join(appDir, "server", "node_modules"));
cp(path.join(staging, "dashboard-dist"), path.join(appDir, "dashboard-dist"));
mkdir(path.join(appDir, "runtime"));
cp(path.join(staging, "runtime", "node.exe"), path.join(appDir, "runtime", "node.exe"));

// 5. Brand the executable: icon + version strings
console.log("[desktop] branding executable (rcedit)…");
const { rcedit } = await import("rcedit");
await rcedit(renamed, {
  icon: path.join(root, "installer", "assets", "icon.ico"),
  'file-version': '0.1.0.0',
  'product-version': '0.1.0.0',
  'version-string': {
    CompanyName: 'Forge Harness',
    FileDescription: 'Forge Harness — Your AI Infrastructure',
    ProductName: 'Forge Harness',
    LegalCopyright: 'Copyright © 2026 Forge Harness',
    OriginalFilename: 'ForgeHarness.exe',
    InternalName: 'ForgeHarness',
  },
});

// 6. Convenience copies for the installer script
const iconSrc = path.join(root, "installer", "assets", "icon.ico");
cp(iconSrc, path.join(out, "icon.ico"));

console.log("[desktop] native app staged at", out);
