// 服務目錄：把常見工作做成「填表 → 送出 → 取得結果」的現成流程，不需要自己設計工作流。
// 每個服務由表單欄位與工作流節點組成；表單值以 {{form.欄位}} 帶入節點。
//
// 欄位類型：
//   text / textarea / url / number / select / checkbox
//   doc   ：文件來源（上傳檔案、檔案庫、貼上文字、網址任選），執行前會先轉成文字
//   file  ：原始檔案（給文字辨識、資料分析），值為檔案庫 id
//   kb    ：知識庫
// ai：none＝不使用 AI（不花用量）／light＝少量／normal＝一般／claude＝需要 Claude

export const CATEGORIES = [
  { id: "office", name: "文書行政", desc: "公文、會議紀錄、信件、校對、摘要、比對" },
  { id: "research", name: "學術研究", desc: "文獻搜尋、論文翻譯、文獻回顧、引用格式" },
  { id: "docs", name: "文件與資料", desc: "文字辨識、翻譯、擷取表格、資料分析、格式轉換" },
  { id: "web", name: "網站與資訊", desc: "網站檢測、網頁監控、新聞摘要、網路研究" },
];

const FORMAL_SYSTEM = "你是熟悉中華民國（臺灣）政府與學校行政作業的文書人員。一律使用臺灣慣用的繁體中文與正式書面用語，不使用簡體字或中國大陸用語。";

const DOC_SOURCES = { label: "文件來源", type: "doc", required: true, help: "可上傳檔案（PDF、Word、Excel、TXT、HTML）、從檔案庫選擇、貼上文字或輸入網址" };

