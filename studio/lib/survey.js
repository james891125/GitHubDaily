// 問卷分析：讀取 Google 表單（或其他問卷）匯出的 CSV／Excel，自動判斷題型，
// 在本機計算統計並產生圖表；個人資料欄位（姓名、Email、學號…）不列入分析也不送給 AI。
import sharp from "sharp";
import ExcelJS from "exceljs";

const PERSONAL = /電子郵件|e-?mail|姓名|名字|名稱\(本名\)|學號|員工編號|電話|手機|身分證|地址|生日|line\s*id/i;
const TIMESTAMP = /時間戳記|timestamp|提交時間|填答時間|填寫時間|submitted at/i;
const DATE_LIKE = /^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}/;
const isNum = (v) => /^-?\d+(\.\d+)?$/.test(String(v).trim());

/** 判斷每一欄的題型 */
export function classify(columns, rows) {
  return columns.map((name) => {
    const vals = rows.map((r) => String(r[name] ?? "").trim()).filter(Boolean);
    const n = vals.length;
    const uniq = new Set(vals);
    if (TIMESTAMP.test(name) || (n && vals.filter((v) => DATE_LIKE.test(v)).length / n > 0.8)) return { name, type: "timestamp", n };
    if (PERSONAL.test(name)) return { name, type: "personal", n };
    // 題目字面上就是開放題（建議、意見、原因…）
    const openHint = /建議|意見|心得|想法|回饋|原因|為什麼|為何|請說明|請描述|其他想說|comment|suggest|feedback|why/i.test(name);
    if (!n) return { name, type: "empty", n };
    if (vals.every(isNum)) {
      const nums = vals.map(Number);
      const ints = nums.every(Number.isInteger);
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      if (ints && min >= 0 && max <= 10 && uniq.size <= 11) return { name, type: "scale", n, min: Math.min(min, 1), max: max <= 5 ? 5 : max <= 7 ? 7 : 10 };
      return { name, type: "number", n };
    }
    // 複選題：Google 表單以「, 」連接多個選項
    const withComma = vals.filter((v) => v.includes(", "));
    const multiShare = withComma.length / n;
    // 複選題必須出現多種不同的選項組合，避免把含逗號的意見誤判為複選
    if (!openHint && multiShare >= 0.15 && new Set(withComma).size >= 3) {
      const opts = vals.flatMap((v) => v.split(", ").map((x) => x.trim()));
      const optSet = new Set(opts);
      const avgLen = opts.reduce((a, o) => a + o.length, 0) / opts.length;
      if (optSet.size <= 25 && avgLen <= 25) return { name, type: "multi", n };
    }
    if (openHint && vals.some((v) => v.length > 8)) return { name, type: "text", n };
    if (uniq.size <= 12 || (uniq.size <= 25 && uniq.size <= n * 0.4)) return { name, type: "single", n };
    return { name, type: "text", n };
  });
}

const count = (arr) => {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()];
};
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

