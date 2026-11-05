// 圖表產生：流程圖、組織圖、心智圖、甘特圖。
// 參考 Mermaid、SimpleMindMap 的概念，但使用更直覺的中文寫法，並在本機繪製成 SVG／PNG（不需瀏覽器）。
// 寫法（AI 也會先轉成這種寫法，使用者可修改後重新產生）：
//   流程圖：每行「步驟A -> 步驟B -> 步驟C」，可加條件「審核？ -[通過]-> 核發」
//   組織圖／心智圖：縮排大綱（空白、Tab 或「-」「1.」「一、」開頭皆可）
//   甘特圖：每行「工作項目, 開始日期, 結束日期或天數」，以「階段名稱：」分組
import dagreMod from "@dagrejs/dagre";
import sharp from "sharp";

const dagre = dagreMod.default || dagreMod;
const userError = (m) => Object.assign(new Error(m), { status: 422 });

const FONT = "'Noto Sans CJK TC','Noto Sans TC','Microsoft JhengHei','PingFang TC','Heiti TC','WenQuanYi Zen Hei',sans-serif";
const INK = "#222a33";
const MUTED = "#5f6b78";
const LINE = "#8a97a6";
const BLUE = "#2a6299";
const BLUE_BG = "#e8eff7";
const AMBER = "#9a6700";
const AMBER_BG = "#fff4dc";
const GRID = "#e3e7ec";
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
const isCjk = (ch) => /[⺀-鿿豈-﫿＀-￯]/.test(ch);
export const textWidth = (s, size) => [...String(s)].reduce((w, c) => w + (isCjk(c) ? 1 : /[A-Z0-9mw]/.test(c) ? 0.62 : 0.52), 0) * size;

/** 依最大寬度斷行 */
function wrap(text, size, maxW) {
  const lines = [];
  for (const para of String(text).split(/\\n|\n/)) {
    let line = "";
    for (const tok of para.match(/[A-Za-z0-9][\w.\-/%]*\s*|./gu) || []) {
      if (line && textWidth(line + tok, size) > maxW) lines.push(line.trim()), (line = tok.trimStart());
      else line += tok;
    }
    lines.push(line.trim());
  }
  return lines.filter((l, i) => l || i === 0);
}
const textLines = (lines, cx, cy, size, fill = INK, weight = 400) => {
  const lh = size * 1.3;
  const y0 = cy - ((lines.length - 1) * lh) / 2 + size * 0.36;
  return `<text font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="middle">${lines.map((l, i) => `<tspan x="${cx.toFixed(1)}" y="${(y0 + i * lh).toFixed(1)}">${esc(l)}</tspan>`).join("")}</text>`;
};
const svgDoc = (w, h, body, title = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" font-family="${FONT}"><rect width="100%" height="100%" fill="#ffffff"/>${
    title ? `<text x="${(w / 2).toFixed(1)}" y="30" font-size="18" font-weight="700" fill="${INK}" text-anchor="middle">${esc(title)}</text>` : ""
  }${body}</svg>`;

// ======================= 流程圖 =======================
const ARROW = /\s*(?:-\[([^\]]*)\]->|--\s*([^-<>]+?)\s*-->|->|→|=>|⇒|-->)\s*/;
const TERMINAL = /^(開始|結束|完成|結案|start|end|begin|finish)$/i;

export function parseFlow(text) {
  const nodes = new Map();
  const edges = [];
  const add = (label) => {
    const t = label.trim().replace(/^["「『]|["」』]$/g, "");
    if (!t) return null;
    if (!nodes.has(t)) nodes.set(t, { id: `n${nodes.size}`, label: t, shape: /[?？]$/.test(t) ? "decision" : TERMINAL.test(t) ? "terminal" : "process" });
    return nodes.get(t);
  };
  for (const raw of String(text).split(/\n/)) {
    const line = raw.replace(/^\s*([-*•]|\d+[.、)])\s*/, "").trim();
    if (!line || /^(#|\/\/|```|flowchart|graph)/i.test(line)) continue;
    // 逐段切開「A -> B -[是]-> C」
    const parts = [];
    let rest = line;
    let m;
    while ((m = ARROW.exec(rest))) {
      parts.push(rest.slice(0, m.index));
      parts.push({ label: (m[1] ?? m[2] ?? "").trim() });
      rest = rest.slice(m.index + m[0].length);
    }
    parts.push(rest);
    if (parts.length === 1) {
      add(parts[0]);
      continue;
    }
    for (let i = 0; i + 2 < parts.length; i += 2) {
      const a = add(parts[i]);
      const b = add(parts[i + 2]);
      if (a && b) edges.push({ from: a.id, to: b.id, label: parts[i + 1].label });
    }
  }
  if (!nodes.size) throw userError("沒有讀到任何步驟。請用「步驟A -> 步驟B」的寫法，每行一條流程");
  if (nodes.size > 150) throw userError(`步驟太多（${nodes.size} 個），請分成多張圖`);
  return { nodes: [...nodes.values()], edges };
}

