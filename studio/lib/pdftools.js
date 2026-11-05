// PDF 工具（不使用 AI）：合併、分割／擷取頁面、旋轉、加浮水印、加頁碼、壓縮、圖片轉 PDF。
// 參考 Stirling-PDF 的常用功能；以 pdf-lib 處理，中文文字先用 sharp 轉成圖片再嵌入（不需另外安裝字型）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { PDFDocument, PDFName, PDFRawStream, PDFNumber, StandardFonts, degrees, rgb } from "pdf-lib";
import sharp from "sharp";

const userError = (msg) => Object.assign(new Error(msg), { status: 422 });

export async function loadPdf(buf, name = "PDF") {
  if (!buf?.length) throw userError(`「${name}」是空的檔案`);
  if (buf.subarray(0, 1024).indexOf("%PDF") < 0) throw userError(`「${name}」不是 PDF 檔`);
  let doc;
  try {
    doc = await PDFDocument.load(buf, { ignoreEncryption: false, updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e.message)) throw userError(`「${name}」有密碼保護，請先用原軟體解除密碼後再處理`);
    throw userError(`「${name}」無法讀取（檔案可能已損毀）：${e.message}`);
  }
  let pages = 0;
  try {
    pages = doc.getPageCount();
  } catch {
    /* 損毀的頁面樹 */
  }
  if (!pages) throw userError(`「${name}」無法讀取（檔案可能已損毀或沒有任何頁面）`);
  return doc;
}

/**
 * 解析頁碼範圍，例如 "1-3, 5, 8-"、"末頁"、"3,1,2"（保留順序）。回傳 0 起算的頁碼陣列。
 */
export function parseRanges(spec, total) {
  const s = String(spec ?? "")
    .replace(/[，、；;]/g, ",")
    .replace(/[－—～~到至]/g, "-")
    .replace(/\s+/g, "")
    .replace(/末頁|最後一頁|last/gi, String(total));
  if (!s) return Array.from({ length: total }, (_, i) => i);
  const out = [];
  for (const part of s.split(",").filter(Boolean)) {
    const m = /^(\d*)-(\d*)$/.exec(part);
    let a, b;
    if (m) {
      a = m[1] ? Number(m[1]) : 1;
      b = m[2] ? Number(m[2]) : total;
    } else if (/^\d+$/.test(part)) a = b = Number(part);
    else throw userError(`頁碼「${part}」格式不正確，請用例如「1-3, 5, 8-」的寫法`);
    if (a < 1 || b < 1 || a > total || b > total) throw userError(`頁碼「${part}」超出範圍（此檔共 ${total} 頁）`);
    const step = a <= b ? 1 : -1;
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) out.push(i - 1);
  }
  return out;
}

const save = (doc) => doc.save({ useObjectStreams: true });

