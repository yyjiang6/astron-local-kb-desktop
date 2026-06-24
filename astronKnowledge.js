/**
 * Astron 统一知识问答协议适配器（阶段2）
 *
 * 让 fork 的 anything-llm 在本机对外暴露 astron 的 `/knowledge/v1` 契约，内部翻译成
 * anything-llm 自带的本地 embed + LanceDB 检索/溯源——消费方（astron agent/workflow/hub）无需改协议。
 *
 * 统一响应：{code:0, message, sid, data}；RetrieveChunk{content, doc_id, file_name, score, ...溯源元数据}
 *
 * 端点：
 *   POST /knowledge/v1/chunk/query                 通用检索（支持 rerank）
 *   POST /knowledge/v1/document/split              文档切分（解析 + TextSplitter）
 *   POST /knowledge/v1/chunks/save                 保存切分后的 chunks 到命名空间
 *   POST /knowledge/v1/personal-kb/index           个人库入库（同步；body.async=true 走异步）
 *   GET  /knowledge/v1/personal-kb/index/status    异步入库状态查询
 *   DELETE /knowledge/v1/personal-kb/index         删除文档向量
 *   POST /knowledge/v1/personal-kb/retrieve        个人库检索（支持 rerank + vector_ids 收窄）
 *   GET  /knowledge/v1/health                       探活
 *
 * 安装：复制本文件到 anything-llm 的 server/endpoints/astronKnowledge.js，并在 server/index.js 中
 *   const { astronKnowledgeEndpoints } = require("./endpoints/astronKnowledge");
 *   astronKnowledgeEndpoints(app);   // 在 app.use("/api", apiRouter); 之后
 * 也可直接运行同目录的 apply-adapter.cjs 自动完成（见 README.md）。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { reqBody } = require("../utils/http");
const { CollectorApi } = require("../utils/collectorApi");
const { TextSplitter } = require("../utils/TextSplitter");
const {
  getVectorDbClass,
  getEmbeddingEngineSelection,
} = require("../utils/helpers");

// 个人知识库集合命名，对齐 astron core/knowledge: personal-{user_id}
const PERSONAL_KB_PREFIX =
  process.env.PERSONAL_KB_COLLECTION_PREFIX || "personal-";
const personalNamespace = (userId) => `${PERSONAL_KB_PREFIX}${userId}`;

// ===== M2：astron 云端连接配置（端云协同）=====
// 存桌面端连接 astron 云端所需：网关地址 + 鉴权 header + 检索模式；落盘 storage 目录。
const ASTRON_CFG_PATH = path.join(
  process.env.STORAGE_DIR || os.tmpdir(),
  "astron-cloud-config.json"
);
function readAstronConfig() {
  try {
    if (fs.existsSync(ASTRON_CFG_PATH)) {
      return JSON.parse(fs.readFileSync(ASTRON_CFG_PATH, "utf-8")) || {};
    }
  } catch (_) {}
  return {};
}
function writeAstronConfig(cfg) {
  fs.mkdirSync(path.dirname(ASTRON_CFG_PATH), { recursive: true });
  fs.writeFileSync(ASTRON_CFG_PATH, JSON.stringify(cfg, null, 2));
}
// 检索模式：local（仅本地）/ cloud（仅云端）/ hybrid（端云混合，默认）
function resolveMode(reqMode) {
  const m = reqMode || readAstronConfig().mode || "hybrid";
  return ["local", "cloud", "hybrid"].includes(m) ? m : "hybrid";
}

// 异步入库任务表（进程内）。生产应换持久化状态（对齐云端 INDEXED/FAILED 异步语义）。
const indexJobs = new Map(); // vector_id -> { status, error, updatedAt }

function ok(data, sid = null) {
  return { code: 0, message: "success", sid, data };
}
function fail(code, message, sid = null) {
  return { code, message, sid };
}

// anything-llm source { ...metadata, text, score, title, id } -> astron RetrieveChunk + 富溯源元数据
function mapSource(s) {
  return {
    content: s.text ?? s.content ?? "",
    doc_id: s.astron_vector_id ?? s.id ?? s.docId ?? null,
    file_name: s.title ?? s.file_name ?? null,
    score: typeof s.score === "number" ? s.score : null,
    // 溯源增强：尽量回带可定位元数据（不同文件类型字段可能缺省）
    source: s.url ?? s.chunkSource ?? s.docSource ?? null,
    chunk_index: s.chunkIndex ?? s.seq_id ?? null,
    page: s.page ?? s.pageNumber ?? null,
    token_count: s.token_count_estimate ?? null,
  };
}

// 解析文件为纯文本：文本类直读；其余类型交 collector 解析（支持绝对路径，不落库）
async function resolveContent({ storage_path, file_type, file_name }) {
  if (!fs.existsSync(storage_path)) {
    return { error: `文件不存在: ${storage_path}` };
  }
  const ext = String(file_type || "").toLowerCase();
  const textTypes = ["txt", "md", "markdown", "text"];
  if (textTypes.includes(ext)) {
    return { content: fs.readFileSync(storage_path, "utf-8") };
  }
  const collector = new CollectorApi();
  if (!(await collector.online())) {
    return { error: `解析 ${ext} 需 collector 服务在线` };
  }
  const { success, reason, documents } = await collector.parseDocument(
    file_name || path.basename(storage_path),
    { absolutePath: storage_path }
  );
  if (!success || !Array.isArray(documents) || documents.length === 0) {
    return { error: reason || "collector 解析失败或无内容" };
  }
  const content = documents
    .map((d) => d?.pageContent)
    .filter(Boolean)
    .join("\n\n");
  return content && content.trim() ? { content } : { error: "解析内容为空" };
}

// ===== M3：端云检索 helper =====
// 本地个人库检索 -> RetrieveChunk[]（origin=local）。供 hybrid 复用。
async function retrieveLocalPersonal(userId, query, topK, vectorIds, rerank) {
  const LLMConnector = getEmbeddingEngineSelection();
  const VectorDb = getVectorDbClass();
  const { sources = [], message: vErr } = await VectorDb.performSimilaritySearch({
    namespace: personalNamespace(userId),
    input: query,
    LLMConnector,
    // 阈值放宽：中文 + 原生小模型相似度普遍偏低，0.1 易漏召，用 0.05
    similarityThreshold: 0.05,
    topN: vectorIds && vectorIds.length > 0 ? Math.max(topK * 5, 20) : topK,
    rerank: rerank === true,
  });
  if (vErr) return [];
  let chunks = sources.map((s) => ({ ...mapSource(s), origin: "local" }));
  if (vectorIds && vectorIds.length > 0) {
    const set = new Set(vectorIds);
    chunks = chunks.filter((c) => c.doc_id && set.has(c.doc_id));
  }
  return chunks.slice(0, topK);
}

// 过滤掉粘贴整套浏览器头时混入的干扰项（content-type/accept/sec-*/host 等），只转发鉴权相关头。
const DROP_HEADERS = new Set([
  "content-type", "content-length", "host", "connection", "accept",
  "accept-encoding", "accept-language", "user-agent", "referer", "origin",
]);
function cleanForwardHeaders(h) {
  const out = {};
  for (const k of Object.keys(h || {})) {
    const lk = k.toLowerCase();
    if (DROP_HEADERS.has(lk) || lk.startsWith("sec-")) continue;
    out[k] = h[k];
  }
  return out;
}

