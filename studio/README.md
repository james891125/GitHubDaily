# AI 辦公服務平台

在自己電腦上執行、使用自己 API Key 的辦公服務平台。它把開源社群中常見工具的功能，整理成 **43 項現成的服務**：像校務、行政系統的「線上申辦」一樣，選擇服務、填寫表單、按送出，就能取得結果（Word、Excel 或文字），不需要自己設計流程。

| 類別 | 服務項目 | 參考的開源專案做法 |
|---|---|---|
| **文書行政** | 公文撰寫（簽、函、公告、書函、開會通知單，標楷體 Word）、會議紀錄整理、信件回覆草稿、錯字與語句校對、文件摘要、文件版本比對、繁簡轉換、**合併列印**（Excel 名單 + Word 範本 → 獎狀、證書、通知單，支援民國日期與國字金額）、**流程圖與組織圖**（流程圖、組織圖、心智圖、甘特圖 → PNG／SVG） | OpenCC、diff、Mermaid、SimpleMindMap |
| **學術研究** | 文獻搜尋與整理（OpenAlex／arXiv → Excel）、文獻回顧草稿（只引用真實搜尋結果）、論文翻譯與摘要、參考文獻格式產生（APA、IEEE、Chicago、MLA、Harvard、BibTeX）、研究主題追蹤（可定期）、**論文 PDF 對照翻譯**（保留原排版、左右對照，公式與參考文獻不翻）、**報告自動排版**（草稿 → 國科會格式 Word：封面、自動目錄、圖表目錄、章節與圖表編號、交互參照、參考文獻排序）、**計畫書／成果報告格式檢查**（依國科會、縣市計畫成果報告規範逐項檢查並自動修正） | arxiv-mcp-server、zotero-pdf2zh、SurveyX、PDFMathTranslate |
| **文件與資料** | 掃描文件文字辨識、文件翻譯（含術語表）、資料擷取成 Excel、資料表分析報告、文件轉純文字、**問卷結果分析**（Google 表單 CSV → 統計圖表與 Word／Excel／HTML 報告） | MinerU、Ollama-OCR、zerox、PDFMathTranslate |
| **影音與圖片** | 錄音轉逐字稿（含時間標記與 .srt 字幕，長錄音自動分段）、會議錄音整理、課堂與演講筆記、圖片分析與說明、AI 圖片生成、簡報轉講稿 | Whisper、SoftWhisper、hyprnote |
| **網站與資訊** | 網站健康檢查、網頁變動監控、新聞與公告摘要（RSS）、外文網頁翻譯摘要、網路研究報告、網站匯入知識庫 | Web-Check、changedetection、crawl4ai、Perplexica |
| **PDF 與圖片工具** | PDF 合併、分割、頁面整理（擷取／排序／刪除／旋轉）、加浮水印（支援中文）、加頁碼、壓縮、圖片轉 PDF、圖片批次處理（縮放、轉格式、壓縮、移除 GPS 等拍攝資訊） | Stirling-PDF、pdf-lib、sharp |
| **知識庫問答** | 上傳規章、手冊、FAQ，AI 只根據這些資料回答並標註出處 | MaxKB、AnythingLLM |
| **自訂工作流程**（進階） | 以 35 種步驟自行組合流程，可定期執行、匯入匯出 | n8n、Dify、huginn |

所有功能皆重新撰寫，不需另外安裝上述專案。標示「不使用 AI」的服務（文獻搜尋、引用格式、繁簡轉換、文件比對、網站檢查、問卷分析、格式檢查、PDF 與圖片工具等）完全不花 API 費用。

### 介面

採用校務／行政系統常見的版型：深藍色標題列、麵包屑、左側功能選單、表格式表單（必填欄位標示紅色 *）、注意事項框、辦理進度表與產出檔案表。支援深色模式與手機瀏覽（選單收合為「功能選單」按鈕）。

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

接著打開 <http://127.0.0.1:8790>，到「系統設定」輸入 API Key，按「測試 AI 連線」確認。

> 標示「不使用 AI」的服務**不需要** API Key。「掃描文件文字辨識」的 PDF 與「網路研究報告」需要使用 Claude。

## 支援的 AI

在「系統設定」中，每家供應商的金鑰與模型分開保存，切換時不會遺失。模型可以按「取得模型清單」**直接從 API 讀取**（OpenRouter 另會顯示每個模型可輸入的類型與價格），也可以手動輸入。

