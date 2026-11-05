// 報告格式檢查（國科會計畫報告／縣市計畫成果報告），依「報告撰寫規範」逐項檢查 Word 檔，
// 並可自動修正機械性項目（字型、字級、對齊、行距、全半形、功能變數更新設定）。
import JSZip from "jszip";

export const PROFILES = {
  auto: "自動判斷",
  academic: "學術型（國科會計畫進度／期末報告、研究報告）",
  project: "計畫成果型（縣市政府計畫、委託勞務採購案）",
};

const RULES = {
  bodyEast: "標楷體",
  bodyAscii: "Times New Roman",
  bodySz: 24, // 12pt（半點）
  h1Sz: 32, // 16pt
  h2Sz: 28, // 14pt
  captionSz: 28, // 14pt
};

const userError = (m) => Object.assign(new Error(m), { status: 422 });
const attr = (xml, name) => new RegExp(`${name}="([^"]*)"`).exec(xml || "")?.[1];
const textOf = (xml) =>
  [...String(xml).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)]
    .map((m) => (m[0] === "<w:tab/>" ? "\t" : m[1]))
    .join("")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');

// ---------------- 樣式解析 ----------------
function parseRPr(rPr = "") {
  const rf = /<w:rFonts\b[^>]*\/?>/.exec(rPr)?.[0] || "";
  const sz = attr(/<w:sz\b[^>]*\/>/.exec(rPr)?.[0], "w:val");
  const b = /<w:b\b[^>]*\/>/.exec(rPr)?.[0];
  return {
    east: attr(rf, "w:eastAsia"),
    ascii: attr(rf, "w:ascii"),
    hAnsi: attr(rf, "w:hAnsi"),
    eastTheme: attr(rf, "w:eastAsiaTheme"),
    asciiTheme: attr(rf, "w:asciiTheme"),
    sz: sz ? Number(sz) : undefined,
    bold: b === undefined ? undefined : !/w:val="(0|false)"/.test(b),
  };
}
function parsePPr(pPr = "") {
  const sp = /<w:spacing\b[^>]*\/>/.exec(pPr)?.[0];
  const ind = /<w:ind\b[^>]*\/>/.exec(pPr)?.[0];
  return {
    jc: attr(/<w:jc\b[^>]*\/>/.exec(pPr)?.[0], "w:val"),
    line: sp && attr(sp, "w:line") ? Number(attr(sp, "w:line")) : undefined,
    lineRule: sp ? attr(sp, "w:lineRule") : undefined,
    hanging: ind ? attr(ind, "w:hanging") : undefined,
    outline: attr(/<w:outlineLvl\b[^>]*\/>/.exec(pPr)?.[0], "w:val"),
    numbered: /<w:numPr>/.test(pPr),
  };
}
const merge = (a, b) => {
  const out = Object.fromEntries(Object.keys({ ...a, ...b }).map((k) => [k, b[k] !== undefined ? b[k] : a[k]]));
  // 較具體的層級直接指定字型時，取代繼承來的佈景主題字型（與 Word 的實際顯示一致）
  if (b.ascii !== undefined && b.asciiTheme === undefined) out.asciiTheme = undefined;
  if (b.east !== undefined && b.eastTheme === undefined) out.eastTheme = undefined;
  return out;
};

function parseStyles(xml = "") {
  const defR = parseRPr(/<w:rPrDefault>([\s\S]*?)<\/w:rPrDefault>/.exec(xml)?.[1]);
  const defP = parsePPr(/<w:pPrDefault>([\s\S]*?)<\/w:pPrDefault>/.exec(xml)?.[1]);
  const styles = {};
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attr(m[1], "w:styleId");
    styles[id] = {
      id,
      type: attr(m[1], "w:type"),
      isDefault: attr(m[1], "w:default") === "1",
      name: attr(/<w:name\b[^>]*\/>/.exec(m[2])?.[0], "w:val") || id,
      basedOn: attr(/<w:basedOn\b[^>]*\/>/.exec(m[2])?.[0], "w:val"),
      r: parseRPr(/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(m[2])?.[1]),
      p: parsePPr(/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(m[2])?.[1]),
    };
  }
  const normal = Object.values(styles).find((s) => s.type === "paragraph" && s.isDefault)?.id || "Normal";
  const cache = {};
  const resolve = (id, depth = 0) => {
    if (cache[id]) return cache[id];
    const s = styles[id];
    if (!s || depth > 10) return { r: defR, p: defP, name: id || "" };
    const base = s.basedOn ? resolve(s.basedOn, depth + 1) : { r: defR, p: defP };
    return (cache[id] = { r: merge(base.r, s.r), p: merge(base.p, s.p), name: s.name });
  };
  return { styles, resolve, normal };
}

