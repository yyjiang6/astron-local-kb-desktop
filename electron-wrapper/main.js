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

const { app, BrowserWindow, shell, Menu, session, net } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const SERVER_PORT = process.env.SERVER_PORT || "3001";
const COLLECTOR_PORT = process.env.COLLECTOR_PORT || "8888";
const isDev = !app.isPackaged;

// ===== astron 统一认证中心（SSO）配置：默认指向 stg，可用环境变量覆盖 =====
// 真实拓扑（已从 astron 前端 .env + vite.config.js + hub application-local.yml 核对）：
//   · 登录 UI 页门面：  https://hfaieco-stg-center.cnbita.com/heros/login  （VITE_SSO_BASE_URL）
//   · 验票/getUserInfo：http://222.173.100.190:30080/api/v1/auth/getUserInfo，Host=aicloud-dev.xlc.com
//   · hub 也用同一个用户中心验票 —— 三者同一套 SSO 联邦，cnbita 登录的 ticket 能在 hub 验过。
// 登录流程：弹窗加载 {SSO_LOGIN_BASE}/heros/login?redirect=<回调>&from=agent
//   → 用户登录 → 重定向回 <回调>?ticket=xxx
//   → 拦截 ticket，调 getUserInfo 换 uid/用户名/token，并抓登录会话 Cookie
//   → 写入端云协同配置（headers 带 Cookie，生产关 fallback 时靠稳定会话校验，不依赖一次性 ticket）。
const SSO_LOGIN_BASE = (process.env.ASTRON_SSO_LOGIN_BASE || "https://hfaieco-stg-center.cnbita.com").replace(/\/$/, "");
const SSO_FROM = process.env.ASTRON_SSO_FROM || "agent";
// 验票后端（与登录 UI 不同域）：默认 stg 的 aicloud-dev，调用时带 Host 头
const SSO_AUTH_BASE = (process.env.ASTRON_SSO_AUTH_BASE || "http://222.173.100.190:30080").replace(/\/$/, "");
const SSO_AUTH_HOST = process.env.ASTRON_SSO_AUTH_HOST || "aicloud-dev.xlc.com";
const SSO_USERINFO_PATH = process.env.ASTRON_SSO_USERINFO_PATH || "/api/v1/auth/getUserInfo";
// 回调哨兵：SSO 会重定向到它并带 ?ticket=，我们在 will-redirect 阶段拦截，URL 本身无需真的可达
const SSO_CALLBACK = `http://127.0.0.1:${SERVER_PORT}/sso-callback`;

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

// ===== astron SSO 登录：弹真实统一认证页 → 拦 ticket → 换 uid/token + 抓 Cookie → 写端云配置 =====
let loginWin = null;

// Node 原生 http(s)：允许覆盖 Host 头（Electron net.request 设 Host 会抛 ERR_INVALID_ARGUMENT），
// 并能取 Set-Cookie。用于 ticket 换 getUserInfo（验票后端是 IP + 虚拟主机，必须改 Host）。
function rawHttp({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    const { URL } = require("url");
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const payload = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const req = mod.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search, method: method || "GET",
        headers: { ...(headers || {}), ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, text: d, setCookie: res.headers["set-cookie"] || [] })); }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 调本地 server（127.0.0.1:SERVER_PORT）读/写端云配置