export function renderFlow({ nodes, edges }, { direction = "TB", title = "" } = {}) {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: direction === "LR" ? "LR" : "TB", nodesep: 36, ranksep: 46, edgesep: 16, marginx: 24, marginy: title ? 56 : 24 });
  g.setDefaultEdgeLabel(() => ({}));
  const size = 15;
  for (const n of nodes) {
    n.lines = wrap(n.label, size, n.shape === "decision" ? 130 : 170);
    const tw = Math.max(...n.lines.map((l) => textWidth(l, size)));
    const th = n.lines.length * size * 1.3;
    let w = Math.max(tw + 32, 90);
    let h = th + 22;
    if (n.shape === "decision") (w = Math.max(tw * 1.55 + 30, 120)), (h = Math.max(th * 1.7 + 26, 64));
    g.setNode(n.id, { width: w, height: h });
  }
  edges.forEach((e, i) => g.setEdge(e.from, e.to, e.label ? { label: e.label, width: textWidth(e.label, 13) + 12, height: 20, labelpos: "c" } : {}, `e${i}`));
  dagre.layout(g);
  const out = [];
  out.push(`<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${LINE}"/></marker></defs>`);
  for (const e of g.edges()) {
    const ed = g.edge(e);
    const pts = ed.points;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    out.push(`<path d="${d}" fill="none" stroke="${LINE}" stroke-width="1.6" marker-end="url(#arr)"/>`);
    if (ed.label) {
      const w = textWidth(ed.label, 13) + 10;
      out.push(`<rect x="${(ed.x - w / 2).toFixed(1)}" y="${(ed.y - 10).toFixed(1)}" width="${w.toFixed(1)}" height="20" rx="3" fill="#ffffff"/><text x="${ed.x.toFixed(1)}" y="${(ed.y + 4.5).toFixed(1)}" font-size="13" fill="${MUTED}" text-anchor="middle">${esc(ed.label)}</text>`);
    }
  }
  for (const n of nodes) {
    const { x, y, width: w, height: h } = g.node(n.id);
    if (n.shape === "decision") out.push(`<polygon points="${x},${y - h / 2} ${x + w / 2},${y} ${x},${y + h / 2} ${x - w / 2},${y}" fill="${AMBER_BG}" stroke="${AMBER}" stroke-width="1.6"/>`);
    else out.push(`<rect x="${(x - w / 2).toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${n.shape === "terminal" ? h / 2 : 6}" fill="${n.shape === "terminal" ? BLUE : BLUE_BG}" stroke="${BLUE}" stroke-width="1.6"/>`);
    out.push(textLines(n.lines, x, y, size, n.shape === "terminal" ? "#ffffff" : INK, n.shape === "terminal" ? 700 : 400));
  }
  const gr = g.graph();
  return svgDoc(Math.max(gr.width, title ? textWidth(title, 18) + 40 : 0), gr.height, out.join(""), title);
}

