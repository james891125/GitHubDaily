// 合併列印：Excel／CSV 名單 + Word 範本 → 每人一份 Word（ZIP）、合併成一個 Word，或合併成一個 PDF。
// 範本中的欄位可寫成 {{姓名}}、«姓名»，也支援 Word 內建「合併列印」插入的 MERGEFIELD 功能變數。
// 格式：{{日期|民國}} → 115年3月5日、{{金額|千分位}} → 12,000、{{金額|國字}} → 壹萬貳仟元整
import JSZip from "jszip";

const userError = (m) => Object.assign(new Error(m), { status: 422 });
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const xmlUnesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const PLACEHOLDER = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]+?)\s*)?\}\}|«([^»|]+?)(?:\|([^»]+))?»/g;
const PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

// ---------- 值的格式 ----------
const BIG = "零壹貳參肆伍陸柒捌玖";
/** 金額轉國字大寫（公文、收據用） */
export function toChineseAmount(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n === 0) return "零元整";
  const units = ["", "拾", "佰", "仟"];
  const groups = ["", "萬", "億", "兆"];
  let out = "";
  let g = 0;
  let zero = false;
  while (n > 0) {
    const part = n % 10000;
    let s = "";
    let z = false;
    for (let i = 0, p = part; i < 4; i++, p = Math.floor(p / 10)) {
      const d = p % 10;
      if (d) (s = BIG[d] + units[i] + (z ? "零" : "") + s), (z = false);
      else if (s) z = true;
    }
    if (part) out = s + groups[g] + (zero ? "零" : "") + out;
    // 下一組（較高位）與已產生的低位之間需要「零」：本組全為零且低位有值，或本組不足千
    zero = part === 0 ? out !== "" : part < 1000;
    n = Math.floor(n / 10000);
    g++;
  }
  return out.replace(/^零+/, "") + "元整";
}
export function formatValue(v, fmt) {
  const s = String(v ?? "");
  if (!fmt) return s;
  const f = fmt.trim();
  if (/^(民國|roc)$/i.test(f)) {
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    return m ? `${Number(m[1]) - 1911}年${Number(m[2])}月${Number(m[3])}日` : s;
  }
  const num = Number(s.replace(/[,\s元$]/g, ""));
  if (/^(千分位|comma)$/i.test(f)) return s !== "" && Number.isFinite(num) ? num.toLocaleString("en-US") : s;
  if (/^(國字|大寫)$/.test(f)) return s !== "" && Number.isFinite(num) ? toChineseAmount(num) : s;
  return s;
}

// ---------- 範本處理 ----------
/** Word 的 MERGEFIELD 功能變數（簡單與複合）先轉成 «欄位» 文字 */
function mergeFieldsToText(xml) {
  const run = (rPr, name) => `<w:r>${rPr || ""}<w:t xml:space="preserve">«${name}»</w:t></w:r>`;
  xml = xml.replace(/<w:fldSimple\b[^>]*w:instr="\s*MERGEFIELD\s+(?:&quot;)?([^"\\&\s]+)(?:&quot;)?[^"]*"[^>]*>([\s\S]*?)<\/w:fldSimple>/g, (_, name, inner) => run(/<w:rPr>[\s\S]*?<\/w:rPr>/.exec(inner)?.[0], name));
  // 複合功能變數：begin … instrText MERGEFIELD … separate … 結果 … end
  return xml.replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>([\s\S]*?)<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, (all, inner) => {
    if (/w:fldCharType="begin"/.test(inner)) return all; // 巢狀功能變數不處理
    const instr = [...inner.matchAll(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/g)].map((m) => xmlUnesc(m[1])).join("");
    const m = /^\s*MERGEFIELD\s+"?([^"\\\s]+)"?/.exec(instr);
    if (!m) return all;
    const result = inner.split(/w:fldCharType="separate"/)[1] || "";
    return run(/<w:rPr>[\s\S]*?<\/w:rPr>/.exec(result)?.[0] || /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(inner)?.[0], m[1]);
  });
}

