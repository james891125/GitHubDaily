// Markdown → Word (.docx)：支援標題、段落、粗體、條列、編號、表格、引言
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, AlignmentType, ImageRun } from "docx";

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];

/** 解析 **粗體** 與 [文字](連結) 成 TextRun */
function runs(text, font, size) {
  const out = [];
  const clean = String(text).replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1（$2）").replace(/`([^`]+)`/g, "$1");
  const parts = clean.split(/(\*\*[^*]+\*\*)/g);
  for (const p of parts) {
    if (!p) continue;
    const bold = /^\*\*[^*]+\*\*$/.test(p);
    out.push(new TextRun({ text: bold ? p.slice(2, -2) : p, bold, font, size }));
  }
  return out;
}

/**
 * @param {string} md
 * @param {{ formal?: boolean, title?: string }} opts formal：公文等正式文件使用標楷體
 */
export async function markdownToDocx(md, { formal = false, images = {} } = {}) {
  const fontName = formal ? "標楷體" : "微軟正黑體";
  const font = { ascii: formal ? "Times New Roman" : "Calibri", hAnsi: formal ? "Times New Roman" : "Calibri", eastAsia: fontName };
  const size = formal ? 28 : 24; // 14pt / 12pt（單位為半點）
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const children = [];
  let i = 0;
  const border = { style: BorderStyle.SINGLE, size: 4, color: "808080" };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // 圖片：![圖說](chart:ID)，圖說放在圖的下方
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (img && images[img[2]]) {
      const im = images[img[2]];
      const maxW = 600;
      const w = Math.min(maxW, im.width);
      children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: "png", data: im.data, transformation: { width: w, height: Math.round((im.height * w) / im.width) } })] }));
      if (img[1]) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [new TextRun({ text: img[1], font, size: formal ? 28 : size })] }));
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) {
      children.push(new Paragraph({ heading: HEADINGS[h[1].length - 1], children: runs(h[2], font, size + (5 - h[1].length) * 4), spacing: { before: 240, after: 120 } }));
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/<br\s*\/?>/gi, "\n"));
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      const width = Math.max(...rows.map((r) => r.length));
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map(
            (r, ri) =>
              new TableRow({
                tableHeader: ri === 0,
                children: Array.from({ length: width }, (_, ci) =>
                  new TableCell({
                    borders: { top: border, bottom: border, left: border, right: border },
                    shading: ri === 0 ? { fill: "E7EEF5" } : undefined,
                    children: String(r[ci] ?? "")
                      .split("\n")
                      .map((t) => new Paragraph({ children: ri === 0 ? [new TextRun({ text: t.replace(/\*\*/g, ""), bold: true, font, size: size - 2 })] : runs(t, font, size - 2) })),
                  }),
                ),
              }),
          ),
        }),
      );
      children.push(new Paragraph({ children: [] }));
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.、)])\s+(.*)/.exec(line);
    if (li) {
      const level = Math.min(Math.floor(li[1].length / 2), 3);
      const numbered = /\d/.test(li[2]);
      children.push(new Paragraph({ children: [new TextRun({ text: numbered ? li[2] + " " : "• ", font, size }), ...runs(li[3], font, size)], indent: { left: 360 * (level + 1), hanging: 280 } }));
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      children.push(new Paragraph({ children: runs(line.replace(/^>\s?/, ""), font, size - 2), indent: { left: 400 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "A0A0A0", space: 8 } } }));
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      i++;
      continue;
    }
    children.push(new Paragraph({ children: runs(line, font, size), spacing: { after: 120, line: formal ? 400 : 320 }, alignment: AlignmentType.LEFT }));
    i++;
  }
  const doc = new Document({
    styles: { default: { document: { run: { font, size } } } },
    sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }],
  });
  return Packer.toBuffer(doc);
}
