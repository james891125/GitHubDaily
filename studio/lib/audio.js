// 音檔前處理（ffmpeg）：轉成語音專用的小檔案，必要時自動切段。
// ffmpeg 來源順序：環境變數 FFMPEG_PATH → npm 套件 ffmpeg-static（npm install 時自動下載）→ 系統 PATH。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let cached;
export function findFfmpeg() {
  if (cached !== undefined) return cached;
  const candidates = [process.env.FFMPEG_PATH];
  try {
    candidates.push(require("ffmpeg-static"));
  } catch {
    /* 未安裝 ffmpeg-static */
  }
  for (const c of candidates) if (c && fs.existsSync(c)) return (cached = c);
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], { encoding: "utf8" });
  cached = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() || null : null;
  return cached;
}

function run(ffmpeg, args, { signal, timeout = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    const t = setTimeout(() => p.kill(), timeout);
    const onAbort = () => p.kill();
    signal?.addEventListener("abort", onAbort);
    p.on("error", (e) => (clearTimeout(t), reject(e)));
    p.on("exit", (code) => {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("已取消"));
      if (code === 0) resolve(err);
      else reject(Object.assign(new Error(`音檔處理失敗（檔案可能已損毀或不是音訊）：${err.split("\n").filter(Boolean).slice(-2).join(" ")}`), { status: 422 }));
    });
  });
}

/** 取得音檔長度（秒） */
export async function probeDuration(file) {
  const ff = findFfmpeg();
  if (!ff) return null;
  const out = await new Promise((resolve) => {
    const p = spawn(ff, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", () => resolve(err));
    p.on("error", () => resolve(""));
  });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * 將音檔轉成適合語音辨識的 MP3（單聲道、16 kHz、32 kbps，一小時約 14 MB），
 * 若仍超過大小上限則切成多段。
 * @returns {Promise<{ chunks: Array<{ buf: Buffer, offset: number }>, duration: number|null, converted: boolean }>}
 */
export async function prepareAudio(buf, ext, { limitBytes, segmentSec, force = false, signal, log = () => {} } = {}) {
  const ff = findFfmpeg();
  const needs = force || buf.length > limitBytes;
  if (!needs) return { chunks: [{ buf, offset: 0 }], duration: null, converted: false };
  if (!ff) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-audio-"));
  try {
    const input = path.join(dir, "input" + (ext || ".bin"));
    fs.writeFileSync(input, buf);
    const duration = await probeDuration(input);
    const small = path.join(dir, "speech.mp3");
    log(`轉換為語音專用格式（單聲道 16 kHz MP3）${duration ? `，長度 ${Math.round(duration / 60)} 分鐘` : ""}…`);
    await run(ff, ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", small], { signal });
    const out = fs.readFileSync(small);
    if (out.length <= limitBytes) return { chunks: [{ buf: out, offset: 0 }], duration, converted: true };
    // 依大小上限推算每段秒數（保留 10% 餘裕），也可由環境變數指定
    const sec = segmentSec || Math.max(60, Math.floor(((limitBytes * 0.9) / (32000 / 8)) / 60) * 60);
    log(`錄音較長，切成每段約 ${Math.round(sec / 60) || 1} 分鐘分批轉錄…`);
    await run(ff, ["-y", "-i", small, "-f", "segment", "-segment_time", String(sec), "-c", "copy", "-reset_timestamps", "1", path.join(dir, "part%03d.mp3")], { signal });
    const parts = fs
      .readdirSync(dir)
      .filter((f) => /^part\d+\.mp3$/.test(f))
      .sort();
    const chunks = [];
    let offset = 0;
    for (const f of parts) {
      const p = path.join(dir, f);
      const d = (await probeDuration(p)) ?? sec;
      chunks.push({ buf: fs.readFileSync(p), offset });
      offset += d;
    }
    return { chunks, duration, converted: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
