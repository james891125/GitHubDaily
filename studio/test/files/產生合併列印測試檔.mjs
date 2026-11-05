// 產生合併列印測試檔：獎狀名單.xlsx 與 獎狀範本.docx
// 範本刻意包含 Word 常見的難處理情況：欄位被拆成多個 run、頁首、表格、Word 內建 MERGEFIELD 功能變數、民國日期與國字金額格式。
// 執行：node test/files/產生合併列印測試檔.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { Document, Packer, Paragraph, TextRun, Header, Table, TableRow, TableCell, AlignmentType, WidthType } from "docx";

const here = path.dirname(fileURLToPath(import.meta.url));
const F = { ascii: "Times New Roman", hAnsi: "Times New Roman", eastAsia: "標楷體" };

// ---- 名單 ----
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("名單");
ws.addRow(["姓名", "系所", "獎項", "日期", "獎金"]);
ws.addRow(["王小明", "河海工程學系", "第一名", new Date(Date.UTC(2026, 2, 5)), 12000]);
ws.addRow(["李美華", "資訊工程學系", "第二名", new Date(Date.UTC(2026, 2, 5)), 8000]);
ws.addRow(["陳志強", "河海工程學系", "佳作", new Date(Date.UTC(2026, 2, 6)), 3500]);
ws.addRow(["", "", "", "", ""]); // 空白列應略過
await wb.xlsx.writeFile(path.join(here, "獎狀名單.xlsx"));

// ---- 範本 ----
const doc = new Document({
  sections: [
    {
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "受獎人：{{姓名}}", font: F, size: 20 })] })] }) },
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "獎　狀", font: F, size: 72, bold: true })] }),
        // 欄位被拆成三個 run，且中間的 run 有不同格式
        new Paragraph({
          children: [
            new TextRun({ text: "{{系所}} ", font: F, size: 32 }),
            new TextRun({ text: "{{", font: F, size: 32 }),
            new TextRun({ text: "姓名", font: F, size: 32, bold: true }),
            new TextRun({ text: "}} 同學", font: F, size: 32 }),
          ],
        }),
        new Paragraph({ children: [new TextRun({ text: "參加本校專題競賽，榮獲 MERGE_HERE，特頒此狀，以資鼓勵。", font: F, size: 32 })] }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph("獎金")] }), new TableCell({ children: [new Paragraph({ children: [new TextRun("新臺幣 {{獎金|國字}}（{{獎金|千分位}} 元）")] })] })] }),
          ],
        }),
        new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "中華民國 {{日期|民國}}", font: F, size: 28 })] }),
      ],
    },
  ],
});
const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
// 以 Word「合併列印」插入的複合功能變數取代 MERGE_HERE
let xml = await zip.file("word/document.xml").async("string");
const field =
  '</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> MERGEFIELD 獎項 \\* MERGEFORMAT </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>«獎項»</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="標楷體"/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">';
xml = xml.replace("MERGE_HERE", field);
zip.file("word/document.xml", xml);
// Word 合併列印會在 settings.xml 記錄資料來源，產出時應移除
let settings = await zip.file("word/settings.xml").async("string");
settings = settings.replace("</w:settings>", '<w:mailMerge><w:mainDocumentType w:val="formLetters"/><w:dataType w:val="native"/></w:mailMerge></w:settings>');
zip.file("word/settings.xml", settings);
fs.writeFileSync(path.join(here, "獎狀範本.docx"), await zip.generateAsync({ type: "nodebuffer" }));
console.log("ok");