// ---------------- 文件結構 ----------------
/** 依序取出 body 最上層的段落與表格 */
function splitBody(xml) {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] || "";
  const blocks = [];
  const re = /<w:(p|tbl|sdt)\b[^>]*?(\/>|>)/g;
  let m;
  while ((m = re.exec(body))) {
    const tag = m[1];
    if (m[2] === "/>") {
      blocks.push({ type: tag, xml: m[0] });
      continue;
    }
    // 找到對應的結束標籤（考慮巢狀）
    let depth = 1;
    const inner = new RegExp(`<w:${tag}\\b[^>]*?(/>|>)|</w:${tag}>`, "g");
    inner.lastIndex = re.lastIndex;
    let n;
    while (depth && (n = inner.exec(body))) {
      if (n[0].startsWith("</")) depth--;
      else if (n[1] === ">") depth++;
    }
    const end = n ? inner.lastIndex : body.length;
    const xmlBlock = body.slice(m.index, end);
    if (tag === "sdt") {
      // 內容控制項（例如 Word 自動目錄）：取出其中段落
      const content = /<w:sdtContent>([\s\S]*)<\/w:sdtContent>/.exec(xmlBlock)?.[1] || "";
      for (const p of content.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) blocks.push({ type: "p", xml: p[0], inSdt: true });
    } else blocks.push({ type: tag, xml: xmlBlock });
    re.lastIndex = end;
  }
  return blocks;
}

const CN_NUM = "一二三四五六七八九十";
/** 中文數字（一～九十九）轉阿拉伯數字 */
function cnNum(t) {
  const d = (c) => "一二三四五六七八九".indexOf(c) + 1;
  if (t === "十") return 10;
  if (t.startsWith("十")) return 10 + d(t[1]);
  if (t.includes("十")) return d(t[0]) * 10 + (t[2] ? d(t[2]) : 0);
  return d(t);
}
const MARKERS = [
  // [regex, academic level, project level]
  [/^第[一二三四五六七八九十百]+章/, 1, null],
  [/^第[一二三四五六七八九十百]+節/, 2, null],
  [/^[壹貳參肆伍陸柒捌玖拾]+、/, null, 1],
  [new RegExp(`^[${CN_NUM}]+、`), 3, 2],
  [new RegExp(`^（[${CN_NUM}]+）`), 4, 3],
  [/^\d+\.(?!\d)/, 5, 4],
  [/^（\d+）/, 6, 5],
  [/^[A-Z]\.(?!\w)/, null, 6],
];

function analyse(documentXml, stylesXml, settingsXml) {
  const st = parseStyles(stylesXml);
  const blocks = splitBody(documentXml);
  const items = [];
  let chapter = 0;
  let seenHeading = false;
  for (const [i, b] of blocks.entries()) {
    if (b.type === "tbl") {
      items.push({ kind: "table", index: i, pos: items.length, chapter });
      continue;
    }
    const pPrXml = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(b.xml)?.[1] || "";
    const styleId = attr(/<w:pStyle\b[^>]*\/>/.exec(pPrXml)?.[0], "w:val") || st.normal;
    const style = st.resolve(styleId);
    const pp = merge(style.p, parsePPr(pPrXml));
    const text = textOf(b.xml).trim();
    const instr = [...b.xml.matchAll(/<w:instrText[^>]*>([^<]*)<\/w:instrText>|<w:fldSimple\b[^>]*w:instr="([^"]*)"/g)].map((x) => (x[1] || x[2] || "").trim());
    const runs = [...b.xml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)]
      .map((r) => ({ r: merge(style.r, parseRPr(/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(r[1])?.[1])), text: textOf(r[0]) }))
      .filter((r) => r.text.trim());
    const sName = (style.name || "").toLowerCase();
    let headingLevel = /^heading (\d)$|^標題 (\d)$/.exec(sName);
    headingLevel = headingLevel ? Number(headingLevel[1] || headingLevel[2]) : pp.outline !== undefined ? Number(pp.outline) + 1 : 0;
    const isCaption = /caption|標號|題注/.test(sName) || /^(圖|表)\s*\d/.test(text);
    // 章次取自標題文字（第X章、壹、），摘要、目錄等不算章
    const chapMatch = headingLevel === 1 && /^(?:第([一二三四五六七八九十百]+)章|([壹貳參肆伍陸柒捌玖拾]+)、)/.exec(text);
    if (chapMatch) chapter = chapMatch[1] ? cnNum(chapMatch[1]) : "壹貳參肆伍陸柒捌玖拾".indexOf(chapMatch[2]) + 1;
    if (headingLevel) seenHeading = true;
    items.push({
      pos: items.length,
      kind: headingLevel ? "heading" : isCaption ? "caption" : "para",
      level: headingLevel,
      index: i,
      text,
      runs,
      pp,
      styleName: style.name,
      instr,
      hasDrawing: /<w:drawing>|<w:pict>|<v:imagedata/.test(b.xml),
      chapter,
      cover: !seenHeading,
      inSdt: !!b.inSdt,
    });
  }
  // <w:updateFields/>（沒有 w:val）在 Word 中也視為開啟
  const updateFields = /<w:updateFields\b(?![^>]*w:val="(false|0)")[^>]*\/?>/.test(settingsXml || "");
  return { items, updateFields, st };
}

