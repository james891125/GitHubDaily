# 🧪 AI 工作坊

一個在自己電腦上執行的 AI 自動化工具，填入你自己的 API Key 就能用。四大功能整合在同一個網頁介面中：

| 功能 | 能做什麼 | 參考的開源專案做法 |
|---|---|---|
| ⚡ **工作流自動化** | 用節點串起「擷取網頁 → AI 處理 → 翻譯 → 擷取表格 → 存檔 → 發通知」，可設定每天／每隔幾分鐘自動執行 | n8n、Dify |
| 📚 **知識庫問答** | 上傳 PDF、Word、Excel、網頁，AI 只根據你的資料回答，並標註 [1] [2] 出處，可點開看原文 | MaxKB、AnythingLLM、KnowNote |
| 📄 **文件工具** | 檔案轉 Markdown、長文件分段翻譯（保留格式、支援術語表）、長文摘要、擷取資料成 Excel／CSV | MinerU、PDFMathTranslate、Stirling-PDF |
| 🌐 **網站工具** | 網站檢測（SSL、DNS、安全標頭、SEO、失效連結，0–100 評分）＋ AI 修正建議；擷取網頁正文；同網域整站爬取並可直接存入知識庫 | Web-Check、crawl4ai、FireCrawl |

所有程式碼都是重新撰寫的，不需要另外安裝上述專案。

## 安裝與啟動