/** 合併多個 PDF（依提供順序） */
export async function mergePdfs(items) {
  if (items.length < 2) throw userError("合併至少需要 2 個 PDF 檔");
  const out = await PDFDocument.create();
  for (const it of items) {
    const src = await loadPdf(it.buf, it.name);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return { buf: Buffer.from(await save(out)), pages: out.getPageCount() };
}

/** 依頁碼擷取（也可用來重新排序、刪除頁面） */
export async function extractPages(buf, spec, name) {
  const src = await loadPdf(buf, name);
  const idx = parseRanges(spec, src.getPageCount());
  const out = await PDFDocument.create();
  (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
  return { buf: Buffer.from(await save(out)), pages: idx.length, total: src.getPageCount() };
}

/** 刪除指定頁面 */
export async function deletePages(buf, spec, name) {
  const src = await loadPdf(buf, name);
  const total = src.getPageCount();
  const del = new Set(parseRanges(spec, total));
  const keep = src.getPageIndices().filter((i) => !del.has(i));
  if (!keep.length) throw userError("不能刪除全部頁面");
  const out = await PDFDocument.create();
  (await out.copyPages(src, keep)).forEach((p) => out.addPage(p));
  return { buf: Buffer.from(await save(out)), pages: keep.length, total };
}

/**
 * 分割：mode "each"＝每頁一個檔；"every"＝每 N 頁一個檔；"ranges"＝依「1-3; 4-6」分組（分號或換行分隔各檔）
 * @returns {Promise<Array<{ label: string, buf: Buffer, pages: number }>>}
 */
export async function splitPdf(buf, { mode = "each", every = 1, ranges = "", name } = {}) {
  const src = await loadPdf(buf, name);
  const total = src.getPageCount();
  let groups = [];
  if (mode === "ranges") {
    const parts = String(ranges)
      .split(/[;；\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!parts.length) throw userError("請輸入分割範圍，例如「1-3; 4-6; 7-」（每組用分號分隔）");
    groups = parts.map((p) => ({ label: p.replace(/\s+/g, ""), idx: parseRanges(p, total) }));
  } else {
    const n = mode === "every" ? Math.max(1, Math.floor(Number(every) || 1)) : 1;
    for (let i = 0; i < total; i += n) {
      const idx = Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k);
      groups.push({ label: idx.length > 1 ? `${i + 1}-${i + idx.length}` : String(i + 1), idx });
    }
  }
  if (groups.length > 500) throw userError(`會產生 ${groups.length} 個檔案，請改用「每 N 頁一個檔」減少檔案數`);
  const out = [];
  for (const g of groups) {
    const d = await PDFDocument.create();
    (await d.copyPages(src, g.idx)).forEach((p) => d.addPage(p));
    out.push({ label: g.label, buf: Buffer.from(await save(d)), pages: g.idx.length });
  }
  return out;
}

/** 旋轉頁面（90 的倍數），spec 空白＝全部 */
export async function rotatePdf(buf, angle = 90, spec = "", name) {
  const doc = await loadPdf(buf, name);
  const a = ((Math.round(Number(angle) / 90) * 90) % 360 + 360) % 360;
  const idx = parseRanges(spec, doc.getPageCount());
  for (const i of idx) {
    const p = doc.getPage(i);
    p.setRotation(degrees((p.getRotation().angle + a) % 360));
  }
  return { buf: Buffer.from(await save(doc)), pages: idx.length };
}

const escXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const FONT_STACK = "'Noto Sans CJK TC','Noto Sans TC','Microsoft JhengHei','PingFang TC','Heiti TC','WenQuanYi Zen Hei','Noto Sans CJK SC',sans-serif";
// 粗估字寬：全形字 1em、半形 0.6em
const textEm = (s) => [...String(s)].reduce((w, ch) => w + (/[⺀-￿]/.test(ch) ? 1 : 0.6), 0);

/** 把文字轉成透明背景 PNG（高解析度，嵌入 PDF 後縮放） */
async function textPng(text, { px = 96, color = "#808080", bold = true } = {}) {
  const lines = String(text).split(/\n/).filter((l) => l.trim());
  const w = Math.ceil(Math.max(...lines.map(textEm)) * px + px * 0.6);
  const lh = Math.round(px * 1.3);
  const h = lh * lines.length + Math.round(px * 0.4);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><g font-family="${FONT_STACK}" font-size="${px}" font-weight="${bold ? 700 : 400}" fill="${color}" text-anchor="middle">${lines
    .map((l, i) => `<text x="${w / 2}" y="${Math.round(px * 0.2) + lh * i + px}">${escXml(l)}</text>`)
    .join("")}</g></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { png, w, h };
}

const COLORS = { gray: "#808080", red: "#c0392b", blue: "#2a6299", black: "#000000" };

/**
 * 加文字浮水印（支援中文）
 * @param {{ text: string, opacity?: number, size?: number, angle?: number, color?: string, tile?: boolean }} opt
 */
export async function watermarkPdf(buf, { text, opacity = 0.2, size = 48, angle = 45, color = "gray", tile = false, name } = {}) {
  if (!String(text || "").trim()) throw userError("請輸入浮水印文字");
  const doc = await loadPdf(buf, name);
  const { png, w, h } = await textPng(text, { color: COLORS[color] || color });
  const img = await doc.embedPng(png);
  const op = Math.min(1, Math.max(0.05, Number(opacity) || 0.2));
  const fs_ = Math.max(8, Number(size) || 48);
  const ang = Number(angle) || 0;
  const rad = (ang * Math.PI) / 180;
  for (const page of doc.getPages()) {
    const { width: pw, height: ph } = page.getSize();
    const scale = fs_ / 96;
    const dw = w * scale;
    const dh = h * scale;
    const at = (cx, cy) => {
      // 以中心點旋轉：pdf-lib 以左下角為旋轉原點，先算出旋轉後左下角位置
      const x = cx - (dw / 2) * Math.cos(rad) + (dh / 2) * Math.sin(rad);
      const y = cy - (dw / 2) * Math.sin(rad) - (dh / 2) * Math.cos(rad);
      page.drawImage(img, { x, y, width: dw, height: dh, rotate: degrees(ang), opacity: op });
    };
    if (tile) {
      const gx = Math.max(dw, dh) * 1.2;
      const gy = Math.max(dh * 3, gx * 0.7);
      for (let y = gy / 2; y < ph + gy; y += gy) for (let x = gx / 2; x < pw + gx; x += gx) at(x, y);
    } else at(pw / 2, ph / 2);
  }
  return { buf: Buffer.from(await save(doc)), pages: doc.getPageCount() };
}

/**
 * 加頁碼。format 可用 {n}（目前頁）與 {total}（總頁數），例如「第 {n} 頁，共 {total} 頁」或「{n} / {total}」
 * position：bottom-center / bottom-right / top-right；skipFirst：封面不加頁碼
 */
export async function addPageNumbers(buf, { format = "{n}", position = "bottom-center", size = 11, start = 1, skipFirst = false, name } = {}) {
  const doc = await loadPdf(buf, name);
  const pages = doc.getPages();
  const total = pages.length - (skipFirst ? 1 : 0);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const sz = Math.max(6, Number(size) || 11);
  const st = Number(start) || 1;
  for (let i = 0; i < pages.length; i++) {
    if (skipFirst && i === 0) continue;
    const n = i - (skipFirst ? 1 : 0) + st;
    const label = String(format || "{n}").replace(/\{n\}/g, n).replace(/\{total\}/g, total + st - 1);
    const page = pages[i];
    const { width: pw, height: ph } = page.getSize();
    const ascii = /^[\x20-\x7e]*$/.test(label);
    let w, h, draw;
    if (ascii) {
      w = font.widthOfTextAtSize(label, sz);
      h = sz;
      draw = (x, y) => page.drawText(label, { x, y, size: sz, font, color: rgb(0.2, 0.2, 0.2) });
    } else {
      const t = await textPng(label, { px: 64, color: "#333333", bold: false });
      const im = await doc.embedPng(t.png);
      const scale = sz / 64;
      w = t.w * scale;
      h = t.h * scale;
      draw = (x, y) => page.drawImage(im, { x, y: y - h * 0.25, width: w, height: h });
    }
    const margin = 28;
    const x = position.endsWith("right") ? pw - margin - w : position.endsWith("left") ? margin : (pw - w) / 2;
    const y = position.startsWith("top") ? ph - margin - h : margin;
    draw(x, y);
  }
  return { buf: Buffer.from(await save(doc)), pages: pages.length };
}

// ---------- 壓縮 ----------
let gsCached;
export function findGhostscript() {
  if (gsCached !== undefined) return gsCached;
  const names = process.platform === "win32" ? ["gswin64c", "gswin32c", "gs"] : ["gs"];
  const cands = [process.env.GS_PATH].filter(Boolean);
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
      const root = path.join(base, "gs");
      if (fs.existsSync(root)) for (const v of fs.readdirSync(root)) cands.push(path.join(root, v, "bin", "gswin64c.exe"));
    }
  }
  for (const c of cands) if (fs.existsSync(c)) return (gsCached = c);
  for (const n of names) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [n], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return (gsCached = r.stdout.split(/\r?\n/)[0].trim());
  }
  return (gsCached = null);
}