// ---------------- 檢查 ----------------
const fontOk = (r) => (r.east || "") === RULES.bodyEast && (r.ascii || "") === RULES.bodyAscii && !r.eastTheme && !r.asciiTheme;
const fontDesc = (r) => `中文「${r.eastTheme ? "佈景主題字型" : r.east || "未設定"}」、英數「${r.asciiTheme ? "佈景主題字型" : r.ascii || "未設定"}」`;
const pt = (sz) => (sz ? `${sz / 2}pt` : "未設定");
const short = (t) => (t.length > 24 ? t.slice(0, 24) + "…" : t);

export function checkReport(analysis, profile = "auto") {
  const { items, updateFields } = analysis;
  const results = [];
  const add = (group, item, status, detail, examples = []) => results.push({ group, item, status, detail, examples: examples.slice(0, 5) });
  const allText = items.map((x) => x.text || "").join("\n");

  // 判斷報告類型
  let type = profile;
  if (type === "auto") {
    const academic = /第[一二三四五六七八九十]+章|國科會|文獻回顧|研究方法/.test(allText);
    const project = /^[壹貳參肆]、/m.test(allText) || /成果自評|計畫工項|委託|採購/.test(allText);
    type = project && !academic ? "project" : "academic";
  }
  add("基本資訊", "報告類型", "資訊", `${PROFILES[type]}${profile === "auto" ? "（依內容自動判斷）" : ""}`);

  const refStart = items.findIndex((x) => x.kind === "heading" && /參考文獻|References/i.test(x.text));
  const refEnd = refStart < 0 ? -1 : items.findIndex((x, k) => k > refStart && x.kind === "heading");
  const inRefs = (k) => refStart >= 0 && k > refStart && (refEnd < 0 || k < refEnd);
  const body = items.filter((x, k) => x.kind === "para" && x.text && !x.cover && !x.inSdt && !inRefs(k) && !/^(摘要|Abstract|目錄|圖目錄|表目錄)$/.test(x.text));

  // ---- 字型與字級 ----
  const badFont = body.filter((p) => p.runs.some((r) => !fontOk(r.r)));
  add("字型與字級", "內文字型：中文標楷體、英數 Times New Roman", badFont.length ? "未通過" : "通過", badFont.length ? `${badFont.length}/${body.length} 段不符，例如 ${fontDesc(badFont[0].runs.find((r) => !fontOk(r.r)).r)}` : `${body.length} 段皆符合`, badFont.map((p) => short(p.text)));
  const badSize = body.filter((p) => p.runs.some((r) => r.r.sz !== RULES.bodySz));
  add("字型與字級", "內文 12pt", badSize.length ? "未通過" : "通過", badSize.length ? `${badSize.length} 段不是 12pt（例：${pt(badSize[0].runs.find((r) => r.r.sz !== RULES.bodySz).r.sz)}）` : "皆為 12pt", badSize.map((p) => short(p.text)));
  for (const [lv, sz, label] of [
    [1, RULES.h1Sz, "章標題 16pt 粗體"],
    [2, RULES.h2Sz, "節標題 14pt 粗體"],
  ]) {
    const hs = items.filter((x) => x.kind === "heading" && (lv === 1 ? x.level === 1 : x.level >= 2) && x.text);
    const bad = hs.filter((h) => h.runs.some((r) => r.r.sz !== sz || !r.r.bold || !fontOk(r.r)));
    add("字型與字級", label + "（標楷體／Times New Roman）", !hs.length ? "提醒" : bad.length ? "未通過" : "通過", !hs.length ? "找不到使用標題樣式的段落（請使用 Word 內建「標題 1／2」樣式，目錄才能自動產生）" : bad.length ? `${bad.length}/${hs.length} 個不符，例如「${short(bad[0].text)}」為 ${pt(bad[0].runs[0].r.sz)}${bad[0].runs[0].r.bold ? "" : "、未粗體"}，${fontDesc(bad[0].runs[0].r)}` : `${hs.length} 個皆符合`, bad.map((h) => short(h.text)));
  }
  const caps = items.filter((x) => x.kind === "caption");
  const badCap = caps.filter((c) => c.runs.some((r) => r.r.sz !== RULES.captionSz));
  add("字型與字級", "圖表標題 14pt", !caps.length ? "提醒" : badCap.length ? "未通過" : "通過", !caps.length ? "沒有找到圖表標題" : badCap.length ? `${badCap.length}/${caps.length} 個不是 14pt` : `${caps.length} 個皆符合`, badCap.map((c) => short(c.text)));

  // ---- 版面 ----
  const badJc = body.filter((p) => !["both", "distribute"].includes(p.pp.jc || "left"));
  add("版面", "內文左右對齊（兩端對齊）", badJc.length ? "未通過" : "通過", badJc.length ? `${badJc.length}/${body.length} 段不是兩端對齊` : "皆為兩端對齊", badJc.map((p) => short(p.text)));
  const badLine = body.filter((p) => !((p.pp.lineRule === "exact" && p.pp.line >= 320 && p.pp.line <= 420) || ((!p.pp.lineRule || p.pp.lineRule === "auto") && p.pp.line >= 340 && p.pp.line <= 380)));
  add("版面", "行距：固定行高約 1.5 倍", badLine.length ? "提醒" : "通過", badLine.length ? `${badLine.length} 段的行距不是固定行高約 18pt（1.5 倍）` : "符合", badLine.map((p) => short(p.text)));

  // ---- 標號層級 ----
  const numbered = items.filter((x, k) => (x.kind === "heading" || x.kind === "para") && x.text && !inRefs(k) && !x.cover);
  const usesAcademic = numbered.some((x) => /^第[一二三四五六七八九十百]+[章節]/.test(x.text));
  const usesProject = numbered.some((x) => /^[壹貳參肆伍陸柒捌玖拾]+、/.test(x.text));
  if (usesAcademic && usesProject) add("標號", "標號體系一致", "未通過", "同時使用「第一章」與「壹、」兩種體系");
  else add("標號", "標號體系一致", "通過", usesProject ? "使用計畫成果型（壹、一、（一）1.（1）A.）" : "使用學術型（第一章、第一節、一、（一）1.（1））");
  const sys = usesProject ? 2 : 1;
  const skips = [];
  let last = 0;
  for (const x of numbered) {
    const mk = MARKERS.find(([re, a, p]) => re.test(x.text) && (sys === 1 ? a : p));
    if (!mk) continue;
    const lv = sys === 1 ? mk[1] : mk[2];
    if (lv > last + 1 && last > 0) skips.push(`「${short(x.text)}」（上一層之後直接跳到第 ${lv} 層）`);
    if (last === 0 && lv > 1 && x.kind === "para") skips.push(`「${short(x.text)}」（前面沒有上一層標號）`);
    last = lv;
  }
  add("標號", "標號層級不跳層", skips.length ? "未通過" : "通過", skips.length ? `${skips.length} 處跳層` : "未發現跳層", skips);
  const halfParen = numbered.filter((x) => /^\([一二三四五六七八九十\d]+\)/.test(x.text));
  add("標號", "括號與頓號使用全形", halfParen.length ? "未通過" : "通過", halfParen.length ? `${halfParen.length} 處使用半形括號` : "符合", halfParen.map((x) => short(x.text)));

  // ---- 架構 ----
  const has = (re) => items.some((x) => (x.kind === "heading" || x.kind === "para") && re.test(x.text.replace(/\s/g, "")));
  const required =
    type === "project"
      ? [["摘要", /^摘要$/], ["Abstract", /^abstract$/i], ["目錄", /^目錄$/], ["前言／計畫主旨", /前言|計畫主旨/], ["結論與建議", /結論/], ["成果自評／價值與貢獻", /成果自評|價值與貢獻/], ["參考文獻", /^參考文獻$/], ["附錄", /^附錄/]]
      : [["摘要", /^摘要$/], ["Abstract", /^abstract$/i], ["目錄", /^目錄$/], ["緒論／前言", /緒論|前言/], ["文獻回顧", /文獻(回顧|探討)/], ["結論與建議", /結論/], ["參考文獻", /^參考文獻$/], ["附錄", /^附錄/]];
  const missing = required.filter(([, re]) => !has(re)).map(([n]) => n);
  add("架構", "必要章節齊全", missing.length ? "未通過" : "通過", missing.length ? `缺少：${missing.join("、")}` : required.map(([n]) => n).join("、"));

  // ---- 圖表 ----
  const capInfo = caps.map((c) => ({ ...c, m: /^(圖|表)\s*(\d+)\s*-\s*(\d+)/.exec(c.text) }));
  const badNo = capInfo.filter((c) => !c.m);
  add("圖表", "編號採「圖1-1」「表2-3」格式", !caps.length ? "提醒" : badNo.length ? "未通過" : "通過", !caps.length ? "沒有圖表" : badNo.length ? `${badNo.length} 個編號格式不符` : `${caps.length} 個皆符合`, badNo.map((c) => short(c.text)));
  const wrongChap = capInfo.filter((c) => c.m && Number(c.m[2]) !== c.chapter && c.chapter > 0);
  if (wrongChap.length) add("圖表", "編號的章次與所在章一致", "未通過", `${wrongChap.length} 個不一致`, wrongChap.map((c) => `${short(c.text)}（位於第 ${c.chapter} 章）`));
  const posIssues = [];
  for (const c of capInfo) {
    const k = c.pos;
    if (c.text.startsWith("表") && items[k + 1]?.kind !== "table") posIssues.push(`「${short(c.text)}」不在表格正上方${items[k - 1]?.kind === "table" ? "（位於表格下方）" : ""}`);
    if (c.text.startsWith("圖") && !items[k - 1]?.hasDrawing) posIssues.push(`「${short(c.text)}」上方沒有圖片（圖標題應在圖的下方）`);
  }
  add("圖表", "表標題在上、圖標題在下", !caps.length ? "提醒" : posIssues.length ? "未通過" : "通過", posIssues.length ? `${posIssues.length} 處位置不符` : caps.length ? "符合" : "沒有圖表", posIssues);
  const bodyText = body.map((p) => p.text).join("\n");
  const unref = capInfo.filter((c) => c.m && !new RegExp(`${c.m[1]}\\s*${c.m[2]}\\s*-\\s*${c.m[3]}(?!\\d)`).test(bodyText));
  add("圖表", "每個圖表都在內文被引用", !caps.length ? "提醒" : unref.length ? "未通過" : "通過", unref.length ? `${unref.length} 個未在內文提及（例如「如表1-1所示」）` : caps.length ? "皆有引用" : "沒有圖表", unref.map((c) => short(c.text)));
  const orderIssues = [];
  let sec = [];
  const flush = () => {
    const firstFig = sec.findIndex((x) => x.kind === "caption" && x.text.startsWith("圖"));
    if (firstFig >= 0 && sec.slice(firstFig).some((x) => x.kind === "table")) orderIssues.push(`「${short(sec[0]?.text || "")}」一節中，表格出現在圖之後`);
    sec = [];
  };
  for (const x of items) {
    if (x.kind === "heading") flush();
    sec.push(x);
  }
  flush();
  add("圖表", "章節內順序：文字 → 表 → 圖", orderIssues.length ? "提醒" : "通過", orderIssues.length ? `${orderIssues.length} 處` : "符合", orderIssues);

  // ---- 功能變數 ----
  const fields = items.flatMap((x) => x.instr);
  const hasToc = fields.some((f) => /^TOC\b/.test(f) && !/\\c\s/.test(f));
  add("目錄與功能變數", "目錄以功能變數自動產生（TOC）", hasToc ? "通過" : "未通過", hasToc ? "已使用 TOC 功能變數" : "沒有自動目錄；請在 Word「參考資料 → 目錄」插入");
  if (caps.length) {
    const seqCaps = caps.filter((c) => c.instr.some((f) => /^SEQ\b/.test(f)));
    add("目錄與功能變數", "圖表編號以 SEQ 功能變數產生", seqCaps.length === caps.length ? "通過" : "提醒", seqCaps.length === caps.length ? "皆使用 SEQ" : `${caps.length - seqCaps.length} 個圖表編號為手動輸入，增刪圖表時不會自動更新（Word「參考資料 → 插入標號」）`, caps.filter((c) => !c.instr.some((f) => /^SEQ\b/.test(f))).map((c) => short(c.text)));
  }
  add("目錄與功能變數", "開啟時自動更新功能變數（updateFields）", updateFields ? "通過" : "提醒", updateFields ? "已設定" : "未設定（自動修正可加上）");

  // ---- 用語 ----
  const scan = (re) => body.filter((p) => re.test(p.text));
  const dash = scan(/——|—|--|─/);
  add("用語", "不使用破折號", dash.length ? "未通過" : "通過", dash.length ? `${dash.length} 段使用破折號，請改用括號、冒號或另起句子` : "符合", dash.map((p) => short(p.text)));
  const COLLOQUIAL = /我們|大概|差不多|搞定|超級|蠻|挺|啦|喔|囉|弄好|一堆/;
  const coll = scan(COLLOQUIAL);
  add("用語", "避免口語", coll.length ? "未通過" : "通過", coll.length ? `${coll.length} 段含口語用詞（${[...new Set(coll.flatMap((p) => p.text.match(new RegExp(COLLOQUIAL, "g"))))].join("、")}）` : "符合", coll.map((p) => short(p.text)));
  const selfR = /本研究/.test(bodyText);
  const selfP = /本計畫/.test(bodyText);
  add("用語", "自稱一致（本研究／本計畫）", selfR && selfP ? "未通過" : "通過", selfR && selfP ? "同時使用「本研究」與「本計畫」" : selfR ? "使用「本研究」" : selfP ? "使用「本計畫」" : "未使用自稱");
  const fullDigit = scan(/[０-９Ａ-Ｚａ-ｚ]/);
  add("用語", "數字與英文使用半形", fullDigit.length ? "未通過" : "通過", fullDigit.length ? `${fullDigit.length} 段含全形數字或英文` : "符合", fullDigit.map((p) => short(p.text)));
  const halfPunct = scan(/[一-鿿][,;:?!]|[,;:?!](?=[一-鿿])|[一-鿿]\.(?=[一-鿿]|$)/);
  add("用語", "中文使用全形標點", halfPunct.length ? "未通過" : "通過", halfPunct.length ? `${halfPunct.length} 段在中文中使用半形標點` : "符合", halfPunct.map((p) => short(p.text)));

  // ---- 參考文獻 ----
  if (refStart < 0) add("參考文獻", "參考文獻格式", "未通過", "找不到「參考文獻」章節");
  else {
    const refs = items.filter((x, k) => inRefs(k) && x.kind === "para" && x.text);
    const noNum = refs.filter((r) => !/^\d+[.．]\s*/.test(r.text) && !r.pp.numbered);
    add("參考文獻", "每筆文獻前有順序標號（1. 2. 3.）", noNum.length ? "未通過" : "通過", noNum.length ? `${noNum.length}/${refs.length} 筆沒有標號` : `${refs.length} 筆皆有標號`, noNum.map((r) => short(r.text)));
    const strip = (t) => t.replace(/^\d+[.．]\s*/, "");
    const en = refs.filter((r) => /^[A-Za-z]/.test(strip(r.text)));
    const badEn = en.filter((r) => !/^[A-Z][^()]*\(\d{4}[a-z]?\)\.\s+\S/.test(strip(r.text)));
    if (en.length) add("參考文獻", "英文文獻採 APA 格式（作者 (年份). 篇名.）", badEn.length ? "未通過" : "通過", badEn.length ? `${badEn.length}/${en.length} 筆不符` : `${en.length} 筆符合`, badEn.map((r) => short(r.text)));
    const zh = refs.filter((r) => /^[一-鿿]/.test(strip(r.text)));
    const badZh = zh.filter((r) => (strip(r.text).match(/，/g) || []).length < 2 || !/\d{4}[。.]?$/.test(strip(r.text)));
    if (zh.length) add("參考文獻", "中文文獻格式（作者，篇名，來源，卷期頁碼，年份。）", badZh.length ? "未通過" : "通過", badZh.length ? `${badZh.length}/${zh.length} 筆不符` : `${zh.length} 筆符合`, badZh.map((r) => short(r.text)));
    const zhIdx = refs.findIndex((r) => /^[一-鿿]/.test(strip(r.text)));
    const enIdx = refs.findIndex((r) => /^[A-Za-z]/.test(strip(r.text)));
    if (zhIdx >= 0 && enIdx >= 0) add("參考文獻", "中文文獻在前、英文在後", zhIdx < enIdx ? "通過" : "提醒", zhIdx < enIdx ? "符合" : "英文文獻排在中文之前");
    const noHang = refs.filter((r) => !r.pp.hanging);
    add("參考文獻", "懸掛縮排", noHang.length ? "提醒" : "通過", noHang.length ? `${noHang.length} 筆未設定懸掛縮排` : "符合");
  }
  const summary = { pass: results.filter((r) => r.status === "通過").length, fail: results.filter((r) => r.status === "未通過").length, warn: results.filter((r) => r.status === "提醒").length };
  return { type, results, summary };
}

