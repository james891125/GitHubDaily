// 名單整理與比對（不使用 AI）：比對兩份名單、合併多份名單、去除重複、依欄位分組。
// 比對時可忽略空白、全半形、英文大小寫、電話與身分證的格式差異。
import ExcelJS from "exceljs";

const userError = (m) => Object.assign(new Error(m), { status: 422 });

/** 正規化：全形轉半形、去空白、英文小寫；電話只留數字 */
export function normalize(v, { loose = true } = {}) {
  let s = String(v ?? "").trim();
  if (!loose) return s;
  s = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, " ");
  s = s.replace(/\s+/g, "").toLowerCase();
  if (/^[\d\-()+#]{8,}$/.test(s)) s = s.replace(/\D/g, "").replace(/^886/, "0");
  return s;
}

const KEY_PRIORITY = [/^學號$/, /身分證|身份證/, /^(e-?mail|電子郵件|email)/i, /員工編號|職員編號|人員代號/, /^(帳號|帳戶|id)$/i, /^(姓名|名字|name)$/i];

/** 自動挑選比對欄位：兩份名單都有、且依常見的唯一識別欄位優先 */
export function guessKey(colsA, colsB) {
  const common = colsA.filter((c) => colsB.includes(c));
  for (const re of KEY_PRIORITY) {
    const k = common.find((c) => re.test(c.trim()));
    if (k) return [k];
  }
  return common.length ? [common[0]] : [];
}

function parseKeys(spec, columns, label) {
  const keys = String(spec || "")
    .split(/[,，、\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  const missing = keys.filter((k) => !columns.includes(k));
  if (missing.length) throw userError(`${label}找不到欄位：${missing.map((k) => `「${k}」`).join("、")}。可用的欄位：${columns.join("、")}`);
  return keys;
}

const keyOf = (row, keys, loose) => keys.map((k) => normalize(row[k], { loose })).join("\u0001");

/**
 * 比對兩份名單
 * @returns {{ keys, onlyA, onlyB, both, changed: Array<{a,b,diffs}>, dupA, dupB }}
 */
export function compareLists(A, B, { keys: spec = "", loose = true } = {}) {
  let keys = spec ? parseKeys(spec, A.columns, "第一份名單") : guessKey(A.columns, B.columns);
  if (spec) parseKeys(spec, B.columns, "第二份名單");
  if (!keys.length) throw userError(`兩份名單沒有相同名稱的欄位可以比對。第一份：${A.columns.join("、")}；第二份：${B.columns.join("、")}。請在「比對欄位」指定，或讓兩份名單的欄位名稱一致`);
  const index = (T) => {
    const m = new Map();
    const dup = [];
    for (const r of T.rows) {
      const k = keyOf(r, keys, loose);
      if (!k.replace(/\u0001/g, "")) continue;
      if (m.has(k)) dup.push(r);
      else m.set(k, r);
    }
    return { m, dup };
  };
  const ia = index(A);
  const ib = index(B);
  const common = A.columns.filter((c) => B.columns.includes(c) && !keys.includes(c));
  const onlyA = [];
  const both = [];
  const changed = [];
  for (const [k, a] of ia.m) {
    const b = ib.m.get(k);
    if (!b) onlyA.push(a);
    else {
      both.push({ a, b });
      const diffs = common.filter((c) => normalize(a[c], { loose }) !== normalize(b[c], { loose })).map((c) => ({ col: c, a: a[c] ?? "", b: b[c] ?? "" }));
      if (diffs.length) changed.push({ a, b, diffs });
    }
  }
  const onlyB = [...ib.m].filter(([k]) => !ia.m.has(k)).map(([, b]) => b);
  return { keys, onlyA, onlyB, both, changed, dupA: ia.dup, dupB: ib.dup, common };
}

/** 合併多份名單：欄位依名稱對齊，加上「來源檔案」欄 */
export function mergeLists(tables, { source = true } = {}) {
  const columns = [];
  for (const t of tables) for (const c of t.columns) if (!columns.includes(c)) columns.push(c);
  if (source) columns.unshift("來源檔案");
  const rows = tables.flatMap((t) => t.rows.filter((r) => Object.values(r).some((v) => String(v).trim())).map((r) => ({ ...(source ? { 來源檔案: t.name } : {}), ...r })));
  return { columns, rows };
}

/** 去除重複：依指定欄位（空白則整列相同才算重複），保留第一筆 */
export function dedupe(table, { keys: spec = "", loose = true } = {}) {
  const keys = spec ? parseKeys(spec, table.columns, "名單") : table.columns.filter((c) => c !== "來源檔案");
  const seen = new Map();
  const kept = [];
  const removed = [];
  for (const r of table.rows) {
    const k = keyOf(r, keys, loose);
    if (!k.replace(/\u0001/g, "")) {
      kept.push(r);
      continue;
    }
    if (seen.has(k)) removed.push({ ...r, 與第幾筆重複: seen.get(k) + 1 });
    else {
      seen.set(k, kept.length);
      kept.push(r);
    }
  }
  return { keys, kept, removed };
}

/** 依欄位分組 */
export function splitBy(table, col) {
  if (!table.columns.includes(col)) throw userError(`找不到分組欄位「${col}」。可用的欄位：${table.columns.join("、")}`);
  const groups = new Map();
  for (const r of table.rows) {
    const g = String(r[col] ?? "").trim() || "（未填）";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  if (groups.size > 200) throw userError(`「${col}」有 ${groups.size} 種不同的值，分組太多，請改用其他欄位`);
  return groups;
}

// ---------------- Excel 輸出 ----------------
const safeSheet = (n, used) => {
  let s = String(n).replace(/[\\/?*[\]:]/g, "_").slice(0, 28) || "工作表";
  let k = 2;
  const base = s;
  while (used.has(s)) s = `${base.slice(0, 25)}(${k++})`;
  used.add(s);
  return s;
};

export async function toWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  const used = new Set();
  for (const sh of sheets) {
    const ws = wb.addWorksheet(safeSheet(sh.name, used));
    ws.addRow(sh.columns);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EFF7" } };
    for (const r of sh.rows) {
      const row = ws.addRow(sh.columns.map((c) => r[c] ?? ""));
      if (sh.highlight) for (const c of sh.highlight(r) || []) row.getCell(sh.columns.indexOf(c) + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF0C2" } };
    }
    ws.columns.forEach((col, i) => {
      const len = Math.max(...[sh.columns[i], ...sh.rows.slice(0, 200).map((r) => r[sh.columns[i]] ?? "")].map((v) => [...String(v)].reduce((a, ch) => a + (/[⺀-￿]/.test(ch) ? 2 : 1), 0)));
      col.width = Math.min(50, Math.max(8, len + 2));
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (sh.rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sh.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 比對結果 → Excel 與摘要 */
export async function compareReport(A, B, r) {
  const diffCols = [...r.keys, ...r.common.flatMap((c) => [`${c}（${A.name}）`, `${c}（${B.name}）`])];
  const changedRows = r.changed.map(({ a, b, diffs }) => {
    const o = Object.fromEntries(r.keys.map((k) => [k, a[k]]));
    for (const c of r.common) {
      o[`${c}（${A.name}）`] = a[c] ?? "";
      o[`${c}（${B.name}）`] = b[c] ?? "";
    }
    o.__diff = diffs.map((d) => d.col);
    return o;
  });
  const sheets = [
    { name: `只在「${A.name}」`, columns: A.columns, rows: r.onlyA },
    { name: `只在「${B.name}」`, columns: B.columns, rows: r.onlyB },
    { name: "兩份都有", columns: [...A.columns, ...B.columns.filter((c) => !A.columns.includes(c))], rows: r.both.map(({ a, b }) => ({ ...b, ...a })) },
  ];
  if (r.common.length) sheets.push({ name: "資料不一致", columns: diffCols, rows: changedRows, highlight: (o) => o.__diff.flatMap((c) => [`${c}（${A.name}）`, `${c}（${B.name}）`]) });
  if (r.dupA.length || r.dupB.length) sheets.push({ name: "名單內重複", columns: ["名單", ...A.columns], rows: [...r.dupA.map((x) => ({ 名單: A.name, ...x })), ...r.dupB.map((x) => ({ 名單: B.name, ...x }))] });
  const show = (rows, T) =>
    rows
      .slice(0, 30)
      .map((x) => `- ${r.keys.map((k) => x[k]).join("／")}${T.columns.filter((c) => !r.keys.includes(c)).slice(0, 2).map((c) => (x[c] ? `（${x[c]}）` : "")).join("")}`)
      .join("\n") + (rows.length > 30 ? `\n- …共 ${rows.length} 筆，完整清單請見 Excel` : "");
  const md = [
    `# 名單比對結果`,
    "",
    `- 比對欄位：${r.keys.join("、")}（${"忽略空白、全半形、大小寫"}）`,
    `- 「${A.name}」${A.rows.length} 筆、「${B.name}」${B.rows.length} 筆`,
    `- 兩份都有：${r.both.length} 筆；只在「${A.name}」：${r.onlyA.length} 筆；只在「${B.name}」：${r.onlyB.length} 筆${r.common.length ? `；資料不一致：${r.changed.length} 筆` : ""}`,
    r.dupA.length || r.dupB.length ? `- 名單內有重複：「${A.name}」${r.dupA.length} 筆、「${B.name}」${r.dupB.length} 筆` : null,
    "",
    r.onlyA.length ? `## 只在「${A.name}」（例如：應繳未繳、未報到）\n\n${show(r.onlyA, A)}\n` : null,
    r.onlyB.length ? `## 只在「${B.name}」\n\n${show(r.onlyB, B)}\n` : null,
    r.changed.length ? `## 資料不一致\n\n${r.changed.slice(0, 30).map((c) => `- ${r.keys.map((k) => c.a[k]).join("／")}：${c.diffs.map((d) => `${d.col}「${d.a}」→「${d.b}」`).join("；")}`).join("\n")}\n` : null,
  ]
    .filter((x) => x !== null)
    .join("\n");
  return { xlsx: await toWorkbook(sheets), markdown: md };
}
