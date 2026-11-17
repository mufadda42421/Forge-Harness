// Forge Harness — native desktop shell.
// A thin window around the local engine (bundled Node server). The engine
// serves API + dashboard on 127.0.0.1:4789; the window loads it. One app,
// one taskbar icon, no browser tab required.
const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");

const PORT = Number(process.env.FORGE_PORT ?? 4789);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const isDev = process.env.FORGE_DEV === "1";

let mainWindow = null;
let serverProcess = null;
let serverStarting = false;

// Single instance: focusing an existing window is better than a second server.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function serverHealthy(timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = http.get(`${ORIGIN}/api/v1/health`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function waitForServer(maxWaitMs = 15_000) {
  const start = Date.now();
  for (;;) {
    if (await serverHealthy()) return true;
    if (Date.now() - start > maxWaitMs) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function startEngine() {
  if (serverProcess || serverStarting) return;
  serverStarting = true;
  const appRoot = path.join(__dirname, "server");
  const bundle = path.join(appRoot, "bundle.cjs");
  const bundledNode = path.join(__dirname, "runtime", "node.exe");
  const sourceServer = path.join(__dirname, "..", "..", "services", "api", "dist", "index.js");

  let engineExe, engineArgs, engineCwd, dashboardDist;
  if (fs.existsSync(bundle) && fs.existsSync(bundledNode)) {
    // Packaged layout: self-contained engine
    engineExe = bundledNode;
    engineArgs = [bundle];
    engineCwd = appRoot;
    dashboardDist = path.join(__dirname, "dashboard-dist");
  } else if (fs.existsSync(sourceServer)) {
    // Source layout: dev mode — run the workspace build directly
    console.log("[desktop] bundled engine not found, using source layout (dev)");
    engineExe = process.env.FORGE_NODE ?? "node";
    engineArgs = [sourceServer];
    engineCwd = path.join(__dirname, "..", "..");
    dashboardDist = path.join(__dirname, "..", "..", "apps", "dashboard", "dist");
  } else {
    serverStarting = false;
    dialog.showErrorBox(
      "Forge Harness",
      `Engine not found.\n\nPackaged: ${bundle}\nSource: ${sourceServer}\n\nRebuild with: node scripts/build-installer.mjs`,
    );
    app.quit();
    return;
  }
  serverProcess = spawn(engineExe, engineArgs, {
    cwd: engineCwd,
    env: {
      ...process.env,
      FORGE_DASHBOARD_DIST: dashboardDist,
      FORGE_PORT: String(PORT),
      ELECTRON_RUN_AS_NODE: undefined, // never make the child think it's electron-node
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout.on("data", (d) => process.stdout.write(`[engine] ${d}`));
  serverProcess.stderr.on("data", (d) => process.stderr.write(`[engine] ${d}`));
  serverProcess.on("exit", (code) => {
    console.log(`[desktop] engine exited (code ${code})`);
    serverProcess = null;
    serverStarting = false;
    // If the window is alive and the engine dies, offer restart.
    if (mainWindow && !app.isQuitting) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        buttons: ["Restart engine", "Quit Forge Harness"],
        defaultId: 0,
        message: "The Forge Harness engine stopped unexpectedly.",
      });
      if (choice === 0) startEngine();
      else app.quit();
    }
  });
}

function iconPath() {
  const ico = path.join(__dirname, "assets", "icon.ico");
  return fs.existsSync(ico) ? ico : undefined;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#0b0d10",
    title: "Forge Harness",
    icon: iconPath(),
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      // The renderer is our own built UI over the local engine; no Node integration needed.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => { mainWindow = null; });

  // External links open in the system browser, never inside the app shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(ORIGIN);

  const template = [
    {
      label: "Forge Harness",
      submenu: [
        { label: "Open in browser", click: () => shell.openExternal(ORIGIN) },
        { label: "Restart engine", click: () => { if (serverProcess) serverProcess.kill(); startEngine(); } },
        { type: "separator" },
        { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "togglefullscreen" },
        ...(isDev ? [{ role: "toggleDevTools" }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  if (await serverHealthy()) {
    // An engine is already running (e.g. dev server) — just attach the window.
    createWindow();
    return;
  }
  startEngine();
  const ok = await waitForServer(15_000);
  if (!ok) {
    dialog.showErrorBox(
      "Forge Harness",
      "The local engine did not start within 15 seconds.\n\nCheck that port " + PORT + " is free, then relaunch.",
    );
    app.quit();
    return;
  }
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
app.on("before-quit", () => {
  app.isQuitting = true;
  if (serverProcess) {
    try { serverProcess.kill(); } catch { /* already gone */ }
    serverProcess = null;
  }
});