function localServer({ method, path: p, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "127.0.0.1", port: SERVER_PORT, path: p, method,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, text: d })); }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function finishLoginWithTicket(ticket, sess) {
  // 1) 用 ticket 换用户信息（验票后端与登录 UI 不同域，需带 Host；用 Node http 以便覆盖 Host + 抓 Set-Cookie）
  let uid = "", username = "", token = "", setCookieArr = [];
  try {
    const r = await rawHttp({
      method: "GET",
      url: SSO_AUTH_BASE + SSO_USERINFO_PATH,
      headers: { "X-Auth-Ticket": ticket, "X-Auth-Type": "3", Host: SSO_AUTH_HOST, Accept: "application/json" },
    });
    setCookieArr = r.setCookie || [];
    const j = JSON.parse(r.text || "{}");
    const d = j.data || j;
    uid = String(d.uid || d.userId || d.id || "");
    username = String(d.login || d.username || d.nickname || uid || "");
    token = d.token ? String(d.token) : "";
  } catch (e) {
    console.error("[astron] getUserInfo 换票失败：", e.message);
  }
  // 远端可能不返 token：用 ticket 顶替，满足 hub fallback 的 token+uid 双必填
  if (!token) token = ticket;

  // 2) 组装 Cookie：优先 getUserInfo 下发的 Set-Cookie，再并上会话里 SSO 域 cookie（生产关 fallback 时靠它做稳定会话校验）
  let cookieStr = "";
  try {
    const fromSet = (setCookieArr || []).map((sc) => String(sc).split(";")[0]).filter(Boolean);
    const all = await sess.cookies.get({});
    const fromSess = all.filter((c) => /cnbita\.com$|xlc\.com$/.test(c.domain || "")).map((c) => `${c.name}=${c.value}`);
    cookieStr = [...fromSet, ...fromSess].join("; ");
  } catch (_) {}

  // 3) 组装鉴权头（与手动粘贴备用路径写的是同一份配置）
  const headers = {
    "X-Auth-Type": "3",
    "X-Auth-User-Id": uid,
    "X-Auth-User-Name": username,
    token,
    "X-Auth-Ticket": ticket,
  };
  if (cookieStr) headers["Cookie"] = cookieStr;

  // 4) 读现有配置保留 gateway_url/mode，仅覆盖 headers，写回本地 server
  let gateway_url = "", mode = "hybrid";
  try {
    const cur = await localServer({ method: "GET", path: "/knowledge/v1/astron/config" });
    const c = JSON.parse(cur.text || "{}").data || {};
    gateway_url = c.gateway_url || "";
    mode = c.mode || "hybrid";
  } catch (_) {}
  await localServer({ method: "POST", path: "/knowledge/v1/astron/config", body: { gateway_url, mode, headers } });

  if (loginWin && !loginWin.isDestroyed()) loginWin.close();
  if (panelWin && !panelWin.isDestroyed()) panelWin.reload();
  console.log(`[astron] SSO 登录完成：uid=${uid} user=${username} cookie=${cookieStr ? "有" : "无"}`);
}

function startAstronLogin() {
  if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return; }
  const sess = session.fromPartition("persist:astron-sso");
  loginWin = new BrowserWindow({
    width: 520, height: 680, title: "登录 astron",
    parent: panelWin && !panelWin.isDestroyed() ? panelWin : undefined,
    webPreferences: { contextIsolation: true, session: sess },
  });
  const loginUrl = `${SSO_LOGIN_BASE}/heros/login?redirect=${encodeURIComponent(SSO_CALLBACK)}&from=${encodeURIComponent(SSO_FROM)}`;
  loginWin.loadURL(loginUrl);

  let done = false;
  const tryTicket = (url, e) => {
    if (done) return;
    const m = (url || "").match(/[?&]ticket=([^&?#]+)/);
    if (!m) return;
    done = true;
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    finishLoginWithTicket(decodeURIComponent(m[1]), sess).catch((err) =>
      console.error("[astron] 登录收尾失败：", err.message)
    );
  };
  loginWin.webContents.on("will-redirect", (e, url) => tryTicket(url, e));
  loginWin.webContents.on("will-navigate", (e, url) => tryTicket(url, e));
  loginWin.webContents.on("did-navigate", (_e, url) => tryTicket(url, null));
  loginWin.on("closed", () => { loginWin = null; });
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
          label: "登录 astron（获取鉴权）",
          accelerator: "CmdOrCtrl+Shift+L",
          click: startAstronLogin,
        },
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
  // macOS：关闭窗口不退出 App，也不要杀后端——否则点 Dock 图标重开窗口时
  // server 已死，会打不开原来的页面（白屏/连不上）。只有真正退出（Cmd+Q）才 shutdown。
  if (process.platform !== "darwin") {
    shutdown();
    app.quit();
  }
});
app.on("quit", shutdown);