需要 [Node.js](https://nodejs.org/) 20 以上。

**Windows**：雙擊 `start.bat`
**macOS / Linux**：執行 `./start.sh`

或手動執行：

```bash
cd studio
npm install
npm start
```

接著打開 <http://127.0.0.1:8790>，到「⚙️ 設定」輸入 API Key，按「測試 AI 連線」確認。

> 網站檢測、爬蟲、文件轉 Markdown **不需要** API Key；AI 問答、翻譯、摘要、擷取表格需要。

## 支援的 AI

| 供應商 | 設定 |
|---|---|
| **Anthropic Claude**（建議） | 填入 `sk-ant-…`，可選 Opus 5.5（預設）／Sonnet 5.5／Haiku 5.5 與思考深度 |
| **OpenAI 相容** | 填入 Base URL 與模型名稱：OpenAI、DeepSeek、Google Gemini、OpenRouter，或本機 Ollama（免金鑰） |

金鑰存在本機 `studio/data/settings.json`（檔案權限 600），只會送往你選擇的 AI 供應商。之所以存在伺服器端而不是瀏覽器，是因為排程工作流在背景執行時需要用到金鑰。

## 學術論文與被擋的網站（HTTP 403）

ScienceDirect、Springer、Wiley 等期刊網站會擋程式直接擷取，論文全文通常也需要訂閱。遇到論文網址（含 DOI 或 Elsevier PII）時，程式會自動改用正規的學術 API：

1. **Elsevier API**（選填）：在「⚙️ 設定」填入你在 [dev.elsevier.com](https://dev.elsevier.com/) 免費申請的 API Key。在有訂閱的學校／機構網路下執行，就能取得 Elsevier 論文全文；校外使用可向圖書館申請 Institution Token。
2. **Crossref + OpenAlex**（免金鑰）：查出論文資料，若有開放取用（OA）版本會自動下載 PDF 取得全文；沒有的話至少取得標題、作者與英文摘要。
3. **都拿不到全文時**：在瀏覽器（已登入學校帳號）下載 PDF，上傳到「📁 檔案」，使用「📑 論文 PDF → 繁中翻譯 + 摘要」範本。

一般網站回應 403 時，表示網站不允許程式存取（需要登入或有防爬蟲機制），本程式不會嘗試繞過；請改為另存網頁／下載檔案後上傳，或使用該網站的官方 API（「呼叫 API」節點）。

## 工作流

### 內建範本（點一下即可建立並修改）

| 範本 | 流程 |
|---|---|
| 🌏 外文文章 → 繁中翻譯 + 摘要 | 擷取網頁 → 翻譯 → 摘要 → 組合 → 存成 .md |
| 📑 論文 PDF → 繁中翻譯 + 摘要 | 讀取上傳的論文 PDF → 學術摘要 → 全文翻譯 → 存成 .md |
| 📰 多網址每日簡報 | 逐一擷取每個網址並摘要 → 整合成簡報 → 存檔 →（可選）推送 Slack/Discord |
| 🩺 網站健康巡檢 + 異常通知 | 網站檢測 → 存報告 → 分數低於 85 才繼續 → AI 寫修正建議 → 通知 |
| 🔔 網頁變動監控 | 擷取網頁 → 與上次內容比對 → 有變動才由 AI 說明並通知 |
| 📊 文件 → Excel 表格 | 讀取檔案 → 擷取指定欄位 → 輸出 .xlsx |
| 📚 網站 → 知識庫 | 爬取整站 → 存入知識庫 |
| 🔌 API 資料 → AI 分析報告 | 呼叫任意 JSON API → AI 解讀 → 存檔 |

### 節點類型

| 節點 | 說明 | 預設輸出變數 |
|---|---|---|
| 🌐 擷取網頁 | 網址 → Markdown（只取正文或整頁） | `{{page}}`、`{{page.title}}`、`{{page.url}}` |
| 🕷️ 爬取網站 | 同網域廣度優先爬取 | `{{site}}` |
| 🔌 呼叫 API | GET / POST / PUT 任意 API，自訂標頭 | `{{api}}`（JSON 可用 `{{api.欄位}}`） |
| 📄 讀取檔案 | 從檔案庫讀取 PDF / Word / Excel / 文字 | `{{doc}}` |
| 🔎 知識庫檢索 | 找出最相關的段落 | `{{context}}` |
| 📚 存入知識庫 | 把文字或爬取結果加入知識庫 | — |
| 🤖 AI 處理 | 自訂提示 | `{{ai}}` |
| 🔁 逐項 AI 處理 | 對清單每一項（每行、每頁、每列）執行提示，可先自動擷取網址 | `{{items}}` |
| 🌏 翻譯 / 📝 摘要 | 長文自動分段處理 | `{{translated}}` / `{{summary}}` |
| 📊 擷取成表格 | 指定欄位 → 表格資料 | `{{table}}` |
| 🩺 網站檢測 | 完整檢測與評分 | `{{check}}`、`{{check.score}}`、`{{check.issues}}` |
| 🚦 條件判斷 | 小於／大於／等於／包含／**與上次執行不同**，不成立就停止 | — |
| ✏️ 組合文字 | 用模板組出新內容 | `{{text}}` |
| 💾 輸出檔案 | .md / .txt / .csv / .xlsx / .json | `{{file}}` |
| 📣 發送通知 | POST 到 Slack / Discord / Teams Webhook | — |

內建變數：`{{input}}`（執行時的輸入）、`{{today}}`（2026-01-31）、`{{now}}`。

工作流可以匯出成 JSON 分享給別人，對方再匯入即可使用。

### 排程

在工作流下方勾選「⏰ 排程自動執行」，選擇「每天 HH:MM」或「每隔 N 分鐘」（最少 5 分鐘）並填入排程時要用的輸入。排程只在程式執行期間有效，若要長期執行，可把 `npm start` 設成開機啟動（Windows 工作排程器、macOS launchd、Linux systemd）。

## 資料存放

所有資料都在 `studio/data/`（不會被 git 追蹤）：

```
data/
├── settings.json      # 設定與金鑰
├── flows.json         # 工作流
├── runs.json          # 最近 100 次執行紀錄
├── kb-index.json      # 知識庫清單
├── kb-<id>.json       # 各知識庫的文件與索引
├── files/             # 檔案庫（已解析成文字）
└── outputs/           # 產出的檔案（可在「📁 檔案」下載）
```

備份或搬家時，複製整個 `data/` 資料夾即可。可用環境變數 `STUDIO_DATA_DIR` 指定其他位置。

## 技術說明

- **知識庫檢索**使用本機 BM25（中日韓文以單字＋雙字切詞），不需要 Embedding API，所以 Claude、DeepSeek、Ollama 等任何模型都能用。
- **PDF** 使用 pdf.js（含 CMap，支援中文），**Word** 使用 mammoth，**Excel** 使用 ExcelJS，**網頁正文**使用 Mozilla Readability + Turndown。
- 掃描影像型 PDF（沒有文字層）目前不支援 OCR，會顯示明確提示。
- 伺服器預設只監聽 `127.0.0.1`，並拒絕跨站 POST 請求。爬蟲與 API 節點可以連到內網位址，這是刻意的設計（方便處理公司內部網站），請勿把本服務公開到網際網路。
- Claude Opus／Sonnet 模型會自動開啟伺服器端備援（`fallbacks: "default"`）。

## 開發

```bash
npm test   # 25 項測試：文件解析、爬蟲、網站檢測、知識庫、學術 API、工作流、排程（使用本機假網站與假 LLM，不需網路與金鑰）
```

```
studio/
├── server.js          # HTTP 伺服器與 API
├── lib/
│   ├── llm.js         # Claude / OpenAI 相容呼叫
│   ├── docs.js        # 文件解析與切塊
│   ├── doctools.js    # 翻譯、摘要、擷取表格、CSV/Excel
│   ├── web.js         # 網頁擷取、爬蟲、網站檢測
│   ├── scholar.js     # 學術論文（Elsevier / Crossref / OpenAlex）
│   ├── kb.js          # 知識庫（BM25 + 問答）
│   ├── flow.js        # 工作流引擎、節點、範本、排程
│   └── store.js       # 本機 JSON 儲存
├── public/            # 前端（純 HTML/CSS/JS，無需建置）
└── test/
```