// ======================= 大綱（組織圖、心智圖） =======================
export function parseOutline(text) {
  const rows = [];
  // Tab 視為一層（兩個空白）
  for (const raw of String(text).replace(/\t/g, "  ").split(/\n/)) {
    if (!raw.trim() || /^\s*(\/\/|%%|```|mindmap)/.test(raw)) continue;
    const m = /^(\s*)(?:[-*•+]\s+|\d+[.、)]\s*|[一二三四五六七八九十]+、\s*|[（(][一二三四五六七八九十\d]+[）)]\s*)?(.*)$/.exec(raw);
    const md = /^(#{1,6})\s+(.*)/.exec(raw.trim());
    rows.push(md ? { depth: md[1].length - 1, text: md[2].trim() } : { indent: m[1].length, text: m[2].trim() });
  }
  if (!rows.length) throw userError("沒有讀到任何內容。請用縮排大綱，每一層多縮排兩個空白，或用「-」開頭");
  // 縮排寬度換算成層級
  const indents = [...new Set(rows.filter((r) => r.indent !== undefined).map((r) => r.indent))].sort((a, b) => a - b);
  for (const r of rows) if (r.depth === undefined) r.depth = indents.indexOf(r.indent);
  const root = { text: "", children: [] };
  const stack = [{ node: root, depth: -1 }];
  for (const r of rows) {
    while (stack.length > 1 && stack.at(-1).depth >= r.depth) stack.pop();
    const node = { text: r.text, children: [] };
    stack.at(-1).node.children.push(node);
    stack.push({ node, depth: r.depth });
  }
  const count = (n) => 1 + n.children.reduce((a, c) => a + count(c), 0);
  if (count(root) - 1 > 200) throw userError("項目太多（超過 200 個），請分成多張圖");
  return root.children.length === 1 ? root.children[0] : { text: "", children: root.children };
}

/** 組織圖：由上而下；子項目都是末端且超過 4 個時改為直向排列，避免太寬 */
export function renderOrg(tree, { title = "" } = {}) {
  const size = 14;
  const gapX = 18;
  const gapY = 46;
  const measure = (n, depth) => {
    n.depth = depth;
    n.lines = wrap(n.text || "（未命名）", size, 160);
    n.w = Math.max(Math.max(...n.lines.map((l) => textWidth(l, size))) + 28, 84);
    n.h = n.lines.length * size * 1.3 + 18;
    n.children.forEach((c) => measure(c, depth + 1));
    n.stack = n.children.length > 4 && n.children.every((c) => !c.children.length);
    if (n.stack) {
      const cw = Math.max(...n.children.map((c) => c.w));
      n.children.forEach((c) => (c.w = cw));
      n.tw = Math.max(n.w, cw + 24);
      n.th = n.children.reduce((a, c) => a + c.h + 10, 0);
    } else n.tw = Math.max(n.w, n.children.reduce((a, c) => a + c.tw, 0) + gapX * Math.max(0, n.children.length - 1));
  };
  const hasRoot = !!tree.text;
  measure(tree, 0);
  const levelH = [];
  const collect = (n) => {
    levelH[n.depth] = Math.max(levelH[n.depth] || 0, n.h);
    if (!n.stack) n.children.forEach(collect);
  };
  collect(tree);
  const top0 = title ? 56 : 20;
  const levelY = [];
  levelH.reduce((y, h, i) => ((levelY[i] = y), y + h + gapY), top0 - (hasRoot ? 0 : levelH[0] + gapY));
  const out = [];
  let maxY = 0;
  const box = (n, x, y, fill, stroke, ink, weight) => {
    out.push(`<rect x="${(x - n.w / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`);
    out.push(textLines(n.lines, x, y + n.h / 2, size, ink, weight));
    maxY = Math.max(maxY, y + n.h);
  };
  const place = (n, left) => {
    const x = left + n.tw / 2;
    const y = levelY[n.depth];
    const show = n.depth > 0 || hasRoot;
    if (show) box(n, x, y, n.depth === 0 ? BLUE : n.depth === 1 ? BLUE_BG : "#ffffff", BLUE, n.depth === 0 ? "#ffffff" : INK, n.depth <= 1 ? 700 : 400);
    if (!n.children.length) return x;
    if (n.stack) {
      let cy = y + n.h + 14;
      const lx = x - n.children[0].w / 2 - 12;
      for (const c of n.children) {
        box(c, x + 6, cy, "#ffffff", LINE, INK, 400);
        out.push(`<path d="M${lx},${(cy + c.h / 2).toFixed(1)} H${(x + 6 - c.w / 2).toFixed(1)}" stroke="${LINE}" stroke-width="1.4" fill="none"/>`);
        cy += c.h + 10;
      }
      out.push(`<path d="M${x},${y + n.h} V${y + n.h + 7} H${lx} V${(cy - 10 - n.children.at(-1).h / 2).toFixed(1)}" stroke="${LINE}" stroke-width="1.4" fill="none"/>`);
      return x;
    }
    let cl = left + (n.tw - (n.children.reduce((a, c) => a + c.tw, 0) + gapX * (n.children.length - 1))) / 2;
    const xs = n.children.map((c) => {
      const cx = place(c, cl);
      cl += c.tw + gapX;
      return cx;
    });
    if (show) {
      const midY = y + n.h + gapY / 2;
      const cy = levelY[n.depth + 1];
      out.push(`<path d="M${x},${y + n.h} V${midY} ${xs.length > 1 ? `M${xs[0]},${midY} H${xs.at(-1)}` : ""} ${xs.map((cx) => `M${cx},${midY} V${cy}`).join(" ")}" stroke="${LINE}" stroke-width="1.4" fill="none"/>`);
    }
    return x;
  };
  const W = Math.max(tree.tw + 40, title ? textWidth(title, 18) + 40 : 0);
  place(tree, (W - tree.tw) / 2);
  return svgDoc(W, maxY + 24, out.join(""), title);
}

/** 心智圖：中心主題、分支左右平衡、曲線連接 */
export function renderMind(tree, { title = "" } = {}) {
  const root = tree.text ? tree : { text: title || "主題", children: tree.children };
  const size = 14;
  const leafGap = 10;
  const measure = (n, depth) => {
    n.depth = depth;
    const s = depth === 0 ? 18 : depth === 1 ? 15 : size;
    n.size = s;
    n.lines = wrap(n.text, s, depth === 0 ? 150 : 170);
    n.w = Math.max(...n.lines.map((l) => textWidth(l, s))) + (depth <= 1 ? 26 : 12);
    n.h = n.lines.length * s * 1.3 + (depth <= 1 ? 16 : 8);
    n.children.forEach((c) => measure(c, depth + 1));
    n.sh = Math.max(n.h, n.children.reduce((a, c) => a + c.sh, 0) + leafGap * Math.max(0, n.children.length - 1));
  };
  measure(root, 0);
  // 依子樹高度分配左右，讓兩邊高度接近
  const right = [];
  const left = [];
  let hr = 0;
  let hl = 0;
  root.children.forEach((c) => (hr <= hl ? (right.push(c), (hr += c.sh + leafGap * 2)) : (left.push(c), (hl += c.sh + leafGap * 2))));
  const colW = [];
  const widths = (n) => {
    colW[n.depth] = Math.max(colW[n.depth] || 0, n.w);
    n.children.forEach(widths);
  };
  root.children.forEach(widths);
  const gap = 46;
  const offs = [0];
  for (let d = 1; d < colW.length; d++) offs[d] = (d === 1 ? root.w / 2 + gap : offs[d - 1] + colW[d - 1] + gap);
  const sideW = colW.length > 1 ? offs.at(-1) + colW.at(-1) : root.w / 2;
  const H = Math.max(hr, hl, root.h) + 40;
  const W = sideW * 2 + 40;
  const top = title && tree.text ? 50 : 10;
  const cx = W / 2;
  const cy = top + H / 2;
  const out = [];
  const nodeSvg = (n, x, y, dir) => {
    if (n.depth === 1) {
      out.push(`<rect x="${(dir > 0 ? x : x - n.w).toFixed(1)}" y="${(y - n.h / 2).toFixed(1)}" width="${n.w.toFixed(1)}" height="${n.h.toFixed(1)}" rx="${(n.h / 2).toFixed(1)}" fill="${BLUE_BG}" stroke="${BLUE}" stroke-width="1.6"/>`);
      out.push(textLines(n.lines, dir > 0 ? x + n.w / 2 : x - n.w / 2, y, n.size, INK, 700));
    } else {
      out.push(`<text font-size="${n.size}" fill="${INK}" text-anchor="${dir > 0 ? "start" : "end"}">${n.lines.map((l, i) => `<tspan x="${(x + dir * 6).toFixed(1)}" y="${(y - ((n.lines.length - 1) * n.size * 1.3) / 2 + n.size * 0.36 + i * n.size * 1.3 - 4).toFixed(1)}">${esc(l)}</tspan>`).join("")}</text>`);
      out.push(`<path d="M${x.toFixed(1)},${(y + n.h / 2 - 4).toFixed(1)} h${(dir * n.w).toFixed(1)}" stroke="${BLUE}" stroke-width="1.4"/>`);
    }
  };
  const layout = (n, x, yTop, dir) => {
    const y = yTop + n.sh / 2;
    nodeSvg(n, x, y, dir);
    const ax = x + dir * n.w;
    const ay = n.depth === 1 ? y : y + n.h / 2 - 4;
    let ct = yTop + (n.sh - (n.children.reduce((a, c) => a + c.sh, 0) + leafGap * Math.max(0, n.children.length - 1))) / 2;
    for (const c of n.children) {
      const nx = cx + dir * offs[c.depth];
      const ny = ct + c.sh / 2 + c.h / 2 - 4;
      const mx = (ax + nx) / 2;
      out.push(`<path d="M${ax.toFixed(1)},${ay.toFixed(1)} C${mx.toFixed(1)},${ay.toFixed(1)} ${mx.toFixed(1)},${ny.toFixed(1)} ${nx.toFixed(1)},${ny.toFixed(1)}" stroke="${BLUE}" stroke-width="1.4" fill="none" opacity="0.8"/>`);
      layout(c, nx, ct, dir);
      ct += c.sh + leafGap;
    }
  };
  const side = (list, dir, total) => {
    let t = cy - total / 2;
    for (const c of list) {
      const x = cx + dir * offs[1];
      const y = t + c.sh / 2;
      const sx = cx + (dir * root.w) / 2;
      out.push(`<path d="M${sx.toFixed(1)},${cy.toFixed(1)} C${((sx + x) / 2).toFixed(1)},${cy.toFixed(1)} ${((sx + x) / 2).toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}" stroke="${BLUE}" stroke-width="2.2" fill="none"/>`);
      layout(c, x, t, dir);
      t += c.sh + leafGap * 2;
    }
  };
  side(right, 1, hr - leafGap * 2);
  side(left, -1, hl - leafGap * 2);
  out.push(`<rect x="${(cx - root.w / 2).toFixed(1)}" y="${(cy - root.h / 2).toFixed(1)}" width="${root.w.toFixed(1)}" height="${root.h.toFixed(1)}" rx="10" fill="${BLUE}"/>`);
  out.push(textLines(root.lines, cx, cy, root.size, "#ffffff", 700));
  return svgDoc(Math.max(W, title ? textWidth(title, 18) + 40 : 0), top + H + 10, out.join(""), tree.text ? title : "");
}

// ======================= 甘特圖 =======================
/** 解析日期：2026-01-05、2026/1/5、115/1/5（民國）、1/5（今年） */
export function parseDate(s, year = new Date().getFullYear()) {
  const t = String(s).trim().replace(/[年月.]/g, "/").replace(/日/g, "").replace(/-/g, "/");
  let m = /^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) {
    let y = Number(m[1]);
    if (y < 1000) y += 1911;
    return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3])));
  }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(t);
  if (m) return new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2])));
  return null;
}
const DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10);

