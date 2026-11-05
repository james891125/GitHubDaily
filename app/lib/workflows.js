// 流程化工作引擎：每個流程由多個步驟組成，步驟之間透過 context 傳遞資料。
// 步驟類型：
//   search   —— 在 GitHubDaily 目錄中搜尋（本地，免 API）
//   pick     —— 依 ID / 名稱 / repo 指定專案
//   github   —— 透過 GitHub API 補充 stars、活躍度、README
//   llm      —— 以提示模板呼叫使用者的 LLM（支援 {{變數}}）
//   filter   —— 依 stars / 活躍度 / 年份篩選
// 模板變數：{{input}}、{{projects}}（目錄清單）、{{github}}（GitHub 資訊）、{{readme}}、{{steps.<id>}}
import { searchCatalog } from "./catalog.js";
import { getRepoInfo, getReadme, healthOf } from "./github.js";
import { generate, extractJson } from "./llm.js";

export const STEP_TYPES = {
  search: { label: "搜尋目錄", fields: ["query", "limit", "category", "year"] },
  pick: { label: "指定專案", fields: ["ids"] },
  ai_select: { label: "AI 篩選專案", fields: ["query", "pool", "count"] },
  github: { label: "GitHub 補充資訊", fields: ["readme"] },
  filter: { label: "條件篩選", fields: ["minStars", "activeOnly", "minYear", "limit"] },
  llm: { label: "LLM 處理", fields: ["system", "prompt", "maxTokens"] },
};

export function render(tpl, ctx) {
  return String(tpl || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    if (key.startsWith("steps.")) return ctx.steps[key.slice(6)] ?? "";
    const v = ctx.vars[key];
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  });
}

function projectsToText(projects, withGithub = false) {
  return projects
    .map((p, i) => {
      let s = `${i + 1}. [${p.name}](${p.url}) ｜ 分類：${p.category}（${p.year}）\n   ${p.description}`;
      if (withGithub && p.github) {
        const g = p.github;
        s += `\n   ⭐ ${g.stars} ｜ 語言：${g.language || "-"} ｜ 授權：${g.license || "-"} ｜ 最後更新：${(g.pushed_at || "").slice(0, 10)} ｜ 狀態：${p.health?.label}`;
      }
      if (p.githubError) s += `\n   （GitHub 資訊取得失敗：${p.githubError}）`;
      return s;
    })
    .join("\n");
}

function refreshVars(ctx) {
  ctx.vars.projects = projectsToText(ctx.projects, ctx.projects.some((p) => p.github));
  ctx.vars.github = projectsToText(ctx.projects, true);
  ctx.vars.readme = ctx.projects
    .filter((p) => p.readme)
    .map((p) => `===== ${p.name} README =====\n${p.readme}`)
    .join("\n\n");
  ctx.vars.count = ctx.projects.length;
}

/**
 * 執行流程。
 * @param {object} wf       { name, steps: [{ id, type, ...config }] }
 * @param {object} options  { input, catalog, llm, githubToken, emit }
 *   emit(event) —— { type: "step-start"|"step-done"|"log"|"text"|"error"|"done", ... }
 */