export function resultsToMarkdown({ type, results, summary }, title = "報告格式檢查") {
  const lines = [`# ${title}`, "", `- 報告類型：${PROFILES[type]}`, `- 結果：通過 ${summary.pass} 項、未通過 ${summary.fail} 項、提醒 ${summary.warn} 項`, "", "| 類別 | 檢查項目 | 結果 | 說明 |", "|---|---|---|---|"];
  for (const r of results.filter((x) => x.status !== "資訊")) lines.push(`| ${r.group} | ${r.item} | ${r.status === "通過" ? "通過" : r.status === "未通過" ? "**未通過**" : "提醒"} | ${r.detail.replace(/\|/g, "／")} |`);
  const withEx = results.filter((r) => r.examples?.length && r.status !== "通過");
  if (withEx.length) {
    lines.push("", "## 需要修正的位置", "");
    for (const r of withEx) {
      lines.push(`### ${r.item}`, "");
      for (const e of r.examples) lines.push(`- ${e}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---------------- 讀取與自動修正 ----------------
async function openDocx(buf) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw userError("無法讀取 Word 檔（請確認是 .docx 格式；舊版 .doc 請另存為 .docx）");
  }
  const doc = await zip.file("word/document.xml")?.async("string");
  if (!doc) throw userError("這不是有效的 Word（.docx）檔");
  return { zip, doc, styles: (await zip.file("word/styles.xml")?.async("string")) || "", settings: (await zip.file("word/settings.xml")?.async("string")) || "" };
}

export async function checkDocx(buf, profile = "auto") {
  const { doc, styles, settings } = await openDocx(buf);
  const analysis = analyse(doc, styles, settings);
  const out = checkReport(analysis, profile);
  out.text = analysis.items.map((x) => x.text || "").filter(Boolean).join("\n\n");
  return out;
}

const FONT_XML = `<w:rFonts w:ascii="${RULES.bodyAscii}" w:hAnsi="${RULES.bodyAscii}" w:eastAsia="${RULES.bodyEast}" w:cs="${RULES.bodyAscii}"/>`;
function setRPr(rPr, { sz, bold }) {
  let r = rPr.replace(/<w:rFonts\b[^>]*\/>/g, "").replace(/<w:sz\b[^>]*\/>|<w:szCs\b[^>]*\/>/g, "");
  if (bold !== undefined) r = r.replace(/<w:b\b[^>]*\/>|<w:bCs\b[^>]*\/>/g, "") + (bold ? "<w:b/><w:bCs/>" : '<w:b w:val="0"/>');
  return FONT_XML + r + `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
}
function fixStyle(xml, styleId, opts) {
  const re = new RegExp(`(<w:style\\b[^>]*w:styleId="${styleId}"[^>]*>)([\\s\\S]*?)(</w:style>)`);
  return xml.replace(re, (_, a, inner, c) => {
    let s = inner;
    s = /<w:rPr>/.test(s) ? s.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/, (__, r) => `<w:rPr>${setRPr(r, opts)}</w:rPr>`) : s + `<w:rPr>${setRPr("", opts)}</w:rPr>`;
    if (opts.jc || opts.line) {
      const ppr = `${opts.line ? `<w:spacing w:line="${opts.line}" w:lineRule="exact"/>` : ""}${opts.jc ? `<w:jc w:val="${opts.jc}"/>` : ""}`;
      s = /<w:pPr>/.test(s)
        ? s.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/, (__, p) => `<w:pPr>${p.replace(opts.line ? /<w:spacing\b[^>]*\/>/g : /$^/, "").replace(opts.jc ? /<w:jc\b[^>]*\/>/g : /$^/, "")}${ppr}</w:pPr>`)
        : s.replace(/(<w:rPr>)/, `<w:pPr>${ppr}</w:pPr>$1`);
    }
    return a + s + c;
  });
}
const CJK = "\\u4e00-\\u9fff";
export function fixText(t) {
  return t
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(new RegExp(`([${CJK}]),(?=\\s*[${CJK}])`, "g"), "$1，")
    .replace(new RegExp(`([${CJK}]);`, "g"), "$1；")
    .replace(new RegExp(`([${CJK}]):(?=[${CJK}])`, "g"), "$1：")
    .replace(new RegExp(`([${CJK}])\\?`, "g"), "$1？")
    .replace(new RegExp(`([${CJK}])!`, "g"), "$1！")
    .replace(/^\(([一二三四五六七八九十\d]+)\)/, "（$1）");
}

/**
 * 自動修正：樣式（內文、標題、圖表標題）的字型字級對齊行距、內文段落的直接格式、全半形、updateFields。
 * 不會修改的：架構、標號層級、圖表位置、口語用詞、破折號、參考文獻內容（需人工判斷）。
 */
export async function fixDocx(buf) {
  const { zip, doc, styles, settings } = await openDocx(buf);
  const st = parseStyles(styles);
  const headingIds = Object.values(st.styles).filter((s) => /^heading \d$|^標題 \d$/i.test(s.name)).map((s) => ({ id: s.id, level: Number(/(\d)$/.exec(s.name)[1]) }));
  const captionId = Object.values(st.styles).find((s) => /^caption$|^標號$/i.test(s.name))?.id;
  let newStyles = styles.replace(/<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/, `<w:rPrDefault><w:rPr>${setRPr("", { sz: RULES.bodySz })}</w:rPr></w:rPrDefault>`);
  newStyles = fixStyle(newStyles, st.normal, { sz: RULES.bodySz, bold: false, jc: "both", line: 360 });
  for (const h of headingIds) newStyles = fixStyle(newStyles, h.id, { sz: h.level === 1 ? RULES.h1Sz : RULES.h2Sz, bold: true });
  if (captionId) newStyles = fixStyle(newStyles, captionId, { sz: RULES.captionSz });
  const headingSet = new Set([...headingIds.map((h) => h.id), captionId].filter(Boolean));
  let changed = 0;
  // 內文段落：移除與規範衝突的直接格式、改為兩端對齊、修正全半形
  const newDoc = doc.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (p) => {
    const sid = attr(/<w:pStyle\b[^>]*\/>/.exec(p)?.[0], "w:val");
    if (sid && headingSet.has(sid)) return p;
    const isCaption = /^(圖|表)\s*\d/.test(textOf(p).trim());
    // 圖表標題：沒有格式設定的文字段也補上 14pt
    let q = isCaption ? p.replace(/<w:r>(?!<w:rPr>)/g, "<w:r><w:rPr></w:rPr>").replace(/<w:r( [^>]*)>(?!<w:rPr>)/g, "<w:r$1><w:rPr></w:rPr>") : p;
    q = q.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (_, r) => `<w:rPr>${r.replace(/<w:rFonts\b[^>]*\/>/g, "").replace(/<w:sz\b[^>]*\/>|<w:szCs\b[^>]*\/>/g, "")}${isCaption ? `<w:sz w:val="${RULES.captionSz}"/><w:szCs w:val="${RULES.captionSz}"/>` : ""}</w:rPr>`);
    if (!isCaption) q = q.replace(/<w:jc w:val="(left|start)"\/>/g, '<w:jc w:val="both"/>');
    q = q.replace(/(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g, (_, a, t, c) => a + fixText(t) + c);
    if (q !== p) changed++;
    return q;
  });
  let newSettings = settings;
  if (settings && !/<w:updateFields\b/.test(settings)) newSettings = settings.replace(/<\/w:settings>/, '<w:updateFields w:val="true"/></w:settings>');
  zip.file("word/document.xml", newDoc);
  zip.file("word/styles.xml", newStyles);
  if (newSettings) zip.file("word/settings.xml", newSettings);
  return { buf: Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })), changedParagraphs: changed };
}