/**
 * 在 XML 中替換欄位。Word 常把一個欄位拆成好幾個 run（例如「{{」「姓名」「}}」），
 * 這裡以段落為單位把文字接起來比對，再把結果寫回第一個 run，保留原本的字型格式。
 */
function replaceInXml(xml, valueOf) {
  const tokens = [];
  const re = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>|<w:p[\s>]|<\/w:p>|<w:tab\/>|<w:br\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith("<w:t")) tokens.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] || "", text: xmlUnesc(m[2]) });
    else tokens.push({ boundary: true });
  }
  const edits = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const full = group.map((t) => t.text).join("");
    if (!/\{\{|«/.test(full)) return void (group = []);
    const matches = [...full.matchAll(PLACEHOLDER)];
    if (!matches.length) return void (group = []);
    // 由後往前改，避免位移
    // 每個 run 在整段文字中的起點與原始長度
    const pos = [];
    const lens = group.map((t) => t.text.length);
    let acc = 0;
    for (const n of lens) pos.push((acc += n) - n);
    const nodeAt = (offset) => {
      for (let k = 0; k < group.length; k++) if (offset >= pos[k] && offset < pos[k] + lens[k]) return k;
      return group.length - 1;
    };
    for (const mm of matches.reverse()) {
      const a = mm.index;
      const b = mm.index + mm[0].length;
      const value = valueOf(mm[1] ?? mm[3], mm[2] ?? mm[4]);
      // 值放在「欄位名稱」所在的 run，沿用名稱的格式（例如只有姓名設為粗體）
      const nameAt = a + mm[0].indexOf((mm[1] ?? mm[3]).trim());
      const ka = nodeAt(a);
      const kb = nodeAt(b - 1);
      const kn = nodeAt(nameAt);
      const texts = [];
      for (let k = ka; k <= kb; k++) {
        const t = group[k].text;
        const keepBefore = k === ka ? t.slice(0, a - pos[ka]) : "";
        const keepAfter = k === kb ? t.slice(b - pos[kb]) : "";
        texts.push([k, keepBefore + (k === kn ? value : "") + keepAfter]);
      }
      for (const [k, t] of texts) (group[k].text = t), (group[k].changed = true);
    }
    for (const t of group) if (t.changed) edits.push(t);
    group = [];
  };
  for (const t of tokens) {
    if (t.boundary) flush();
    else group.push(t);
  }
  flush();
  edits.sort((p, q) => q.start - p.start);
  for (const t of edits) {
    const body = xmlEsc(t.text).replace(/\r?\n/g, '</w:t><w:br/><w:t xml:space="preserve">');
    xml = xml.slice(0, t.start) + `<w:t xml:space="preserve">${body}</w:t>` + xml.slice(t.end);
  }
  return xml;
}

/** 讀取範本，回傳各部位 XML 與其中使用的欄位名稱 */
export async function loadTemplate(buf) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw userError("範本需要 Word 檔（.docx）。舊版 .doc 請先用 Word 另存為 .docx");
  }
  if (!zip.file("word/document.xml")) throw userError("範本不是有效的 Word（.docx）檔");
  const parts = {};
  for (const name of Object.keys(zip.files)) if (PARTS.test(name)) parts[name] = mergeFieldsToText(await zip.file(name).async("string"));
  const fields = new Set();
  for (const xml of Object.values(parts)) {
    // 以去除標記後的段落文字找欄位（欄位可能被拆成多個 run）
    for (const p of xml.split(/<\/w:p>/)) {
      const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((x) => xmlUnesc(x[1])).join("");
      for (const mm of text.matchAll(PLACEHOLDER)) fields.add((mm[1] ?? mm[3]).trim());
    }
  }
  return { zip, parts, fields: [...fields] };
}

/** 檔名中的 {{欄位}} 也可代入 */
export const fillText = (tpl, row) => String(tpl).replace(PLACEHOLDER, (_, a, f1, b, f2) => formatValue(row[(a ?? b).trim()] ?? "", f1 ?? f2));

