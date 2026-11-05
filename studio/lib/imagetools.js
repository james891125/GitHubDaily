// 圖片批次處理（不使用 AI）：縮放、轉格式、壓縮、移除中繼資料（含 GPS 位置）、依 EXIF 轉正。
import sharp from "sharp";

const userError = (msg) => Object.assign(new Error(msg), { status: 422 });

export const IMAGE_INPUT = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".bmp", ".avif", ".svg", ".heic", ".heif"];
export const IMAGE_FORMATS = { keep: "維持原格式", jpg: "JPG（照片，檔案小）", png: "PNG（截圖、需透明背景）", webp: "WebP（網頁用，最小）" };

const EXT = { jpeg: "jpg", jpg: "jpg", png: "png", webp: "webp", gif: "gif", tiff: "tif", avif: "avif", svg: "png", heif: "jpg" };

/**
 * 處理單張圖片
 * @param {Buffer} buf
 * @param {{ width?: number, height?: number, fit?: "inside"|"cover"|"fill", percent?: number, format?: string, quality?: number, keepMeta?: boolean, maxKB?: number, noEnlarge?: boolean }} opt
 */
export async function processImage(buf, name, opt = {}) {
  let meta;
  try {
    meta = await sharp(buf, { animated: false }).metadata();
  } catch (e) {
    if (/\.hei[cf]$/i.test(name)) throw userError(`「${name}」是 HEIC 格式，目前無法直接讀取。請在 iPhone「設定 → 相機 → 格式」改為「最相容」，或先轉成 JPG 後再上傳`);
    throw userError(`「${name}」無法讀取為圖片：${e.message.split("\n")[0]}`);
  }
  const srcFmt = meta.format === "heif" ? "jpg" : EXT[meta.format] || "png";
  let fmt = !opt.format || opt.format === "keep" ? srcFmt : opt.format;
  const quality = Math.min(100, Math.max(10, Number(opt.quality) || 80));
  const make = async (q, extraScale = 1) => {
    let p = sharp(buf, { animated: false }).rotate(); // 依 EXIF 方向轉正
    const ow = meta.autoOrient?.width || (meta.orientation >= 5 ? meta.height : meta.width);
    const oh = meta.autoOrient?.height || (meta.orientation >= 5 ? meta.width : meta.height);
    let w = Number(opt.width) || null;
    let h = Number(opt.height) || null;
    if (Number(opt.percent) > 0) {
      w = Math.round((ow * Number(opt.percent)) / 100);
      h = null;
    }
    if (extraScale < 1) {
      w = Math.round((w || ow) * extraScale);
      h = h ? Math.round(h * extraScale) : null;
    }
    if (w || h) p = p.resize({ width: w || undefined, height: h || undefined, fit: opt.fit || "inside", withoutEnlargement: opt.noEnlarge !== false });
    if (opt.keepMeta) p = p.keepMetadata();
    if (fmt === "jpg") p = p.flatten({ background: "#ffffff" }).jpeg({ quality: q, mozjpeg: true });
    else if (fmt === "png") p = p.png({ compressionLevel: 9, palette: q < 90, quality: q });
    else if (fmt === "webp") p = p.webp({ quality: q });
    else if (fmt === "avif") p = p.avif({ quality: q });
    else if (fmt === "tif") p = p.tiff({ quality: q, compression: "jpeg" });
    else if (fmt === "gif") p = p.gif();
    return p.toBuffer({ resolveWithObject: true });
  };
  let r = await make(quality);
  // 指定檔案大小上限：逐步降低品質，仍太大再縮小尺寸
  const maxBytes = Number(opt.maxKB) > 0 ? Number(opt.maxKB) * 1024 : 0;
  if (maxBytes && r.data.length > maxBytes) {
    for (const q of [70, 60, 50, 40, 30]) {
      if (q >= quality) continue;
      r = await make(q);
      if (r.data.length <= maxBytes) break;
    }
    for (let s = 0.8; r.data.length > maxBytes && s > 0.2; s -= 0.15) r = await make(30, s);
  }
  return { buf: r.data, ext: fmt, width: r.info.width, height: r.info.height, before: buf.length, after: r.data.length, srcWidth: meta.width, srcHeight: meta.height };
}

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 批次處理，回傳結果與 Markdown 摘要表 */
export async function batchImages(items, opt = {}, { log = () => {} } = {}) {
  if (!items.length) throw userError("請選擇至少一張圖片");
  const results = [];
  const errors = [];
  for (const it of items) {
    try {
      const r = await processImage(it.buf, it.name, opt);
      const base = it.name.replace(/\.[^.]+$/, "");
      results.push({ ...r, name: `${base}${opt.suffix ?? ""}.${r.ext}`, src: it.name });
      log(`${it.name}：${r.srcWidth}×${r.srcHeight} → ${r.width}×${r.height}，${kb(r.before)} → ${kb(r.after)}`);
    } catch (e) {
      errors.push({ name: it.name, error: e.message });
      log(`${it.name}：${e.message}`);
    }
  }
  if (!results.length) throw userError(errors[0]?.error || "沒有可處理的圖片");
  // 檔名重複時加序號
  const seen = new Map();
  for (const r of results) {
    const n = seen.get(r.name) || 0;
    seen.set(r.name, n + 1);
    if (n) r.name = r.name.replace(/(\.[^.]+)$/, `-${n + 1}$1`);
  }
  const before = results.reduce((a, r) => a + r.before, 0);
  const after = results.reduce((a, r) => a + r.after, 0);
  const md =
    `# 圖片批次處理結果\n\n共 ${results.length} 張${errors.length ? `（${errors.length} 張失敗）` : ""}，總大小 ${kb(before)} → ${kb(after)}（${before ? Math.round((1 - after / before) * 100) : 0}%）。\n\n` +
    "| 原檔 | 原尺寸 | 新檔 | 新尺寸 | 原大小 | 新大小 |\n|---|---|---|---|---|---|\n" +
    results.map((r) => `| ${r.src} | ${r.srcWidth}×${r.srcHeight} | ${r.name} | ${r.width}×${r.height} | ${kb(r.before)} | ${kb(r.after)} |`).join("\n") +
    (errors.length ? `\n\n## 無法處理的檔案\n\n${errors.map((e) => `- ${e.name}：${e.error}`).join("\n")}` : "");
  return { results, errors, before, after, markdown: md };
}