// 云端个人库检索 -> RetrieveChunk[]（origin=cloud）。调 astron hub /api/v1/user/personal-kb/retrieve。
async function retrieveCloudPersonal(query, topK, documentIds) {
  const cfg = readAstronConfig();
  if (!cfg.gateway_url || !cfg.headers) return []; // 未连接云端
  try {
    const url =
      cfg.gateway_url.replace(/\/$/, "") + "/api/v1/user/personal-kb/retrieve";
    const body = { query, top_k: topK };
    if (documentIds && documentIds.length > 0) body.document_ids = documentIds;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cleanForwardHeaders(cfg.headers) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    // hub 统一响应 {code,message,data:RetrieveChunk[]}
    const arr = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.chunks)
        ? json.chunks
        : [];
    return arr.map((c) => {
      let fn = c.file_name;
      // core/knowledge 返回的 file_name 可能是 URL 编码（中文显示成 %xx），解码便于展示
      if (typeof fn === "string" && fn.includes("%")) {
        try {
          fn = decodeURIComponent(fn);
        } catch (_) {}
      }
      return { ...c, file_name: fn, origin: c.origin || "cloud" };
    });
  } catch (e) {
    console.error("[astronKnowledge] cloud retrieve error:", e.message);
    return [];
  }
}

// 个人库入库核心逻辑（同步/异步共用）-> { status, vector_id, error }
async function doPersonalIndex({ user_id, document_id, storage_path, file_type, file_name }) {
  const vectorId = `pkb-${user_id}-${document_id}`;
  const { content, error } = await resolveContent({ storage_path, file_type, file_name });
  if (error) return { status: "FAILED", vector_id: null, error };

  const VectorDb = getVectorDbClass();
  const r = await VectorDb.addDocumentToNamespace(
    personalNamespace(user_id),
    {
      pageContent: content,
      docId: vectorId,
      title: file_name || vectorId,
      // anything-llm 给每个 chunk 分配独立 UUID 作 id；把 astron vector_id 写进保留的 metadata，
      // 供 retrieve 按 vector_ids 收窄。注意：同命名空间所有写入须保持一致字段集（LanceDB 列式 schema）。
      astron_vector_id: vectorId,
    },
    null,
    true
  );
  if (r?.vectorized === false || r === false) {
    return { status: "FAILED", vector_id: null, error: r?.error || "向量化失败" };
  }
  return { status: "INDEXED", vector_id: vectorId, error: null };
}