const LEVELS = {
  low: { dpi: 200, quality: 80, gs: "/printer" },
  medium: { dpi: 150, quality: 65, gs: "/ebook" },
  high: { dpi: 100, quality: 50, gs: "/screen" },
};

async function ghostscript(buf, level) {
  const gs = findGhostscript();
  if (!gs) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-gs-"));
  try {
    const input = path.join(dir, "in.pdf");
    const output = path.join(dir, "out.pdf");
    fs.writeFileSync(input, buf);
    await new Promise((resolve, reject) => {
      const p = spawn(gs, ["-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", `-dPDFSETTINGS=${LEVELS[level].gs}`, "-dNOPAUSE", "-dQUIET", "-dBATCH", "-dSAFER", `-sOutputFile=${output}`, input], { stdio: "ignore" });
      const t = setTimeout(() => (p.kill(), reject(userError("Ghostscript 壓縮逾時"))), 10 * 60 * 1000);
      p.on("error", (e) => (clearTimeout(t), reject(e)));
      p.on("exit", (c) => (clearTimeout(t), c === 0 ? resolve() : reject(userError("Ghostscript 壓縮失敗"))));
    });
    return fs.existsSync(output) ? fs.readFileSync(output) : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const num = (v) => (v instanceof PDFNumber ? v.asNumber() : Number(v?.toString?.()));

/** 不靠外部程式：重新壓縮 PDF 內的圖片（JPEG 降解析度與品質；未壓縮或 Flate 的 8 位元 RGB／灰階圖轉 JPEG） */
async function recompressImages(doc, { dpi, quality }) {
  const ctx = doc.context;
  // 遮罩（SMask／Mask）不轉成 JPEG，避免透明邊緣失真
  const masks = new Set();
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj?.dict;
    if (!d) continue;
    for (const k of ["SMask", "Mask"]) {
      const r = d.get(PDFName.of(k));
      if (r?.objectNumber != null) masks.add(r.toString());
    }
  }
  // 以頁面寬度推算圖片最大像素（A4 寬 8.27 英寸）
  const maxPx = Math.round(8.27 * dpi * 1.2);
  let changed = 0;
  let saved = 0;
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(PDFName.of("Subtype"))?.toString() !== "/Image" || masks.has(ref.toString())) continue;
    const filter = d.get(PDFName.of("Filter"))?.toString() || "";
    const w = num(d.get(PDFName.of("Width")));
    const h = num(d.get(PDFName.of("Height")));
    const bpc = num(d.get(PDFName.of("BitsPerComponent")));
    const cs = d.get(PDFName.of("ColorSpace"))?.toString();
    if (!w || !h || w * h < 40000) continue; // 小圖示不處理
    let input;
    try {
      if (filter === "/DCTDecode") {
        if (cs === "/DeviceCMYK") continue;
        input = sharp(Buffer.from(obj.contents));
      } else if ((filter === "/FlateDecode" || filter === "") && bpc === 8 && (cs === "/DeviceRGB" || cs === "/DeviceGray") && !d.get(PDFName.of("DecodeParms")) && !d.get(PDFName.of("Decode"))) {
        const raw = filter ? zlib.inflateSync(Buffer.from(obj.contents)) : Buffer.from(obj.contents);
        const channels = cs === "/DeviceRGB" ? 3 : 1;
        if (raw.length < w * h * channels) continue;
        input = sharp(raw.subarray(0, w * h * channels), { raw: { width: w, height: h, channels } });
      } else continue;
      const scale = Math.min(1, maxPx / Math.max(w, h));
      const nw = Math.max(1, Math.round(w * scale));
      const nh = Math.max(1, Math.round(h * scale));
      const gray = cs === "/DeviceGray";
      let pipe = input.resize(nw, nh, { fit: "fill" });
      if (gray) pipe = pipe.toColourspace("b-w");
      const out = await pipe.jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" }).toBuffer();
      if (out.length >= obj.contents.length * 0.9) continue;
      const nd = d.clone(ctx);
      nd.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
      nd.set(PDFName.of("Width"), ctx.obj(nw));
      nd.set(PDFName.of("Height"), ctx.obj(nh));
      nd.set(PDFName.of("BitsPerComponent"), ctx.obj(8));
      nd.set(PDFName.of("ColorSpace"), PDFName.of(gray ? "DeviceGray" : "DeviceRGB"));
      nd.delete(PDFName.of("DecodeParms"));
      nd.delete(PDFName.of("Length"));
      ctx.assign(ref, PDFRawStream.of(nd, out));
      saved += obj.contents.length - out.length;
      changed++;
    } catch {
      /* 無法處理的圖片保持原樣 */
    }
  }
  return { changed, saved };
}