export function parseGantt(text) {
  const tasks = [];
  let section = "";
  let prevEnd = null;
  for (const raw of String(text).split(/\n/)) {
    const line = raw.replace(/^\s*([-*•]|\d+[.、)])\s+/, "").trim();
    if (!line || /^(\/\/|```|gantt)/i.test(line)) continue;
    const sec = /^(?:#+\s*|section\s+)(.+)$/i.exec(line) || /^([^,，|\t]+)[：:]$/.exec(line);
    if (sec) {
      section = sec[1].trim().replace(/[：:]$/, "");
      continue;
    }
    const parts = line.split(/\s*[,，|\t]\s*/).filter((x) => x !== "");
    if (parts.length < 2) throw userError(`「${line}」格式不正確，請寫成「工作項目, 開始日期, 結束日期或天數」`);
    const [name, a, b] = parts;
    let start = /^(接續|after|之後|接著)$/i.test(a) ? prevEnd : parseDate(a);
    if (!start) throw userError(`「${name}」的開始日期「${a}」無法辨識，請用 2026-01-05 或 115/1/5 的格式`);
    let end;
    const dur = /^(\d+(?:\.\d+)?)\s*(天|日|d|days?|週|周|w|weeks?|個?月|m|months?)$/i.exec(b || "");
    if (!b) end = start;
    else if (dur) {
      const n = Number(dur[1]);
      const u = dur[2];
      end = /週|周|^w/i.test(u) ? new Date(start.getTime() + (n * 7 - 1) * DAY) : /月|^m/i.test(u) ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n, start.getUTCDate() - 1)) : new Date(start.getTime() + (n - 1) * DAY);
    } else {
      end = parseDate(b, start.getUTCFullYear());
      if (!end) throw userError(`「${name}」的結束日期或天數「${b}」無法辨識`);
    }
    if (end < start) throw userError(`「${name}」的結束日期早於開始日期`);
    tasks.push({ name, start, end, section, milestone: !b || +end === +start && /里程碑|milestone|◆/i.test(name + (parts[3] || "")) });
    prevEnd = new Date(end.getTime() + DAY);
  }
  if (!tasks.length) throw userError("沒有讀到任何工作項目。請每行寫「工作項目, 開始日期, 結束日期或天數」");
  if (tasks.length > 120) throw userError("工作項目太多（超過 120 項），請分成多張圖");
  return tasks;
}

export function renderGantt(tasks, { title = "" } = {}) {
  const size = 13;
  const rowH = 30;
  const header = "工作項目（民國年/月）";
  const labelW = Math.min(300, Math.max(textWidth(header, 12) + 24, ...tasks.map((t) => textWidth(t.name, size) + 34)));
  const min = new Date(Math.min(...tasks.map((t) => t.start)));
  const max = new Date(Math.max(...tasks.map((t) => t.end)));
  const start = new Date(Date.UTC(min.getUTCFullYear(), min.getUTCMonth(), 1));
  const end = new Date(Date.UTC(max.getUTCFullYear(), max.getUTCMonth() + 1, 1));
  const days = (end - start) / DAY;
  const months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  const pxDay = Math.max(2, Math.min(28, 760 / days));
  const chartW = days * pxDay;
  const top = (title ? 50 : 14) + 40;
  const rows = [];
  let sec = null;
  for (const t of tasks) {
    if (t.section && t.section !== sec) rows.push({ section: t.section });
    sec = t.section;
    rows.push({ task: t });
  }
  const H = top + rows.length * rowH + 16;
  const W = labelW + chartW + 24;
  const x = (d) => labelW + ((d - start) / DAY) * pxDay;
  const out = [];
  // 月份格線與標籤（月份多時每季或每半年標示）
  const step = months > 24 ? 6 : months > 12 ? 3 : 1;
  for (let i = 0; i <= months; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const xx = x(d);
    out.push(`<line x1="${xx.toFixed(1)}" y1="${top - 8}" x2="${xx.toFixed(1)}" y2="${H - 16}" stroke="${GRID}"/>`);
    if (i < months && i % step === 0) out.push(`<text x="${(xx + 4).toFixed(1)}" y="${top - 14}" font-size="12" fill="${MUTED}">${d.getUTCFullYear() - 1911}/${d.getUTCMonth() + 1}</text>`);
  }
  out.push(`<text x="10" y="${top - 14}" font-size="12" fill="${MUTED}">${header}</text>`);
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    if (r.section) {
      out.push(`<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="#f3f5f8"/><text x="10" y="${y + rowH / 2 + 5}" font-size="${size}" font-weight="700" fill="${INK}">${esc(r.section)}</text>`);
      return;
    }
    const t = r.task;
    out.push(`<text x="${t.section ? 22 : 10}" y="${y + rowH / 2 + 5}" font-size="${size}" fill="${INK}">${esc(t.name)}</text>`);
    const x0 = x(t.start);
    const x1 = x(new Date(t.end.getTime() + DAY));
    const bw = Math.max(4, x1 - x0);
    const d = Math.round((t.end - t.start) / DAY) + 1;
    if (t.milestone) out.push(`<path d="M${x0},${y + 7} l8,8 l-8,8 l-8,-8 z" fill="${AMBER}"><title>${esc(t.name)}：${ymd(t.start)}</title></path>`);
    else {
      // 只有資料端圓角
      const r4 = Math.min(4, bw / 2);
      out.push(`<path d="M${x0.toFixed(1)},${y + 8} H${(x0 + bw - r4).toFixed(1)} q${r4},0 ${r4},${r4} V${y + rowH - 8 - r4} q0,${r4} -${r4},${r4} H${x0.toFixed(1)} z" fill="${BLUE}"><title>${esc(t.name)}：${ymd(t.start)} ~ ${ymd(t.end)}（${d} 天）</title></path>`);
      const lbl = `${d} 天`;
      if (textWidth(lbl, 11) + 8 < bw) out.push(`<text x="${(x0 + bw / 2).toFixed(1)}" y="${y + rowH / 2 + 4}" font-size="11" fill="#ffffff" text-anchor="middle">${lbl}</text>`);
      else out.push(`<text x="${(x0 + bw + 4).toFixed(1)}" y="${y + rowH / 2 + 4}" font-size="11" fill="${MUTED}">${lbl}</text>`);
    }
  });
  out.push(`<line x1="${labelW}" y1="${top - 8}" x2="${labelW}" y2="${H - 16}" stroke="${LINE}"/>`);
  return svgDoc(Math.max(W, title ? textWidth(title, 18) + 40 : 0), H, out.join(""), title);
}

// ======================= 共用 =======================
export const DIAGRAM_TYPES = { flow: "流程圖", org: "組織圖", mind: "心智圖", gantt: "甘特圖（工作時程）" };

export const DIAGRAM_SYNTAX = {
  flow: "每行一條流程，用 -> 連接步驟；條件分支寫成「審核？ -[通過]-> 核發」，判斷步驟以「？」結尾；「開始」「結束」會畫成圓角框。",
  org: "縮排大綱：第一行是最上層單位，下一層多縮排兩個空白（或用「-」開頭）。",
  mind: "縮排大綱：第一行是中心主題，下一層多縮排兩個空白（或用「-」開頭）。",
  gantt: "每行「工作項目, 開始日期, 結束日期或天數」，例如「文獻蒐集, 2026-02-01, 2026-03-15」或「問卷設計, 接續, 3週」；以「階段名稱：」分組。日期可用民國年（115/2/1）。",
};

/** 依類型解析並繪製，回傳 SVG */
export function renderDiagram(type, text, opts = {}) {
  if (type === "flow") return renderFlow(parseFlow(text), opts);
  if (type === "org") return renderOrg(parseOutline(text), opts);
  if (type === "mind") return renderMind(parseOutline(text), opts);
  if (type === "gantt") return renderGantt(parseGantt(text), opts);
  throw userError(`未知的圖表類型：${type}`);
}

export const svgToPng = (svg, density = 192) => sharp(Buffer.from(svg), { density }).png().toBuffer();

/** 給 AI 的說明：把文字描述整理成上述寫法 */
export function diagramPrompt(type, desc) {
  const ex = {
    flow: "開始 -> 填寫申請表 -> 單位主管審核？\n單位主管審核？ -[同意]-> 會計室核章 -> 結束\n單位主管審核？ -[退回]-> 填寫申請表",
    org: "校長\n  教務處\n    註冊組\n    課務組\n  學務處\n    生輔組",
    mind: "研究計畫\n  研究目的\n    建立模型\n  研究方法\n    數值模擬\n    現地調查",
    gantt: "第一階段：\n文獻蒐集, 2026-02-01, 2026-03-15\n問卷設計, 接續, 3週\n第二階段：\n資料分析, 2026-05-01, 2個月\n期末報告, 2026-07-31",
  }[type];
  return `請把下列描述整理成「${DIAGRAM_TYPES[type]}」的文字寫法。\n寫法：${DIAGRAM_SYNTAX[type]}\n範例：\n${ex}\n\n要求：使用臺灣繁體中文；每個步驟或項目 2 到 14 個字；不要加入描述沒有的內容；只輸出寫法本身，不要加任何說明或程式碼區塊。\n\n描述：\n${desc}`;
}