| 供應商 | 文字 | 讀 PDF | 看圖 | 語音轉文字 | 生成圖片 | 申請金鑰 |
|---|---|---|---|---|---|---|
| **Anthropic Claude**（建議） | ✓ | ✓ | ✓ | — | — | console.anthropic.com |
| **OpenAI** | ✓ | ✓ | ✓ | ✓（Whisper、gpt-4o-transcribe） | ✓（gpt-image） | platform.openai.com |
| **OpenRouter** | ✓（數百種模型） | ✓ | ✓ | ✓（音訊模型） | ✓ | openrouter.ai |
| **Google Gemini** | ✓ | — | ✓ | ✓（直接聽 MP3／WAV） | ✓（Imagen） | aistudio.google.com |
| **DeepSeek** | ✓ | — | — | — | — | platform.deepseek.com |
| **Groq** | ✓ | — | — | ✓（whisper-large-v3，便宜快速） | — | console.groq.com |
| **Ollama**（本機，免金鑰） | ✓ | — | 依模型 | — | — | ollama.com |
| **其他 OpenAI 相容服務** | ✓ | — | ✓ | ✓ | ✓ | 學校自建伺服器、vLLM、LM Studio 等 |

- **文字 AI**、**語音轉文字**、**圖片生成**可以分別選擇不同供應商（例如文字用 Claude、語音用 Groq、生圖用 OpenAI）。
- 「網路搜尋研究」需要 Claude；掃描型 PDF 的文字辨識需要 Claude、OpenAI 或 OpenRouter。
- 語音轉文字選擇繁體中文時，結果會在本機自動轉為臺灣用語（Whisper 常輸出簡體字）。
- 金鑰存在本機 `studio/data/settings.json`（檔案權限 600），設定頁只顯示遮罩後的金鑰。舊版設定（OpenAI 相容＋自訂網址）會自動轉移。

## 支援的檔案格式

| 類型 | 格式 |
|---|---|
| 文件 | PDF、Word（.docx、.doc）、Excel（.xlsx、.xls）、PowerPoint（.pptx、.ppt，含講者備註與表格）、OpenDocument（.odt、.ods、.odp）、RTF（含 Big5 編碼）、EPUB、Email（.eml，含 Big5 編碼與附件清單）、CSV／TSV、TXT、Markdown、HTML、JSON、XML、字幕（.srt、.vtt） |
| 圖片 | PNG、JPG、WEBP、GIF、TIFF、BMP、AVIF、SVG（文字辨識、圖片分析時自動轉成 AI 支援的格式；HEIC 請先轉成 JPG） |
| 音檔 | MP3、M4A、WAV、WEBM、OGG、FLAC、AAC、MP4（內建 ffmpeg 自動轉成語音專用格式，一小時約 14 MB；超過上限自動分段轉錄並接上時間軸） |

