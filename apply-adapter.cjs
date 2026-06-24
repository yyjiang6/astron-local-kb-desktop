#!/usr/bin/env node
/**
 * 把 astron 统一知识问答协议适配器应用到一份 anything-llm 源码。
 *
 * 用法：
 *   node apply-adapter.cjs <anything-llm 根目录>
 *   # 或
 *   ANYLLM_ROOT=/path/to/anything-llm node apply-adapter.cjs
 *
 * 做三件事（幂等，可重复运行）：
 *   1. 复制 astronKnowledge.js -> <root>/server/endpoints/astronKnowledge.js
 *   2. 在 <root>/server/index.js 注入 require + astronKnowledgeEndpoints(app)
 *   3. 给 <root>/server/utils/collectorApi/index.js 的 parseDocument 加 600s 长超时 dispatcher
 *
 * 设计为在 CI（GitHub Actions）里对 checkout 出来的 anything-llm 源码执行，
 * 这样适配器会被一起打包进桌面端 server.js。
 */

const fs = require("fs");
const path = require("path");

const root = process.argv[2] || process.env.ANYLLM_ROOT;
if (!root) {
  console.error("用法: node apply-adapter.cjs <anything-llm 根目录>  (或设 ANYLLM_ROOT)");
  process.exit(1);
}

const serverDir = path.join(root, "server");
const indexPath = path.join(serverDir, "index.js");
const endpointsDir = path.join(serverDir, "endpoints");
const collectorPath = path.join(serverDir, "utils", "collectorApi", "index.js");
const adapterSrc = path.join(__dirname, "astronKnowledge.js");
const adapterDst = path.join(endpointsDir, "astronKnowledge.js");

function die(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}
if (!fs.existsSync(indexPath)) die(`未找到 ${indexPath} —— 第一个参数应为 anything-llm 根目录`);
if (!fs.existsSync(adapterSrc)) die(`未找到适配器源文件 ${adapterSrc}（应与本脚本同目录）`);

// 1) 复制适配器文件
fs.mkdirSync(endpointsDir, { recursive: true });
fs.copyFileSync(adapterSrc, adapterDst);
console.log(`✓ 写入 ${path.relative(root, adapterDst)}`);

