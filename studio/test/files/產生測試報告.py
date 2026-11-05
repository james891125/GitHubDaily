# 產生格式檢查用的測試報告：一份符合規範、一份含常見錯誤
import sys
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

out = sys.argv[1]


def set_fonts(run_or_style_font_el, east="標楷體", ascii="Times New Roman"):
    rpr = run_or_style_font_el
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    for a in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        if rfonts.get(qn(a)) is not None:
            del rfonts.attrib[qn(a)]
    rfonts.set(qn("w:eastAsia"), east)
    rfonts.set(qn("w:ascii"), ascii)
    rfonts.set(qn("w:hAnsi"), ascii)


def style_setup(doc, east="標楷體", ascii="Times New Roman", body=12, h1=16, h2=14):
    for name, size, bold in [("Normal", body, False), ("Heading 1", h1, True), ("Heading 2", h2, True), ("Heading 3", h2, True), ("Caption", 14, False)]:
        st = doc.styles[name]
        st.font.size = Pt(size)
        st.font.bold = bold
        st.font.name = ascii
        set_fonts(st.element.get_or_add_rPr(), east, ascii)
    doc.styles["Normal"].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    doc.styles["Normal"].paragraph_format.line_spacing = Pt(18)


def add_field(paragraph, instr, text=""):
    r = paragraph.add_run()
    b = OxmlElement("w:fldChar")
    b.set(qn("w:fldCharType"), "begin")
    r._r.append(b)
    r2 = paragraph.add_run()
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = instr
    r2._r.append(it)
    r3 = paragraph.add_run()
    s = OxmlElement("w:fldChar")
    s.set(qn("w:fldCharType"), "separate")
    r3._r.append(s)
    paragraph.add_run(text)
    r4 = paragraph.add_run()
    e = OxmlElement("w:fldChar")
    e.set(qn("w:fldCharType"), "end")
    r4._r.append(e)


def caption(doc, kind, chap, n, title):
    p = doc.add_paragraph(style="Caption")
    p.add_run(kind)
    add_field(p, f'STYLEREF 1 \\s', str(chap))
    p.add_run("-")
    add_field(p, f"SEQ {kind} \\* ARABIC \\s 1", str(n))
    p.add_run(" " + title)
    return p


def update_fields(doc):
    s = doc.settings.element
    u = OxmlElement("w:updateFields")
    u.set(qn("w:val"), "true")
    s.append(u)


# ---------------- 符合規範 ----------------
doc = Document()
style_setup(doc)
doc.add_paragraph("國科會專題研究計畫期末報告")
doc.add_heading("摘要", 1)
doc.add_paragraph("本研究探討無網格法於地下水問題之應用，結果顯示計算效率提升約 30%。")
doc.add_heading("Abstract", 1)
doc.add_paragraph("This study investigates meshless methods for groundwater problems.")
doc.add_heading("目錄", 1)
p = doc.add_paragraph()
add_field(p, 'TOC \\o "1-3" \\h \\z \\u', "（目錄）")
doc.add_heading("第一章 緒論", 1)
doc.add_heading("第一節 研究背景", 2)
doc.add_paragraph("本研究之數值結果如表1-1所示，收斂情形詳見圖1-1。")
caption(doc, "表", 1, 1, "數值結果比較")
t = doc.add_table(rows=2, cols=2)
t.cell(0, 0).text = "方法"
t.cell(0, 1).text = "誤差"
t.cell(1, 0).text = "本方法"
t.cell(1, 1).text = "0.01"
doc.add_paragraph().add_run().add_picture(f"{out}/截圖.png")
caption(doc, "圖", 1, 1, "收斂曲線")
doc.add_heading("第二章 文獻回顧", 1)
doc.add_heading("第一節 國內外研究", 2)
doc.add_paragraph("一、無網格法之發展")
doc.add_paragraph("（一）徑向基底函數法")
doc.add_heading("第三章 結論與建議", 1)
doc.add_paragraph("本研究完成無網格法之驗證。")
doc.add_heading("參考文獻", 1)
ref1 = doc.add_paragraph("1. 劉芷妤，時空配點無網格法於變飽和度地下水問題之研究，國立臺灣海洋大學河海工程學系博士論文，2023。")
ref2 = doc.add_paragraph("2. Iverson, R. M. (1997). The physics of debris flows. Reviews of Geophysics, 35(3), 245-296.")
for r in (ref1, ref2):
    r.paragraph_format.left_indent = Pt(24)
    r.paragraph_format.first_line_indent = Pt(-24)
doc.add_heading("附錄", 1)
doc.add_paragraph("會議紀錄。")
update_fields(doc)
doc.save(f"{out}/報告-符合規範.docx")

# ---------------- 含常見錯誤 ----------------
bad = Document()
style_setup(bad, east="新細明體", ascii="Arial", body=11, h1=14, h2=12)
bad.styles["Normal"].paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT
bad.add_heading("摘要", 1)
bad.add_paragraph("我們做了很多實驗，大概搞定了問題,效果差不多不錯——之後再改進。")
bad.add_heading("第一章 緒論", 1)
bad.add_paragraph("本計畫說明如下，本研究亦同。數據為１２３。")
bad.add_paragraph("（一）跳過一、直接用括號")
t = bad.add_table(rows=1, cols=2)
t.cell(0, 0).text = "A"
t.cell(0, 1).text = "B"
bad.add_paragraph("表1 數值結果")  # 表標題在表格下方且編號格式錯誤
bad.add_paragraph("圖2-1 未被引用的圖")
bad.add_heading("參考文獻", 1)
bad.add_paragraph("Iverson 1997 The physics of debris flows")
bad.save(f"{out}/報告-格式錯誤.docx")
print("ok")