- 舊版 `.xls`、`.ppt`（以及少數 `.doc`）需要電腦安裝免費的 [LibreOffice](https://www.libreoffice.org) 才能讀取；未安裝時會提示另存為新格式。
- Outlook 的 `.msg` 目前不支援，請在 Outlook 另存為 `.eml`。
- 掃描型 PDF 與圖片需使用「掃描文件文字辨識」服務；音檔需使用「錄音轉逐字稿」等服務。

## 學術論文與被擋的網站（HTTP 403）

ScienceDirect、Springer、Wiley 等期刊網站會擋程式直接擷取，論文全文通常也需要訂閱。遇到論文網址（含 DOI 或 Elsevier PII）時，程式會自動改用正規的學術 API：

1. **Elsevier API**（選填）：在「設定」填入你在 [dev.elsevier.com](https://dev.elsevier.com/) 免費申請的 API Key。在有訂閱的學校／機構網路下執行，就能取得 Elsevier 論文全文；校外使用可向圖書館申請 Institution Token。
2. **Crossref + OpenAlex**（免金鑰）：查出論文資料，若有開放取用（OA）版本會自動下載 PDF 取得全文；沒有的話至少取得標題、作者與英文摘要。
3. **都拿不到全文時**：在瀏覽器（已登入學校帳號）下載 PDF，上傳到「檔案管理」，使用「論文 PDF → 繁中翻譯 + 摘要」範本。

一般網站回應 403 時，表示網站不允許程式存取（需要登入或有防爬蟲機制），本程式不會嘗試繞過；請改為另存網頁／下載檔案後上傳，或使用該網站的官方 API（「呼叫 API」節點）。

## 工作流

### 內建範本（點一下即可建立並修改）

| 範本 | 流程 |
|---|---|
| 外文文章 → 繁中翻譯 + 摘要 | 擷取網頁 → 翻譯 → 摘要 → 組合 → 存成 .md |
| 論文 PDF → 繁中翻譯 + 摘要 | 讀取上傳的論文 PDF → 學術摘要 → 全文翻譯 → 存成 .md |
| 多網址每日簡報 | 逐一擷取每個網址並摘要 → 整合成簡報 → 存檔 →（可選）推送 Slack/Discord |
| 網站健康巡檢 + 異常通知 | 網站檢測 → 存報告 → 分數低於 85 才繼續 → AI 寫修正建議 → 通知 |
| 網頁變動監控 | 擷取網頁 → 與上次內容比對 → 有變動才由 AI 說明並通知 |
| 文件 → Excel 表格 | 讀取檔案 → 擷取指定欄位 → 輸出 .xlsx |
| 網站 → 知識庫 | 爬取整站 → 存入知識庫 |
| API 資料 → AI 分析報告 | 呼叫任意 JSON API → AI 解讀 → 存檔 |

### 節點類型

| 節點 | 說明 | 預設輸出變數 |
|---|---|---|
| 擷取網頁 | 網址 → Markdown（只取正文或整頁） | `{{page}}`、`{{page.title}}`、`{{page.url}}` |
| 爬取網站 | 同網域廣度優先爬取 | `{{site}}` |
| 呼叫 API | GET / POST / PUT 任意 API，自訂標頭 | `{{api}}`（JSON 可用 `{{api.欄位}}`） |
| 讀取檔案 | 從檔案庫讀取 PDF / Word / Excel / 文字 | `{{doc}}` |
| 知識庫檢索 | 找出最相關的段落 | `{{context}}` |
| 存入知識庫 | 把文字或爬取結果加入知識庫 | — |
| AI 處理 | 自訂提示 | `{{ai}}` |
| 逐項 AI 處理 | 對清單每一項（每行、每頁、每列）執行提示，可先自動擷取網址 | `{{items}}` |
| 翻譯 / 摘要 | 長文自動分段處理 | `{{translated}}` / `{{summary}}` |
| 擷取成表格 | 指定欄位 → 表格資料 | `{{table}}` |
| 網站檢測 | 完整檢測與評分 | `{{check}}`、`{{check.score}}`、`{{check.issues}}` |
| 條件判斷 | 小於／大於／等於／包含／**與上次執行不同**，不成立就停止 | — |
| 組合文字 | 用模板組出新內容 | `{{text}}` |
| 輸出檔案 | .md / .txt / .csv / .xlsx / .json | `{{file}}` |
| 問卷分析 | CSV／Excel → 題型判斷、統計、圖表、Word／Excel／HTML 報告（個資欄位排除） | `{{survey}}` |
| 報告格式檢查 | Word 檔逐項檢查字型、字級、對齊、標號、架構、圖表、用語、參考文獻，可自動修正 | `{{check}}` |
| PDF 工具 | 合併、分割、擷取／刪除／旋轉頁面、浮水印、頁碼、壓縮、圖片轉 PDF | `{{pdf}}` |
| 圖片批次處理 | 縮放、轉格式、壓縮、移除 EXIF | `{{images}}` |
| 論文 PDF 對照翻譯 | 保留排版翻譯 PDF（左右對照／只有譯文／交錯） | `{{pdf}}` |
| 產生圖表 | 流程圖、組織圖、心智圖、甘特圖（可由 AI 從描述整理） | `{{diagram}}` |
| 報告自動排版 | 草稿 → 符合規範的 Word | `{{report}}` |
| 合併列印 | 名單 + Word 範本 → 每人一份文件 | `{{merge}}` |
| 發送通知 | POST 到 Slack / Discord / Teams Webhook | — |

內建變數：`{{input}}`（執行時的輸入）、`{{today}}`（2026-01-31）、`{{now}}`。

工作流可以匯出成 JSON 分享給別人，對方再匯入即可使用。

### 排程

在工作流下方勾選「⏰ 排程自動執行」，選擇「每天 HH:MM」或「每隔 N 分鐘」（最少 5 分鐘）並填入排程時要用的輸入。排程只在程式執行期間有效，若要長期執行，可把 `npm start` 設成開機啟動（Windows 工作排程器、macOS launchd、Linux systemd）。

## 節省 API 用量

程式預設就會盡量減少 AI 呼叫次數與 token 用量，每次執行後也會顯示這次用了多少：

| 做法 | 效果 |
|---|---|
| **回應快取**（預設 7 天） | 同樣的內容、同樣的提示重跑時直接用上次結果，**不呼叫 API、不計費**。適合反覆調整後面節點、或排程重跑同一份資料 |
| **逐項處理自動合併** | 「逐項 AI 處理」會把多個項目合併成一次呼叫（例如 10 個網址的每日簡報：從 11 次降為 2 次）；AI 回傳格式不對時才自動改回逐項 |
| **大段落處理** | Claude 一次可處理很長的內容，翻譯每次約 1.4 萬字、摘要 30 萬字內一次完成、擷取表格每次 8 萬字，大幅減少分段呼叫次數（OpenAI 相容服務因輸出上限較小，會切得比較細） |
| **省用量模式**（預設） | 翻譯、擷取表格、逐項處理等機械性工作使用較低的思考深度（思考 token 也要計費）；摘要、問答、自訂 AI 節點維持你設定的品質 |
| **結構化輸出** | Claude 擷取表格時以 JSON Schema 保證格式，不會因格式錯誤而重試；表格每列用陣列而非物件，不重複欄位名稱，輸出 token 更少 |
| **精簡輸入** | 送出前去除網頁中的圖片、data URI、多餘空白；知識庫只送最相關的段落、只帶最近 2 輪對話 |
| **條件判斷放在 AI 之前** | 範本中的「網站巡檢」只有分數低於門檻、「網頁監控」只有內容變動時才會呼叫 AI |

在「設定 → 用量控管」可以切換模式、調整快取天數、清除快取，並查看今天與本月的呼叫次數與 token 數。
用量統計中的 token 數：Claude 與 OpenAI 官方 API 為實際數字；其他相容服務若未回報用量，會以字數估算並標示「約」。

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
└── outputs/           # 產出的檔案（可在「檔案」下載）
```

備份或搬家時，複製整個 `data/` 資料夾即可。可用環境變數 `STUDIO_DATA_DIR` 指定其他位置。

## 技術說明

- **知識庫檢索**使用本機 BM25（中日韓文以單字＋雙字切詞），不需要 Embedding API，所以 Claude、DeepSeek、Ollama 等任何模型都能用。
- **PDF** 使用 pdf.js（含 CMap，支援中文），**Word** 使用 mammoth，**Excel** 使用 ExcelJS，**網頁正文**使用 Mozilla Readability + Turndown。
- 掃描影像型 PDF（沒有文字層）使用「掃描文件文字辨識」服務處理。
- **長錄音**：`npm install` 會一併下載 ffmpeg（ffmpeg-static），也可用環境變數 `FFMPEG_PATH` 指定。錄音先轉成單聲道 16 kHz 32 kbps MP3，超過供應商上限時切段轉錄，下一段的提示附上前一段結尾讓用詞連貫，字幕時間軸自動接續。
- **PDF 工具**使用 pdf-lib；中文浮水印與頁碼先由 sharp 轉成圖片再嵌入，不需安裝字型。壓縮會重新壓縮內嵌圖片；若電腦已安裝 Ghostscript（或以 `GS_PATH` 指定）會自動採用效果較好者。
- **論文 PDF 對照翻譯**：以 pdf.js 取得文字位置，組成段落（支援雙欄、行尾連字號），判斷公式、頁碼、參考文獻不翻；段落合併成批次翻譯（每批約 6,000 字一次呼叫，回傳數量不符時自動拆半重試），譯文以 sharp 轉成透明圖層，蓋在原段落位置並自動調整字級。
- **圖表**：流程圖以 dagre 計算版面，組織圖、心智圖、甘特圖為自行實作的排版；全部在本機繪成 SVG／PNG，不需瀏覽器。
- **報告自動排版**：以 docx 套件產生，圖表編號使用 `SEQ`（每章第一個以 `\r 1` 重新起算，Word 與 LibreOffice 皆正確）、引用使用書籤 + `REF` 功能變數；產生後立即以格式檢查驗證。
- **合併列印**：以段落為單位比對欄位，可處理 Word 把 `{{姓名}}` 拆成多個 run 的情況，值沿用欄位名稱的格式；也支援 Word 的 `MERGEFIELD` 功能變數，並移除範本中的合併列印資料來源設定。
- **問卷分析**、**格式檢查**都在本機計算；勾選 AI 選項時只送出統計結果或報告文字，不送出姓名、Email 等個資欄位。格式檢查的規則依「報告撰寫規範」（標楷體＋Times New Roman、內文 12pt、章標題 16pt 粗體、節標題 14pt 粗體、圖表標題 14pt、兩端對齊、表標題在上、圖標題在下、圖1-1 編號、目錄功能變數、參考文獻 APA 等）。
- 伺服器預設只監聽 `127.0.0.1`，並拒絕跨站 POST 請求。爬蟲與 API 節點可以連到內網位址，這是刻意的設計（方便處理公司內部網站），請勿把本服務公開到網際網路。
- Claude Opus／Sonnet 模型會自動開啟伺服器端備援（`fallbacks: "default"`）。

## 測試

```bash
npm test          # 單元、整合、服務、供應商與格式測試（280 項，約 3 分鐘，不需網路與金鑰）
npm run test:ui   # 瀏覽器端到端測試（需要 Playwright）
```

測試使用 `test/world.js` 建立的「模擬世界」，在本機重現真實使用會遇到的情況：

- **假網站**：一般頁面、Big5 編碼（含只在 `<meta>` 宣告編碼的舊網站）、轉址、gzip、直接連到 PDF / Word、以附件下載、被擋（403）、限流（429）、伺服器錯誤、只有 JavaScript 才有內容的網頁、JSON API
- **假 AI**：OpenAI 相容（一般、只收 `max_completion_tokens` 的新模型、推理模型、只收 `max_tokens` 的舊服務、限流、回傳壞掉的 JSON）、Claude（Messages API 串流格式、拒絕回答）
- **Webhook 接收器、學術 API（Elsevier / Crossref / OpenAlex）**
- **測試檔案**（`test/files/`）：中文 PDF、掃描型 PDF、Word（含表格）、Excel、CSV、Markdown、TXT、HTML、空白檔、Google 表單問卷 CSV、符合規範與含常見錯誤的報告 Word 檔、報告草稿（Markdown，含圖片與錯誤編號）、合併列印範本（欄位拆成多個 run、頁首、表格、MERGEFIELD）與名單；測試時另以 pdf-lib 產生雙欄英文論文、測試時另以 ffmpeg 產生 150 秒音檔驗證分段，以 pdf-lib、sharp 產生 PDF 與照片

涵蓋範圍：

- **每一個範本 × 6 種 AI 設定**（Claude Opus / Haiku、OpenAI 一般 / 新模型 / 推理模型、舊版相容服務）實際執行，並檢查輸出檔內容、Webhook 是否送出、輸出中沒有 `undefined`、`[object Object]`、未替換的 `{{變數}}`
- 每一種節點、每一種檔案格式、每一種網站狀況、AI 錯誤（金鑰錯誤、限流、拒絕、格式錯誤）、取消執行
- API 用量：快取命中不呼叫 API、批次合併的呼叫次數、省用量模式送出的參數、送出內容已精簡
- Windows 情境：`\r\n` 換行、Big5 / UTF-16 編碼的檔案、檔名非法字元與長度、pdf.js 路徑格式
- 安全性：拒絕跨站請求、下載路徑不能跳出資料夾、不回傳完整金鑰
- 瀏覽器端：每個分頁的實際點擊操作、從介面執行每個範本、檔案上傳與下載、深色模式、手機寬度不出現橫向捲動、全程無 JavaScript 錯誤

## 開發

```
studio/
├── server.js          # HTTP 伺服器與 API
├── lib/
│   ├── llm.js         # Claude / OpenAI 相容呼叫、快取、用量統計
│   ├── docs.js        # 文件解析與切塊
│   ├── doctools.js    # 翻譯、摘要、擷取表格、CSV/Excel
│   ├── web.js         # 網頁擷取（編碼偵測、文件下載）、爬蟲、網站檢測
│   ├── scholar.js     # 學術論文（Elsevier / Crossref / OpenAlex）
│   ├── kb.js          # 知識庫（BM25 + 問答）
│   ├── flow.js        # 工作流引擎、節點、範本、排程
│   ├── services.js    # 服務目錄（表單欄位 + 流程）
│   ├── survey.js      # 問卷分析、圖表
│   ├── formatcheck.js # 報告格式檢查與自動修正
│   ├── pdftools.js    # PDF 工具
│   ├── imagetools.js  # 圖片批次處理
│   ├── audio.js       # ffmpeg 轉檔與分段
│   ├── pdftranslate.js # 論文 PDF 對照翻譯
│   ├── diagram.js     # 流程圖、組織圖、心智圖、甘特圖
│   ├── reportbuild.js # 報告自動排版
│   ├── mailmerge.js   # 合併列印
│   └── store.js       # 本機 JSON 儲存
├── public/            # 前端（純 HTML/CSS/JS，無需建置）
└── test/              # 測試與模擬世界
```