export const SERVICES = [
  // ======================= 文書行政 =======================
  {
    id: "official-document",
    cat: "office",
    name: "公文撰寫",
    desc: "依「文書處理手冊」格式撰寫簽、函、公告、書函、開會通知單等公文草稿，輸出 Word 檔（標楷體）。",
    ai: "normal",
    notes: ["產出內容為草稿，發文前請依機關規定由承辦人與主管核閱。", "受文者、文號、日期等欄位如未填寫，會以「○○」保留空位。", "請勿輸入個人敏感資料（身分證字號、病歷等）。"],
    fields: [
      { key: "kind", label: "文別", type: "select", required: true, options: { 簽: "簽（內部陳核）", 函: "函（對外行文）", 書函: "書函", 公告: "公告", 開會通知單: "開會通知單", 便箋: "便箋" }, default: "簽" },
      { key: "org", label: "機關／單位", type: "text", placeholder: "例：國立○○大學 教務處" },
      { key: "to", label: "受文者", type: "text", placeholder: "例：本校各學院（簽可留空）" },
      { key: "content", label: "事由與重點", type: "textarea", required: true, rows: 6, placeholder: "例：為辦理 115 學年度新生入學說明會，擬於 8 月 20 日假行政大樓第一會議室舉行，經費約 3 萬元由教務處業務費支應，請核示。" },
      { key: "attach", label: "附件", type: "text", placeholder: "例：活動議程 1 份" },
    ],
    nodes: [
      {
        id: "draft",
        type: "llm",
        system: FORMAL_SYSTEM,
        prompt:
          "請依中華民國「文書處理手冊」撰寫一份「{{form.kind}}」草稿。\n機關／單位：{{form.org}}\n受文者：{{form.to}}\n附件：{{form.attach}}\n事由與重點：\n{{form.content}}\n\n格式要求：\n- 簽：主旨、說明（分項）、擬辦；以「敬陳 ○○長」結尾；期望語用「請 鑒核」等。\n- 函、書函：發文機關、受文者、發文日期、發文字號（以○○保留）、速別、附件，本文分主旨、說明、辦法（需要時）。期望語依上下行選用「請 查照」「請 鑒核」「請 照辦」。\n- 公告：主旨、依據、公告事項，不使用期望語與「說明」段。\n- 開會通知單：受文者、開會事由、開會時間、開會地點、主持人、出（列）席者、聯絡人。\n- 主旨一段完成、不分項，約 50 字內；說明、辦法分項用「一、二、三、」，細項用「（一）（二）」。\n- 使用 Markdown：機關名稱與文別用標題，各段名稱用粗體。只輸出公文本身。",
        out: "ai",
      },
      { id: "save", type: "save_file", source: "{{ai}}", format: "docx", formal: true, filename: "{{form.kind}}-{{today}}", out: "file" },
    ],
  },
  {
    id: "meeting-minutes",
    cat: "office",
    name: "會議紀錄整理",
    desc: "把會議逐字稿、筆記或錄音轉出的文字，整理成正式會議紀錄（含決議事項與待辦清單），輸出 Word 檔。",
    ai: "normal",
    notes: ["內容只會依據提供的資料整理，不會自行補充未提到的決議。", "逐字稿很長時會自動分段處理。"],
    fields: [
      { key: "title", label: "會議名稱", type: "text", required: true, placeholder: "例：115 學年度第 1 次系務會議" },
      { key: "meta", label: "時間、地點、主席、出席者", type: "textarea", rows: 3, placeholder: "例：11 月 5 日 14:00，系館 301 會議室，主席：王主任，出席：…" },
      { ...DOC_SOURCES, key: "doc", label: "逐字稿或會議筆記" },
    ],
    nodes: [
      {
        id: "minutes",
        type: "llm",
        system: FORMAL_SYSTEM,
        prompt:
          "請依據以下資料整理正式會議紀錄。\n會議名稱：{{form.title}}\n會議資訊：{{form.meta}}\n\n格式：\n# {{form.title}} 會議紀錄\n- 時間、地點、主席、出席人員、紀錄（資料中沒有的寫「○○」）\n## 一、報告事項\n## 二、討論事項（每案：案由、說明、決議）\n## 三、臨時動議\n## 四、待辦事項（表格：事項｜負責人｜期限）\n## 五、散會時間\n\n只能依據資料內容，不得自行補充；不確定的地方標註「（待確認）」。\n\n資料：\n{{form.doc}}",
        out: "ai",
      },
      { id: "save", type: "save_file", source: "{{ai}}", format: "docx", formal: true, filename: "{{form.title}}-會議紀錄", out: "file" },
    ],
  },
  {
    id: "email-reply",
    cat: "office",
    name: "信件回覆草稿",
    desc: "貼上收到的信件與你想表達的重點，產生得體的回覆草稿，可選擇語氣與語言。",
    ai: "light",
    notes: ["送出前請確認日期、金額、人名等細節是否正確。"],
    fields: [
      { key: "mail", label: "收到的信件內容", type: "textarea", required: true, rows: 6 },
      { key: "points", label: "回覆重點", type: "textarea", required: true, rows: 3, placeholder: "例：同意出席，但需改到下午；請對方提供議程" },
      { key: "tone", label: "語氣", type: "select", options: { 正式: "正式（長官、外部單位）", 一般: "一般（同事）", 親切: "親切（學生、熟識對象）" }, default: "正式" },
      { key: "lang", label: "語言", type: "select", options: { 繁體中文: "繁體中文", English: "English", 日本語: "日本語" }, default: "繁體中文" },
    ],
    nodes: [
      {
        id: "reply",
        type: "llm",
        system: "你擅長撰寫得體、精簡的商務與行政信件。",
        prompt: "請用{{form.lang}}、{{form.tone}}的語氣，撰寫回覆以下信件的草稿，需涵蓋回覆重點。包含主旨、稱謂、內文、結尾敬語與署名（署名以○○代替）。只輸出信件。\n\n回覆重點：{{form.points}}\n\n收到的信：\n{{form.mail}}",
        out: "ai",
      },
    ],
  },
  {
    id: "proofread",
    cat: "office",
    name: "錯字與語句校對",
    desc: "檢查錯別字、標點、語句不通順與不一致的用詞，提供修正後全文與修改清單。",
    ai: "light",
    fields: [
      { ...DOC_SOURCES, key: "doc", label: "要校對的文件" },
      { key: "level", label: "修改程度", type: "select", options: { 輕度: "輕度（只改錯字與標點）", 中度: "中度（含語句通順）", 潤飾: "潤飾（調整為正式書面語）" }, default: "中度" },
    ],
    nodes: [
      {
        id: "fix",
        type: "llm",
        light: true,
        system: "你是嚴謹的中文校對人員，使用臺灣繁體中文與標點符號規範（全形標點）。",
        prompt: "請以「{{form.level}}」程度校對以下文件。輸出兩部分：\n## 修改清單\n表格：原文｜修改後｜原因（只列有修改的地方）\n## 修正後全文\n\n文件：\n{{form.doc}}",
        out: "ai",
      },
      { id: "save", type: "save_file", source: "{{ai}}", format: "docx", filename: "校對結果-{{today}}", out: "file" },
    ],
  },
  {
    id: "summarize",
    cat: "office",
    name: "文件摘要",
    desc: "長篇報告、法規、計畫書快速整理成重點摘要，可選擇摘要風格。",
    ai: "normal",
    fields: [
      { ...DOC_SOURCES, key: "doc", label: "要摘要的文件" },
      { key: "style", label: "摘要風格", type: "select", options: { "重點條列": "重點條列", "主管簡報（結論先行）": "主管簡報（結論先行）", "白話解說（給一般民眾）": "白話解說（給一般民眾）", "學術摘要（目的、方法、結果、結論）": "學術摘要" }, default: "重點條列" },
    ],
    nodes: [
      { id: "sum", type: "summarize", source: "{{form.doc}}", style: "{{form.style}}", out: "summary" },
      { id: "save", type: "save_file", source: "{{summary}}", format: "docx", filename: "摘要-{{form.doc.name}}", out: "file" },
    ],
  },
  {
    id: "compare",
    cat: "office",
    name: "文件版本比對",
    desc: "比較兩個版本的文件（合約、法規、辦法修正），逐條列出新增、刪除與修改，可產生修正對照表。",
    ai: "none",
    notes: ["比對本身不使用 AI、不花用量；勾選「AI 說明重點」才會呼叫 AI。"],
    fields: [
      { ...DOC_SOURCES, key: "a", label: "舊版文件" },
      { ...DOC_SOURCES, key: "b", label: "新版文件" },
      { key: "explain", label: "由 AI 說明修改重點與影響", type: "checkbox", default: false },
    ],
    nodes: [
      { id: "diff", type: "compare", a: "{{form.a}}", b: "{{form.b}}", out: "diff" },
      { id: "save", type: "save_file", source: "{{diff}}", format: "docx", filename: "比對結果-{{today}}", out: "file" },
      { id: "explain", type: "llm", when: "{{form.explain}}", system: FORMAL_SYSTEM, prompt: "以下是文件新舊版本的差異。請用繁體中文說明：1. 主要修改重點 2. 對相關人員的影響 3. 需要特別注意的地方。\n\n{{diff}}", out: "ai" },
    ],
  },
  {
    id: "zh-convert",
    cat: "office",
    name: "繁簡轉換",
    desc: "簡體與繁體中文互轉，並轉換兩岸用詞（例：软件→軟體、网络→網路）。",
    ai: "none",
    fields: [
      { ...DOC_SOURCES, key: "doc", label: "要轉換的內容" },
      { key: "mode", label: "轉換方式", type: "select", options: { s2twp: "簡體 → 繁體（臺灣用詞）", s2t: "簡體 → 繁體（只轉字形）", tw2sp: "繁體 → 簡體（大陸用詞）", t2s: "繁體 → 簡體（只轉字形）" }, default: "s2twp" },
    ],
    nodes: [
      { id: "cv", type: "convert_zh", source: "{{form.doc}}", mode: "{{form.mode}}", out: "converted" },
      { id: "save", type: "save_file", source: "{{converted}}", format: "docx", filename: "轉換結果-{{form.doc.name}}", out: "file" },
    ],
  },

  // ======================= 學術研究 =======================
  {
    id: "literature-search",
    cat: "research",
    name: "文獻搜尋與整理",
    desc: "以關鍵字搜尋 OpenAlex 或 arXiv，整理成 Excel 文獻清單（標題、作者、年份、期刊、被引用次數、DOI、開放全文連結）。",
    ai: "none",
    notes: ["搜尋本身不使用 AI；勾選「AI 綜整研究趨勢」才會呼叫 AI。", "OpenAlex 涵蓋大部分期刊論文；arXiv 為物理、數學、資訊等領域的預印本。"],
    fields: [
      { key: "query", label: "關鍵字（建議用英文）", type: "text", required: true, placeholder: "例：meshless method boundary value problem" },
      { key: "source", label: "資料庫", type: "select", options: { openalex: "OpenAlex（跨領域、含期刊）", arxiv: "arXiv（預印本）" }, default: "openalex" },
      { key: "fromYear", label: "起始年份", type: "number", placeholder: "例：2020" },
      { key: "sort", label: "排序", type: "select", options: { relevance: "相關度", date: "最新", cited: "被引用次數" }, default: "relevance" },
      { key: "limit", label: "篇數", type: "number", default: 20 },
      { key: "synth", label: "AI 綜整研究趨勢（中文）", type: "checkbox", default: false },
    ],
    nodes: [
      { id: "search", type: "paper_search", query: "{{form.query}}", source: "{{form.source}}", limit: "{{form.limit}}", fromYear: "{{form.fromYear}}", sort: "{{form.sort}}", out: "papers" },
      { id: "xlsx", type: "save_file", source: "{{papers}}", format: "xlsx", filename: "文獻清單-{{form.query}}", out: "file" },
      { id: "synth", type: "llm", when: "{{form.synth}}", prompt: "以下是關於「{{form.query}}」的論文清單。請用繁體中文整理：1. 主要研究方向（分類，每類列出代表論文）2. 常用方法 3. 近年趨勢 4. 可能的研究缺口。引用時以 [編號] 對應清單順序。\n\n{{papers}}", out: "ai" },
    ],
  },
  {
    id: "literature-review",
    cat: "research",
    name: "文獻回顧草稿",
    desc: "搜尋相關論文後，依主題撰寫文獻回顧段落草稿，並附參考文獻清單（每篇皆為真實搜尋結果）。",
    ai: "normal",
    notes: ["引用的論文全部來自 OpenAlex 搜尋結果，不會捏造文獻；但內容仍須自行閱讀原文確認。"],
    fields: [
      { key: "query", label: "研究主題關鍵字（英文）", type: "text", required: true },
      { key: "focus", label: "回顧重點（選填）", type: "textarea", rows: 2, placeholder: "例：著重數值方法的收斂性與計算效率比較" },
      { key: "fromYear", label: "起始年份", type: "number", default: 2015 },
      { key: "lang", label: "撰寫語言", type: "select", options: { 繁體中文: "繁體中文", English: "English" }, default: "繁體中文" },
    ],
    nodes: [
      { id: "search", type: "paper_search", query: "{{form.query}}", source: "openalex", limit: 25, fromYear: "{{form.fromYear}}", sort: "relevance", out: "papers" },
      {
        id: "review",
        type: "llm",
        system: "你是嚴謹的學術寫作助理。只能引用提供清單中的論文，不得捏造文獻或結果。",
        prompt: "請用{{form.lang}}撰寫「{{form.query}}」的文獻回顧草稿。{{form.focus}}\n要求：依主題分段論述（不是逐篇條列），比較不同方法的優缺點，以 [編號] 引用（編號對應清單順序），最後列出「參考文獻」（APA 格式，只列有引用的）。\n\n論文清單：\n{{papers}}",
        out: "ai",
      },
      { id: "save", type: "save_file", source: "{{ai}}", format: "docx", filename: "文獻回顧-{{form.query}}", out: "file" },
    ],
  },
  {
    id: "paper-translate",
    cat: "research",
    name: "論文翻譯與摘要",
    desc: "上傳論文 PDF（或貼上論文網址），產生學術摘要與全文翻譯，輸出 Word 檔。",
    ai: "normal",
    notes: ["期刊網站多半需要訂閱：建議先用學校帳號下載 PDF 再上傳。", "掃描型 PDF 請先使用「掃描文件文字辨識」。"],
    fields: [
      { ...DOC_SOURCES, key: "doc", label: "論文（PDF 或網址）" },
      { key: "target", label: "翻譯成", type: "select", options: { "zh-TW": "繁體中文", en: "English", ja: "日本語" }, default: "zh-TW" },
      { key: "full", label: "翻譯全文（不勾選則只產生摘要，可大幅節省用量）", type: "checkbox", default: true },
    ],
    nodes: [
      { id: "sum", type: "summarize", source: "{{form.doc}}", style: "學術摘要（研究目的、方法、結果、結論、貢獻與限制），使用繁體中文", out: "summary" },
      { id: "tr", type: "translate", when: "{{form.full}}", source: "{{form.doc}}", target: "{{form.target}}", out: "translated" },
      { id: "join", type: "set", value: "# {{form.doc.name}}\n\n## 摘要\n\n{{summary}}\n\n## 全文翻譯\n\n{{translated}}", out: "text" },
      { id: "save", type: "save_file", source: "{{text}}", format: "docx", filename: "論文翻譯-{{form.doc.name}}", out: "file" },
    ],
  },
  {
    id: "citation",
    cat: "research",
    name: "參考文獻格式產生",
    desc: "貼上 DOI 或論文的 doi.org 網址（可多筆），自動產生 APA、IEEE、Chicago、MLA、Harvard 或 BibTeX 格式。",
    ai: "none",
    notes: ["資料來自 Crossref，不使用 AI、不花用量。"],
    fields: [
      { key: "dois", label: "DOI（每行一筆）", type: "textarea", required: true, rows: 5, placeholder: "10.1016/j.enganabound.2017.10.009\nhttps://doi.org/10.3390/math11051234" },
      { key: "style", label: "格式", type: "select", options: { apa: "APA 第 7 版", ieee: "IEEE", "chicago-author-date": "Chicago（作者-年份）", "modern-language-association": "MLA", "harvard-cite-them-right": "Harvard", bibtex: "BibTeX" }, default: "apa" },
    ],
    nodes: [
      { id: "cite", type: "cite", source: "{{form.dois}}", style: "{{form.style}}", out: "citations" },
      { id: "save", type: "save_file", source: "{{citations}}", format: "txt", filename: "參考文獻-{{form.style}}", out: "file" },
    ],
  },
  {
    id: "research-tracker",
    cat: "research",
    name: "研究主題追蹤",
    desc: "追蹤某個研究主題的最新論文，整理成週報；可設為每週自動執行並寄送通知。",
    ai: "light",
    schedulable: true,
    fields: [
      { key: "query", label: "研究主題關鍵字（英文）", type: "text", required: true },
      { key: "source", label: "資料庫", type: "select", options: { openalex: "OpenAlex", arxiv: "arXiv" }, default: "arxiv" },
      { key: "notify", label: "完成後發送通知（需在系統設定填寫 Webhook）", type: "checkbox", default: false },
    ],
    nodes: [
      { id: "search", type: "paper_search", query: "{{form.query}}", source: "{{form.source}}", limit: 15, sort: "date", out: "papers" },
      { id: "brief", type: "llm", light: true, prompt: "以下是「{{form.query}}」最新的論文。請用繁體中文寫一份簡短週報：每篇用 1–2 句說明貢獻並附連結，最後用 3 句話總結本期趨勢。\n\n{{papers}}", out: "ai" },
      { id: "save", type: "save_file", source: "{{ai}}", format: "md", filename: "研究追蹤-{{form.query}}-{{today}}", out: "file" },
      { id: "notify", type: "webhook", when: "{{form.notify}}", url: "", message: "研究主題追蹤：{{form.query}}（{{today}}）\n\n{{ai}}" },
    ],
  },

  // ======================= 文件與資料 =======================
  {
    id: "ocr",
    cat: "docs",
    name: "掃描文件文字辨識",
    desc: "將掃描型 PDF、拍照的文件或截圖轉成可編輯的文字（含表格），輸出 Word 檔。",
    ai: "claude",
    notes: ["PDF 需要使用 Claude；圖片也可使用支援影像的 OpenAI 相容模型。", "每頁約需 1,500–3,000 token，頁數多時用量較大。", "單一檔案上限 25 MB。"],
    fields: [
      { key: "file", label: "掃描檔或圖片", type: "file", required: true, accept: ".pdf,.png,.jpg,.jpeg,.webp,.gif" },
      { key: "hint", label: "補充說明（選填）", type: "text", placeholder: "例：這是手寫筆記；表格請保留欄位" },
    ],
    nodes: [
      { id: "ocr", type: "ocr", fileId: "{{form.file}}", instruction: "{{form.hint}}", out: "doc" },
      { id: "save", type: "save_file", source: "{{doc}}", format: "docx", filename: "文字辨識-{{doc.name}}", out: "file" },
    ],
  },
  {
    id: "translate",
    cat: "docs",
    name: "文件翻譯",
    desc: "翻譯 PDF、Word、網頁或貼上的文字，保留標題、條列與表格格式，可提供術語表。",
    ai: "normal",
    fields: [
      { ...DOC_SOURCES, key: "doc", label: "要翻譯的文件" },
      { key: "target", label: "翻譯成", type: "select", options: { "zh-TW": "繁體中文", en: "English", ja: "日本語", ko: "한국어", "zh-CN": "简体中文" }, default: "zh-TW" },
      { key: "glossary", label: "術語表（選填，每行「原文 = 譯文」）", type: "textarea", rows: 2 },
    ],
    nodes: [
      { id: "tr", type: "translate", source: "{{form.doc}}", target: "{{form.target}}", glossary: "{{form.glossary}}", out: "translated" },
      { id: "save", type: "save_file", source: "{{translated}}", format: "docx", filename: "翻譯-{{form.doc.name}}", out: "file" },
    ],
  },
  {
    id: "extract-table",
    cat: "docs",
    name: "資料擷取成 Excel",
    desc: "從報價單、名冊、型錄、報告中擷取指定欄位，整理成 Excel 表格。",
    ai: "light",
    fields: [
      { ...DOC_SOURCES, key: "doc", label: "來源文件" },
      { key: "fields", label: "要擷取的欄位（逗號分隔，留空由 AI 判斷）", type: "text", placeholder: "例：姓名, 單位, 電話, Email" },
      { key: "instruction", label: "條件（選填）", type: "text", placeholder: "例：只要 2025 年以後的項目" },
    ],
    nodes: [
      { id: "ex", type: "extract", source: "{{form.doc}}", fields: "{{form.fields}}", instruction: "{{form.instruction}}", out: "table" },
      { id: "save", type: "save_file", source: "{{table}}", format: "xlsx", filename: "擷取結果-{{form.doc.name}}", out: "file" },
    ],
  },
  {
    id: "data-analysis",
    cat: "docs",
    name: "資料表分析報告",
    desc: "上傳 Excel 或 CSV（成績、問卷、報名、經費等），自動計算統計數字並撰寫分析報告。",
    ai: "light",
    notes: ["統計數字在本機計算，只把統計結果（而非整份資料）送給 AI，用量低且保護資料隱私。", "第一列需為欄位名稱。"],
    fields: [
      { key: "file", label: "資料檔（.xlsx / .csv）", type: "file", required: true, accept: ".xlsx,.csv" },
      { key: "question", label: "想了解什麼（選填）", type: "textarea", rows: 2, placeholder: "例：各系所的報名人數差異？哪些項目超出預算？" },
    ],
    nodes: [
      { id: "stats", type: "table_stats", fileId: "{{form.file}}", out: "stats" },
      { id: "report", type: "llm", prompt: "以下是一份資料表的統計摘要（由程式精確計算）。請用繁體中文撰寫分析報告：重要發現（引用具體數字）、異常或值得注意之處、建議。{{form.question}}\n不要自行推算未提供的數字。\n\n{{stats}}", out: "ai" },
      { id: "join", type: "set", value: "{{ai}}\n\n---\n\n{{stats}}", out: "text" },
      { id: "save", type: "save_file", source: "{{text}}", format: "docx", filename: "資料分析報告-{{today}}", out: "file" },
    ],
  },
  {
    id: "to-markdown",
    cat: "docs",
    name: "文件轉純文字",
    desc: "把 PDF、Word、Excel、網頁轉成乾淨的純文字／Markdown，方便複製或匯入其他系統。",
    ai: "none",
    fields: [{ ...DOC_SOURCES, key: "doc", label: "來源文件" }],
    nodes: [
      { id: "t", type: "set", value: "{{form.doc}}", out: "text" },
      { id: "save", type: "save_file", source: "{{text}}", format: "md", filename: "{{form.doc.name}}", out: "file" },
    ],
  },

  // ======================= 網站與資訊 =======================
  {
    id: "site-check",
    cat: "web",
    name: "網站健康檢查",
    desc: "檢查網站的 SSL 憑證、安全標頭、DNS、SEO 與失效連結，給予 0–100 分評分與問題清單。",
    ai: "none",
    schedulable: true,
    notes: ["檢測本身不使用 AI；勾選「AI 修正建議」才會呼叫 AI。"],
    fields: [
      { key: "url", label: "網站網址", type: "url", required: true, placeholder: "https://www.example.edu.tw" },
      { key: "advise", label: "AI 修正建議（含設定範例）", type: "checkbox", default: false },
      { key: "notify", label: "分數低於 80 時發送通知", type: "checkbox", default: false },
    ],
    nodes: [
      { id: "check", type: "site_check", url: "{{form.url}}", out: "check" },
      { id: "save", type: "save_file", source: "{{check}}", format: "docx", filename: "網站檢測-{{check.host}}-{{today}}", out: "file" },
      { id: "advise", type: "llm", when: "{{form.advise}}", prompt: "以下是網站檢測報告。請用繁體中文列出最該優先處理的 5 個問題，每個附具體修正方法與設定範例（Nginx、Apache、IIS 或 Cloudflare）。\n\n{{check}}", out: "ai" },
      { id: "cond", type: "condition", when: "{{form.notify}}", left: "{{check.score}}", op: "lt", right: "80" },
      { id: "notify", type: "webhook", when: "{{form.notify}}", url: "", message: "網站檢測警示：{{check.host}} 分數 {{check.score}}（{{check.grade}}）\n{{check.issues}}" },
    ],
  },
  {
    id: "page-monitor",
    cat: "web",
    name: "網頁變動監控",
    desc: "定期檢查公告、招生、價格、法規等網頁，內容有變動時說明改了什麼並通知你。",
    ai: "light",
    schedulable: true,
    notes: ["第一次執行只會記錄目前內容作為比較基準。", "建議按「設為定期執行」，例如每天早上 8 點檢查一次。", "只有內容真的變動時才會呼叫 AI。"],
    fields: [
      { key: "url", label: "要監控的網址", type: "url", required: true },
      { key: "notify", label: "有變動時發送通知", type: "checkbox", default: true },
    ],
    nodes: [
      { id: "fetch", type: "fetch_url", url: "{{form.url}}", mode: "full", out: "page" },
      { id: "text", type: "set", value: "{{page.markdown}}", out: "text" },
      { id: "changed", type: "condition", left: "{{text}}", op: "changed", right: "" },
      { id: "explain", type: "llm", light: true, prompt: "網頁 {{page.url}} 的內容有更新。請用繁體中文簡要說明目前頁面的重點（特別是日期、金額、名額、截止時間等）：\n\n{{text}}", out: "ai" },
      { id: "notify", type: "webhook", when: "{{form.notify}}", url: "", message: "網頁有變動：{{page.title}}\n{{page.url}}\n\n{{ai}}" },
    ],
  },
  {
    id: "news-digest",
    cat: "web",
    name: "新聞與公告摘要",
    desc: "讀取多個 RSS 訂閱（新聞、政府公告、期刊目次），整理成一份每日摘要。",
    ai: "light",
    schedulable: true,
    notes: ["大多數新聞網站、政府機關與期刊都有提供 RSS 訂閱網址（常見於網頁底部或「RSS」圖示）。", "多個來源只會呼叫一次 AI。"],
    fields: [
      { key: "feeds", label: "RSS 訂閱網址（每行一個）", type: "textarea", required: true, rows: 4 },
      { key: "days", label: "只看最近幾天", type: "number", default: 2 },
      { key: "topic", label: "關注主題（選填）", type: "text", placeholder: "例：高等教育、獎補助、資訊安全" },
      { key: "notify", label: "完成後發送通知", type: "checkbox", default: false },
    ],
    nodes: [
      { id: "rss", type: "rss", url: "{{form.feeds}}", limit: 15, sinceDays: "{{form.days}}", out: "feed" },
      { id: "digest", type: "llm", light: true, prompt: "以下是今天收集到的新聞與公告標題。請用繁體中文整理成「{{today}} 每日摘要」：依主題分類、每則一句話重點並附連結。{{form.topic}}\n若有指定關注主題，請把相關的排在最前面並標示「重點」。\n\n{{feed}}", out: "ai" },
      { id: "save", type: "save_file", source: "{{ai}}", format: "md", filename: "每日摘要-{{today}}", out: "file" },
      { id: "notify", type: "webhook", when: "{{form.notify}}", url: "", message: "{{ai}}" },
    ],
  },
  {
    id: "web-translate",
    cat: "web",
    name: "外文網頁翻譯摘要",
    desc: "貼上外文文章網址，擷取正文後產生繁體中文摘要與全文翻譯。",
    ai: "normal",
    fields: [
      { key: "url", label: "文章網址", type: "url", required: true },
      { key: "full", label: "翻譯全文（不勾選則只產生摘要）", type: "checkbox", default: true },
    ],
    nodes: [
      { id: "fetch", type: "fetch_url", url: "{{form.url}}", mode: "article", out: "page" },
      { id: "sum", type: "summarize", source: "{{page}}", style: "三到五點重點條列，使用繁體中文", out: "summary" },
      { id: "tr", type: "translate", when: "{{form.full}}", source: "{{page}}", target: "zh-TW", out: "translated" },
      { id: "join", type: "set", value: "# {{page.title}}\n\n原文：{{page.url}}\n\n## 摘要\n\n{{summary}}\n\n## 全文翻譯\n\n{{translated}}", out: "text" },
      { id: "save", type: "save_file", source: "{{text}}", format: "docx", filename: "網頁翻譯-{{today}}", out: "file" },
    ],
  },
  {
    id: "web-research",
    cat: "web",
    name: "網路研究報告",
    desc: "提出問題，由 AI 上網搜尋最新資料，整理成附來源連結的研究報告（例：各校招生政策比較、某法規最新修正）。",
    ai: "claude",
    notes: ["需要使用 Claude（網路搜尋功能）。", "每次搜尋會另外計費，可調整搜尋次數上限。", "報告附有來源連結，重要資訊請點開原始來源確認。"],
    fields: [
      { key: "question", label: "研究問題", type: "textarea", required: true, rows: 3, placeholder: "例：比較臺灣各國立大學 2026 年的數位學習政策與補助辦法" },
      { key: "searches", label: "最多搜尋次數", type: "number", default: 5 },
    ],
    nodes: [
      { id: "research", type: "web_research", prompt: "{{form.question}}\n\n請以報告形式回答：摘要、主要發現（分點並標註來源）、比較表（如適用）、結論。", maxSearches: "{{form.searches}}", out: "research" },
      { id: "save", type: "save_file", source: "{{research}}", format: "docx", filename: "研究報告-{{today}}", out: "file" },
    ],
  },
  {
    id: "site-to-kb",
    cat: "web",
    name: "網站匯入知識庫",
    desc: "爬取整個網站（例如校規、FAQ、產品說明），存入知識庫，之後可在「知識庫問答」直接提問。",
    ai: "none",
    fields: [
      { key: "url", label: "網站起始網址", type: "url", required: true },
      { key: "kb", label: "存入的知識庫", type: "kb", required: true },
      { key: "include", label: "只爬網址包含（選填）", type: "text", placeholder: "例：/faq/" },
      { key: "max", label: "最多頁數", type: "number", default: 30 },
    ],
    nodes: [
      { id: "crawl", type: "crawl", url: "{{form.url}}", maxPages: "{{form.max}}", maxDepth: 3, include: "{{form.include}}", out: "site" },
      { id: "add", type: "kb_add", kbId: "{{form.kb}}", source: "{{site}}", title: "{{form.url}}", out: "kbResult" },
    ],
  },
];

export function getService(id) {
  const s = SERVICES.find((x) => x.id === id);
  if (!s) throw Object.assign(new Error("找不到此服務"), { status: 404 });
  return s;
}

/** 檢查必填欄位，回傳錯誤訊息陣列 */
export function validateForm(service, form) {
  const errors = [];
  for (const f of service.fields) {
    const v = form?.[f.key];
    const empty = v == null || v === "" || (typeof v === "object" && !v.fileId && !v.text?.trim() && !v.url?.trim() && !v.file);
    if (f.required && empty) errors.push(`請填寫「${f.label}」`);
    if (f.type === "url" && v && !/^https?:\/\/|^[\w-]+(\.[\w-]+)+/.test(String(v).trim())) errors.push(`「${f.label}」不是有效的網址`);
  }
  return errors;
}