function astronKnowledgeEndpoints(app) {
  if (!app) return;

  // 通用检索 —— 对齐 astron POST /knowledge/v1/chunk/query
  // ChunkQueryReq{query, topN, match:{repoId[],docIds[],threshold}, ragType, rerank?}
  app.post("/knowledge/v1/chunk/query", async (request, response) => {
    try {
      const body = reqBody(request);
      const query = body?.query;
      const match = body?.match || {};
      const topN = Number(body?.topN) > 0 ? Number(body.topN) : 4;
      const threshold =
        typeof match?.threshold === "number" ? match.threshold : 0.25;
      const rerank = body?.rerank === true;
      const namespace = Array.isArray(match?.repoId) ? match.repoId[0] : match?.repoId;
      const docIds = Array.isArray(match?.docIds) ? match.docIds : [];

      if (!query || !namespace) {
        response.status(400).json(fail(40001, "query 和 match.repoId 必填"));
        return;
      }

      const LLMConnector = getEmbeddingEngineSelection();
      const VectorDb = getVectorDbClass();
      const { sources = [], message: vErr } =
        await VectorDb.performSimilaritySearch({
          namespace,
          input: query,
          LLMConnector,
          similarityThreshold: threshold,
          topN: docIds.length > 0 ? Math.max(topN * 5, 20) : topN,
          rerank,
        });

      if (vErr) {
        response.status(200).json(ok([]));
        return;
      }

      let data = sources.map(mapSource);
      // docIds 收窄（按 astron vector_id）
      if (docIds.length > 0) {
        const set = new Set(docIds);
        data = data.filter((c) => c.doc_id && set.has(c.doc_id)).slice(0, topN);
      }
      response.status(200).json(ok(data));
    } catch (e) {
      console.error("[astronKnowledge] chunk/query error:", e);
      response.status(500).json(fail(50000, e?.message || "internal error"));
    }
  });

  // 文档切分 —— 对齐 astron POST /knowledge/v1/document/split
  // {storage_path, file_type, file_name, lengthRange?:[min,max], overlap?} -> data: [{seq_id, content}]
  app.post("/knowledge/v1/document/split", async (request, response) => {
    try {
      const body = reqBody(request);
      const { storage_path, file_type, file_name } = body;
      if (!storage_path) {
        response.status(400).json(fail(40001, "storage_path 必填"));
        return;
      }
      const { content, error } = await resolveContent({ storage_path, file_type, file_name });
      if (error) {
        response.status(200).json(fail(40002, error));
        return;
      }
      const chunkSize =
        Array.isArray(body?.lengthRange) && body.lengthRange[1]
          ? Number(body.lengthRange[1])
          : 1000;
      const chunkOverlap = Number(body?.overlap) >= 0 ? Number(body.overlap) : 20;
      const splitter = new TextSplitter({ chunkSize, chunkOverlap });
      const textChunks = await splitter.splitText(content);
      const data = textChunks.map((c, i) => ({ seq_id: i, content: c }));
      response.status(200).json(ok(data));
    } catch (e) {
      console.error("[astronKnowledge] document/split error:", e);
      response.status(500).json(fail(50000, e?.message || "split error"));
    }
  });

  // 保存切分后的 chunks —— 对齐 astron POST /knowledge/v1/chunks/save
  // {docId, group, uid, chunks:[{content}]} -> data: {vector_id, chunks}
  app.post("/knowledge/v1/chunks/save", async (request, response) => {
    try {
      const body = reqBody(request);
      const { docId, group, uid } = body;
      const chunks = Array.isArray(body?.chunks) ? body.chunks : [];
      const namespace = group || (uid ? personalNamespace(uid) : null);
      if (!docId || !namespace || chunks.length === 0) {
        response.status(400).json(fail(40001, "docId/group(或uid)/chunks 必填"));
        return;
      }
      const pageContent = chunks
        .map((c) => (typeof c === "string" ? c : c?.content))
        .filter(Boolean)
        .join("\n\n");
      if (!pageContent.trim()) {
        response.status(200).json(fail(40002, "chunks 内容为空"));
        return;
      }
      const VectorDb = getVectorDbClass();
      const r = await VectorDb.addDocumentToNamespace(
        namespace,
        { pageContent, docId, title: docId, astron_vector_id: docId },
        null,
        true
      );
      if (r?.vectorized === false || r === false) {
        response.status(200).json(fail(50001, r?.error || "向量化失败"));
        return;
      }
      response.status(200).json(ok({ vector_id: docId, chunks: chunks.length }));
    } catch (e) {
      console.error("[astronKnowledge] chunks/save error:", e);
      response.status(500).json(fail(50000, e?.message || "save error"));
    }
  });

  // 个人库入库 —— 对齐 astron POST /knowledge/v1/personal-kb/index
  // 同步返回 INDEXED/FAILED；body.async=true 时立即返回 INDEXING，后台处理 + 状态查询。
  app.post("/knowledge/v1/personal-kb/index", async (request, response) => {
    try {
      const body = reqBody(request);
      const { user_id, document_id, storage_path } = body;
      if (!user_id || !document_id || !storage_path) {
        response.status(200).json({
          status: "FAILED",
          vector_id: null,
          error: "缺少 user_id/document_id/storage_path",
        });
        return;
      }
      const vectorId = `pkb-${user_id}-${document_id}`;

      if (body?.async === true) {
        indexJobs.set(vectorId, { status: "INDEXING", error: null, updatedAt: Date.now() });
        // 后台处理，不阻塞响应（大文件/扫描件适用）
        doPersonalIndex(body)
          .then((res) =>
            indexJobs.set(vectorId, {
              status: res.status,
              error: res.error,
              updatedAt: Date.now(),
            })
          )
          .catch((e) =>
            indexJobs.set(vectorId, {
              status: "FAILED",
              error: e?.message || "index error",
              updatedAt: Date.now(),
            })
          );
        response.status(200).json({ status: "INDEXING", vector_id: vectorId, error: null });
        return;
      }

      const res = await doPersonalIndex(body);
      response.status(200).json(res);
    } catch (e) {
      console.error("[astronKnowledge] personal-kb/index error:", e);
      response
        .status(200)
        .json({ status: "FAILED", vector_id: null, error: e?.message || "index error" });
    }
  });

  // 异步入库状态查询
  app.get("/knowledge/v1/personal-kb/index/status", (request, response) => {
    const vectorId = request.query?.vector_id;
    if (!vectorId) {
      response.status(400).json(fail(40001, "vector_id 必填"));
      return;
    }
    const job = indexJobs.get(vectorId);
    response
      .status(200)
      .json(ok(job ? { vector_id: vectorId, ...job } : { vector_id: vectorId, status: "UNKNOWN" }));
  });

  // 删除文档向量 —— 对齐 astron DELETE /knowledge/v1/personal-kb/index
  // {user_id, document_id, vector_id?}
  app.delete("/knowledge/v1/personal-kb/index", async (request, response) => {
    try {
      const body = reqBody(request);
      const { user_id, document_id } = body;
      const vectorId = body?.vector_id || `pkb-${user_id}-${document_id}`;
      if (!user_id || (!document_id && !body?.vector_id)) {
        response.status(400).json(fail(40001, "user_id + document_id(或 vector_id) 必填"));
        return;
      }
      const VectorDb = getVectorDbClass();
      await VectorDb.deleteDocumentFromNamespace(personalNamespace(user_id), vectorId);
      indexJobs.delete(vectorId);
      response.status(200).json(ok({ status: "removed", vector_id: vectorId }));
    } catch (e) {
      console.error("[astronKnowledge] personal-kb/index DELETE error:", e);
      response.status(500).json(fail(50000, e?.message || "delete error"));
    }
  });

  // 个人库检索 —— 对齐 astron POST /knowledge/v1/personal-kb/retrieve
  // RetrieveRequest{user_id, query, vector_ids[], top_k, rerank?} -> {chunks, error}
  app.post("/knowledge/v1/personal-kb/retrieve", async (request, response) => {
    try {
      const body = reqBody(request);
      const userId = body?.user_id;
      const query = body?.query;
      const topK = Number(body?.top_k) > 0 ? Number(body.top_k) : 3;
      const rerank = body?.rerank === true;
      const vectorIds = Array.isArray(body?.vector_ids) ? body.vector_ids : [];

      if (!userId || !query) {
        response.status(200).json({ chunks: [], error: "缺少 user_id/query" });
        return;
      }

      const LLMConnector = getEmbeddingEngineSelection();
      const VectorDb = getVectorDbClass();
      const { sources = [], message: vErr } =
        await VectorDb.performSimilaritySearch({
          namespace: personalNamespace(userId),
          input: query,
          LLMConnector,
          similarityThreshold: 0.1,
          topN: vectorIds.length > 0 ? Math.max(topK * 5, 20) : topK,
          rerank,
        });

      if (vErr) {
        response.status(200).json({ chunks: [], error: null });
        return;
      }

      let chunks = sources.map(mapSource);
      if (vectorIds.length > 0) {
        const set = new Set(vectorIds);
        chunks = chunks.filter((c) => c.doc_id && set.has(c.doc_id));
      }
      chunks = chunks.slice(0, topK);
      response.status(200).json({ chunks, error: null });
    } catch (e) {
      console.error("[astronKnowledge] personal-kb/retrieve error:", e);
      response.status(200).json({ chunks: [], error: e?.message || "retrieve error" });
    }
  });

  // ===== M2：astron 云端连接配置 =====
  // 读取配置（token/headers 脱敏返回）
  app.get("/knowledge/v1/astron/config", (_request, response) => {
    const cfg = readAstronConfig();
    response.status(200).json(
      ok({
        gateway_url: cfg.gateway_url || "",
        mode: cfg.mode || "hybrid",
        connected: !!(cfg.gateway_url && cfg.headers),
        // 不回传明文鉴权头，仅标识哪些 header 已配置
        header_keys: cfg.headers ? Object.keys(cfg.headers) : [],
      })
    );
  });

  // 保存配置 {gateway_url, headers:{...鉴权头}, mode}
  app.post("/knowledge/v1/astron/config", (request, response) => {
    try {
      const body = reqBody(request);
      const cur = readAstronConfig();
      const cfg = {
        gateway_url: body?.gateway_url ?? cur.gateway_url ?? "",
        headers: body?.headers ?? cur.headers ?? null,
        mode: ["local", "cloud", "hybrid"].includes(body?.mode)
          ? body.mode
          : cur.mode || "hybrid",
      };
      writeAstronConfig(cfg);
      response.status(200).json(
        ok({
          gateway_url: cfg.gateway_url,
          mode: cfg.mode,
          connected: !!(cfg.gateway_url && cfg.headers),
        })
      );
    } catch (e) {
      response.status(500).json(fail(50000, e?.message || "save config error"));
    }
  });

  // ===== M3：端云混合检索 =====
  // {user_id, query, top_k?, vector_ids?, rerank?, mode?} -> {chunks(含 origin), sources:{local,cloud}, mode}
  app.post("/knowledge/v1/hybrid/retrieve", async (request, response) => {
    try {
      const body = reqBody(request);
      const userId = body?.user_id;
      const query = body?.query;
      const topK = Number(body?.top_k) > 0 ? Number(body.top_k) : 3;
      const rerank = body?.rerank === true;
      const vectorIds = Array.isArray(body?.vector_ids) ? body.vector_ids : [];
      const docIds = Array.isArray(body?.document_ids) ? body.document_ids : [];
      const mode = resolveMode(body?.mode);
      if (!query) {
        response.status(200).json({ chunks: [], error: "缺少 query", mode });
        return;
      }

      const tasks = [];
      if (mode !== "cloud" && userId) {
        tasks.push(retrieveLocalPersonal(userId, query, topK, vectorIds, rerank));
      } else {
        tasks.push(Promise.resolve([]));
      }
      tasks.push(
        mode !== "local"
          ? retrieveCloudPersonal(query, topK, docIds)
          : Promise.resolve([])
      );

      const [local, cloud] = await Promise.all(tasks);
      // 合并 + 按 score 降序 + 截 topK（端云混合）
      const merged = [...local, ...cloud]
        .filter((c) => c && c.content)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, topK);

      response.status(200).json({
        chunks: merged,
        sources: { local: local.length, cloud: cloud.length },
        mode,
        error: null,
      });
    } catch (e) {
      console.error("[astronKnowledge] hybrid/retrieve error:", e);
      response.status(200).json({ chunks: [], error: e?.message || "hybrid error" });
    }
  });

  // ===== 端云协同控制台（内置 UI，桌面 app 内直接打开 /knowledge/v1/astron/ui）=====
  app.get("/knowledge/v1/astron/ui", (_request, response) => {
    response.status(200).type("html").send(ASTRON_UI_HTML);
  });

  // 健康检查 / 协议探活
  app.get("/knowledge/v1/health", (_request, response) => {
    response.status(200).json(ok({ status: "ok", adapter: "anything-llm" }));
  });
}

