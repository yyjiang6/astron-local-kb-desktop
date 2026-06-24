/**
 * 本地知识库桌面客户端 · Electron 外壳主进程
 *
 * 由于 anything-llm 没有公开的桌面构建仓库，这里自建一个最小外壳：
 *   1. 用「随包的 Node 运行时」拉起 anything-llm 的 server（含 astron /knowledge/v1 适配器）和 collector
 *      —— 用真实 node 子进程跑，避开 electron 原生模块 ABI 重建问题（lancedb/onnxruntime/better-sqlite3）。
 *   2. 等 server 健康检查通过后，打开窗口加载前端。
 *
 * 资源布局（electron-builder extraResources 注入到 process.resourcesPath/app）：
 *   <resources>/app/server       anything-llm server（已 npm 安装 + 含适配器）
 *   <resources>/app/collector    anything-llm collector（已 npm 安装）
 *   <resources>/app/frontend     前端构建产物(dist) —— 实际由 server 静态托管，这里直接连 server
 *   <resources>/app/node(.exe)   随包 Node 运行时（与 server node_modules 同一 ABI）
 *
 * 数据目录用 app.getPath('userData')，避免污染安装目录。
 */

const { app, BrowserWindow, shell, Menu } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const SERVER_PORT = process.env.SERVER_PORT || "3001";
const COLLECTOR_PORT = process.env.COLLECTOR_PORT || "8888";
const isDev = !app.isPackaged;

// 资源根：打包后在 resourcesPath/app；开发时用环境变量 ANYLLM_DIR 指向 anything-llm 源码根
const RES = isDev
  ? process.env.ANYLLM_DIR || path.resolve(__dirname, "..", "..", "..", "..", "..", "anything-llm")
  : path.join(process.resourcesPath, "app");

// 随包 node 路径（开发时用系统 node）
const NODE_BIN = isDev
  ? process.execPath && process.env.ELECTRON_RUN_AS_NODE
    ? process.execPath
    : "node"
  : path.join(RES, process.platform === "win32" ? "node.exe" : "node");

const STORAGE_DIR = path.join(app.getPath("userData"), "storage");

let serverProc = null;
let collectorProc = null;
let win = null;

// 修复 hotdir 不一致：server 上传时按 STORAGE_DIR/../../collector/hotdir 写文件，
// 而 collector 硬编码读包内 collector/hotdir。把前者软链到后者，使两边指向同一目录。
function ensureHotdirLink() {
  try {
    const fs = require("fs");
    const serverExpect = path.resolve(STORAGE_DIR, "../../collector/hotdir");
    const collectorReal = path.join(RES, "collector", "hotdir");
    fs.mkdirSync(collectorReal, { recursive: true });
    fs.mkdirSync(path.dirname(serverExpect), { recursive: true });
    // 已存在的普通目录先清掉，再建软链（幂等）
    try {
      const st = fs.lstatSync(serverExpect);
      if (st.isSymbolicLink()) {
        if (fs.readlinkSync(serverExpect) === collectorReal) return;
        fs.unlinkSync(serverExpect);
      } else {
        fs.rmSync(serverExpect, { recursive: true, force: true });
      }
    } catch (_) {}
    fs.symlinkSync(collectorReal, serverExpect);
  } catch (e) {
    console.error("[ensureHotdirLink]", e.message);
  }
}

function startBackend() {
  ensureHotdirLink();
  const commonEnv = {
    ...process.env,
    NODE_ENV: "production",
    STORAGE_DIR,
    SERVER_PORT,
    COLLECTOR_PORT,
    // 用原生 embedder（无需任何 API key，内置默认模型 + 按需下载）
    EMBEDDING_ENGINE: process.env.EMBEDDING_ENGINE || "native",
    VECTOR_DB: process.env.VECTOR_DB || "lancedb",
  };

  const serverDir = path.join(RES, "server");
  serverProc = spawn(NODE_BIN, ["index.js"], {
    cwd: serverDir,
    env: commonEnv,
    stdio: "inherit",
  });
  serverProc.on("exit", (code) => console.log("[server] exited", code));

  const collectorDir = path.join(RES, "collector");
  collectorProc = spawn(NODE_BIN, ["index.js"], {
    cwd: collectorDir,
    env: commonEnv,
    stdio: "inherit",
  });
  collectorProc.on("exit", (code) => console.log("[collector] exited", code));
}

function waitForServer(retries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get(
        { host: "127.0.0.1", port: SERVER_PORT, path: "/api/ping", timeout: 1500 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", () => {
        if (n <= 0) return reject(new Error("server 未在限定时间内就绪"));
        setTimeout(() => tick(n - 1), 1000);
      });
      req.on("timeout", () => {
        req.destroy();
        if (n <= 0) return reject(new Error("server 健康检查超时"));
        setTimeout(() => tick(n - 1), 1000);
      });
    };
    tick(retries);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "本地知识库客户端",
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(`http://127.0.0.1:${SERVER_PORT}`);
  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// 端云协同控制台：在 app 内新窗口打开内置控制台页（菜单项触发）
let panelWin = null;
function openControlPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 1100,
    height: 820,
    title: "端云协同控制台",
    webPreferences: { contextIsolation: true },
  });
  panelWin.loadURL(`http://127.0.0.1:${SERVER_PORT}/knowledge/v1/astron/ui`);
  panelWin.on("closed", () => {
    panelWin = null;
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "端云协同",
      submenu: [
        {
          label: "打开控制台",
          accelerator: "CmdOrCtrl+Shift+K",
          click: openControlPanel,
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  startBackend();
  try {
    await waitForServer();
  } catch (e) {
    console.error(e.message);
  }
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function shutdown() {
  try { serverProc && serverProc.kill(); } catch (_) {}
  try { collectorProc && collectorProc.kill(); } catch (_) {}
}
app.on("window-all-closed", () => {
  shutdown();
  if (process.platform !== "darwin") app.quit();
});
app.on("quit", shutdown);
