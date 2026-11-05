# 🧰 GitHubDaily 工作台

把 GitHubDaily 2018–2025 年推薦的 **3,600+ 個開源專案**整合成一個可操作的工具：可以瀏覽、搜尋、收藏、檢查專案健康度，也可以**輸入自己的 API Key**，讓 AI 跑「流程化工作」，例如智能推薦、專案導讀、選型比較、學習路線、週報產生等。

## 快速開始

需要 Node.js 18 以上。

```bash
cd app
npm install
npm start
```

打開瀏覽器進入 <http://127.0.0.1:8787>，到「⚙️ 設定」輸入你的 API Key 即可開始使用。

> 可用 `PORT=3000 npm start` 改埠號；`HOST=0.0.0.0` 可讓區網其他裝置連入（請自行評估安全性）。

## 功能

| 分頁 | 說明 | 需要 API？ |
|---|---|---|
| 🔎 探索專案 | 依關鍵字（支援繁體輸入搜尋簡體內容）、年份、分類篩選全部專案；可收藏、加入比較、一鍵 AI 導讀 | 否 |
| ⚡ 流程工作 | 執行內建或自訂流程，逐步顯示進度，結果以 Markdown 即時串流，可複製或下載 `.md` | LLM Key |
| 🛠️ 流程編輯器 | 拖拉式（上下移動）組合步驟、編輯提示模板，匯入／匯出 JSON | — |
| ⭐ 收藏與健康檢查 | 批次查詢收藏專案的 Stars、語言、授權、最後更新時間，標出已封存或停滯的專案；匯出清單 | GitHub Token（選填） |
| 🕘 歷史紀錄 | 自動保存最近 50 次流程輸出 | 否 |

### 內建流程

| 流程 | 步驟 |
|---|---|
| 🎯 AI 智能推薦 | AI 從目錄篩選 → 查詢 GitHub 狀態 → 產生推薦報告與上手步驟 |
| 🔍 專案深度分析 | 指定專案 → 讀取 GitHub 資訊與 README → 產生中文導讀（功能、架構、安裝、風險） |
| ⚖️ 專案比較評估 | 指定多個專案 → 讀取 README → 比較表與情境化選型建議 |
| 🗺️ 學習路線規劃 | AI 挑選教程資源 → 規劃分階段學習路線 |
| 📈 分類趨勢週報 | 搜尋目錄 → 查詢熱度 → 排除停滯專案並依 Stars 排序 → 撰寫電子報 |
| 🧱 技術方案組合 | AI 挑選元件 → 查詢狀態 → 產生架構圖（Mermaid）、里程碑與風險 |

### 自訂流程的步驟類型

| 類型 | 作用 |
|---|---|
| 搜尋目錄 `search` | 本地關鍵字搜尋，可限定分類／年份 |
| 指定專案 `pick` | 依 ID、名稱或 `owner/repo` 指定（也可指定不在目錄中的 GitHub 專案） |
| AI 篩選專案 `ai_select` | 先以關鍵字取候選池，再讓 LLM 依語意挑出最適合的專案 |
| GitHub 補充資訊 `github` | 取得 Stars、語言、授權、活躍度，可選擇讀取 README |
| 條件篩選 `filter` | 最少 Stars、排除停滯／封存、最早收錄年份、依 Stars 排序、數量上限 |
| LLM 處理 `llm` | 以提示模板呼叫你的 LLM |

提示模板可用的變數：

- `{{input}}`：使用者輸入
- `{{projects}}`：目前的專案清單
- `{{github}}`：含 GitHub 數據的專案清單
- `{{readme}}`：已讀取的 README 內容
- `{{count}}`：專案數量
- `{{steps.步驟ID}}`：某個步驟的輸出

流程 JSON 範例：

```json
{
  "name": "找出活躍的爬蟲工具",
  "inputLabel": "要爬什麼網站？",
  "steps": [
    { "id": "s", "type": "search", "query": "爬虫 {{input}}", "limit": 20 },
    { "id": "gh", "type": "github" },
    { "id": "f", "type": "filter", "activeOnly": true, "sortBy": "stars", "limit": 5 },
    { "id": "out", "type": "llm", "prompt": "針對「{{input}}」，從以下工具中推薦最適合的並給出範例程式：\n{{github}}" }
  ]
}
```

## 支援的 API

| 供應商 | 設定方式 |
|---|---|
| **Anthropic Claude**（建議） | 填入 `sk-ant-…` 金鑰，選擇模型（預設 Claude Opus 5.5，可改 Sonnet 5.5／Haiku 5.5）與思考深度 effort |
| **OpenAI 相容端點** | 填入 Base URL 與模型名稱，例如 OpenAI `https://api.openai.com/v1`、DeepSeek `https://api.deepseek.com/v1`、OpenRouter `https://openrouter.ai/api/v1`、本機 Ollama `http://localhost:11434/v1`（本機可免金鑰） |
| **GitHub Token**（選填） | 未設定時 GitHub API 每小時只有 60 次；建立一個不勾任何權限的 Personal Access Token 即可提升到 5,000 次 |

Claude 的 Opus／Sonnet 模型會自動開啟伺服器端備援（`fallbacks: "default"`）：若請求被安全分類器拒絕，API 會改用建議的備援模型重試。

### 金鑰安全

- 金鑰只存在**你的瀏覽器** localStorage，每次請求時以 HTTP 標頭送到**本機**伺服器，再轉發給 API 供應商；伺服器不會寫入硬碟或記錄。
- 伺服器預設只監聽 `127.0.0.1`。
- 也可以用環境變數代替：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GITHUB_TOKEN`（瀏覽器設定優先）。

## 專案結構

```
app/
├── server.js          # HTTP 伺服器與 API 路由（無框架）
├── lib/
│   ├── catalog.js     # 解析各年度 Markdown → 專案目錄、本地搜尋、繁簡轉換
│   ├── github.js      # GitHub REST API（含快取與健康度評估）
│   ├── llm.js         # LLM 供應商抽象層（Claude SDK／OpenAI 相容）
│   └── workflows.js   # 流程引擎與內建流程
├── public/            # 前端（純 HTML/CSS/JS）
└── test/              # 單元測試：npm test
```

目錄資料是在伺服器啟動時直接從倉庫根目錄的 `README.md`、`2018.md`…`2024.md` 解析，所以上游更新 Markdown 後，重新啟動即可取得最新專案。

## API 端點

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/meta` | 統計資料、模型清單、內建流程 |
| GET | `/api/projects?q=&year=&category=&offset=&limit=` | 搜尋專案 |
| GET | `/api/github/repo?repo=owner/name&readme=1` | 單一專案的 GitHub 資訊 |
| POST | `/api/github/batch` | 批次健康檢查（NDJSON 串流） |
| POST | `/api/llm/test` | 測試 LLM 金鑰 |
| POST | `/api/llm/chat` | 單次提示（NDJSON 串流） |
| POST | `/api/workflows/run` | 執行流程（NDJSON 串流事件） |

想自動化的話，也可以直接用 `curl` 呼叫 `/api/workflows/run`：

```bash
curl -N http://127.0.0.1:8787/api/workflows/run \
  -H "content-type: application/json" \
  -H "x-llm-key: $ANTHROPIC_API_KEY" \
  -d '{"input":"本地執行的語音轉文字","workflow":{"steps":[{"type":"ai_select","query":"{{input}}","count":5},{"type":"llm","prompt":"比較這些專案：\n{{projects}}"}]}}'
```
