# 本地知识库桌面客户端 · 构建仓库

把 anything-llm + astron `/knowledge/v1` 协议适配器 + 端云协同，打包成 Windows / Linux / macOS 桌面安装包。
用 **GitHub Actions** 三平台并行构建，免签名（内测用）。

## 内容
| 文件/目录 | 作用 |
|---|---|
| `apply-adapter.cjs` | 把适配器注入 anything-llm 源码（幂等）：协议端点 + collector 长超时 + 对话端云深度集成 |
| `astronKnowledge.js` | 适配器本体（`/knowledge/v1/*` 端点 + 端云控制台 UI + 混合检索） |
| `electron-wrapper/` | Electron 外壳（`main.js` + electron-builder 配置） |
| `.github/workflows/build-desktop.yml` | 三平台构建 CI |

## 怎么出安装包（操作步骤）
1. 把本仓库内容 push 到你的 GitHub 仓库（见下方命令）。
2. 仓库页 → **Actions** → 左侧 **build-desktop** → 右侧 **Run workflow** → Run。
3. 等三平台跑完（约 15~30 分钟，首次装依赖较慢）。
4. 进入该次运行页面，底部 **Artifacts** 下载：
   - `windows-installer` → `.exe`
   - `linux-installer` → `.AppImage`
   - `mac-installer` → `.dmg`

> CI 会自动从 GitHub 拉官方 `Mintplex-Labs/anything-llm` 源码并打上适配器，**你不需要 fork anything-llm**。
> 若某天官方源码结构变化导致 apply 失败，在 Run workflow 时把 `anyllm_ref` 填一个稳定 tag（如 `v1.14.1`）。

## 安装包装上后（配置一次）
- **对话模型**：装 [Ollama](https://ollama.com) → `ollama pull qwen2.5:3b`，app 设置里 LLM 选 Ollama；或填云端 key。
- **端云协同**：app 菜单「端云协同 → 打开控制台」→ 填云端网关 + 鉴权头 → 检索/对话即可用本地+云端知识。
- 免签名安装：mac 右键→打开；Windows SmartScreen→仍要运行；Linux `chmod +x *.AppImage`。

## 回填站内下载（可选）
把产出的安装包传到 MinIO/OSS，配 astron hub 的 `APP_DOWNLOAD_*` 环境变量，
即可在「用户偏好与隐私 → 客户端下载」页下载（详见 astron 仓库 `docs/客户端下载-发布说明.md`）。

## 首次 CI 可能需微调
这是首版自建打包，第一次跑若某步报错（多为依赖/原生模块/路径），把 Actions 日志贴出来即可定位修正。