// 2) 注入 server/index.js
let idx = fs.readFileSync(indexPath, "utf-8");
if (idx.includes("astronKnowledgeEndpoints")) {
  console.log("• server/index.js 已包含适配器挂载，跳过");
} else {
  const requireLine =
    'const { astronKnowledgeEndpoints } = require("./endpoints/astronKnowledge");\n';
  // require：插在第一处 endpoints require 之前；找不到则插在文件顶部
  const firstEndpointReq = idx.search(/const\s*\{[^}]*\}\s*=\s*require\(["']\.\/endpoints\//);
  if (firstEndpointReq >= 0) {
    idx = idx.slice(0, firstEndpointReq) + requireLine + idx.slice(firstEndpointReq);
  } else {
    idx = requireLine + idx;
  }
  // mount：插在 app.use("/api", apiRouter); 之后（适配器直接挂 app，路径精确为 /knowledge/v1/*）
  const mountAnchor = /app\.use\(\s*["']\/api["']\s*,\s*apiRouter\s*\)\s*;?/;
  const m = idx.match(mountAnchor);
  if (m) {
    const insertAt = m.index + m[0].length;
    const mountLine =
      "\n// astron 统一知识问答协议适配器：直接挂在 app 上，路径精确为 /knowledge/v1/*\nastronKnowledgeEndpoints(app);";
    idx = idx.slice(0, insertAt) + mountLine + idx.slice(insertAt);
  } else {
    die('无法在 server/index.js 找到 `app.use("/api", apiRouter)` 锚点，请手动添加 astronKnowledgeEndpoints(app);');
  }
  fs.writeFileSync(indexPath, idx);
  console.log("✓ 注入 server/index.js（require + astronKnowledgeEndpoints(app)）");
}

// 3) collectorApi parseDocument 长超时（大文件解析防 "fetch failed"）。失败仅告警，不中断。
try {
  if (!fs.existsSync(collectorPath)) {
    console.warn("• 未找到 collectorApi/index.js，跳过长超时补丁（可手动加）");
  } else {
    let col = fs.readFileSync(collectorPath, "utf-8");
    const parseAt = col.indexOf("/parse`");
    if (parseAt < 0) {
      console.warn("• collectorApi 未找到 /parse 锚点，跳过长超时补丁（版本差异，可手动加）");
    } else {
      // 在 /parse fetch 的 `body: data,` 后插入 dispatcher（若该 fetch 块尚无 dispatcher）
      const bodyAt = col.indexOf("body: data,", parseAt);
      const windowAfter = col.slice(bodyAt, bodyAt + 200);
      if (bodyAt < 0) {
        console.warn("• 未定位到 parseDocument 的 body，跳过长超时补丁");
      } else if (windowAfter.includes("dispatcher")) {
        console.log("• collectorApi.parseDocument 已有 dispatcher，跳过");
      } else {
        const insertAt = bodyAt + "body: data,".length;
        const disp =
          "\n      // 大文件/扫描件解析耗时较长，加长 headersTimeout，避免默认超时导致 \"fetch failed\"\n      dispatcher: new Agent({ headersTimeout: 600000 }),";
        col = col.slice(0, insertAt) + disp + col.slice(insertAt);
        if (!/require\(["']undici["']\)/.test(col) || !/\bAgent\b/.test(col.split("\n").slice(0, 5).join("\n"))) {
          // 确保 Agent 已导入（多数版本已在顶部 `const { Agent } = require("undici");`）
          if (!/const\s*\{[^}]*\bAgent\b[^}]*\}\s*=\s*require\(["']undici["']\)/.test(col)) {
            col = 'const { Agent } = require("undici");\n' + col;
          }
        }
        fs.writeFileSync(collectorPath, col);
        console.log("✓ collectorApi.parseDocument 加 600s 长超时 dispatcher");
      }
    }
  }
} catch (e) {
  console.warn("• collectorApi 补丁失败（非致命）:", e.message);
}

// 4) 深度集成：在自带对话 stream.js 本地检索后并入云端片段（端云协同）。幂等；失败仅告警。
try {
  const streamPath = path.join(serverDir, "utils", "chats", "stream.js");
  if (!fs.existsSync(streamPath)) {
    console.warn("• 未找到 chats/stream.js，跳过对话深度集成（版本差异）");
  } else {
    let s = fs.readFileSync(streamPath, "utf-8");
    if (s.includes("端云协同（深度集成）")) {
      console.log("• stream.js 已含端云对话集成，跳过");
    } else {
      const anchor = "sources = [...sources, ...vectorSearchResults.sources];";
      const at = s.indexOf(anchor);
      if (at < 0) {
        console.warn("• stream.js 未找到 sources 合并锚点，跳过对话深度集成（可手动加）");
      } else {
        const inject =
          "\n\n  // === astron 端云协同（深度集成）：把云端个人知识库相关片段并入上下文 + 引用 ===\n" +
          "  // 仅当已在「端云协同控制台」连接云端时生效；失败/未连接不影响本地对话。\n" +
          "  try {\n" +
          '    const { retrieveCloudPersonal } = require("../../endpoints/astronKnowledge");\n' +
          "    const cloudChunks = await retrieveCloudPersonal(updatedMessage, workspace?.topN || 4, []);\n" +
          "    for (const c of cloudChunks || []) {\n" +
          "      if (!c || !c.content) continue;\n" +
          "      contextTexts.push(c.content);\n" +
          '      sources.push({ text: c.content, title: c.file_name || c.doc_id || "云端文档", chunkSource: "astron-cloud", score: c.score, _origin: "cloud" });\n' +
          "    }\n" +
          '  } catch (e) { console.error("[astron] cloud merge in chat failed:", e.message); }';
        const insertAt = at + anchor.length;
        s = s.slice(0, insertAt) + inject + s.slice(insertAt);
        fs.writeFileSync(streamPath, s);
        console.log("✓ stream.js 注入端云对话深度集成");
      }
    }
  }
} catch (e) {
  console.warn("• stream.js 深度集成失败（非致命）:", e.message);
}

console.log("\n完成。适配器已应用，桌面端打包 server 时会一并包含 /knowledge/v1/* 端点 + 端云对话集成。");
