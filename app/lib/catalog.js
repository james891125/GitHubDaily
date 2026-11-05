// 解析 GitHubDaily 倉庫中的年度 Markdown（README.md = 2025，20xx.md = 各年度），
// 產生統一格式的專案目錄。
import fs from "node:fs";
import path from "node:path";

const ROW_RE = /^\s*\[([^\]]+)\]\(([^)\s]+)\)\s*\|\s*(.+)$/;
const GH_RE = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i;

/** 從 Markdown 表格的一列中取出描述欄（第二欄），並清掉 HTML / 圖片徽章。 */
function cleanDescription(rest) {
  const cells = rest.split("|").map((c) => c.trim());
  let desc = cells[0] || "";
  desc = desc
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
  return desc;
}

export function parseRepoFromUrl(url) {
  const m = GH_RE.exec(url || "");
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, "");
  if (["orgs", "topics", "collections", "sponsors", "features", "marketplace"].includes(owner.toLowerCase())) return null;
  return `${owner}/${repo}`;
}

/** 解析單一 Markdown 文字。year: 數字。 */
export function parseMarkdown(text, year) {
  const items = [];
  let category = null;
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const h2 = /^##\s+(.+)/.exec(line);
    if (h2 && !line.startsWith("###")) {
      inSection = /复盘/.test(h2[1]);
      category = null;
      continue;
    }
    const h3 = /^###\s+(.+)/.exec(line);
    if (h3) {
      category = h3[1].trim();
      if (category === "目录") category = null;
      continue;
    }
    if (!inSection || !category) continue;
    const m = ROW_RE.exec(line);
    if (!m) continue;
    const [, name, url, rest] = m;
    const description = cleanDescription(rest);
    if (!description) continue;
    items.push({
      name: name.trim(),
      url: url.trim(),
      repo: parseRepoFromUrl(url),
      description,
      category,
      year,
    });
  }
  return items;
}

/** 讀取倉庫根目錄所有年度檔案。 */
export function loadCatalog(rootDir) {
  const files = fs.readdirSync(rootDir).filter((f) => /^(README|20\d\d)\.md$/.test(f));
  const all = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(rootDir, f), "utf8");
    let year;
    if (f === "README.md") {
      const m = /##\s*(20\d\d)\s*年复盘/.exec(text);
      year = m ? Number(m[1]) : new Date().getFullYear();
    } else {
      year = Number(f.slice(0, 4));
    }
    all.push(...parseMarkdown(text, year));
  }
  // 去重：同一 URL 只保留最新年份
  const byKey = new Map();
  for (const it of all) {
    const key = (it.repo || it.url).toLowerCase();
    const prev = byKey.get(key);
    if (!prev || it.year > prev.year) byKey.set(key, it);
  }
  const list = [...byKey.values()].sort((a, b) => b.year - a.year || a.name.localeCompare(b.name));
  list.forEach((it, i) => (it.id = i + 1));
  return list;
}

// ---- 本地關鍵字搜尋（不需 API）----

function tokenize(q) {
  const s = (q || "").toLowerCase();
  const tokens = new Set(s.split(/[\s,，、。;；/|+]+/).filter(Boolean));
  // 中文：加入 2-gram，讓「影片剪輯」也能比對「视频剪辑」以外的近似詞
  const han = s.replace(/[^一-鿿]/g, "");
  for (let i = 0; i < han.length - 1; i++) tokens.add(han.slice(i, i + 2));
  return [...tokens];
}

// 常見繁簡對照（目錄內容為簡體），讓繁體使用者也能搜尋
const T2S = {
  "體": "体", "發": "发", "開": "开", "源": "源", "專": "专", "項": "项", "編": "编", "輯": "辑",
  "視": "视", "頻": "频", "圖": "图", "語": "语", "書": "书", "學": "学", "習": "习", "資": "资",
  "料": "料", "數": "数", "據": "据", "庫": "库", "網": "网", "頁": "页", "爬": "爬", "蟲": "虫",
  "機": "机", "器": "器", "應": "应", "產": "产", "測": "测", "試": "试", "實": "实", "現": "现",
  "線": "线", "設": "设", "計": "计", "檔": "档", "檢": "检", "辨": "辨", "識": "识", "轉": "转",
  "換": "换", "錄": "录", "製": "制", "畫": "画", "聲": "声", "識": "识", "讀": "读", "寫": "写",
  "譯": "译", "翻": "翻", "雲": "云", "端": "端", "務": "务", "門": "门", "戶": "户", "後": "后",
  "臺": "台", "台": "台", "績": "绩", "效": "效", "監": "监", "控": "控", "價": "价", "格": "格",
  "筆": "笔", "記": "记", "簡": "简", "歷": "历", "腦": "脑", "電": "电", "動": "动", "畫": "画",
  "遊": "游", "戲": "戏", "聊": "聊", "天": "天", "對": "对", "話": "话", "模": "模", "型": "型",
  "訓": "训", "練": "练", "優": "优", "化": "化", "壓": "压", "縮": "缩", "載": "载", "下": "下",
  "瀏": "浏", "覽": "览", "擴": "扩", "展": "展", "插": "插", "件": "件", "幣": "币", "區": "区",
  "塊": "块", "鏈": "链", "與": "与", "為": "为", "這": "这", "個": "个", "們": "们", "說": "说",
  "問": "问", "題": "题", "答": "答", "協": "协", "作": "作", "團": "团", "隊": "队", "管": "管",
  "理": "理", "統": "统", "搜": "搜", "尋": "寻", "索": "索", "郵": "邮", "傳": "传", "輸": "输",
  "濾": "滤", "鏡": "镜", "頭": "头", "像": "像", "臉": "脸", "辦": "办", "公": "公", "務": "务",
  "財": "财", "經": "经", "股": "股", "票": "票", "幫": "帮", "助": "助", "自": "自", "動": "动",
};
export function toSimplified(s) {
  return (s || "").replace(/[一-鿿]/g, (c) => T2S[c] || c);
}

export function searchCatalog(catalog, query, { limit = 50, category, year } = {}) {
  const tokens = tokenize(toSimplified(query));
  const results = [];
  for (const it of catalog) {
    if (category && it.category !== category) continue;
    if (year && it.year !== Number(year)) continue;
    if (!tokens.length) {
      results.push({ item: it, score: 0 });
      continue;
    }
    const name = it.name.toLowerCase();
    const desc = it.description.toLowerCase();
    const cat = it.category.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (name === t) score += 12;
      else if (name.includes(t)) score += 6;
      if (cat.includes(t)) score += 3;
      if (desc.includes(t)) score += t.length >= 2 ? 2 : 1;
    }
    if (score > 0) results.push({ item: it, score: score + (it.year - 2017) * 0.05 });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map((r) => r.item);
}

export function catalogStats(catalog) {
  const years = {};
  const categories = {};
  for (const it of catalog) {
    years[it.year] = (years[it.year] || 0) + 1;
    categories[it.category] = (categories[it.category] || 0) + 1;
  }
  return { total: catalog.length, years, categories };
}
