#!/usr/bin/env bash
# 本地 macOS dmg 构建：前端 -> server/public，暂存 payload(server+collector+node)，electron-builder 出 dmg。
set -euo pipefail

ANYLLM="/Users/jiangyuanyuan/Desktop/anything-llm"
KIT="/Users/jiangyuanyuan/Desktop/astron-local-kb-desktop"
WRAP="$KIT/electron-wrapper"
NODE_BIN="$(command -v node)"

echo "==[1/4] 构建前端 -> server/public =="
cd "$ANYLLM/frontend"
printf "VITE_API_BASE='/api'\n" > .env.production
./node_modules/.bin/vite build && node scripts/postbuild.js
rm -rf "$ANYLLM/server/public" && mkdir -p "$ANYLLM/server/public"
cp -r "$ANYLLM/frontend/dist/"* "$ANYLLM/server/public/"
echo "前端产物已就位: $(ls "$ANYLLM/server/public" | head -3 | tr '\n' ' ')"

echo "==[2/4] 暂存 payload =="
rm -rf "$WRAP/payload" && mkdir -p "$WRAP/payload"
# server：保留 storage/models（native embedder 必需）等，但排除 dev 用户数据；
# 排除项用前导 / 锚定到源根目录，避免误伤 node_modules 里同名子目录（如 multer/storage）。
rsync -a --delete \
  --exclude '/.env' --exclude '/logs' \
  --exclude '/storage/documents/***' \
  --exclude '/storage/vector-cache/***' \
  --exclude '/storage/lancedb/***' \
  --exclude '/storage/anythingllm.db' \
  --exclude '/storage/anythingllm.db-journal' \
  --exclude '/storage/anythingllm.db-wal' \
  "$ANYLLM/server/" "$WRAP/payload/server/"
rsync -a --delete \
  --exclude '/hotdir/*' --exclude '/outputs' --exclude '/.env' \
  "$ANYLLM/collector/" "$WRAP/payload/collector/"

# 生成「干净库」随包：复制 dev 库 → 清掉用户数据行（保留 system_settings：onboarding_complete + 预配置 LLM/embedder）。
# 不带 db 会导致迁移未跑（main.js 不跑 prisma migrate）→ onboarding 死循环。
mkdir -p "$WRAP/payload/server/storage"
cp "$ANYLLM/server/storage/anythingllm.db" "$WRAP/payload/server/storage/anythingllm.db"
sqlite3 "$WRAP/payload/server/storage/anythingllm.db" "
  PRAGMA foreign_keys=OFF;
  DELETE FROM workspace_agent_invocations;
  DELETE FROM workspace_threads;
  DELETE FROM workspace_chats;
  DELETE FROM document_vectors;
  DELETE FROM workspace_documents;
  DELETE FROM workspaces;
  DELETE FROM event_logs;
  -- 清掉 dev 定制，避免盖掉平台品牌（标题/上传 logo/favicon）
  DELETE FROM system_settings WHERE label IN ('meta_page_title','logo_filename','meta_page_favicon','telemetry_id');
  UPDATE system_settings SET value='true' WHERE label='onboarding_complete';
  VACUUM;
"
echo "干净库: onboarding=$(sqlite3 "$WRAP/payload/server/storage/anythingllm.db" "select value from system_settings where label='onboarding_complete'") workspaces=$(sqlite3 "$WRAP/payload/server/storage/anythingllm.db" "select count(*) from workspaces")"

# 内置 LLM 配置（qwen-plus）：anything-llm 的 LLM 设置存在 server/.env。
# 从当前安装的 App .env 取 LLM/embedder/向量库 行（含真实 API key）写入 payload，key 不经过对话/git。
# 只取这几类，不带 STORAGE_DIR（由 main.js 按机器设）和 JWT/加密密钥（由 server 首启自生成）。
APP_ENV="/Applications/AstronLocalKB.app/Contents/Resources/app/server/.env"
if [ -f "$APP_ENV" ]; then
  grep -E '^(LLM_PROVIDER|GENERIC_OPEN_AI_|EMBEDDING_ENGINE|VECTOR_DB)' "$APP_ENV" > "$WRAP/payload/server/.env"
  echo "内置 LLM 配置: provider=$(grep '^LLM_PROVIDER' "$WRAP/payload/server/.env" | cut -d= -f2) model=$(grep '^GENERIC_OPEN_AI_MODEL_PREF' "$WRAP/payload/server/.env" | cut -d= -f2) （$(grep -c . "$WRAP/payload/server/.env") 行，key 已含）"
else
  echo "⚠️ 未找到 App .env，跳过内置 LLM 配置（首启需手动配）"
fi
cp "$NODE_BIN" "$WRAP/payload/node"
chmod +x "$WRAP/payload/node"
echo "payload: server($(du -sh "$WRAP/payload/server" | cut -f1)) collector($(du -sh "$WRAP/payload/collector" | cut -f1)) node($("$WRAP/payload/node" -v))"

echo "==[3/4] electron-builder 出 dmg =="
cd "$WRAP"
CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder --mac --publish never

echo "==[4/4] 产物 =="
ls -lh "$WRAP/dist/"*.dmg 2>/dev/null || echo "未找到 dmg"