// 端云协同控制台 UI（自包含 HTML；嵌入 JS 用字符串拼接，避免与外层模板冲突）
const ASTRON_UI_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>端云协同控制台 · 本地知识库</title>
<style>
  :root{--bg:#f5f7fa;--card:#fff;--bd:#e2e8ff;--pri:#1677ff;--mut:#888;}
  *{box-sizing:border-box;font-family:-apple-system,system-ui,"PingFang SC",sans-serif;}
  body{margin:0;background:var(--bg);color:#222;padding:24px;}
  h1{font-size:20px;margin:0 0 4px;} .sub{color:var(--mut);font-size:13px;margin-bottom:20px;}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:18px;margin-bottom:16px;}
  .card h2{font-size:15px;margin:0 0 12px;}
  label{display:block;font-size:13px;color:#555;margin:10px 0 4px;}
  input,select,textarea{width:100%;padding:8px 10px;border:1px solid var(--bd);border-radius:6px;font-size:13px;}
  textarea{min-height:72px;font-family:ui-monospace,Menlo,monospace;}
  .row{display:flex;gap:12px;} .row>div{flex:1;}
  button{background:var(--pri);color:#fff;border:0;border-radius:6px;padding:9px 16px;font-size:13px;cursor:pointer;margin-top:12px;}
  button.ghost{background:#eef2ff;color:var(--pri);}
  .status{font-size:13px;margin-top:10px;}
  .ok{color:#16a34a;} .err{color:#dc2626;}
  .chunk{border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin-top:10px;}
  .badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;margin-right:6px;}
  .b-local{background:#dcfce7;color:#16a34a;} .b-cloud{background:#dbeafe;color:#1677ff;}
  .meta{color:var(--mut);font-size:12px;margin-top:4px;}
</style>
</head>
<body>
  <h1>端云协同控制台</h1>
  <div class="sub">本地知识库客户端 · 连接 astron 云端 + 端云混合检索（来源标记）</div>

  <div class="card">
    <h2>① 连接 astron 云端</h2>
    <label>云端网关地址 (gateway_url)</label>
    <input id="gw" placeholder="http://your-astron-host:8190"/>
    <label>鉴权 Header (JSON，如登录后拿到的 token / ticket)</label>
    <textarea id="hdr" placeholder='{"X-Auth-Type":"3","token":"...","X-Auth-User-Id":"..."}'></textarea>
    <div class="row">
      <div>
        <label>检索模式 (mode)</label>
        <select id="mode"><option value="hybrid">hybrid 端云混合</option><option value="local">local 仅本地</option><option value="cloud">cloud 仅云端</option></select>
      </div>
    </div>
    <button onclick="saveCfg()">保存配置</button>
    <button class="ghost" onclick="loadCfg()">刷新状态</button>
    <div class="status" id="cfgStatus"></div>
  </div>

  <div class="card">
    <h2>② 快速入库（本地，纯文本，便于测试）</h2>
    <div class="sub" style="margin:0 0 8px">先把一段文字存进本地知识库，再到下面③检索它。user_id 两处要一致。</div>
    <div class="row">
      <div><label>user_id（本地库用户）</label><input id="iuid" value="1"/></div>
      <div><label>文档名</label><input id="iname" value="测试文档.txt"/></div>
    </div>
    <label>知识内容（直接粘贴一段文字）</label>
    <textarea id="itext" placeholder="例如：本地知识库客户端基于 anything-llm，向量库用 LanceDB，支持端云混合检索与来源标记。"></textarea>
    <button onclick="quickIndex()">入库到本地</button>
    <div class="status" id="iStatus"></div>
  </div>

  <div class="card">
    <h2>③ 检索测试（端云混合 + 来源徽标）</h2>
    <div class="row">
      <div><label>user_id（本地库用户）</label><input id="uid" value="1"/></div>
      <div><label>top_k</label><input id="topk" value="3"/></div>
      <div><label>模式覆盖</label><select id="rmode"><option value="">用已存配置</option><option value="hybrid">hybrid</option><option value="local">local</option><option value="cloud">cloud</option></select></div>
    </div>
    <label>问题 (query)</label>
    <input id="q" placeholder="例如：本地知识库用什么向量库"/>
    <button onclick="doRetrieve()">检索</button>
    <div class="status" id="rStatus"></div>
    <div id="results"></div>
  </div>

<script>
var BASE="/knowledge/v1";
function el(id){return document.getElementById(id);}
function quickIndex(){
  var txt=el("itext").value.trim();
  if(!txt){ el("iStatus").innerHTML='<span class="err">请先填知识内容</span>'; return; }
  el("iStatus").textContent="入库中...";
  var uid=el("iuid").value, docId="ui-"+uid+"-"+Date.now();
  var body={docId:docId, uid:uid, chunks:[{content:txt}]};
  fetch(BASE+"/chunks/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(j){
      if(j.code===0){ el("iStatus").innerHTML='<span class="ok">已入库</span> 到本地库 user_id='+uid+'（共 '+(j.data&&j.data.chunks)+' 段）。现在到③用同样 user_id、模式选 local 或 hybrid 检索。'; }
      else { el("iStatus").innerHTML='<span class="err">入库失败: '+(j.message||'')+'</span>'; }
    }).catch(function(e){el("iStatus").innerHTML='<span class="err">入库失败: '+e+'</span>';});
}
function loadCfg(){
  fetch(BASE+"/astron/config").then(function(r){return r.json();}).then(function(j){
    var d=j.data||{};
    el("gw").value=d.gateway_url||"";
    if(d.mode) el("mode").value=d.mode;
    el("cfgStatus").innerHTML = d.connected
      ? '<span class="ok">已连接</span> 网关 '+(d.gateway_url||'')+'，已配鉴权头: '+((d.header_keys||[]).join(", ")||"无")
      : '<span class="err">未连接</span> 请填写网关与鉴权头后保存';
  }).catch(function(e){el("cfgStatus").innerHTML='<span class="err">读取失败: '+e+'</span>';});
}
function saveCfg(){
  var headers=null, raw=el("hdr").value.trim();
  if(raw){ try{ headers=JSON.parse(raw); }catch(e){ el("cfgStatus").innerHTML='<span class="err">鉴权 Header 不是合法 JSON</span>'; return; } }
  var body={gateway_url:el("gw").value.trim(), mode:el("mode").value};
  if(headers) body.headers=headers;
  fetch(BASE+"/astron/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(){ loadCfg(); el("cfgStatus").innerHTML+=' · <span class="ok">已保存</span>'; })
    .catch(function(e){el("cfgStatus").innerHTML='<span class="err">保存失败: '+e+'</span>';});
}
function doRetrieve(){
  el("results").innerHTML=""; el("rStatus").textContent="检索中...";
  var body={user_id:el("uid").value, query:el("q").value, top_k:Number(el("topk").value)||3};
  if(el("rmode").value) body.mode=el("rmode").value;
  fetch(BASE+"/hybrid/retrieve",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
    .then(function(r){return r.json();}).then(function(j){
      var s=j.sources||{local:0,cloud:0};
      el("rStatus").innerHTML='模式 <b>'+(j.mode||'')+'</b> · 本地 '+s.local+' 条 / 云端 '+s.cloud+' 条'+(j.error?(' · <span class="err">'+j.error+'</span>'):'');
      var html="";
      (j.chunks||[]).forEach(function(c){
        var cls=c.origin==="cloud"?"b-cloud":"b-local";
        var name=c.origin==="cloud"?"云端":"本地";
        html+='<div class="chunk"><span class="badge '+cls+'">'+name+'</span>'
           + '<b>'+(c.file_name||c.doc_id||'')+'</b> <span class="meta">score '+(c.score!=null?Number(c.score).toFixed(3):'-')+'</span>'
           + '<div style="margin-top:6px;white-space:pre-wrap;font-size:13px;">'+((c.content||'').replace(/</g,"&lt;").slice(0,400))+'</div></div>';
      });
      el("results").innerHTML=html||'<div class="meta">无命中</div>';
    }).catch(function(e){el("rStatus").innerHTML='<span class="err">检索失败: '+e+'</span>';});
}
loadCfg();
</script>
</body>
</html>`;

// 供 anything-llm 自带对话流程并入云端片段（深度集成）；未连云端时返回 []。
module.exports = { astronKnowledgeEndpoints, retrieveCloudPersonal, readAstronConfig };