export async function runWorkflow(wf, { input = "", catalog, llm, githubToken, emit = () => {}, signal }) {
  const ctx = { vars: { input }, steps: {}, projects: [] };
  refreshVars(ctx);
  const outputs = [];

  for (const [i, step] of (wf.steps || []).entries()) {
    if (signal?.aborted) throw new Error("已取消");
    const id = step.id || `s${i + 1}`;
    const label = step.title || STEP_TYPES[step.type]?.label || step.type;
    emit({ type: "step-start", index: i, id, label, stepType: step.type });
    let result = "";

    switch (step.type) {
      case "search": {
        const q = render(step.query || "{{input}}", ctx);
        const found = searchCatalog(catalog, q, {
          limit: Number(step.limit) || 20,
          category: step.category || undefined,
          year: step.year || undefined,
        });
        ctx.projects = found.map((p) => ({ ...p }));
        result = `找到 ${found.length} 個專案（關鍵字：${q || "（全部）"}）`;
        break;
      }
      case "pick": {
        const raw = render(step.ids || "{{input}}", ctx);
        const keys = raw.split(/[\s,，\n]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const picked = [];
        for (const k of keys) {
          const p = catalog.find(
            (c) => String(c.id) === k || c.name.toLowerCase() === k || (c.repo || "").toLowerCase() === k,
          );
          if (p) picked.push({ ...p });
          else if (/^[\w.-]+\/[\w.-]+$/.test(k)) {
            picked.push({ id: 0, name: k.split("/")[1], repo: k, url: `https://github.com/${k}`, description: "（非 GitHubDaily 目錄中的專案）", category: "外部", year: new Date().getFullYear() });
          }
        }
        ctx.projects = picked;
        result = `已選取 ${picked.length} 個專案：${picked.map((p) => p.name).join("、")}`;
        break;
      }
      case "ai_select": {
        // 先以本地搜尋取候選池，再請 LLM 挑出最適合的專案
        const q = render(step.query || "{{input}}", ctx);
        const poolSize = Number(step.pool) || 120;
        let pool = ctx.projects.length ? ctx.projects : searchCatalog(catalog, q, { limit: poolSize });
        if (pool.length < 40 && !ctx.projects.length) {
          // 關鍵字比對太少時，補上最新收錄的專案，讓 LLM 做語意判斷
          const seen = new Set(pool.map((p) => p.id));
          for (const p of catalog) {
            if (pool.length >= poolSize) break;
            if (!seen.has(p.id)) pool.push(p);
          }
        }
        const count = Number(step.count) || 6;
        const list = pool.map((p) => `#${p.id} ${p.name}｜${p.category}｜${p.description}`).join("\n");
        const prompt = `使用者需求：${q}\n\n以下是候選開源專案（格式：#ID 名稱｜分類｜簡介）：\n${list}\n\n請挑出最符合需求的最多 ${count} 個專案，依適合程度排序。只輸出 JSON 陣列，格式：[{"id": 數字, "reason": "繁體中文的推薦理由（一句話）"}]。若沒有適合的，輸出 []。`;
        emit({ type: "log", id, message: `候選池 ${pool.length} 個，請 LLM 篩選中…` });
        const { text } = await generate(llm, { prompt, maxTokens: 4000 });
        const arr = extractJson(text);
        if (!Array.isArray(arr)) throw new Error("LLM 回傳的格式無法解析為 JSON 陣列");
        const byId = new Map(pool.map((p) => [p.id, p]));
        ctx.projects = arr
          .map((r) => (byId.get(Number(r.id)) ? { ...byId.get(Number(r.id)), reason: r.reason } : null))
          .filter(Boolean);
        result = ctx.projects.map((p, k) => `${k + 1}. ${p.name} —— ${p.reason || ""}`).join("\n") || "沒有找到合適的專案";
        break;
      }
      case "github": {
        let n = 0;
        for (const p of ctx.projects) {
          if (signal?.aborted) throw new Error("已取消");
          if (!p.repo) {
            p.githubError = "非 GitHub 連結";
            continue;
          }
          try {
            p.github = await getRepoInfo(p.repo, githubToken);
            p.health = healthOf(p.github);
            if (step.readme) p.readme = await getReadme(p.repo, githubToken, Number(step.readmeChars) || 20000);
            n++;
            emit({ type: "log", id, message: `✓ ${p.repo} ⭐${p.github.stars}` });
          } catch (e) {
            p.githubError = e.message;
            emit({ type: "log", id, message: `✗ ${p.repo}：${e.message}` });
            if (e.status === 401 || e.status === 403 || e.status === 429) {
              // 金鑰無效或額度用完：其餘專案不必再試，流程繼續往下走
              ctx.projects.forEach((q) => q.github || q.githubError || (q.githubError = e.message));
              emit({ type: "log", id, message: "已停止查詢其餘專案，流程將以目錄資料繼續。" });
              break;
            }
          }
        }
        result = `已取得 ${n}/${ctx.projects.length} 個專案的 GitHub 資訊${step.readme ? "（含 README）" : ""}`;
        break;
      }
      case "filter": {
        const before = ctx.projects.length;
        let list = ctx.projects;
        if (step.minStars) list = list.filter((p) => (p.github?.stars ?? 0) >= Number(step.minStars));
        if (step.activeOnly) list = list.filter((p) => p.health && p.health.level !== "bad");
        if (step.minYear) list = list.filter((p) => p.year >= Number(step.minYear));
        if (step.sortBy === "stars") list = [...list].sort((a, b) => (b.github?.stars ?? 0) - (a.github?.stars ?? 0));
        if (step.limit) list = list.slice(0, Number(step.limit));
        ctx.projects = list;
        result = `篩選後剩 ${list.length}/${before} 個專案`;
        break;
      }
      case "llm": {
        refreshVars(ctx);
        const prompt = render(step.prompt, ctx);
        const system = render(step.system || "你是一位資深開源技術顧問。請一律使用繁體中文回答，並以 Markdown 格式輸出。", ctx);
        const { text } = await generate(llm, { system, prompt, maxTokens: Number(step.maxTokens) || 16000 }, (delta) =>
          emit({ type: "text", id, delta }),
        );
        result = text;
        outputs.push({ id, label, text });
        break;
      }
      default:
        throw new Error(`未知的步驟類型：${step.type}`);
    }

    ctx.steps[id] = result;
    refreshVars(ctx);
    emit({
      type: "step-done",
      index: i,
      id,
      result: step.type === "llm" ? undefined : result,
      projects: ctx.projects.map(({ readme, ...rest }) => rest),
    });
  }

  const final = outputs.length ? outputs[outputs.length - 1].text : ctx.vars.projects;
  emit({ type: "done", output: final, projects: ctx.projects.map(({ readme, ...rest }) => rest) });
  return { output: final, ctx };
}

// ---- 內建流程範本 ----
export const PRESET_WORKFLOWS = [
  {
    key: "recommend",
    name: "🎯 AI 智能推薦",
    description: "描述你的需求，AI 從 3000+ 個 GitHubDaily 推薦專案中挑出最適合的，並查詢 GitHub 即時狀態。",
    inputLabel: "你想解決什麼問題？",
    inputPlaceholder: "例如：我想把影片自動加上中文字幕，最好能本地執行",
    steps: [
      { id: "pick", type: "ai_select", title: "AI 從目錄篩選", query: "{{input}}", pool: 150, count: 6 },
      { id: "gh", type: "github", title: "查詢 GitHub 狀態" },
      {
        id: "report",
        type: "llm",
        title: "產生推薦報告",
        prompt:
          "使用者需求：{{input}}\n\n候選專案（含 GitHub 即時資訊）：\n{{github}}\n\nAI 初選理由：\n{{steps.pick}}\n\n請撰寫一份推薦報告：\n1. 一句話總結最推薦哪一個及原因\n2. 以表格比較各專案（名稱、適用情境、優點、注意事項、活躍度）\n3. 給出首選專案的快速上手步驟（3-5 步）\n若有專案已封存或停滯，請明確提醒。",
      },
    ],
  },
  {
    key: "deep-dive",
    name: "🔍 專案深度分析",
    description: "讀取專案 README 與 GitHub 資訊，產生中文導讀：用途、架構、安裝步驟、適用場景與風險。",
    inputLabel: "專案名稱、目錄 ID 或 owner/repo",
    inputPlaceholder: "例如：jason5ng32/MyIP 或 MyIP",
    steps: [
      { id: "pick", type: "pick", title: "指定專案", ids: "{{input}}" },
      { id: "gh", type: "github", title: "讀取 GitHub 資訊與 README", readme: true },
      {
        id: "guide",
        type: "llm",
        title: "產生中文導讀",
        prompt:
          "請根據以下資訊，為這個開源專案撰寫一份繁體中文導讀：\n\n{{github}}\n\n{{readme}}\n\n內容包括：\n## 一句話介紹\n## 核心功能（條列）\n## 技術架構與依賴\n## 安裝與快速上手（具體指令）\n## 適用場景 / 不適用場景\n## 專案健康度與風險（授權、維護狀態、社群）\n## 類似替代方案（若你知道的話）",
      },
    ],
  },
  {
    key: "compare",
    name: "⚖️ 專案比較評估",
    description: "輸入多個專案，AI 依據 GitHub 數據與 README 產生客觀比較與選型建議。",
    inputLabel: "以逗號分隔多個專案（名稱、ID 或 owner/repo）",
    inputPlaceholder: "例如：ollama/ollama, mudler/LocalAI, lmstudio-ai/lms",
    steps: [
      { id: "pick", type: "pick", title: "指定專案", ids: "{{input}}" },
      { id: "gh", type: "github", title: "讀取 GitHub 資訊與 README", readme: true, readmeChars: 8000 },
      {
        id: "cmp",
        type: "llm",
        title: "產生比較報告",
        prompt:
          "請比較以下開源專案：\n\n{{github}}\n\n{{readme}}\n\n輸出：\n1. 比較總表（功能、技術棧、上手難度、社群活躍度、授權、適合對象）\n2. 各專案優缺點\n3. 依不同情境（個人使用／團隊導入／商業產品）給出選型建議",
      },
    ],
  },
  {
    key: "roadmap",
    name: "🗺️ 學習路線規劃",
    description: "輸入想學的技術，AI 從 GitHubDaily 收錄的教程與資源中，排出循序漸進的學習路線。",
    inputLabel: "想學什麼？目前程度如何？",
    inputPlaceholder: "例如：我會基本 Python，想在 3 個月內學會開發 LLM 應用",
    steps: [
      { id: "pick", type: "ai_select", title: "AI 挑選學習資源", query: "{{input}} 教程 学习 入门 资料", pool: 150, count: 10 },
      {
        id: "plan",
        type: "llm",
        title: "規劃學習路線",
        prompt:
          "學習目標：{{input}}\n\n可用的開源學習資源：\n{{projects}}\n\n請規劃一份分階段的學習路線（每階段包含：目標、建議時間、使用上述哪些資源、實作練習題、完成標準）。資源請以 Markdown 連結呈現，最後附上常見卡關點與建議。",
      },
    ],
  },
  {
    key: "trend",
    name: "📈 分類趨勢週報",
    description: "選擇一個分類或關鍵字，抓取專案與 GitHub 熱度，產生可直接發佈的技術週報／電子報。",
    inputLabel: "主題關鍵字",
    inputPlaceholder: "例如：AI 智能体 agent",
    steps: [
      { id: "s", type: "search", title: "搜尋目錄", query: "{{input}}", limit: 15 },
      { id: "gh", type: "github", title: "查詢 GitHub 熱度" },
      { id: "f", type: "filter", title: "排除停滯專案並依 Stars 排序", activeOnly: true, sortBy: "stars", limit: 8 },
      {
        id: "post",
        type: "llm",
        title: "撰寫週報",
        prompt:
          "主題：{{input}}\n\n本期精選專案：\n{{github}}\n\n請撰寫一篇繁體中文技術電子報：吸引人的標題、100 字導言、每個專案一段介紹（亮點、適合誰、連結），結尾附上「本期觀察」趨勢分析。語氣專業但輕鬆。",
      },
    ],
  },
  {
    key: "stack",
    name: "🧱 技術方案組合",
    description: "描述要做的產品，AI 從目錄中組合出一套可落地的開源技術方案（前端、後端、AI、部署…）。",
    inputLabel: "你要做什麼產品？",
    inputPlaceholder: "例如：一個給小團隊用的內部知識庫，可以用 AI 問答",
    steps: [
      { id: "pick", type: "ai_select", title: "AI 挑選相關元件", query: "{{input}}", pool: 200, count: 12 },
      { id: "gh", type: "github", title: "查詢 GitHub 狀態" },
      {
        id: "arch",
        type: "llm",
        title: "設計技術方案",
        prompt:
          "產品需求：{{input}}\n\n可選用的開源元件：\n{{github}}\n\n請設計一套技術方案：\n1. 架構圖（用 Mermaid flowchart）\n2. 各層選用哪個專案、為什麼\n3. 部署方式與預估資源\n4. 開發里程碑（MVP → v1）\n5. 風險與替代方案",
      },
    ],
  },
];