/** 計算各題統計 */
export function analyzeSurvey({ columns, rows }, { group } = {}) {
  const qs = classify(columns, rows);
  const total = rows.length;
  const groupQ = group ? qs.find((q) => q.name === group) : null;
  const out = [];
  for (const q of qs) {
    const vals = rows.map((r) => String(r[q.name] ?? "").trim());
    const answered = vals.filter(Boolean);
    const base = { name: q.name, type: q.type, answered: answered.length, missing: total - answered.length };
    if (q.type === "single") {
      const c = count(answered).sort((a, b) => b[1] - a[1]);
      out.push({ ...base, options: c.map(([label, n]) => ({ label, n, pct: r1((n / answered.length) * 100) })) });
    } else if (q.type === "multi") {
      const c = count(answered.flatMap((v) => v.split(", ").map((x) => x.trim()).filter(Boolean))).sort((a, b) => b[1] - a[1]);
      // 複選題百分比以「填答人數」為分母（加總會超過 100%）
      out.push({ ...base, options: c.map(([label, n]) => ({ label, n, pct: r1((n / answered.length) * 100) })) });
    } else if (q.type === "scale" || q.type === "number") {
      const nums = answered.map(Number).sort((a, b) => a - b);
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(nums.length - 1, 1));
      const median = nums.length % 2 ? nums[(nums.length - 1) / 2] : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
      const stat = { mean: r2(mean), median, sd: r2(sd), min: nums[0], max: nums.at(-1) };
      if (q.type === "scale") {
        const levels = [];
        for (let k = q.min; k <= q.max; k++) levels.push(k);
        const top2 = nums.filter((x) => x >= q.max - 1).length;
        out.push({ ...base, ...stat, scaleMax: q.max, options: levels.map((k) => ({ label: String(k), n: nums.filter((x) => x === k).length, pct: r1((nums.filter((x) => x === k).length / nums.length) * 100) })), topBox: r1((top2 / nums.length) * 100) });
      } else if (nums.every(Number.isInteger) && new Set(nums).size <= 15) {
        // 整數且種類不多（例如年齡、年級）：逐值列出
        const values = [...new Set(nums)].sort((a, b) => a - b);
        out.push({ ...base, ...stat, options: values.map((v) => ({ label: String(v), n: nums.filter((x) => x === v).length, pct: r1((nums.filter((x) => x === v).length / nums.length) * 100) })) });
      } else {
        // 數值題：分成 5–8 組
        const bins = Math.min(8, Math.max(5, Math.ceil(Math.sqrt(nums.length))));
        const w = (stat.max - stat.min) / bins || 1;
        const options = Array.from({ length: bins }, (_, i) => {
          const lo = stat.min + i * w;
          const hi = i === bins - 1 ? stat.max : lo + w;
          const n = nums.filter((x) => x >= lo && (i === bins - 1 ? x <= hi : x < hi)).length;
          return { label: `${r1(lo)}–${r1(hi)}`, n, pct: r1((n / nums.length) * 100) };
        });
        out.push({ ...base, ...stat, options });
      }
    } else if (q.type === "text") {
      out.push({ ...base, responses: answered });
    } else out.push(base);
  }
  // 分組比較：量表題的平均、單選題的分布
  let groups = null;
  if (groupQ && ["single"].includes(groupQ.type)) {
    const gNames = [...new Set(rows.map((r) => String(r[groupQ.name] ?? "").trim()).filter(Boolean))].sort();
    groups = { by: groupQ.name, names: gNames, tables: [] };
    for (const q of out.filter((x) => (x.type === "scale" || x.type === "number") && x.name !== groupQ.name)) {
      groups.tables.push({
        question: q.name,
        kind: "mean",
        rows: gNames.map((g) => {
          const nums = rows.filter((r) => String(r[groupQ.name]).trim() === g).map((r) => String(r[q.name] ?? "").trim()).filter(isNum).map(Number);
          const mean = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
          return { group: g, n: nums.length, mean: mean === null ? null : r2(mean) };
        }),
      });
    }
  }
  const personal = qs.filter((q) => q.type === "personal").map((q) => q.name);
  return { total, questions: out, groups, personal };
}

// ---------------- 圖表（SVG） ----------------
const FONT = "Microsoft JhengHei, PingFang TC, Noto Sans CJK TC, WenQuanYi Zen Hei, sans-serif";
const INK = "#222a33";
const MUTED = "#5f6b78";
const GRID = "#e3e7ec";
const BAR = "#2a6299"; // 已通過 dataviz 色彩驗證（淺色底）
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const textWidth = (s) => [...String(s)].reduce((w, ch) => w + (/[⺀-￿]/.test(ch) ? 14 : 8), 0);
const clip = (s, max) => {
  let out = "";
  let w = 0;
  for (const ch of String(s)) {
    w += /[⺀-￿]/.test(ch) ? 14 : 8;
    if (w > max) return out + "…";
    out += ch;
  }
  return out;
};