async function renderDoc(tpl, row) {
  const zip = new JSZip();
  for (const [name, file] of Object.entries(tpl.zip.files)) {
    if (file.dir) continue;
    if (tpl.parts[name]) zip.file(name, replaceInXml(tpl.parts[name], (k, f) => formatValue(row[k.trim()] ?? "", f)));
    else if (name === "word/settings.xml") {
      // 移除 Word 合併列印的資料來源設定，避免開檔時詢問 SQL 指令
      zip.file(name, (await file.async("string")).replace(/<w:mailMerge>[\s\S]*?<\/w:mailMerge>/, ""));
    } else zip.file(name, await file.async("nodebuffer"));
  }
  return zip;
}

/** 多份文件合併成一個 Word：依序接上本文，以分頁隔開 */
async function combine(tpl, rows) {
  const first = await renderDoc(tpl, rows[0]);
  const docXml = await first.file("word/document.xml").async("string");
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(docXml)[1];
  const sectM = /<w:sectPr\b[\s\S]*<\/w:sectPr>\s*$/.exec(body);
  const sect = sectM ? sectM[0] : "";
  const pieces = [];
  for (const [k, row] of rows.entries()) {
    let x = replaceInXml(/<w:body>([\s\S]*)<\/w:body>/.exec(tpl.parts["word/document.xml"])[1], (key, f) => formatValue(row[key.trim()] ?? "", f));
    x = x.replace(/<w:sectPr\b[\s\S]*<\/w:sectPr>\s*$/, "");
    // 圖片物件編號不可重複；書籤只保留第一份
    x = x.replace(/(<wp:docPr\b[^>]*\bid=")(\d+)"/g, (_, a, id) => `${a}${Number(id) + k * 10000}"`);
    if (k) x = x.replace(/<w:bookmark(Start|End)\b[^>]*\/>/g, "");
    pieces.push(x);
  }
  const brk = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  first.file("word/document.xml", docXml.replace(/<w:body>[\s\S]*<\/w:body>/, () => `<w:body>${pieces.join(brk)}${sect}</w:body>`));
  return first.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * 執行合併列印
 * @param {Buffer} templateBuf Word 範本
 * @param {{ columns: string[], rows: object[] }} table 名單
 * @param {{ mode?: "separate"|"combined", filename?: string, log?: Function }} opt
 */
export async function mailMerge(templateBuf, table, { mode = "separate", filename = "", log = () => {} } = {}) {
  const tpl = await loadTemplate(templateBuf);
  if (!tpl.fields.length) throw userError("範本中沒有找到任何欄位。請在 Word 範本中以 {{欄位名稱}} 標示要代入的位置（欄位名稱需與 Excel 第一列相同），例如「{{姓名}} 同學」");
  const cols = new Set(table.columns.map((c) => c.trim()));
  const missing = tpl.fields.filter((f) => !cols.has(f));
  if (missing.length) throw userError(`範本中的欄位在名單中找不到：${missing.map((f) => `「${f}」`).join("、")}。名單的欄位有：${table.columns.join("、")}`);
  const rows = table.rows.filter((r) => Object.values(r).some((v) => String(v).trim()));
  if (!rows.length) throw userError("名單中沒有資料");
  if (rows.length > 1000) throw userError(`名單有 ${rows.length} 筆，一次最多 1000 筆，請分批處理`);
  log(`範本欄位：${tpl.fields.join("、")}；名單 ${rows.length} 筆`);
  if (mode === "combined") return { mode, buf: await combine(tpl, rows), count: rows.length, fields: tpl.fields };
  const zip = new JSZip();
  const used = new Map();
  for (const row of rows) {
    const base = (filename ? fillText(filename, row) : fillText(`{{${table.columns[0]}}}`, row)).replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "文件";
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const doc = await renderDoc(tpl, row);
    zip.file(`${base}${n > 1 ? `-${n}` : ""}.docx`, await doc.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  }
  return { mode, buf: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), count: rows.length, fields: tpl.fields };
}
