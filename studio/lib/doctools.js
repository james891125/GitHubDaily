// 文件處理工具：翻譯、摘要、表格擷取、匯出 CSV / Excel
import ExcelJS from "exceljs";
import { generate, generateJson } from "./llm.js";
import { splitForProcessing } from "./docs.js";

const LANGS = {
  "zh-TW": "繁體中文（台灣用語）",
  "zh-CN": "简体中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
};
export const LANGUAGES = LANGS;

/**
 * 分段翻譯長文件，保留 Markdown 格式。
 * onProgress({done,total,partial}) 每完成一段呼叫一次；onText 傳出即時文字。
 */
export async function translate(text, { target = "zh-TW", glossary = "", onProgress = () => {}, onText = () => {}, signal } = {}) {
  const parts = splitForProcessing(text, 5000);
  const lang = LANGS[target] || target;
  const out = [];
  for (const [i, part] of parts.entries()) {
    if (signal?.aborted) throw new Error("已取消");
    const prompt =
      `請將以下內容翻譯成${lang}。要求：\n- 保留原本的 Markdown 結構、程式碼區塊、連結與數字\n- 專有名詞第一次出現時可附原文\n- 只輸出譯文，不要任何說明` +
      (glossary ? `\n- 依照此術語表翻譯：\n${glossary}` : "") +
      `\n\n---\n${part}`;
    const { text: t } = await generate({ prompt, maxTokens: 16000 }, onText, signal);
    out.push(t.trim());
    onText("\n\n");
    onProgress({ done: i + 1, total: parts.length });
  }
  return out.join("\n\n");
}

/** Map-reduce 摘要：長文先分段摘要，再整合 */
export async function summarize(text, { style = "重點條列", length = "中等", onText = () => {}, onProgress = () => {}, signal } = {}) {
  const parts = splitForProcessing(text, 12000);
  let material = text;
  if (parts.length > 1) {
    const notes = [];
    for (const [i, p] of parts.entries()) {
      if (signal?.aborted) throw new Error("已取消");
      const { text: n } = await generate({ prompt: `以下是一份長文件的第 ${i + 1}/${parts.length} 部分。請用繁體中文條列出此部分所有重要事實、數據、結論（不要遺漏數字）：\n\n${p}`, maxTokens: 4000 }, undefined, signal);
      notes.push(`### 第 ${i + 1} 部分\n${n}`);
      onProgress({ done: i + 1, total: parts.length + 1 });
    }
    material = notes.join("\n\n");
  }
  const prompt = `請以繁體中文為以下內容撰寫摘要。\n風格：${style}\n長度：${length}\n請包含：一句話總結、重點、關鍵數據、待辦或建議（若有）。使用 Markdown。\n\n${material}`;
  const { text: result } = await generate({ prompt, maxTokens: 8000 }, onText, signal);
  onProgress({ done: parts.length + 1, total: parts.length + 1 });
  return result;
}

/**
 * 依使用者描述的欄位，從文字中擷取結構化資料。
 * @returns {Promise<{columns:string[], rows:Array<Record<string,string>>}>}
 */
export async function extractTable(text, { fields = "", instruction = "", onProgress = () => {}, signal } = {}) {
  const parts = splitForProcessing(text, 10000);
  let columns = fields
    .split(/[,，、\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const rows = [];
  for (const [i, p] of parts.entries()) {
    if (signal?.aborted) throw new Error("已取消");
    const colHint = columns.length ? `欄位固定為：${JSON.stringify(columns)}` : "請自行判斷最合適的欄位（第一段決定後就沿用）";
    const data = await generateJson(
      `從以下內容中擷取所有符合條件的資料列。${colHint}。${instruction ? "條件／說明：" + instruction : ""}\n輸出格式：{"columns":[...],"rows":[{欄位:值,...}]}。找不到值的欄位填空字串，不要捏造。\n\n內容：\n${p}`,
      { signal },
    );
    if (!columns.length && Array.isArray(data.columns)) columns = data.columns.map(String);
    for (const r of data.rows || []) rows.push(r);
    onProgress({ done: i + 1, total: parts.length });
  }
  if (!columns.length && rows.length) columns = Object.keys(rows[0]);
  return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] == null ? "" : String(r[c])]))) };
}

export function toCsv({ columns, rows }) {
  const q = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // 加 BOM，讓 Excel 正確顯示中文
  return "﻿" + [columns.map(q).join(","), ...rows.map((r) => columns.map((c) => q(r[c])).join(","))].join("\r\n");
}

export async function toXlsx({ columns, rows }, sheetName = "資料") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.min(60, Math.max(10, c.length * 2 + 4)) }));
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toMarkdownTable({ columns, rows }) {
  const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${columns.map(esc).join(" | ")} |`, `|${columns.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${columns.map((c) => esc(r[c])).join(" | ")} |`)].join("\n");
}