/**
 * 壓縮 PDF。優先使用 Ghostscript（若有安裝）；否則重新壓縮內嵌圖片並整理物件結構。
 * level：low（品質優先）／medium／high（檔案最小）
 */
export async function compressPdf(buf, { level = "medium", name } = {}) {
  const lv = LEVELS[level] ? level : "medium";
  const doc = await loadPdf(buf, name);
  const before = buf.length;
  const candidates = [];
  let method = "";
  const gsOut = await ghostscript(buf, lv).catch(() => null);
  if (gsOut) candidates.push({ buf: gsOut, method: "Ghostscript" });
  const r = await recompressImages(doc, LEVELS[lv]);
  candidates.push({ buf: Buffer.from(await save(doc)), method: r.changed ? `重新壓縮 ${r.changed} 張圖片` : "整理檔案結構" });
  let best = candidates.reduce((a, b) => (b.buf.length < a.buf.length ? b : a));
  if (best.buf.length >= before) best = { buf, method: "原檔已是最佳化狀態" };
  method = best.method;
  return {
    buf: best.buf,
    before,
    after: best.buf.length,
    pages: doc.getPageCount(),
    method,
    ghostscript: !!findGhostscript(),
  };
}

/** 多張圖片轉成一個 PDF。pageSize：fit（依圖片大小）／a4（置中縮放至 A4，保留邊界） */
export async function imagesToPdf(items, { pageSize = "a4", margin = 36 } = {}) {
  if (!items.length) throw userError("請選擇至少一張圖片");
  const doc = await PDFDocument.create();
  for (const it of items) {
    let img;
    try {
      const meta = await sharp(it.buf).metadata();
      const rotated = sharp(it.buf).rotate(); // 依 EXIF 方向轉正
      const isJpeg = meta.format === "jpeg" && !meta.orientation;
      const data = isJpeg ? it.buf : meta.hasAlpha || meta.format === "png" ? await rotated.png().toBuffer() : await rotated.jpeg({ quality: 90 }).toBuffer();
      img = isJpeg || (!meta.hasAlpha && meta.format !== "png") ? await doc.embedJpg(data) : await doc.embedPng(data);
    } catch (e) {
      throw userError(`「${it.name}」無法讀取為圖片：${e.message.split("\n")[0]}`);
    }
    if (pageSize === "fit") {
      const page = doc.addPage([img.width * 0.75, img.height * 0.75]);
      page.drawImage(img, { x: 0, y: 0, width: img.width * 0.75, height: img.height * 0.75 });
    } else {
      const landscape = img.width > img.height;
      const [pw, ph] = landscape ? [841.89, 595.28] : [595.28, 841.89];
      const page = doc.addPage([pw, ph]);
      const s = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height, 1.5);
      const w = img.width * s;
      const h = img.height * s;
      page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
  }
  return { buf: Buffer.from(await save(doc)), pages: doc.getPageCount() };
}

export async function pdfInfo(buf, name) {
  const doc = await loadPdf(buf, name);
  return { pages: doc.getPageCount(), title: doc.getTitle() || "", size: buf.length };
}
