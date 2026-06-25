/**
 * 独立 SSO 登录调试脚本（不打包、不拉起 server）。
 *
 * 用途：直接连 stg 把「弹登录页 → 拦 ticket → 换 uid/token → 抓 Cookie → 写端云配置」整条链路跑通，
 *       全程打印每一步，便于定位 SSO 回调白名单 / 换票 / Cookie 等问题。
 *
 * 前提：正在运行的 AstronLocalKB.app（或任意本地 server）监听 127.0.0.1:3001，
 *       本脚本登录成功后会把鉴权头 POST 到它的 /knowledge/v1/astron/config。
 *
 * 运行：
 *   cd electron-wrapper
 *   ./node_modules/.bin/electron login-test.js
 *   # 可覆盖地址：
 *   SERVER_PORT=3001 ASTRON_SSO_LOGIN_BASE=https://hfaieco-stg-center.cnbita.com ./node_modules/.bin/electron login-test.js
 */
const { app, BrowserWindow, session, net } = require("electron");
const http = require("http");
const https = require("https");
const { URL } = require("url");

// Node 原生 http(s) 请求：允许覆盖 Host 头（Electron net.request 设 Host 会抛 ERR_INVALID_ARGUMENT），
// 并能拿到 Set-Cookie。用于 ticket 换 getUserInfo（后端是 IP + 虚拟主机，必须改 Host）。
function rawHttp({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
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

const SERVER_PORT = process.env.SERVER_PORT || "3001";
const SSO_LOGIN_BASE = (process.env.ASTRON_SSO_LOGIN_BASE || "https://hfaieco-stg-center.cnbita.com").replace(/\/$/, "");
const SSO_FROM = process.env.ASTRON_SSO_FROM || "agent";
const SSO_AUTH_BASE = (process.env.ASTRON_SSO_AUTH_BASE || "http://222.173.100.190:30080").replace(/\/$/, "");
const SSO_AUTH_HOST = process.env.ASTRON_SSO_AUTH_HOST || "aicloud-dev.xlc.com";
const SSO_USERINFO_PATH = process.env.ASTRON_SSO_USERINFO_PATH || "/api/v1/auth/getUserInfo";
const SSO_CALLBACK = `http://127.0.0.1:${SERVER_PORT}/sso-callback`;

const log = (...a) => console.log("[login-test]", ...a);

function netJson(sess, { method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: method || "GET", url, session: sess, useSessionCookies: true });
    for (const [k, v] of Object.entries(headers || {})) req.setHeader(k, v);
    let data = "";
    req.on("response", (res) => {
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

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

async function finishLoginWithTicket(ticket, sess, win) {
  log("==== 抓到 ticket ====", ticket);

  // 1) 换用户信息（Node http，可覆盖 Host + 抓 Set-Cookie）
  log("调 getUserInfo:", SSO_AUTH_BASE + SSO_USERINFO_PATH, "Host=", SSO_AUTH_HOST);
  let uid = "", username = "", token = "", setCookieArr = [];
  try {
    const r = await rawHttp({
      method: "GET",
      url: SSO_AUTH_BASE + SSO_USERINFO_PATH,
      headers: { "X-Auth-Ticket": ticket, "X-Auth-Type": "3", Host: SSO_AUTH_HOST, Accept: "application/json" },
    });
    log("getUserInfo HTTP", r.status, "body:", r.text);
    setCookieArr = r.setCookie || [];
    if (setCookieArr.length) log("getUserInfo 下发 Set-Cookie:", setCookieArr.join(" || "));
    const j = JSON.parse(r.text || "{}");
    const d = j.data || j;
    uid = d.uid || d.userId || d.id || "";
    username = d.login || d.username || d.nickname || uid;
    token = d.token || "";
  } catch (e) {
    log("✗ getUserInfo 失败:", e.message);
  }
  if (!token) { token = ticket; log("用户信息未返回 token，用 ticket 顶替"); }

  // 2) 组装 Cookie：优先用 getUserInfo 下发的 Set-Cookie，再并上会话里 SSO 域的 cookie
  let cookieStr = "";
  try {
    const fromSet = (setCookieArr || []).map((sc) => String(sc).split(";")[0]).filter(Boolean);
    const all = await sess.cookies.get({});
    log("会话里全部 Cookie 域名:", [...new Set(all.map((c) => c.domain))].join(", ") || "(空)");
    const fromSess = all.filter((c) => /cnbita\.com$|xlc\.com$/.test(c.domain || "")).map((c) => `${c.name}=${c.value}`);
    cookieStr = [...fromSet, ...fromSess].join("; ");
    log("最终 Cookie 串:", cookieStr || "(无)");
  } catch (e) { log("读 Cookie 失败:", e.message); }

  // 3) 组装并写配置
  const headers = { "X-Auth-Type": "3", "X-Auth-User-Id": uid, "X-Auth-User-Name": username, token, "X-Auth-Ticket": ticket };
  if (cookieStr) headers["Cookie"] = cookieStr;
  log("最终鉴权头:", JSON.stringify({ ...headers, token: token.slice(0, 8) + "…", Cookie: cookieStr ? "(已带)" : undefined }));

  let gateway_url = "", mode = "hybrid";
  try {
    const cur = await localServer({ method: "GET", path: "/knowledge/v1/astron/config" });
    const c = JSON.parse(cur.text || "{}").data || {};
    gateway_url = c.gateway_url || "";
    mode = c.mode || "hybrid";
    log("现有配置 gateway_url=", gateway_url || "(空)", "mode=", mode);
  } catch (e) { log("读本地配置失败（server 没起？）:", e.message); }

  try {
    const w = await localServer({ method: "POST", path: "/knowledge/v1/astron/config", body: { gateway_url, mode, headers } });
    log("写配置 HTTP", w.status, w.text);
    log("✅ 登录链路完成。uid=", uid, "user=", username, "—— 回到 App 控制台「刷新状态」即可看到已连接。");
  } catch (e) { log("✗ 写配置失败:", e.message); }
}

app.whenReady().then(() => {
  const sess = session.fromPartition("persist:astron-sso");
  const win = new BrowserWindow({ width: 560, height: 720, title: "SSO 登录调试", webPreferences: { contextIsolation: true, session: sess } });
  win.webContents.openDevTools({ mode: "detach" });

  const loginUrl = `${SSO_LOGIN_BASE}/heros/login?redirect=${encodeURIComponent(SSO_CALLBACK)}&from=${encodeURIComponent(SSO_FROM)}`;
  log("加载登录页:", loginUrl);
  log("回调哨兵:", SSO_CALLBACK);
  win.loadURL(loginUrl);

  let done = false;
  const tryTicket = (tag, url, e) => {
    log(`[${tag}]`, url);
    if (done) return;
    const m = (url || "").match(/[?&]ticket=([^&?#]+)/);
    if (!m) return;
    done = true;
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    finishLoginWithTicket(decodeURIComponent(m[1]), sess, win).catch((err) => log("收尾异常:", err.message));
  };
  win.webContents.on("will-redirect", (e, url) => tryTicket("will-redirect", url, e));
  win.webContents.on("will-navigate", (e, url) => tryTicket("will-navigate", url, e));
  win.webContents.on("did-navigate", (_e, url) => tryTicket("did-navigate", url, null));
  win.webContents.on("did-navigate-in-page", (_e, url) => tryTicket("did-navigate-in-page", url, null));
  win.webContents.on("did-fail-load", (_e, code, desc, url) => log("did-fail-load", code, desc, url));
});

app.on("window-all-closed", () => app.quit());