/** 水平長條圖（單選、複選）；4px 圓角只在資料端、條與條間隔 2px 以上 */
export function barChartH(options, { title = "", pctLabel = "%" } = {}) {
  const items = options.slice(0, 15);
  const labelW = Math.min(220, Math.max(60, ...items.map((o) => textWidth(o.label)))) + 16;
  const width = 720;
  const plotW = width - labelW - 90;
  const rowH = 30;
  const barH = 18;
  const top = title ? 36 : 12;
  const height = top + items.length * rowH + 28;
  const max = Math.max(...items.map((o) => o.pct), 1);
  // 刻度取整數（10% 或 20% 一格）
  const scaleMax = max > 50 ? 100 : Math.max(10, Math.ceil(max / 10) * 10);
  const step = scaleMax > 50 ? 20 : 10;
  const x = (p) => labelW + (p / scaleMax) * plotW;
  const grid = Array.from({ length: scaleMax / step + 1 }, (_, k) => k * step).map((v) => {
    const gx = x(v);
    return `<line x1="${gx}" y1="${top - 4}" x2="${gx}" y2="${top + items.length * rowH}" stroke="${GRID}" stroke-width="1"/><text x="${gx}" y="${top + items.length * rowH + 16}" font-size="11" fill="${MUTED}" text-anchor="middle">${v}${pctLabel}</text>`;
  });
  const bars = items.map((o, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    const w = Math.max(x(o.pct) - labelW, o.n ? 2 : 0);
    const rad = Math.min(4, w / 2);
    // 只有資料端（右側）是圓角，基線端維持直角
    const path = w > 0 ? `M${labelW},${y} H${labelW + w - rad} Q${labelW + w},${y} ${labelW + w},${y + rad} V${y + barH - rad} Q${labelW + w},${y + barH} ${labelW + w - rad},${y + barH} H${labelW} Z` : "";
    return `<g><title>${esc(o.label)}：${o.n}（${o.pct}%）</title><text x="${labelW - 10}" y="${y + barH / 2 + 5}" font-size="13" fill="${INK}" text-anchor="end">${esc(clip(o.label, labelW - 16))}</text>${path ? `<path d="${path}" fill="${BAR}"/>` : ""}<text x="${labelW + w + 6}" y="${y + barH / 2 + 5}" font-size="12" fill="${INK}">${o.n}（${o.pct}%）</text></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}"><rect width="100%" height="100%" fill="#ffffff"/>${title ? `<text x="12" y="22" font-size="15" font-weight="700" fill="${INK}">${esc(clip(title, width - 24))}</text>` : ""}${grid.join("")}${bars.join("")}</svg>`;
}

/** 垂直長條圖（量表分布、數值分組） */
export function barChartV(options, { title = "" } = {}) {
  const width = 720;
  const top = title ? 40 : 16;
  const plotH = 200;
  const left = 46;
  const n = options.length;
  const slot = (width - left - 20) / n;
  const barW = Math.min(64, slot - 8);
  const height = top + plotH + 46;
  const max = Math.max(...options.map((o) => o.pct), 1);
  const scaleMax = Math.ceil(max / 10) * 10;
  const y = (p) => top + plotH - (p / scaleMax) * plotH;
  const grid = [0, 0.5, 1].map((f) => `<line x1="${left}" y1="${y(f * scaleMax)}" x2="${width - 20}" y2="${y(f * scaleMax)}" stroke="${GRID}"/><text x="${left - 6}" y="${y(f * scaleMax) + 4}" font-size="11" fill="${MUTED}" text-anchor="end">${Math.round(f * scaleMax)}%</text>`);
  const bars = options.map((o, i) => {
    const cx = left + slot * i + slot / 2;
    const h = top + plotH - y(o.pct);
    const x0 = cx - barW / 2;
    const yt = y(o.pct);
    const rad = Math.min(4, h / 2, barW / 2);
    const path = h > 0 ? `M${x0},${top + plotH} V${yt + rad} Q${x0},${yt} ${x0 + rad},${yt} H${x0 + barW - rad} Q${x0 + barW},${yt} ${x0 + barW},${yt + rad} V${top + plotH} Z` : "";
    return `<g><title>${esc(o.label)}：${o.n}（${o.pct}%）</title>${path ? `<path d="${path}" fill="${BAR}"/>` : ""}<text x="${cx}" y="${yt - 6}" font-size="12" fill="${INK}" text-anchor="middle">${o.n}</text><text x="${cx}" y="${top + plotH + 18}" font-size="12" fill="${INK}" text-anchor="middle">${esc(clip(o.label, slot - 4))}</text><text x="${cx}" y="${top + plotH + 34}" font-size="11" fill="${MUTED}" text-anchor="middle">${o.pct}%</text></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}"><rect width="100%" height="100%" fill="#ffffff"/>${title ? `<text x="12" y="24" font-size="15" font-weight="700" fill="${INK}">${esc(clip(title, width - 24))}</text>` : ""}${grid.join("")}<line x1="${left}" y1="${top + plotH}" x2="${width - 20}" y2="${top + plotH}" stroke="${MUTED}"/>${bars.join("")}</svg>`;
}

export function chartFor(q) {
  if (q.type === "scale" || q.type === "number") return barChartV(q.options, { title: q.name });
  if (q.type === "single" || q.type === "multi") return barChartH(q.options, { title: q.name });
  return null;
}

export const svgToPng = (svg) => sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();

// ---------------- 報告 ----------------
const TYPE_NAME = { single: "單選題", multi: "複選題", scale: "量表題", number: "數值題", text: "開放題", personal: "個人資料（不分析）", timestamp: "時間", empty: "無資料" };

/** Markdown 報告（圖表以 chart:N 參照，由 Word／HTML 輸出時置換為圖片） */
export function surveyMarkdown(a, { title = "問卷分析報告", narrative = "", openSummary = "" } = {}) {
  const L = [`# ${title}`, "", `- 有效問卷：${a.total} 份`, a.personal.length ? `- 以下個人資料欄位未列入分析：${a.personal.join("、")}` : "", ""];
  if (narrative) L.push("## 分析摘要", "", narrative, "");
  L.push("## 題目一覽", "", "| 題目 | 題型 | 填答數 |", "|---|---|---|");
  for (const q of a.questions.filter((x) => !["personal", "timestamp", "empty"].includes(x.type))) L.push(`| ${q.name.replace(/\|/g, "／")} | ${TYPE_NAME[q.type]} | ${q.answered} |`);
  L.push("");
  let fig = 0;
  let tab = 0;
  for (const [i, q] of a.questions.entries()) {
    if (["personal", "timestamp", "empty"].includes(q.type)) continue;
    L.push(`## ${q.name}`, "", `${TYPE_NAME[q.type]}，填答 ${q.answered} 人${q.missing ? `（未填 ${q.missing} 人）` : ""}。`, "");
    if (q.type === "scale") L.push(`平均 ${q.mean}（滿分 ${q.scaleMax}），中位數 ${q.median}，標準差 ${q.sd}；給 ${q.scaleMax - 1} 分以上者占 ${q.topBox}%。`, "");
    if (q.type === "number") L.push(`平均 ${q.mean}，中位數 ${q.median}，標準差 ${q.sd}，範圍 ${q.min}–${q.max}。`, "");
    if (q.type === "multi") L.push("（複選題：百分比以填答人數為分母，加總可能超過 100%。）", "");
    if (q.options) {
      tab++;
      L.push(`表${tab} ${q.name}`, "", "| 選項 | 人數 | 百分比 |", "|---|---|---|", ...q.options.map((o) => `| ${String(o.label).replace(/\|/g, "／")} | ${o.n} | ${o.pct}% |`), "");
      fig++;
      L.push(`![圖${fig} ${q.name}](chart:${i})`, "");
    }
    if (q.type === "text") {
      L.push(`共 ${q.responses.length} 則意見${q.responses.length > 20 ? "，以下列出前 20 則（完整內容請見 Excel 檔）" : ""}：`, "");
      for (const r of q.responses.slice(0, 20)) L.push(`- ${r.replace(/\n+/g, " ")}`);
      L.push("");
    }
  }
  if (openSummary) L.push("## 開放題意見歸納", "", openSummary, "");
  if (a.groups?.tables.length) {
    L.push(`## 分組比較：依「${a.groups.by}」`, "");
    for (const t of a.groups.tables) L.push(`### ${t.question}`, "", `| ${a.groups.by} | 人數 | 平均 |`, "|---|---|---|", ...t.rows.map((r) => `| ${r.group} | ${r.n} | ${r.mean ?? "—"} |`), "");
  }
  return L.filter((x) => x !== null).join("\n");
}

/** 只含統計結果（不含原始資料與個資），給 AI 撰寫分析摘要 */
export function statsForAI(a) {
  return a.questions
    .filter((q) => q.options)
    .map((q) => `【${q.name}】${TYPE_NAME[q.type]}，填答 ${q.answered} 人${q.mean !== undefined ? `，平均 ${q.mean}` : ""}\n${q.options.map((o) => `${o.label}：${o.n}（${o.pct}%）`).join("；")}`)
    .concat(a.groups?.tables.map((t) => `【分組：${t.question}，依${a.groups.by}】${t.rows.map((r) => `${r.group} 平均 ${r.mean}（${r.n} 人）`).join("；")}`) || [])
    .join("\n\n");
}

export function openAnswersForAI(a) {
  return a.questions
    .filter((q) => q.type === "text")
    .map((q) => `【${q.name}】（${q.responses.length} 則）\n${q.responses.map((r) => "- " + r.replace(/\n+/g, " ").slice(0, 300)).join("\n")}`)
    .join("\n\n");
}

export async function surveyXlsx(a) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("統計結果");
  ws.columns = [{ header: "題目", key: "q", width: 36 }, { header: "題型", key: "t", width: 10 }, { header: "選項／統計量", key: "o", width: 30 }, { header: "人數", key: "n", width: 10 }, { header: "百分比", key: "p", width: 10 }];
  ws.getRow(1).font = { bold: true };
  for (const q of a.questions) {
    if (q.options) for (const o of q.options) ws.addRow({ q: q.name, t: TYPE_NAME[q.type], o: o.label, n: o.n, p: o.pct / 100 });
    if (q.mean !== undefined) for (const [k, v] of [["平均", q.mean], ["中位數", q.median], ["標準差", q.sd]]) ws.addRow({ q: q.name, t: TYPE_NAME[q.type], o: k, n: v });
  }
  ws.getColumn("p").numFmt = "0.0%";
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const texts = a.questions.filter((q) => q.type === "text");
  if (texts.length) {
    const ws2 = wb.addWorksheet("開放題意見");
    ws2.columns = [{ header: "題目", key: "q", width: 30 }, { header: "意見", key: "r", width: 80 }];
    ws2.getRow(1).font = { bold: true };
    for (const q of texts) for (const r of q.responses) ws2.addRow({ q: q.name, r });
    ws2.getColumn("r").alignment = { wrapText: true, vertical: "top" };
  }
  if (a.groups?.tables.length) {
    const ws3 = wb.addWorksheet("分組比較");
    ws3.addRow(["題目", a.groups.by, "人數", "平均"]).font = { bold: true };
    for (const t of a.groups.tables) for (const r of t.rows) ws3.addRow([t.question, r.group, r.n, r.mean]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 可直接用瀏覽器開啟、列印的 HTML 報告（圖表為內嵌 SVG，含滑鼠提示） */
export function surveyHtml(a, markdownHtml) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>問卷分析報告</title>
<style>body{font-family:${FONT};max-width:820px;margin:24px auto;padding:0 16px;color:#222a33;background:#fff;line-height:1.7}h1{border-left:5px solid #2a6299;padding-left:10px}h2{border-bottom:1px solid #c5d0dc;padding-bottom:2px;margin-top:32px}table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid #c5d0dc;padding:4px 10px;text-align:left}th{background:#eef2f7}svg{max-width:100%;height:auto;display:block;margin:8px 0}@media print{h2{break-before:auto}svg{break-inside:avoid}}</style></head><body>${markdownHtml}</body></html>`;
}
