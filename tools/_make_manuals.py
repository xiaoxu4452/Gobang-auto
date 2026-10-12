# -*- coding: utf-8 -*-
"""Meter Gomoku 手册生成器（2026-10-09 第五次重写：功能详述 + UI 切片插图 + 表格化）。

本轮（用户「继续」指令）的四处硬要求：
  ① 手册里带上本软件的下载链接与取件密码（蓝奏云 b016l49aqj / 密码 15）；
  ② 开源说明必须带上必要链接，并用表格表达，越详细越好；
  ③ 不写「软件说明 / 界面说明 / logo」这类笼统章节，改为逐功能详述；
  ④ 把软件界面按 CSS/HTML 的结构切成 PNG 插图插进正文 —— 尺寸适中，
     排版像一篇「带图的技术文章」：图版居中、图号 + 图题在下、正文环绕小图。

前四次留下的能力全部保留：
  · 字体全部开源可商用（思源宋体 Noto Serif SC 标题 + 思源黑体 Noto Sans SC 正文，OFL 1.1）；
  · 产物一份：《软件说明 (Software Description).pdf》—— 中文版在前、英文版在后；
  · PDF 书签大纲 + 目录每行可点 + 每页右上角「中文 | English」胶囊可点（两遍构建量页码）。

插图管线的分工：
  tools/_make_ui_slices.js 负责「真机截图 → 逐元素切片 → tools/_ui_slices/<lang>/*.png」；
  本脚本只负责「读切片 → 按版面折算尺寸 → 排到正文里」。切片缺席时只警告、不中断排版。
"""
import os
import time
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
                                HRFlowable, PageBreak, Table, TableStyle, Image,
                                KeepTogether)
from reportlab.lib.styles import ParagraphStyle

pdfmetrics.registerFont(TTFont('SRCSONG', r'C:\Windows\Fonts\NotoSerifSC-VF.ttf'))   # 思源宋体（标题）
pdfmetrics.registerFont(TTFont('SRCHEI',  r'C:\Windows\Fonts\NotoSansSC-VF.ttf'))    # 思源黑体（正文/小标题）

HERE  = os.path.dirname(os.path.abspath(__file__))
SYST  = os.path.abspath(os.path.join(HERE, '..'))
OUT   = os.path.join(SYST, 'Meter Gomoku')
FINAL = os.path.join(OUT, '软件说明 (Software Description).pdf')
BASE  = os.path.join(OUT, '_sd_base.pdf')          # 中间产物（reportlab 出、PyMuPDF 加工后再删）
SLICE = os.path.join(HERE, '_ui_slices')           # tools/_ui_slices/<lang>/<name>.png

VER      = '4.37'
DL_URL   = 'https://wwbbj.lanzout.com/b016l49aqj'
DL_PWD   = '15'

DARK = HexColor('#1a1a1a'); BLUE = HexColor('#1457a8'); GREY = HexColor('#666666')
BODYC = HexColor('#222222'); LINE = HexColor('#cccccc'); CHIP_OFF = HexColor('#8ea6bf')
WHITE = HexColor('#ffffff')
TBL_HD = HexColor('#eaf1f9'); TBL_GRID = HexColor('#dcdcdc'); TBL_BOX = HexColor('#c2cdd8')
PLATE_BG = HexColor('#fcfcfd'); PLATE_BD = HexColor('#d8d8d8')

PAGE_W, PAGE_H = A4
LM = RM = 22 * mm
TM, BM = 20 * mm, 18 * mm
CW = PAGE_W - LM - RM                              # 正文栏宽 ≈ 166mm

CHIP_SIZE, CHIP_H, CHIP_GAP = 8.5, 14.0, 7
CHIP_BOTTOM = PAGE_H - TM + 12                     # 页眉留白里，内容框之上
CHIP_BOXES = {}                                    # page -> (x,y,w,h) 未选中那侧（供挂链接）

FIG_BOX_W, FIG_BOX_H = 118 * mm, 96 * mm           # 单张插图的「适中」上限框
FIG_ROW_H = 88 * mm                                # 并排图组的统一高度
PLATE_PAD = 3.0                                    # 图版内衬（pt）


# ------------------------------------------------------------------ 文本样式
def styles():
    tf, sf = 'SRCHEI', 'SRCSONG'
    return dict(
        title=ParagraphStyle('t', fontName=sf, fontSize=25, leading=32, alignment=TA_CENTER,
                             textColor=DARK, spaceAfter=4, wordWrap='CJK'),
        sub=ParagraphStyle('s', fontName=tf, fontSize=11, leading=17, alignment=TA_CENTER,
                           textColor=GREY, spaceAfter=6, wordWrap='CJK'),
        hint=ParagraphStyle('hint', fontName=tf, fontSize=9.2, leading=15, alignment=TA_CENTER,
                            textColor=GREY, spaceAfter=8, wordWrap='CJK'),
        dl=ParagraphStyle('dl', fontName=tf, fontSize=10, leading=16, alignment=TA_CENTER,
                          textColor=HexColor('#2f5c8c'), spaceAfter=4, wordWrap='CJK'),
        h1=ParagraphStyle('h1', fontName=sf, fontSize=14.5, leading=22, textColor=BLUE,
                          spaceBefore=13, spaceAfter=5, wordWrap='CJK', keepWithNext=1),
        h2=ParagraphStyle('h2', fontName=sf, fontSize=11.6, leading=19, textColor=HexColor('#333333'),
                          spaceBefore=8, spaceAfter=3, wordWrap='CJK', keepWithNext=1),
        h3=ParagraphStyle('h3', fontName=tf, fontSize=10.2, leading=17, textColor=HexColor('#3d3d3d'),
                          spaceBefore=5, spaceAfter=2, wordWrap='CJK', keepWithNext=1),
        body=ParagraphStyle('b', fontName=tf, fontSize=10.3, leading=17.5, textColor=BODYC,
                            alignment=TA_LEFT, spaceAfter=3.5, wordWrap='CJK', leftIndent=0),
        toc=ParagraphStyle('toc', fontName=tf, fontSize=10.3, leading=18, textColor=BODYC,
                           alignment=TA_LEFT, wordWrap='CJK', leftIndent=0),
        tocp=ParagraphStyle('tocp', fontName=tf, fontSize=10.3, leading=18, textColor=GREY,
                            alignment=TA_RIGHT, wordWrap='CJK'),
        foot=ParagraphStyle('f', fontName=tf, fontSize=9, leading=15, alignment=TA_CENTER,
                            textColor=GREY, spaceBefore=10, wordWrap='CJK'),
        cap=ParagraphStyle('cap', fontName=tf, fontSize=8.6, leading=13.5, alignment=TA_CENTER,
                           textColor=GREY, spaceBefore=4, spaceAfter=10, wordWrap='CJK'),
        th=ParagraphStyle('th', fontName=tf, fontSize=9.3, leading=14, textColor=HexColor('#123c66'),
                          wordWrap='CJK'),
        td=ParagraphStyle('td', fontName=tf, fontSize=9.3, leading=14, textColor=BODYC,
                          wordWrap='CJK'),
        tcap=ParagraphStyle('tcap', fontName=tf, fontSize=8.6, leading=13.5, alignment=TA_LEFT,
                            textColor=GREY, spaceBefore=4, spaceAfter=10, wordWrap='CJK'),
    )


HINT = {
    # ★ 2026-10-09（用户：「我已经改动了，不需要在 PDF 中说，点击胶囊就能换语言了」）：
    #   删掉「点右上角胶囊切换语言」这句话 —— 软件侧已改，说明书不再宣传这个操作。
    #   （右上角的中英文小标仍按原样绘制/挂链，只是不再写进提示语里。）
    'zh': '中英双册合一：'
          '打开阅读器的「书签 / 大纲」面板可展开完整目录，目录里每一行也能直接点开。'
          '正文中的蓝色文字均为可点击链接。',
    'en': 'Bilingual in one file: '
          'open the reader\'s bookmarks (outline) panel for the full contents; every contents line is '
          'clickable too. Blue text in the body is a clickable link.',
}

# 封面上的下载信息（与「二、下载与安装」章节同源，只此一处改）
DL_LINE = {
    'zh': '下载：' + '<a href="%s" color="#1457a8"><u>%s</u></a>' % (DL_URL, DL_URL) +
          '　　取件密码：<b>%s</b>' % DL_PWD,
    'en': 'Download: ' + '<a href="%s" color="#1457a8"><u>%s</u></a>' % (DL_URL, DL_URL) +
          '　　Password: <b>%s</b>' % DL_PWD,
}


def Lk(url, text):
    """正文 / 表格里的可点击链接标记。"""
    return '<a href="%s" color="#1457a8"><u>%s</u></a>' % (url, text)


# ------------------------------------------------------------------ 插图折算
def _px_size(path):
    from PIL import Image as PILImage
    with PILImage.open(path) as im:
        return im.size


def _fit(px_w, px_h, box_w, box_h):
    """等比缩放进不超 box_w × box_h 的框（居中留白由 reportlab 处理）。"""
    r = float(px_w) / float(px_h)
    w = box_w
    h = w / r
    if h > box_h:
        h = box_h
        w = h * r
    if w > box_w:
        w = box_w
        h = w / r
    return w, h


def _plate(img):
    """给截图加一圈发丝边 + 极浅底：纯白截图上白底页面会「糊」在一起。"""
    t = Table([[img]], colWidths=[img.drawWidth + 2 * PLATE_PAD])
    t.setStyle(TableStyle([
        ('BOX', (0, 0), (-1, -1), 0.5, PLATE_BD),
        ('BACKGROUND', (0, 0), (-1, -1), PLATE_BG),
        ('LEFTPADDING', (0, 0), (-1, -1), PLATE_PAD),
        ('RIGHTPADDING', (0, 0), (-1, -1), PLATE_PAD),
        ('TOPPADDING', (0, 0), (-1, -1), PLATE_PAD),
        ('BOTTOMPADDING', (0, 0), (-1, -1), PLATE_PAD),
    ]))
    t.hAlign = 'CENTER'
    return t


def _load(lang, name):
    p = os.path.join(SLICE, lang, name + '.png')
    if not os.path.exists(p):
        print('  ! slice missing:', lang + '/' + name + '.png')
        return None
    return p


def make_figure(lang, names, st, styleset, ch, idx, cap_text):
    """单个（names 长度 1）或并排一组插图 + 图号图题。返回是否排入。"""
    names = [names] if isinstance(names, str) else list(names)
    paths = [(n, _load(lang, n)) for n in names]
    paths = [(n, p) for n, p in paths if p]
    if not paths:
        return False
    imgs = []
    if len(paths) == 1:
        n, p = paths[0]
        w, h = _fit(*_px_size(p), FIG_BOX_W, FIG_BOX_H)
        imgs.append(Image(p, w, h))
    else:
        # 并排图组：先按统一高度 FIG_ROW_H 算宽，超栏宽则整体等比缩
        raw = []
        for n, p in paths:
            pw, ph = _px_size(p)
            r = float(pw) / float(ph)
            raw.append((n, p, FIG_ROW_H * r, FIG_ROW_H))
        gap = 5 * mm
        need = sum(w for _, _, w, _ in raw) + gap * (len(raw) - 1) + 2 * PLATE_PAD * len(raw)
        if need > CW:
            k = (CW - gap * (len(raw) - 1) - 2 * PLATE_PAD * len(raw)) / \
                sum(w for _, _, w, _ in raw)
            raw = [(n, p, w * k, h * k) for n, p, w, h in raw]
        row = []
        colw = []
        for n, p, w, h in raw:
            im = Image(p, w, h)
            row.append(_plate(im))
            colw.append(w + 2 * PLATE_PAD)
        t = Table([row], colWidths=colw)
        t.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'BOTTOM'),
            ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ]))
        t.hAlign = 'CENTER'
        t.spaceAfter = 0
        if len(row) > 1:                       # 用间隙表把并排图隔开
            pass
        imgs.append(t)
    label = ('图' if lang == 'zh' else 'Figure') + ' %d-%d' % (ch, idx)
    cap = Paragraph('<font color="#1457a8"><b>%s</b></font>　%s' % (label, cap_text),
                    styleset['cap'])
    st.append(KeepTogether([_plate(imgs[0]) if len(paths) == 1 else imgs[0], cap]))
    return True


def make_table(colw_mm, rows, st, styleset, lang, ch, idx, cap_text):
    """表格 + 表号表题。rows[0] 为表头。"""
    total = sum(colw_mm)
    if total > 166.5:
        print('  ! table too wide (%.1fmm), clamping' % total)
        k = 166.0 / total
        colw_mm = [w * k for w in colw_mm]
    data = []
    for ri, row in enumerate(rows):
        sty = styleset['th'] if ri == 0 else styleset['td']
        data.append([Paragraph(c, sty) for c in row])
    t = Table(data, colWidths=[w * mm for w in colw_mm], repeatRows=1)
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BACKGROUND', (0, 0), (-1, 0), TBL_HD),
        ('LINEBELOW', (0, 0), (-1, 0), 0.7, BLUE),
        ('INNERGRID', (0, 1), (-1, -1), 0.35, TBL_GRID),
        ('LINEABOVE', (0, 0), (-1, 0), 0.7, TBL_BOX),
        ('BOX', (0, 0), (-1, -1), 0.5, TBL_BOX),
        ('LEFTPADDING', (0, 0), (-1, -1), 5), ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5), ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
    ]))
    label = ('表' if lang == 'zh' else 'Table') + ' %d-%d' % (ch, idx)
    st.append(t)
    st.append(Paragraph('<font color="#1457a8"><b>%s</b></font>　%s' % (label, cap_text),
                        styleset['tcap']))
    return True


# ------------------------------------------------------------------ 文档模板 / 导航
def _chip_w(text):
    return pdfmetrics.stringWidth(text, 'SRCHEI', CHIP_SIZE) + 13


def _draw_chips(canv, zh, page):
    """右上角「中文 | English」切换胶囊：当前语言实心高亮，另一侧描边可点。"""
    t_zh, t_en = '中文', 'English'
    w1, w2 = _chip_w(t_zh), _chip_w(t_en)
    x_en = PAGE_W - RM - w2
    x_zh = x_en - CHIP_GAP - w1
    y = CHIP_BOTTOM
    for x, w, text, active in ((x_zh, w1, t_zh, zh), (x_en, w2, t_en, not zh)):
        if active:
            canv.setFillColor(BLUE)
            canv.roundRect(x, y, w, CHIP_H, 3.2, stroke=0, fill=1)
            canv.setFillColor(WHITE)
        else:
            canv.setFillColor(WHITE)
            canv.setStrokeColor(CHIP_OFF)
            canv.setLineWidth(0.7)
            canv.roundRect(x, y, w, CHIP_H, 3.2, stroke=1, fill=1)
            canv.setFillColor(CHIP_OFF)
            CHIP_BOXES[page] = (x, y, w, CHIP_H)      # 供 PyMuPDF 挂「切换语言」链接
        canv.setFont('SRCHEI', CHIP_SIZE)
        canv.drawCentredString(x + w / 2.0, y + 4.6, text)


class NavParagraph(Paragraph):
    """带导航锚点的段落：afterFlowable 里据此记下它落在第几页。"""
    def __init__(self, text, style, navkey=None, **kw):
        Paragraph.__init__(self, text, style, **kw)
        self.navkey = navkey


class Manual(BaseDocTemplate):
    def __init__(self, filename, nav, onpage=None, **kw):
        self.nav = nav
        BaseDocTemplate.__init__(self, filename, pagesize=A4, leftMargin=LM, rightMargin=RM,
                                 topMargin=TM, bottomMargin=BM,
                                 title='Meter Gomoku v%s' % VER,
                                 author='Meter', **kw)
        fr = Frame(LM, BM, CW, PAGE_H - TM - BM, id='body',
                   leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        self.addPageTemplates([PageTemplate(id='main', frames=[fr],
                                            onPage=onpage or (lambda canv, doc: None))])

    def afterFlowable(self, f):
        k = getattr(f, 'navkey', None)
        if k:
            self.nav[k] = self.page


def _make_onpage(nav):
    en_toc = nav.get('en:toc', 10 ** 9)

    def on_page(canv, doc):
        p = doc.page
        zh = p < en_toc
        canv.saveState()
        canv.setStrokeColor(LINE)
        canv.setLineWidth(0.5)
        canv.line(LM, BM - 6, PAGE_W - RM, BM - 6)
        canv.setFont('SRCHEI', 8.4)
        canv.setFillColor(GREY)
        canv.drawString(LM, BM - 17, 'Meter Gomoku   ·   v%s   ·   ' % VER +
                        ('中文版 Chinese' if zh else 'English Version'))
        canv.drawRightString(PAGE_W - RM, BM - 17, '- %d -' % p)
        _draw_chips(canv, zh, p)
        canv.restoreState()

    return on_page


# ------------------------------------------------------------------ 正文装配
def _make_story(blocks_pair, toc_pages):
    """blocks_pair = [('zh', zh_blocks), ('en', en_blocks)]；toc_pages 为空 = 第一遍（页码留空）。"""
    S = styles()
    st = []
    for lang, blocks in blocks_pair:
        if lang == 'en':
            st.append(PageBreak())
        ch, i = 0, 0
        figc, tblc = 0, 0
        while i < len(blocks):
            kind = blocks[i][0]
            if kind == 'toc':                     # 连续目录行 → 一张「标题 + 页码」两列表
                j, rows = i, []
                while j < len(blocks) and blocks[j][0] == 'toc':
                    pg = toc_pages.get('%s:h1:%d' % (lang, j - i))
                    rows.append([Paragraph(blocks[j][1], S['toc']),
                                 Paragraph(str(pg) if pg else '', S['tocp'])])
                    j += 1
                t = Table(rows, colWidths=[CW - 18 * mm, 18 * mm])
                t.setStyle(TableStyle([
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                    ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
                ]))
                st.append(t)
                i = j
                continue
            if kind == 'title':
                st.append(Paragraph(blocks[i][1], S['title']))
            elif kind == 'sub':
                st.append(Paragraph(blocks[i][1], S['sub']))
                st.append(HRFlowable(width='46%', thickness=0.8, color=HexColor('#bbbbbb'),
                                     spaceBefore=2, spaceAfter=4, hAlign='CENTER'))
                st.append(Paragraph(DL_LINE[lang], S['dl']))
                st.append(Paragraph(HINT[lang], S['hint']))
            elif kind == 'h1':
                t = blocks[i][1]
                if t in ('目录', 'Contents'):
                    st.append(NavParagraph(t, S['h1'], navkey=lang + ':toc'))
                else:
                    ch += 1
                    figc, tblc = 0, 0
                    st.append(NavParagraph(t, S['h1'], navkey='%s:h1:%d' % (lang, ch - 1)))
            elif kind == 'h2':
                st.append(Paragraph(blocks[i][1], S['h2']))
            elif kind == 'h3':
                st.append(Paragraph(blocks[i][1], S['h3']))
            elif kind == 'body':
                st.append(Paragraph(blocks[i][1], S['body']))
            elif kind == 'fig':                   # ('fig', 名称 或 [名称...], 图题)
                figc += 1
                if not make_figure(lang, blocks[i][1], st, S, ch, figc, blocks[i][2]):
                    figc -= 1
            elif kind == 'table':                 # ('table', [栏宽mm...], [[行]...], 表题)
                tblc += 1
                make_table(blocks[i][1], blocks[i][2], st, S, lang, ch, tblc, blocks[i][3])
            elif kind == 'foot':
                st.append(Spacer(1, 6))
                st.append(HRFlowable(width='100%', thickness=0.6, color=LINE,
                                     spaceBefore=4, spaceAfter=6))
                st.append(Paragraph(blocks[i][1], S['foot']))
            i += 1
    return st


def _chapter_labels(blocks):
    return [t for k, t, *_ in blocks if k == 'h1' and t not in ('目录', 'Contents')]


def _search_label(t):
    """目录行里用于定位的短标签：截到第一个括号（长标题可能折行，短标签一定在首行）。"""
    for sep in ('（', '('):
        i = t.find(sep)
        if i > 0:
            return t[:i].strip()
    return t


def add_navigation(nav, zh, en):
    """PyMuPDF 后处理：书签大纲 + 目录行可点 + 每页右上角语言胶囊可点。"""
    import pymupdf
    doc = pymupdf.open(BASE)
    zh_toc = nav.get('zh:toc', 1)
    en_toc = nav.get('en:toc', doc.page_count)

    # ① 书签（大纲面板）：中文版 / English Version 两大支，各带每章二级条目
    outline = [[1, '中文版 Chinese', zh_toc]]
    for i, t in enumerate(_chapter_labels(zh)):
        outline.append([2, t, nav.get('zh:h1:%d' % i, zh_toc)])
    outline.append([1, 'English Version', en_toc])
    for i, t in enumerate(_chapter_labels(en)):
        outline.append([2, t, nav.get('en:h1:%d' % i, en_toc)])
    doc.set_toc(outline)

    def link_row(page_no, label, target):
        if not (1 <= page_no <= doc.page_count and 1 <= target <= doc.page_count):
            return False
        page = doc[page_no - 1]
        hits = page.search_for(label)
        if not hits:
            return False
        r = hits[0]
        rect = pymupdf.Rect(LM, r.y0 - 1.5, PAGE_W - RM, r.y1 + 1.5)   # 整行宽做成热区
        page.insert_link({'kind': pymupdf.LINK_GOTO, 'from': rect,
                          'page': target - 1, 'to': pymupdf.Point(0, 0), 'zoom': 0})
        return True

    # ② 目录每行可点
    miss = 0
    for lang, toc_page, blocks in (('zh', zh_toc, zh), ('en', en_toc, en)):
        for i, t in enumerate(_chapter_labels(blocks)):
            lab = _search_label(t)
            tgt = nav.get('%s:h1:%d' % (lang, i), toc_page)
            if not (link_row(toc_page, lab, tgt) or link_row(toc_page + 1, lab, tgt)):
                miss += 1
                print('  ! contents link not found:', lab)
    print('  contents links done, missing =', miss)

    # ③ 右上角未选中的语言胶囊 → 跳到该语言的目录页
    for pno in range(1, doc.page_count + 1):
        box = CHIP_BOXES.get(pno)
        if not box:
            continue
        x, y, w, h = box
        target = en_toc if pno < en_toc else zh_toc
        doc[pno - 1].insert_link({
            'kind': pymupdf.LINK_GOTO,
            'from': pymupdf.Rect(x, PAGE_H - y - h, x + w, PAGE_H - y),
            'page': target - 1, 'to': pymupdf.Point(0, 0), 'zoom': 0})

    # ④ 统计正文里的外链（确认链接确实落进了 PDF）
    nlink = 0
    for pno in range(1, doc.page_count + 1):
        for l in doc[pno - 1].get_links():
            if l.get('kind') == pymupdf.LINK_URI:
                nlink += 1
    print('  external URI links in PDF:', nlink)

    # ★ 2026-10-09：产物 PDF 常被**预览器/IDE 面板**以「共享读」方式打开着 —— 那种锁会让
    #   PyMuPDF 的内部 removeFile 直接失败（code=2 Permission denied），整轮生成白跑。
    #   这里改成「先写临时名 → 尽力替换 → 失败就退避重试若干次」，既保住原子性，
    #   也让「面板还开着」这种可自愈的情况不用人工干预。
    tmp = FINAL + '.new'
    doc.save(tmp, garbage=4, deflate=True)
    doc.close()
    last_err = None
    for attempt in range(1, 7):
        try:
            os.replace(tmp, FINAL)          # 同盘原子替换（目标被读锁时才可能抛错）
            last_err = None
            break
        except OSError as e:
            last_err = e
            print('  ! 替换失败（第 %d 次）：%s' % (attempt, e))
            time.sleep(2.0)
    if last_err is not None:
        print('  !! 目标 PDF 仍被占用，新手册已留在：' + tmp)
        print('     （通常是 PDF 预览面板/阅读器还开着 —— 关掉后重跑本脚本即可）')
        raise SystemExit(3)


def main():
    for f in (BASE, FINAL):
        try:
            if os.path.exists(f):
                os.remove(f)
        except OSError as e:
            print('  ! cannot remove', f, e)
    # 第一遍：量页码
    nav1 = {}
    Manual(BASE, nav1).build(_make_story([('zh', zh), ('en', en)], {}))
    # 第二遍：页码回填 + 页脚 / 语言胶囊（布局与第一遍一致 → 页码不变）
    CHIP_BOXES.clear()
    nav2 = {}
    Manual(BASE, nav2, onpage=_make_onpage(nav1)).build(
        _make_story([('zh', zh), ('en', en)], nav1))
    if nav1 != nav2:
        print('  ! page map changed between passes:')
        for k in sorted(set(nav1) | set(nav2)):
            if nav1.get(k) != nav2.get(k):
                print('   ', k, nav1.get(k), '->', nav2.get(k))
    add_navigation(nav1, zh, en)
    try:
        os.remove(BASE)
    except OSError:
        pass
    import pymupdf
    d = pymupdf.open(FINAL)
    print('saved', os.path.basename(FINAL), os.path.getsize(FINAL), 'bytes / pages', d.page_count)
    print('outline entries:', len(d.get_toc()),
          '| zh contents links:', len(d[nav1['zh:toc'] - 1].get_links()),
          '| en contents links:', len(d[nav1['en:toc'] - 1].get_links()))
    d.close()


# ==================================================================== 中文版
zh = [
 ('title', 'Meter Gomoku'),
 ('sub', '五子棋研究与实战辅助　版本 %s　作者：Meter' % VER),
 ('h1', '目录'),
 ('toc', '一、软件简介'),
 ('toc', '二、下载、安装与运行'),
 ('toc', '三、对局设置（模式 · AI 执子 · 思考时间 · 规则 · 引擎 · 棋盘显示 · 局面）'),
 ('toc', '四、棋盘操作与残局摆盘'),
 ('toc', '五、计算评估（计算 · 多点分析 · 平衡一/二 · 扫描防守 · 教练 · 分析计算 · 清除标记）'),
 ('toc', '六、前瞻 · VCF · VCT'),
 ('toc', '七、引擎仪表盘与评估曲线'),
 ('toc', '八、历史与复盘'),
 ('toc', '九、识图（Gomoku Vision）'),
 ('toc', '十、规则、语言与外观'),
 ('toc', '十一、连线功能（在外部对局软件中实战辅助）'),
 ('toc', '十二、常见问题'),
 ('toc', '十三、开源组件与许可'),

 # ---------------------------------------------------------------- 一
 ('h1', '一、软件简介'),
 ('body', 'Meter Gomoku（米特五子棋）是一款在本机运行的五子棋研究与训练工具，把棋局推演、引擎评估、算杀、屏幕识图与实战连线辅助合在一起。全部计算都在你自己的电脑上完成 —— 界面与引擎以进程内 C++ 直连，识别组件走本机管道，软件不监听、也不使用任何网络端口（零 HTTP、零 WebSocket），断网也能用。'),
 ('body', '软件有三个界面：主窗（棋盘 + 三张功能卡）、复盘窗（只有棋盘的独立窗口，不连引擎）、连线窗（在外部对局软件里辅助实战）。主窗与复盘窗共用同一套界面代码，连线窗是固定尺寸的小窗，独立运行。'),
 ('body', '本说明按「功能」逐项展开，并配以软件界面的实际切片插图，便于对照。所有插图均为软件真机截图按界面结构切出的局部。'),
 ('table', [34, 132],
  [['想做什么', '去哪儿'],
   ['下一盘、让 AI 陪练或复盘一局', '第三节 对局设置 · 第四节 棋盘操作'],
   ['看清某一手好不好、该防哪里', '第五节 计算评估'],
   ['算一条必胜的杀棋线', '第六节 前瞻 · VCF · VCT'],
   ['把一张对局截图变成可继续练习的局面', '第九节 识图'],
   ['在对战平台 / 对手软件里让 AI 帮手', '第十一节 连线功能'],
   ['查开源组件与许可、找不到东西怎么办', '第十三节 开源组件 · 第十二节 常见问题']],
  '按需求索引章节'),

 # ---------------------------------------------------------------- 二
 ('h1', '二、下载、安装与运行'),
 ('body', '本软件为绿色免安装：下载后解压到任意目录（建议非中文路径，或直接用安装包装到默认位置），双击主程序即可运行，不写注册表、不装驱动。'),
 ('table', [30, 136],
  [['项目', '内容'],
   ['名称', 'Meter Gomoku 连线训练器（主程序 Desktop GomokuTrainer）'],
   ['版本', 'v%s' % VER],
   ['下载地址', '<a href="%s" color="#1457a8"><u>%s</u></a>' % (DL_URL, DL_URL)],
   ['取件密码', '<b>%s</b>（打开下载页后按提示输入）' % DL_PWD],
   ['适用系统', 'Windows 10 / 11 64 位，亦可在 Windows Server 上运行'],
   ['运行方式', '绿色免安装，解压即用；也提供带开始菜单快捷方式的安装包'],
   ['授权', '界面与配套代码 MIT；棋力内核 Rapfi GPL-3.0；识别组件与 OpenCV Apache-2.0'],
   ['手册随附', '本说明（中英双语）随压缩包一同分发']],
  '发行信息（下载地址与取件密码）'),
 ('h2', '运行环境'),
 ('table', [26, 50, 90],
  [['项目', '要求', '说明'],
   ['操作系统', 'Windows 10 1809 以上（建议 2004+ / Windows 11）',
    '边框识别与「窗口常驻最上层」用到 Windows 10 2004 起的显示 API；更早的系统会自动降级运行，功能不受影响'],
   ['界面运行时', 'Microsoft Edge WebView2 Runtime',
    'Windows 10 / 11 通常已随系统预装；若缺失，安装包会提示并引导前往微软官方页面免费安装'],
   ['处理器', 'x86-64，支持 SSE4.1 及以上',
    '引擎内置五个指令集变体，启动时按本机 CPU 自动选择最快的一支，老机器自动降级到 SSE 版'],
   ['内存', '4 GB 起，建议 8 GB 以上',
    '引擎的置换表（哈希）按可用内存自适应；内存越大、长考越稳'],
   ['显卡', '无要求', '纯 CPU 计算，不依赖显卡，也不需要独立显卡'],
   ['网络', '不需要', '全程本地运行，不监听任何端口，可断网使用']],
  '运行环境与依赖'),
 ('h2', '目录说明'),
 ('table', [46, 120],
  [['路径', '内容'],
   ['Desktop GomokuTrainer.exe', '主程序：界面宿主、引擎调度、识别调度'],
   ['Vision/', '识图组件 GomokuVision.exe 及其静态链接库（含 OpenCV）'],
   ['rapfi-native/', '棋力内核 Rapfi 的五个指令集变体（avx512vnni / avxvnni / avx512 / avx2 / sse）、'
                     '神经网络权重、开局与配置，以及 GPL 许可文本与来源说明'],
   ['calc/', '界面资源：加密后的页面、样式与脚本（防止误改，正常运行不需要动它）'],
   ['软件说明 (Software Description).pdf', '本说明（中文版在前、英文版在后，可点目录与书签）']],
  '目录结构与各文件的作用'),

 # ---------------------------------------------------------------- 三
 ('h1', '三、对局设置'),
 ('body', '主窗右侧的「对局设置」卡片分四个可折叠板块：对局、引擎、棋盘显示、局面。点板块标题即可折叠 / 展开。'),
 ('h2', '（一）对局板块'),
 ('body', '这一板块决定「谁和谁下、下多久、按什么规则」。'),
 ('fig', 'm-set-game', '对局设置 · 对局板块（模式 / AI 执子 / 思考时间 / 规则）'),
 ('h3', '模式'),
 ('table', [24, 30, 112],
  [['模式', 'AI 参与', '典型用途'],
   ['对弈', '是（按 AI 执子设置自动应答）', '实战、复盘、让 AI 陪练；这是日常使用最多的一种'],
   ['摆盘', '否', '自由摆子构图，研究布局或试做变化图；辅助 / 热力 / 教练等提示功能停摆'],
   ['残局', '否', '摆一个局面专门研究，配合棋盘下方的摆盘键与「确定」，详见第四节']],
  '三种模式的差别'),
 ('h3', 'AI 执子'),
 ('body', '两个开关可任意组合，四种组合各有明确含义：'),
 ('table', [22, 22, 34, 88],
  [['AI 执黑', 'AI 执白', '谁先走', '说明'],
   ['开', '关', 'AI 先走（天元）', '你执白。AI 落第一手天元，之后按你的落子应答'],
   ['关', '开', '你先走', '你执黑。AI 等你落子后应答'],
   ['开', '开', '双方都是 AI', 'AI 自打：你只旁观，棋盘点击无效；点棋盘正中的键可暂停 / 继续'],
   ['关', '关', '你', '双人手动对弈：没有 AI，黑白双方都由你自己下']],
  'AI 执子四种组合'),
 ('h3', '思考时间'),
 ('table', [26, 46, 94],
  [['项目', '取值', '说明'],
   ['可调范围', '0.2 ~ 300 秒，步进 0.1 秒', '默认 2 秒；短到闪电出手，长到深度长考'],
   ['快捷档', '0.5 / 1 / 1.5 / 2 / 3 / 4 / 5 秒', '一键切换，常用档位不必手动输入'],
   ['棋力关系', '时间越长越强', '热力图与教练视图的色档也随思考时间自动调节'],
   ['短时增强', '思考时间 ≤ 1 秒时启用',
    '计算期间临时向系统申请更高的 CPU 运行频率，算完立即恢复，用于改善极短时间的棋力']],
  '思考时间档位与影响'),
 ('h3', '规则'),
 ('table', [30, 14, 14, 108],
  [['规则', '禁手', '换色', '要点'],
   ['无禁手', '无', '无', '连成五子（含长连）即胜，最自由'],
   ['无禁手 · 长连不赢', '无', '无', '标准规则：长连不算赢，必须正好五子'],
   ['连珠（有禁手）', '黑有', '无', '黑方三三 / 四四 / 长连为禁手，白方无禁手；禁手点会画红叉'],
   ['一手交换', '无', '有', '黑下第 1 手后，白方可选择是否与黑交换颜色'],
   ['山口规则 Yamaguchi', '有', '有',
    '黑摆 3 子（黑1 天元、白2 限 3×3、黑3 限 5×5）并声明第 5 手的打点数；对方选色后白4 任意位置，'
    '黑按声明数叫点（对称点不可重复），白挑一个落第 5 手'],
   ['塔拉山口规则 Taraguchi', '有', '有',
    '黑1 天元、白2 限 3×3、黑3 限 5×5、白4 限 7×7；第 5 手可直接下（9×9）或十打叫 10 点由对方挑，'
    '随后对方选色'],
   ['塔拉尼科夫规则 Tarannikov', '有', '有',
    '黑1 天元、白2 限 3×3、黑3 限 5×5、白4 限 7×7、黑5 限 9×9；每手之后对方均可换色，无打点']],
  '七种规则的禁手、换色与要点'),
 ('body', '前瞻推演与算杀（VCF / VCT）都会跟随当前所选规则；交换类规则在开局时会弹出小窗，让你选先手或后手。切换规则时<font color="#0f3f7a">不会清空棋盘</font> —— 保留当前布局，按新规则继续，终局判定与禁手标记会重新计算。'),
 ('h2', '（二）引擎板块'),
 ('fig', 'm-set-engine', '对局设置 · 引擎板块（系统信息 / 线程数 / 哈希表）'),
 ('table', [26, 140],
  [['字段', '含义与调法'],
   ['系统信息', '显示本机处理器、指令集变体（决定实际使用哪个引擎版本）与系统内存，每 3 秒自动刷新；'
                '换机器排查问题时，第一手就看这里'],
   ['线程数', '引擎的搜索线程数。下拉按本机核心数给档位，旁边实时显示「本机线程数 / 上限」；'
              '线程越多并行度越高，但超过物理核心后收益递减'],
   ['哈希表', '引擎置换表（TT）的大小。正在干活的那条引擎车道独占所选档位的 100%，其余车道降到地板值，'
              '因此<font color="#0f3f7a">总占用始终等于你所选的档位</font>，不会因为多开而翻倍']],
  '引擎板块三个字段'),
 ('h2', '（三）棋盘显示板块'),
 ('fig', 'm-set-view', '对局设置 · 棋盘显示板块（显示序号 / 预览框）'),
 ('body', '「显示序号」在每颗棋子上标出它是第几手，复盘时最有用；「预览框」是鼠标悬停时显示的圆角方框，默认开启，关掉后落子更「素」。'),
 ('h2', '（四）局面板块'),
 ('fig', 'm-set-code', '对局设置 · 局面板块（局面代码的复制 / 粘贴 / 载入）'),
 ('body', '局面代码用小写列字母 + 行号逐手拼接（与 ' + Lk('https://gomocalc.com', 'gomocalc.com') +
          ' 同格式），例如 ' + '<font face="SRCHEI">h8i9g7</font>' +
          ' 表示依次落子于 H8、I9、G7。可「复制 / 粘贴 / 载入」，用于导入导出、分享或存档一个局面。'),
 ('h2', '（五）AI 执子小窗'),
 ('fig', 'm-aiside', '「AI 执子」小窗（棋盘下沿功能键可随时弹出）'),

 # ---------------------------------------------------------------- 四
 ('h1', '四、棋盘操作与残局摆盘'),
 ('fig', 'm-board', '主窗棋盘：上沿坐标轴，下沿功能键行，棋盘正中一颗「继续 / 暂停」键'),
 ('table', [30, 44, 92],
  [['操作', '方式', '说明'],
   ['落子', '直接点击棋盘交点', '当前行棋方由落子数的奇偶推出，无需手动切换'],
   ['上一步 / 下一步', '棋盘下沿 ‹ › 键', '逐手回退与前进，用于复盘',
    ],
   ['重新开始', '棋盘下沿「重新开始」', '会先把当前这一局自动存进历史，再清盘'],
   ['保存局面', '棋盘下沿「保存局面」', '把当前盘面手动存入历史'],
   ['旋转', '棋盘下沿「旋转」', '棋子整体顺时针旋转 90°'],
   ['翻转', '棋盘下沿「翻转」', '弹出小窗可选左右 / 上下 / 两种对角翻转'],
   ['平移', '棋盘下沿「平移」', '局面整体平移一格；若有子会出盘则整体不动并给出提示'],
   ['让 AI 立刻走一手 / 暂停', '棋盘正中的键', '空闲时点它 = AI 立刻为当前行棋方算一手并落下；AI 思考中点头 = 暂停'],
   ['AI 执子 / 设置', '棋盘下沿最右两键', '分别弹出「AI 执子」与「设置」小窗']],
  '棋盘操作速查'),
 ('body', '旋转 / 翻转 / 平移三者只变换棋子布局，棋盘线与坐标轴不动。'),
 ('h2', '残局摆盘'),
 ('body', '把模式切成「残局」后，棋盘下方会出现摆盘键，用来把一个局面精确摆出来再研究：'),
 ('table', [30, 136],
  [['摆盘键', '用法'],
   ['顺序摆盘', '黑白轮流落子，按落子顺序摆放'],
   ['任意摆盘', '点开右侧圆角小框选「黑子」或「白子」，之后可连续摆该色，数量与顺序都不限；选中的色键会变色'],
   ['确定', '点最左的「确定」把局面定下来：键变浅绿并显示「已确定」。此后「重新开始」回到该局面，'
            '存进历史时它也是首帧；再点一次即可解除重摆']],
  '残局摆盘三个键'),
 ('body', '残局模式下 AI 全程不参与，交换手类规则自动变灰（残局没有开局交换可言）。'),

 # ---------------------------------------------------------------- 五
 ('h1', '五、计算评估'),
 ('body', '这一卡是软件的「棋力工作台」，七个功能彼此独立，结果都直接画在棋盘上；「清除标记」一键把它们的痕迹全部擦掉。'),
 ('fig', 'm-analysis', '计算评估卡：从计算、多点分析到平衡、防守、教练与分析计算'),
 ('table', [24, 142],
  [['功能', '作用与用法'],
   ['计算', '对当前局面做单路深搜，并把最佳点标在棋盘上；键随状态在「计算 / 停止计算」之间切换'],
   ['多点分析', '按「分析点数」（2 ~ 8，默认 4）一次给出若干候选，每个圆圈里是名次与评估分'],
   ['平衡一', '在候选里挑评估最接近 0 的一手（最均衡的一手）'],
   ['平衡二', '先把候选逐个虚拟落子、再看对手的应手，从中挑最稳的一手'],
   ['扫描防守', '在 9×9 邻域逐个空点打分，给出该防的点（百分比越高越危险）；'
                '点过一次后随落子自动重扫，直至「清除标记」或重新开始'],
   ['教练（指导视图）', '轮到你时用方形四色提示最佳落点（最佳 / 良好 / 一般 / 劣势），你一落子就消失'],
   ['分析计算', '棋盘左下角的开关键：开启后在主车道持续深算当前局面，铺出引擎当前榜单'
                '（最佳点 + 候选，最多 8 个），随搜索加深自然微变并收敛；用户落子 / 悔棋自动重开会话，'
                '仪表盘用时跨轮累加；再点一次即停止'],
   ['清除标记', '一键擦掉本卡任意项目留在棋盘上的标记（徽标与评估分、扫描防守的百分比与胜负徽标、'
                '前瞻 / VCF / VCT 的序号、虚线与代码链），只清标记，不动局面本身']],
  '计算评估七项功能'),
 ('table', [30, 136],
  [['项目', '取值与含义'],
   ['分析点数', '2 ~ 8，默认 4；决定多点分析一次给出几个候选'],
   ['危险度色档', '青 → 绿 → 黄 → 橙 → 红 连续渐变，越红越危险，百分比越高越该防'],
   ['教练四色', '最佳 / 良好 / 一般 / 劣势 四档方形提示'],
   ['分析计算榜单', '最佳点 + 候选，最多 8 个，随深度加深自动收敛']],
  '计算评估的关键参数'),
 ('body', '摆盘、残局与双人手动对弈下，「分析计算」同样可用 —— 只要有一个「你」的执子方存在，就能持续铺榜单。'),

 # ---------------------------------------------------------------- 六
 ('h1', '六、前瞻 · VCF · VCT'),
 ('table', [22, 144],
  [['功能', '说明'],
   ['前瞻', '从当前局面逐手推演，一路走到盘面真的五子连珠才结束 —— 不凭引擎的胜负判断提前定性，'
            '最坏情况是铺满棋盘判和。首手会加强全局计算找突破口，并给出预计耗时区间；'
            '推演子是半透明的、数字表示手数；每一步都做必应校验（能连五就连五、对手成五必堵、活三必应）'],
   ['VCF', '连续冲四必胜搜索：只考虑连续冲四的强制序列'],
   ['VCT', '冲四 + 活三连续威胁搜索：在冲四之外把活三也纳入威胁序列'],
   ['进攻方', '黑 / 白为指示框（不可点），自动判定 = 轮走方；算杀题面按惯例取子多的一方'],
   ['代码链', '左右步进键可逐手查看；悬浮代码预览到那一手；点击选中、「确定」把这一段落到棋盘'],
   ['十打', '叫 10 个候选点，交给对方挑选']],
  '前瞻与算杀六项'),
 ('body', 'VCF 与 VCT 都跑本机算杀器（多线程并行 + 迭代加深），命中即给出必胜线并在棋盘上标注杀路；无解会弹窗明示「所选进攻方不存在该强制杀」。选了 VCF / VCT 后，你在棋盘上落子时它会边走边回探，一旦能接手就切进杀棋序列。'),

 # ---------------------------------------------------------------- 七
 ('h1', '七、引擎仪表盘与评估曲线'),
 ('fig', 'm-engine', '引擎仪表盘与评估曲线卡'),
 ('table', [24, 142],
  [['字段', '含义'],
   ['深度', '当前搜索到达的深度（层）'],
   ['速度', '每秒搜索的节点数，反映算力利用是否正常'],
   ['节点', '本次搜索已展开的节点总数'],
   ['用时', '本次（分析计算模式下跨轮累加）的累计用时'],
   ['评估', '当前局面对行棋方的评分，正数占优、负数落后'],
   ['最佳', '当前搜索给出的最佳一手'],
   ['评估曲线', '按黑 / 白两条记录整局走势；纵轴随分数自动进位（最大约 ±1200），横轴可滚动查看'],
   ['状态行', '轮到你 / AI 思考中 / 暂停 / 终局 / 背诵等提示（最多两行）']],
  '仪表盘与曲线字段'),
 ('body', '任意计算期间（AI 落子、计算评估、多点分析、平衡、扫描防守、教练、前瞻、分析计算）这些数值都会边算边跳，是判断「引擎有没有在干活、干得顺不顺」最直接的地方。'),

 # ---------------------------------------------------------------- 八
 ('h1', '八、历史与复盘'),
 ('fig', ['m-drawer', 'm-rv'], '历史抽屉（左）与复盘窗（右）：抽屉管存档，复盘窗只有棋盘'),
 ('table', [30, 136],
  [['按键 / 操作', '作用'],
   ['历史 / 保存历史', '抽屉内两个页面：前者是自动存档，后者是你手动保存的对局'],
   ['打开', '把选中的一局载入棋盘（VC / 残局记录以整盘为首帧，不必从第一手重放）'],
   ['保存选中', '把选中的记录搬进「保存历史」页'],
   ['删除 / 全部选中', '删除选中项；「全部选中」一键勾满当前页'],
   ['导入 / 导出', '支持 txt 格式的导入与导出'],
   ['Ctrl / Shift 多选', '像文件管理器一样连续或离散多选'],
   ['右键菜单', '对单条记录：打开复盘 / 重命名 / 导出这一局 / 存入保存历史 / 删除'],
   ['复盘窗', '顶栏「复盘」打开一个只有棋盘的独立窗口，不连 AI、不参与其他功能；'
              '可用「背诵复盘 / 回顾复盘」逐手走'],
   # ★ 2026-10-09（用户：「软件中复盘的『序号』」）：复盘窗那一排按键此前整张表都没写，
   #   补两行讲清「序号」以及它为什么与主窗那颗无关。
   ['复盘窗：序号', '复盘窗内的「序号」键：点开后每颗子上标出它是第几手。与主窗对局设置里的'
                   '「显示序号」<font color="#0f3f7a">互相独立</font> —— 背诵复盘时序号等于把答案'
                   '印在盘上，所以这里默认关，开关状态随设置记忆'],
   ['复盘窗：重来 / 保存局面 / 历史', '重来 = 清空回到开局（不写历史）；保存局面 = 存进'
                                     '「保存历史」；历史 = 在复盘窗内直接挑一局载入。'
                                     '键盘：Ctrl+Z 上一手、Ctrl+R 重来']],
  '历史抽屉与复盘窗操作'),

 # ---------------------------------------------------------------- 九
 ('h1', '九、识图（Gomoku Vision）'),
 ('fig', 'm-vis', '识图面板：上传 / 截图、框选、识别、人工修改与图片抽屉'),
 ('table', [24, 142],
  [['步骤', '说明'],
   ['上传 / 截图', '导入一张对局截图；也可以直接抓取屏幕区域'],
   ['框选', '选框会自动贴住棋盘，并向外多留约棋盘 1/30 的余量，确保最外侧的棋子完整进框；'
            '识别前也可先手动框选图片区域'],
   ['识别', '点「识别」开始；结果会同步成局面代码，可复制，也可直接载入练习'],
   ['修改', '人工微调：交换黑白子（点一黑一白即互换）、删除棋子、补充黑子 / 白子；Ctrl+Z 撤销'],
   ['图片抽屉', '每次上传的图片自动进抽屉（超过 150 张清最老），支持多选、删除与复制']],
  '识图的使用步骤'),
 # ★ 2026-10-09（用户：「VC 模式与普通识图的差别表格过界」）：本表是**三列**，
 #   旧写法只给了两个栏宽（[26,140]）——reportlab 给第三列分不到宽度，整表顶出页面右边界。
 ('table', [24, 58, 84],
  [['对比项', '普通识图', 'VC（算杀题）模式'],
   ['黑白子数', '必须相等', '可以不等'],
   ['补子 / 删子', '受棋局约束', '补黑 / 补白不限数量，删除任意删'],
   ['载入后', '按局面继续', '自动切成残局模式，并预设进攻方（子多的一方）'],
   ['算杀', '不自动开', '也不自动开 —— 点 VCF 或 VCT 由你自己决定']],
  'VC 模式与普通识图的差别'),

 # ---------------------------------------------------------------- 十
 ('h1', '十、规则、语言与外观'),
 ('table', [26, 140],
  [['项目', '说明'],
   ['规则', '七种，见第三节「对局设置 · 规则」的对照表'],
   ['语言', '顶栏「EN / 中」一键切换全界面语言，包含识图截图框的按键与历史里的日期格式'],
   ['颜色', '调色窗管理棋盘色、页面底色、深色 / 浅色主题以及预制色方案'],
   ['布局', '右栏卡片可用标题栏拖动换位、点小横杠折叠、点关闭键隐藏；布局自动记忆，下次启动照旧'],
   ['文字选择', '按钮、标题、标签这类<font color="#0f3f7a">界面文字不可选中、不可复制</font>'
                '（拖动窗口或棋盘时不会误选出一片蓝色）；棋谱、历史着法、日志与输入框仍可正常选中与复制']],
  '规则、语言与外观'),
 ('fig', 'm-color', '调色窗：棋盘 / 页面底色、深浅主题与预制色'),

 # ---------------------------------------------------------------- 十一
 ('h1', '十一、连线功能（在外部对局软件中实战辅助）'),
 ('body', '连线功能是本版本的核心：它把「看棋盘」和「算棋」都放进一个固定尺寸的小窗里，通过屏幕识别读到你正在对局的那盘棋，再让引擎帮你想。它不接触对方软件的任何内部接口 —— 只做屏幕取像与模拟点击两件事。'),
 ('fig', ['l-window', 'l-panel'],
  '连线窗全貌（左：整窗；右：控制面板放大）—— 窗内自带上沿栏、控制面板、状态区与右侧局面小棋盘'),
 ('h2', '（一）框选与识别'),
 ('table', [22, 144],
  [['按键', '作用'],
   ['框选棋盘', '在屏幕上拖出一个矩形框住目标棋盘；框完成后窗内开始识别'],
   ['识别（窗栏）', '在窗栏点「识别」正式开认。成功时框由紫变蓝绿、四角出现 L 形角框与定位点'],
   ['自动落子', '打开后识别到对方落子即自动思考，并用模拟点击替你落子（详见下节）'],
   ['×1', '落子次数：每个落点连点几下，1 ~ 3 循环切换（标题提示当前档位）'],
   ['真实点击', '给<font color="#0f3f7a">只认「真实鼠标输入」</font>的程序用（如 QQ 五子棋这类自绘 / 防外挂窗口）：'
                '打开后每次落子都由系统真实移动光标并按下左键 —— 与真人操作完全同路径，'
                '不再去试窗口消息与模拟键盘鼠标输入。开关状态会被记住。'
                '代价是打开期间会占用你的物理鼠标，所以做成显式开关']],
  '框选与识别相关按键'),
 ('fig', 'l-top', '连线窗上沿：框选棋盘与识别键'),
 ('body', '识别全程在后台静默进行：采用<font color="#0f3f7a">帧间像素差分</font> —— 画面静止时零消耗，棋子一变才重新识别。因此框色不会来回闪，也不会持续占用 CPU。自动裁框时会向棋盘外多留 <font color="#0f3f7a">0.8 格</font>的余量（方形棋盘的最外侧一枚子最容易被切掉，这个余量保证它完整进框且不会把相邻 UI 误收进来）。'),
 ('h2', '（二）控制面板'),
 ('fig', 'l-rule', '规则三键：无禁手 / 长连不赢 / 有禁手'),
 ('table', [26, 140],
  [['控件', '说明'],
   ['规则三键', '无禁手 / 长连不赢 / 有禁手，直接切换连线窗使用的终局与禁手判定'],
   ['框选棋盘 / 自动落子 / ×1 / 真实点击', '见上一节'],
   ['AI 执黑 / AI 执白', '互斥的二选一（也可以都不选，由你自己下）；选择会<font color="#0f3f7a">无条件同步</font>到主窗对局设置里的执子'],
   ['思考时间', '0.2 ~ 300 秒，与主窗<font color="#0f3f7a">同一个口径</font>（两边始终一致）'],
   ['交换平衡点', '给出开局平衡点（见下节）'],
   ['交换评估', '与交换平衡点相互独立的另一项功能，用于评估当前交换局面的优劣，判断是否值得交换']],
  '连线窗控制面板按键'),
 ('fig', 'l-side', 'AI 执黑 / AI 执白与思考时间（互斥档，选中会同步到主窗）'),
 ('fig', 'l-swap', '交换平衡点与交换评估两键'),
 ('h2', '（三）状态区与局面小棋盘'),
 ('fig', 'l-stats', '状态区：深度 / 速度 / 节点 / 评估'),
 ('fig', 'l-status', '状态文字区（虚线大框，留足三行以上余量，中英文换行长也不折叠）'),
 ('table', [26, 140],
  [['区域', '内容'],
   ['状态行', '深度 / 速度 / 节点 / 评估，任意计算期间边算边跳'],
   ['状态文字', '一行说明当前在做什么（识别中 / 思考中 / 已标出平衡点等），虚线大框留足三行以上'],
   ['局面小棋盘', '实时镜像识别结果，旁边显示手数；语义与助手的局面小窗一致 —— 识别到什么就显示什么，'
                  '没识别到就保持上一手好盘面，不无故清空']],
  '连线窗状态区与局面小棋盘'),
 ('fig', 'l-board', '右侧局面小棋盘（实时镜像识别结果）与手数'),
 ('h2', '（四）分工：谁负责什么'),
 ('body', '连线窗负责识别与 AI 的全部工作（评估、自动落子）；主窗的大棋盘只<font color="#0f3f7a">同步显示</font>识别到的局面与执子设置，本身不参与评估、不落子。这样两侧永远不会抢同一份算力 —— 打开连线时主窗自动切到 1.16 : 1 的布局，关闭连线后主窗恢复你自己原来的模式与设置。'),
 ('h2', '（五）自动落子'),
 ('table', [22, 44, 100],
  [['级数', '方式', '触发条件'],
   ['一级', 'PostMessage 直达目标窗口', '默认首选：最轻、不干扰物理鼠标'],
   ['二级', 'SendInput 模拟输入', '一级回帧判定失败后自动升级'],
   ['三级', 'SetCursorPos + mouse_event 真实点击', '前两级都无效时的兜底；成功后会被「钉住」复用。'
                                              '落点前光标会从当前位置<font color="#0f3f7a">平滑滑过去</font>（不是瞬移），点完停在落点上'],
   ['真实点击模式', '跳过前两级，直接用三级', '打开「真实点击」开关时：第一发就走真实鼠标，'
                                            '且超时也不降级、不白试前两条管线'],
   ['裁决', '回帧确认', '每一级都用下一帧判断落子是否真的生效，未生效才升级'],
   ['重试', '整轮重来（最多 3 轮）', '三级全失效不会就此死等：自动重开一整轮，三轮都失败才停机提示'],
   ['收尾', '开局即自动结束', '一局结束（五子连珠）自动关闭自动落子，下一局需重新打开']],
  '自动落子的三级点击管线与重试'),
 ('body', '打开自动落子时若你执黑且棋盘是空的，它会先替你下天元。前两级全程不干扰物理鼠标；'
          '只有最后一级（真实点击）会真的借用光标 —— 它会像人一样从当前位置<font color="#0f3f7a">连续滑到落点</font>、'
          '停一下再按下，点完<font color="#0f3f7a">光标就停在落点上</font>（这正是真人操作的痕迹，'
          '专治只认真实鼠标轨迹的程序）。'),
 ('h2', '（六）交换平衡点'),
 ('body', '这是给「交换开局」用的：软件替你算出一组对双方都尽量公平的平衡开局点，并画在识别框内的对应交点上。它会自动参考 Rapfi 官方的平衡开局库 —— 以官方 SWAP2 开局表为母本，用棋盘的八种对称变换（恒等、主对角、左右、上下、180°、顺 / 逆时针 90°、副对角）展开并去重，实际可用 <font color="#0f3f7a">64 型</font>平衡开局，远超官方表内直接列出的 9 型。'),
 ('table', [30, 30, 26, 80],
  [['盘面手数', '给出点数', '颜色', '说明'],
   ['0 手（空盘）', '3 点', '两黑一白', '交换开局的第一阶段：先摆三子，由对手决定是否交换'],
   ['3 子（共 5 手）', '2 点', '一黑一白', '第二次交换：一手黑 + 一手白，补足到五手开局'],
   ['超过 5 子', '不调用', '—', '已过交换窗口，功能不可用并给出提示']],
  '交换平衡点在不同手数下的行为'),
 ('table', [30, 136],
  [['联动行为', '说明'],
   ['与 AI 执子互斥', '点「交换平衡点」的同时会自动取消已选的 AI 执黑 / AI 执白（两者会相互干扰）'],
   ['与自动落子联动', '先点平衡点、后开自动落子：评估完成时若自动落子已开，就按序自动把这几点落下；'
                      '若是评估完才打开自动落子，则打开的那一刻按序补摆'],
   ['标记生命周期', '标记留在识别框内不消失；平衡评估引擎随即释放、不再占用算力；你把该下的子下够（黑白各够颗数即可，'
                  '落点不必和圆圈分毫不差）标记就自动消失，方便下一手继续看局面']],
  '交换平衡点的联动逻辑'),
 ('h2', '（七）盘中标记'),
 ('table', [30, 46, 90],
  [['标记', '外观', '含义'],
   ['推荐落点', '天蓝圆圈', '引擎给出的推荐点'],
   ['交换平衡点 · 黑', '紫圈 + 序号', '两黑一白里的黑方落点，序号 1 / 2 / 3 表示落子顺序'],
   ['交换平衡点 · 白', '蓝圈 + 序号', '两黑一白里的白方落点'],
   ['误读防护', '全部排除出截图', '所有标记都直接画在识别框内的交点上，并被排除出屏幕捕获 —— '
                                   '绝不会被自己的识别器误读成棋子']],
  '棋盘上的各类标记'),
 ('h2', '（八）资源的科学分配'),
 ('body', '引擎、识别与界面<font color="#0f3f7a">共用全部逻辑核心</font>，谁也不被单独关进一小撮核里 —— '
          '这是棋力与稳定性同时最好的做法：引擎拿到的线程数与你单独运行单机训练器时<font color="#0f3f7a">完全一致</font>。'
          '真正需要隔离的场合（极老的机器、多个处理器组）可以显式开启核配额。'),
 ('table', [26, 40, 100],
  [['子系统', '占用', '说明'],
   ['引擎搜索线程', '全部逻辑核心', '与单独使用单机训练器时<font color="#0f3f7a">同一口径</font>；'
                                     '线程数可在引擎板块的「本机线程数 / 上限」里看到'],
   ['车道之间的借还', '按需，总量不超订', '同一时刻只有真正在搜索的车道占用线程：其它车道空闲时主搜直接拿满编，'
                                        '副搜在跑时主搜只让出它真占的那几条'],
   ['落子 / 快棋', '主搜独占满编', '落子这类独占事件会先让正在搜索的副车道带着当前最优解收尾，主搜随即吃满整组核'],
   ['屏幕识别', '与引擎共享核心', '识别是间歇性的（帧间像素差分），只在画面变化时才算，且只占很短时间'],
   ['屏幕抓取', '先显卡，不成再全 CPU', '抓屏首选举显卡的桌面复制通道（画面本来就在显存里），桌面没变时直接复用上一帧、几乎零开销；'
                                '建不起来（多屏拼接 / 远程桌面 / 无显卡驱动）或<font color="#0f3f7a">实测并不比 CPU 快</font>时'
                                '自动切换为全 CPU 抓屏，运行中显卡通道反复失败也会永久降级 —— 绝不为了「用显卡」而更慢。'
                                '边框与线族这类复杂的识别始终由 CPU 完成，两边各司其职'],
   ['对手思考时', '引擎继续算（有上限）', '你落子之后引擎并不会闲着：它会接着算对手最可能的应手（置换表越烧越热，'
                                  '你的下一手因此在同样的时间里搜得更深）。这道「后台思考」配了看门狗，'
                                  '长时间没有新棋步就自动收工，不会空转一整夜'],
   ['引擎主车道', '哈希独占所选档位', '正在干活的那条引擎车道独占 100% 置换表，其余车道降到地板值，'
                                      '总占用恒等于所选档位'],
   ['哈希自适应', '按可用内存折算', '按机器实际内存折算并夹在合理区间内；另有一道「不超过物理内存 1/3」的长跑安全线，'
                                   '连续运行一整天也不会把系统拖进分页'],
   ['信息流控', '按需上报', '与界面的信息通道只上报界面真正要用的那一档数据，避免海量冗余明细把通道灌满'],
   ['拥塞保护', '标记区环形缓冲', '标记与曲线数据用固定容量的环形缓冲承载，长时间连算也不会无限增长'],
   ['长期运行', '闲置车道不常驻', '只有确实会被用到的车道常驻引擎进程，其余车道第一次被用到时才启动，'
                                 '省下一个进程的内存与置换表建页开销']],
  '引擎与识别资源的科学分配'),
 ('h2', '（九）窗口常驻最上层'),
 ('body', '连线窗本身固定在桌面最上层：它以「顶层窗口」创建，并在窗口位置变化时把自己压回最上层，显示与设备状态变化时也会重新压一次 —— 因此它不会被对局软件的窗口盖住。你自己点最小化时软件不干预，只在你把它叫回来时重新置顶。'),
 ('table', [30, 136],
  [['收尾', '说明'],
   ['关闭连线窗', '主窗自动恢复你自己原来的模式与设置，对弈 / 计算等功能照常使用'],
   ['退出软件', '一并关闭所有引擎与相关进程，不在后台残留']],
  '连线窗的关闭与收尾'),

 # ---------------------------------------------------------------- 十二
 ('h1', '十二、常见问题'),
 ('table', [40, 60, 66],
  [['现象', '原因', '处理'],
   ['识别不到棋盘，或识别不稳定', '框选没有把四角与边框完整包住',
    '重新「框选棋盘」，可适当多框一点边缘；棋子较满时软件会结合棋子与边框共同判断'],
   ['棋盘边缘的子识别不到', '自动裁框余量不足，最外侧一枚被切掉',
    '本版已把外扩余量提高到 0.8 格（方形棋盘最外侧最易受影响的正是这一枚）；'
    '如仍出现，请把框选范围连棋盘外框一起框进去'],
   ['自动落子开着却一直不落子', '某一次三级点击都没生效，旧逻辑会停在这一轮不再重试',
    '本版改为「整轮重来」：一级 → 二级 → 三级全失效后自动重开一整轮，最多 3 轮；'
    '三轮都失败才停机提示。若仍不动，先点「框选棋盘」重新锁定'],
   ['对手程序收不到落子（如 QQ 五子棋这类自绘 / 防外挂窗口）', '它不认窗口消息，连模拟输入也过滤掉，只认真实鼠标',
    '打开连线窗的「<font color="#0f3f7a">真实点击</font>」开关：之后每次落子都由系统真实移动光标并按下左键，'
    '与真人操作同路径。代价是打开期间会占用你的物理鼠标，不需要时记得关掉'],
   ['棋力时高时低', '引擎没拿到应有的核 / 内存，偶尔被饿住',
    '本版让引擎<font color="#0f3f7a">与单机训练器拿到一样的线程数</font>（不再自行砍核），'
    '车道之间按「谁在搜谁占用」借还、互不超订；哈希表按实际内存自适应并夹住长跑安全线，'
    '同时收紧了信息上报；把思考时间调长也立竿见影'],
   ['偶见「引擎响应超时」', '极少数发生在引擎抢占 / 换档的瞬间',
    '软件会在约 1.5 秒后自动重评并静默重试，不影响正常落子'],
   ['一直提示正在识别', '空心选窗或首次预热中',
    '关闭空心选窗后重新框选；首次打开会做识别预热，稍候即可'],
   ['点了「交换平衡点」没有反应', '当前手数不在交换窗口内',
    '交换平衡点只在<font color="#0f3f7a">空盘</font>（两黑一白 3 点）或<font color="#0f3f7a">已有 3 子</font>（一黑一白 2 点）时可用；'
    '超过五手会明确提示「不在交换窗口」'],
   ['是否需要联网', '—', '不需要：软件与引擎全部在本机运行，不监听任何网络端口'],
   ['退出后是否残留进程', '—', '退出时会一并关闭所有引擎与相关进程，不在后台残留']],
  '常见问题与处理'),

 # ---------------------------------------------------------------- 十三
 ('h1', '十三、开源组件与许可'),
 ('body', '本软件由多个组件构成，各组件依其<font color="#0f3f7a">原始许可证</font>发布。下表列出随软件分发的全部第三方 / 开源组件、其许可证与官方链接，便于核对与获取源码。'),
 ('table', [34, 32, 36, 64],
  [['组件', '用途', '许可证', '官方链接'],
   ['Meter Gomoku 界面与配套代码', '界面、宿主程序与配套脚本（作者：Meter）', 'MIT',
    '随本说明附带许可声明'],
   ['Rapfi', '棋力内核（五子棋 / 连珠引擎），随本软件分发五个指令集变体与权重',
    'GNU GPL-3.0', '<a href="https://github.com/dhbloo/rapfi" color="#1457a8"><u>github.com/dhbloo/rapfi</u></a>'],
   ['OpenCV', '棋盘与棋子识别，静态链入 GomokuVision.exe，不额外分发 DLL',
    'Apache-2.0', '<a href="https://opencv.org" color="#1457a8"><u>opencv.org</u></a>'],
   ['Microsoft Edge WebView2 Runtime', '桌面界面运行时，由 Windows / Edge 提供，本软件不随包分发',
    '专有（微软）',
    '<a href="https://developer.microsoft.com/microsoft-edge/webview2/" color="#1457a8"><u>microsoft-edge/webview2</u></a>'],
   ['思源宋体 / 思源黑体（Source Han Serif / Sans）', '本说明的排版字体，随文档嵌入',
    'SIL OFL 1.1',
    '<a href="https://github.com/adobe-fonts/source-han-serif" color="#1457a8"><u>adobe-fonts</u></a>'],
   ['Inno Setup', '制作 Windows 安装包的工具（仅用于打包，不随软件分发）',
    'Inno Setup License（允许商用免费）',
    '<a href="https://jrsoftware.org/isinfo.php" color="#1457a8"><u>jrsoftware.org/isinfo.php</u></a>']],
  '随软件分发的第三方 / 开源组件一览'),
 ('table', [26, 140],
  [['许可证', '允许 / 要求 / 链接'],
   ['MIT', '允许免费获得、使用、复制、修改、合并、发布、分发、再许可与销售副本；'
            '<font color="#0f3f7a">要求</font>在副本中保留原版权声明与许可声明；软件按「现状」提供，不附任何明示或默示担保'],
   ['GNU GPL-3.0',
    '允许免费获取、使用、修改与再分发；<font color="#0f3f7a">要求</font>分发时保留许可证并提供源码获取方式'
    '（Rapfi 源码见 ' + Lk('https://github.com/dhbloo/rapfi', 'github.com/dhbloo/rapfi') +
    '，许可证全文见 ' + Lk('https://www.gnu.org/licenses/gpl-3.0.html', 'gnu.org/licenses/gpl-3.0') + '）'],
   ['Apache-2.0',
    '允许商用与再分发；<font color="#0f3f7a">要求</font>保留版权与许可声明、标注修改；'
    '许可证全文见 ' + Lk('https://www.apache.org/licenses/LICENSE-2.0', 'apache.org/licenses/LICENSE-2.0')],
   ['SIL OFL 1.1',
    '允许免费用于个人与商业用途，包括嵌入文档再分发；<font color="#0f3f7a">要求</font>不得单独出售字体文件本身，'
    '不得以原字体名销售改造版本；全文见 ' + Lk('https://openfontlicense.org', 'openfontlicense.org')],
   ['专有（WebView2）',
    '按微软自身条款使用；本安装包不对其再分发，仅在缺失时引导前往官方页面下载']],
  '各许可证的要点与全文链接'),
 ('h3', '合规说明'),
 ('body', '（1）Rapfi —— 本软件以编译后的独立进程方式调用 Rapfi，双方只通过标准输入输出与消息通信，不与 Rapfi 合并为同一作品；随本软件分发 Rapfi 时已一并保留其 GPL-3.0 许可文本与来源说明（位于 rapfi-native/ 目录）。'),
 ('body', '（2）OpenCV —— 以静态链接方式并入 GomokuVision.exe，未额外分发 OpenCV 的动态库；其 Apache-2.0 许可要求保留版权与许可声明，已在识图组件处保留。'),
 ('body', '（3）字体 —— 本说明与软件界面不使用任何非商用授权字体（例如微软雅黑、黑体等 Windows 系统字体），全部改用同源开源的思源宋体 / 思源黑体。'),
 ('body', '（4）开发期依赖 —— 开发与构建期使用的脚本及其依赖（NumPy、Pillow、PyMuPDF、reportlab 等）只在本机运行，不随软件分发，因此不在上表之列。'),
 ('body', '（5）免责声明 —— 本软件按「现状」提供，作者不对软件的适用性、稳定性或任何直接 / 间接损失承担责任。请在遵守对弈平台规则的前提下合理使用辅助功能。各组件名称与商标归其各自权利人所有。'),
 ('foot', '作者：Meter　界面与配套代码以 MIT 许可发布，棋力内核 Rapfi 以 GPL-3.0 发布，'
          '识别组件与 OpenCV 以 Apache-2.0 发布，文档排版使用思源宋体 / 思源黑体（SIL OFL 1.1 开源授权）。'
          '下载：' + DL_URL + '　取件密码：' + DL_PWD),
]

# ==================================================================== English
en = [
 ('title', 'Meter Gomoku'),
 ('sub', 'Gomoku Study and Live-Play Assistant　Version %s　Author: Meter' % VER),
 ('h1', 'Contents'),
 ('toc', '1. Introduction'),
 ('toc', '2. Download, Install and Run'),
 ('toc', '3. Game Setup (Mode, AI Side, Thinking Time, Rules, Engine, Board Display, Position)'),
 ('toc', '4. Board Operations and Endgame Setup'),
 ('toc', '5. Calculation and Evaluation (Calc, Multi-point, Balance 1/2, Defend Scan, Coach, Live Analysis, Clear Marks)'),
 ('toc', '6. Lookahead, VCF and VCT'),
 ('toc', '7. Engine Dashboard and Evaluation Curve'),
 ('toc', '8. History and Review'),
 ('toc', '9. Screen Recognition (Gomoku Vision)'),
 ('toc', '10. Rules, Language and Appearance'),
 ('toc', '11. Link Mode (assistance inside another playing app)'),
 ('toc', '12. Frequently Asked Questions'),
 ('toc', '13. Open-Source Components and Licences'),

 # ---------------------------------------------------------------- 1
 ('h1', '1. Introduction'),
 ('body', 'Meter Gomoku is a Gomoku (Five in a Row) study and training tool that runs on your own computer. It combines position analysis, engine evaluation, mate search, screen recognition and live-play assistance. Every calculation happens locally: the UI and the engine talk to each other in-process through C++, the recognition component runs through a local pipe, and the app listens on no network port at all (zero HTTP, zero WebSocket), so it works fully offline.'),
 ('body', 'There are three surfaces: the main window (board plus three feature cards), the Review window (a standalone board-only window that never talks to the engine) and the Link window (assistance inside another playing app). The main and Review windows share the same UI code; the Link window is a fixed-size small window that runs on its own.'),
 ('body', 'This manual describes the software feature by feature, illustrated with real UI slices cut along the structure of the interface, so that the text and the screen always line up.'),
 ('table', [40, 126],
  [['What you want to do', 'Where to look'],
   ['Play a game, practise against the AI, review a game', 'Section 3 Game Setup / Section 4 Board Operations'],
   ['See how good a move is, or what to defend', 'Section 5 Calculation and Evaluation'],
   ['Search a forced winning line', 'Section 6 Lookahead, VCF and VCT'],
   ['Turn a screenshot of a game into a position you can study', 'Section 9 Screen Recognition'],
   ['Get help while playing inside another app', 'Section 11 Link Mode'],
   ['Check open-source components, or fix a problem', 'Section 13 Licences / Section 12 FAQ']],
  'Chapter index by need'),

 # ---------------------------------------------------------------- 2
 ('h1', '2. Download, Install and Run'),
 ('body', 'The app is portable: unzip it anywhere (an ASCII path is safest, or just use the installer and keep the default location) and double-click the main program. It writes no registry keys and installs no drivers.'),
 ('table', [30, 136],
  [['Item', 'Details'],
   ['Name', 'Meter Gomoku Link Trainer (main program: Desktop GomokuTrainer)'],
   ['Version', 'v%s' % VER],
   ['Download', '<a href="%s" color="#1457a8"><u>%s</u></a>' % (DL_URL, DL_URL)],
   ['Password', '<b>%s</b> (enter it on the download page when asked)' % DL_PWD],
   ['Platform', 'Windows 10 / 11 64-bit; also runs on Windows Server'],
   ['Install', 'Portable - unzip and run. An installer is also provided that adds a Start-menu shortcut'],
   ['Licensing', 'Interface and companion code MIT; playing core Rapfi GPL-3.0; recognition component and OpenCV Apache-2.0'],
   ['Manual', 'This document (bilingual) ships inside the package']],
  'Release information (download link and password)'),
 ('h2', 'Runtime requirements'),
 ('table', [28, 48, 90],
  [['Item', 'Requirement', 'Notes'],
   ['Operating system', 'Windows 10 1809 or later (2004+ / Windows 11 recommended)',
    'Border recognition and the always-on-top window use display APIs from Windows 10 2004; on older systems the app downgrades automatically without losing features'],
   ['UI runtime', 'Microsoft Edge WebView2 Runtime',
    'Normally already present on Windows 10 / 11; if it is missing the installer points you to the free Microsoft download page'],
   ['Processor', 'x86-64 with SSE4.1 or later',
    'The engine ships in five instruction-set variants and picks the fastest one for your CPU at start-up, falling back to the SSE build on older machines'],
   ['Memory', '4 GB minimum, 8 GB or more recommended',
    'The engine transposition table scales with available memory; more memory means steadier long searches'],
   ['Graphics', 'None', 'Pure CPU calculation - no GPU and no discrete card required'],
   ['Network', 'Not required', 'Everything runs locally; no port is opened, so it works offline']],
  'Runtime environment and dependencies'),
 ('h2', 'Folders'),
 ('table', [46, 120],
  [['Path', 'Contents'],
   ['Desktop GomokuTrainer.exe', 'Main program: UI host, engine scheduling, recognition scheduling'],
   ['Vision/', 'Recognition component GomokuVision.exe and its statically linked library (including OpenCV)'],
   ['rapfi-native/', 'Playing core Rapfi in five instruction-set variants (avx512vnni / avxvnni / avx512 / avx2 / sse), '
                     'its neural-network weights, opening and configuration files, plus the GPL licence text and source notice'],
   ['calc/', 'UI resources: encrypted pages, styles and scripts (kept encrypted so they cannot be edited by accident)'],
   ['软件说明 (Software Description).pdf', 'This manual (Chinese first, English after; clickable contents and bookmarks)']],
  'Folder structure and what each file does'),

 # ---------------------------------------------------------------- 3
 ('h1', '3. Game Setup'),
 ('body', 'The "Game Setup" card on the right of the main window has four collapsible sections: Game, Engine, Board Display and Position. Click a section title to fold or unfold it.'),
 ('h2', '(a) The Game section'),
 ('body', 'This section decides who plays whom, for how long, and under which rules.'),
 ('fig', 'm-set-game', 'Game Setup - the Game section (mode / AI side / thinking time / rules)'),
 ('h3', 'Mode'),
 ('table', [24, 34, 108],
  [['Mode', 'AI plays?', 'Typical use'],
   ['Match', 'Yes (answers automatically per the AI-side setting)', 'Real play, review, practising against the AI - the everyday mode'],
   ['Place', 'No', 'Free stone placement to study shapes and variations; hint, heat and coach features stand down'],
   ['Endgame', 'No', 'Set up one position to study, using the placement keys and Confirm under the board - see section 4']],
  'The three modes'),
 ('h3', 'AI side'),
 ('body', 'The two switches combine freely; each of the four combinations has a clear meaning:'),
 ('table', [22, 22, 40, 82],
  [['AI Black', 'AI White', 'Moves first', 'Notes'],
   ['On', 'Off', 'AI (centre point)', 'You play White. The AI opens on the centre point and answers your moves'],
   ['Off', 'On', 'You', 'You play Black. The AI answers after your move'],
   ['On', 'On', 'Both are AI', 'AI self-play: you just watch, board clicks are ignored; the centre key pauses / resumes'],
   ['Off', 'Off', 'You', 'Two-player manual play: no AI, you play both colours']],
  'The four AI-side combinations'),
 ('h3', 'Thinking time'),
 ('table', [28, 44, 94],
  [['Item', 'Value', 'Notes'],
   ['Range', '0.2 to 300 s in 0.1 s steps', 'Default 2 s - from lightning-fast to a deep think'],
   ['Presets', '0.5 / 1 / 1.5 / 2 / 3 / 4 / 5 s', 'One-click switching for the common settings'],
   ['Strength', 'Longer is stronger', 'The heat-map and coach colour bands follow the thinking time as well'],
   ['Short-time boost', 'Active at 1 s or below',
    'During the calculation the app briefly requests a higher CPU frequency and restores it afterwards, improving strength in very short searches']],
  'Thinking-time settings and their effect'),
 ('h3', 'Rules'),
 ('table', [30, 14, 14, 108],
  [['Rule', 'Forbidden', 'Swap', 'Key points'],
   ['Freestyle', 'None', 'No', 'Five or more in a row wins - the most permissive rule'],
   ['Freestyle, overline loses', 'None', 'No', 'Standard: an overline does not win, exactly five is required'],
   ['Renju (forbidden moves)', 'Black', 'No', 'Black is forbidden 3-3 / 4-4 / overline; White is unrestricted. Forbidden points are drawn as red crosses'],
   ['Swap1', 'None', 'Yes', 'After Black plays move 1, White may choose to swap colours'],
   ['Yamaguchi', 'Yes', 'Yes',
    'Black places 3 stones (B1 centre, W2 within 3x3, B3 within 5x5) and declares how many 5th-move picks there will be; '
    'White picks a colour and plays move 4 anywhere; Black names the picks (symmetric points may not repeat) and White chooses one as move 5'],
   ['Taraguchi-10', 'Yes', 'Yes',
    'B1 centre, W2 within 3x3, B3 within 5x5, W4 within 7x7; move 5 is either played directly (9x9) or Black calls ten picks with White choosing one, then White picks a colour'],
   ['Tarannikov', 'Yes', 'Yes',
    'B1 centre, W2 within 3x3, B3 within 5x5, W4 within 7x7, B5 within 9x9; after every move the opponent may swap colours. No tentative fifths']],
  'The seven rules: forbidden moves, colour swapping and key points'),
 ('body', 'Lookahead and mate search follow the selected rule. Swap-type rules open a small dialog at the start of the game asking you to choose first or second. Switching rules <font color="#0f3f7a">never clears the board</font> - the position is kept and play continues under the new rule, with the result and the forbidden marks recomputed.'),
 ('h2', '(b) The Engine section'),
 ('fig', 'm-set-engine', 'Game Setup - the Engine section (system info / threads / hash)'),
 ('table', [28, 138],
  [['Field', 'Meaning and how to tune it'],
   ['System info', 'Shows your processor, the instruction-set variant in use (which decides the engine build) and system memory, refreshed every 3 s. First thing to look at when moving to another machine'],
   ['Threads', 'The engine search thread count. The drop-down lists the allowed steps and the local thread count and its cap are shown beside it. More threads means more parallelism, but returns fall off past the physical core count'],
   ['Hash', 'The engine transposition-table (TT) size. The working engine lane takes 100% of the selected step while the other lanes drop to a floor value, so the <font color="#0f3f7a">total always equals the chosen step</font> and never doubles just because more lanes exist']],
  'The three Engine fields'),
 ('h2', '(c) The Board Display section'),
 ('fig', 'm-set-view', 'Game Setup - the Board Display section (move numbers / preview box)'),
 ('body', '"Show move numbers" prints the move order on each stone, which is most useful when reviewing. The "preview box" is the rounded square shown under the mouse; it is on by default, and turning it off gives a cleaner board.'),
 ('h2', '(d) The Position section'),
 ('fig', 'm-set-code', 'Game Setup - the Position section (copy / paste / load a position code)'),
 ('body', 'A position code is a lowercase column letter plus row number, concatenated move by move (the ' +
          Lk('https://gomocalc.com', 'gomocalc.com') + ' format). For example ' +
          '<font face="SRCHEI">h8i9g7</font> means H8, then I9, then G7. Use Copy / Paste / Load to import, '
          'export, share or archive a position.'),
 ('h2', '(e) The AI-side pop-up'),
 ('fig', 'm-aiside', 'The "AI side" pop-up, reachable at any time from the button row under the board'),

 # ---------------------------------------------------------------- 4
 ('h1', '4. Board Operations and Endgame Setup'),
 ('fig', 'm-board', 'The main board: coordinate axes along the top, the button row along the bottom, and one resume / pause key at the centre'),
 ('table', [32, 42, 92],
  [['Action', 'How', 'Notes'],
   ['Play a move', 'Click an intersection', 'The side to move follows the parity of the move count - no manual switching'],
   ['Previous / next', 'The ‹ › keys under the board', 'Step back and forward one move at a time, for review'],
   ['Restart', 'The Restart key under the board', 'Saves the current game to History first, then clears the board'],
   ['Save position', 'The Save position key', 'Stores the current position in History manually'],
   ['Rotate', 'The Rotate key', 'Turns the stones 90 degrees clockwise'],
   ['Flip', 'The Flip key', 'A pop-up offers left-right, top-bottom and the two diagonal flips'],
   ['Shift', 'The Shift key', 'Moves the whole position one cell; if a stone would leave the board nothing moves and you are told'],
   ['Think one move now / pause', 'The key at the board centre', 'When idle, the AI computes and plays one move for the side to move; while thinking, it pauses'],
   ['AI side / Settings', 'The two rightmost keys under the board', 'Open the AI-side and Settings pop-ups']],
  'Board operations at a glance'),
 ('body', 'Rotate, Flip and Shift move the stones only - the grid and the coordinate axes never move.'),
 ('h2', 'Endgame setup'),
 ('body', 'Switch the mode to Endgame and placement keys appear under the board, so you can set up an exact position to study:'),
 ('table', [32, 134],
  [['Key', 'How to use it'],
   ['Alternate placement', 'Black and White take turns, placed in move order'],
   ['Free placement', 'Open the small rounded box, pick Black or White, then place that colour freely in any number and any order; the selected key changes colour'],
   ['Confirm', 'Press it to fix the position: the key turns pale green and reads confirmed. From then on Restart returns to this position and it becomes the first frame when saved to History; press it again to release']],
  'The three endgame placement keys'),
 ('body', 'In Endgame mode the AI takes no part at all, and swap-type rules are greyed out (an endgame has no opening swap).'),

 # ---------------------------------------------------------------- 5
 ('h1', '5. Calculation and Evaluation'),
 ('body', 'This card is the analysis workbench. Its seven features are independent of one another, every result is drawn straight onto the board, and "Clear marks" erases all of their traces in one press.'),
 ('fig', 'm-analysis', 'The Calculation and Evaluation card, from Calc and Multi-point through Balance, Defend scan and Coach to Live analysis'),
 ('table', [26, 140],
  [['Feature', 'What it does and how to use it'],
   ['Calc', 'A single deep search of the current position that marks the best point on the board; the key toggles between Calc and Stop'],
   ['Multi-point analysis', 'Returns several candidates according to "Analysis points" (2 to 8, default 4), each circle carrying its rank and score'],
   ['Balance 1', 'Picks the candidate whose score is closest to zero - the most even move'],
   ['Balance 2', 'Virtually plays each candidate and looks at the opponent reply, then picks the most solid move'],
   ['Defend scan', 'Scores every empty point in a 9x9 neighbourhood and shows the points you should defend (the higher the percentage, the more dangerous). Once started it re-scans automatically after each move until you clear the marks or restart'],
   ['Coach', 'While it is your turn, square four-colour hints show the best move (Best / Good / Fair / Poor); they vanish as soon as you move'],
   ['Live analysis', 'The toggle at the bottom left of the board: when on, the main lane keeps deepening the current position and lays out the engine\'s current list (best point plus candidates, up to 8), changing and converging naturally as the search deepens. Your move or undo restarts the session automatically and the dashboard time accumulates across turns; press again to stop'],
   ['Clear marks', 'One press erases every analysis mark this card leaves on the board (the badges and scores, the percentages and win-loss badges of Defend scan, and the numbers, dashed lines and code chain of Lookahead, VCF and VCT) without touching the position itself']],
  'The seven features of Calculation and Evaluation'),
 ('table', [30, 136],
  [['Item', 'Value and meaning'],
   ['Analysis points', '2 to 8, default 4; how many candidates Multi-point returns at once'],
   ['Danger gradient', 'Teal to green to yellow to orange to red, continuous - the redder, the more dangerous'],
   ['Coach colours', 'Four bands: Best / Good / Fair / Poor'],
   ['Live-analysis list', 'Best point plus candidates, up to 8, converging automatically as the search deepens']],
  'Key parameters of Calculation and Evaluation'),
 ('body', 'Live analysis also works in Place, Endgame and two-player manual play - as long as there is a "you" side to analyse for, the list keeps updating.'),

 # ---------------------------------------------------------------- 6
 ('h1', '6. Lookahead, VCF and VCT'),
 ('table', [24, 142],
  [['Feature', 'Description'],
   ['Lookahead', 'Plays the position forward move by move until five in a row genuinely appears on the board - it never declares a result from the engine\'s score, and in the worst case fills the board and calls a draw. The first move uses a reinforced global search to find a breakthrough and an estimated time range is shown; the simulated stones are translucent with the move number on them; every step applies forced-reply checking (make five if you can, block an opponent five, answer a live three)'],
   ['VCF', 'Continuous-four forced-win search: only sequences of consecutive fours are considered'],
   ['VCT', 'Continuous-four plus live-three threat search: live threes join the threat sequence'],
   ['Attacking side', 'The Black / White tags are indicators only (not clickable). The side is decided automatically as the side to move; in mate problems, by convention, the side with more stones'],
   ['Code chain', 'Step through it with the arrow keys; hovering previews up to that move; click to select and press Confirm to play that segment onto the board'],
   ['Ten-call', 'Asks for 10 candidate points for the opponent to choose from']],
  'The six features of Lookahead, VCF and VCT'),
 ('body', 'VCF and VCT both run a local mate searcher (multi-threaded with iterative deepening). On success the winning line is drawn on the board; if there is none, a dialog states plainly that the attacking side has no such forced win. Once selected, they keep probing while you play and switch into the mate sequence as soon as it can take over.'),

 # ---------------------------------------------------------------- 7
 ('h1', '7. Engine Dashboard and Evaluation Curve'),
 ('fig', 'm-engine', 'The Engine Dashboard and Evaluation Curve card'),
 ('table', [26, 140],
  [['Field', 'Meaning'],
   ['Depth', 'How deep the current search has reached, in plies'],
   ['Speed', 'Nodes searched per second - the quickest way to see whether the compute is being used properly'],
   ['Nodes', 'Total number of nodes expanded in this search'],
   ['Time', 'Elapsed time (accumulated across turns in Live analysis mode)'],
   ['Eval', 'The score of the current position for the side to move: positive is better, negative is worse'],
   ['Best', 'The best move the current search has found'],
   ['Evaluation curve', 'Records the whole game as a Black line and a White line; the vertical axis scales automatically (up to about 1200) and the horizontal axis scrolls'],
   ['Status line', 'Your turn / AI thinking / paused / game over / reciting, etc. (at most two lines)']],
  'Dashboard and curve fields'),
 ('body', 'During any calculation (AI move, evaluation, multi-point, balance, defend scan, coach, lookahead, live analysis) these values update live - the most direct way to tell whether the engine is working and working smoothly.'),

 # ---------------------------------------------------------------- 8
 ('h1', '8. History and Review'),
 ('fig', ['m-drawer', 'm-rv'], 'The History drawer (left) and the Review window (right): the drawer stores games, the review window is board only'),
 ('table', [34, 132],
  [['Key / action', 'What it does'],
   ['History / Saved', 'The two pages inside the drawer: automatic archives, and games you saved yourself'],
   ['Open', 'Loads the selected game onto the board (VC and Endgame records open with the whole position as the first frame)'],
   ['Save selected', 'Moves the selected records into the Saved page'],
   ['Delete / Select all', 'Deletes the selected records; Select all ticks everything on the current page'],
   ['Import / Export', 'txt import and export are supported'],
   ['Ctrl / Shift multi-select', 'Continuous or scattered multi-selection, like a file manager'],
   ['Right-click menu', 'On a single record: open the review, rename, export that game, store it in Saved History or delete it'],
   ['Review window', 'The top-bar Review button opens a standalone board-only window that never talks to the engine; Recite / Replay review steps through the game move by move'],
   # 2026-10-09: the review bar keys (incl. Numbers) were missing from this table entirely.
   ['Review window: Numbers', 'The Numbers key inside the review window labels every stone with its move number. It is <font color="#0f3f7a">independent</font> of Move numbers in Game Setup - during Recite review the numbers would print the answer onto the board, so this one starts off and its state is remembered'],
   ['Review window: Redo / Save position / History', 'Redo clears back to the opening (nothing is written to History); Save position stores the game in Saved History; History picks a game to load without leaving the review window. Keyboard: Ctrl+Z previous, Ctrl+R redo']],
  'History drawer and Review window operations'),

 # ---------------------------------------------------------------- 9
 ('h1', '9. Screen Recognition (Gomoku Vision)'),
 ('fig', 'm-vis', 'The recognition panel: upload / screenshot, framing, recognition, manual editing and the image drawer'),
 ('table', [26, 140],
  [['Step', 'Notes'],
   ['Upload / screenshot', 'Import a screenshot of a game, or capture a screen region directly'],
   ['Frame', 'The selection box snaps to the board and leaves about 1/30 of the board as margin so the outermost stones stay complete; you can also frame the image region by hand before recognising'],
   ['Recognize', 'Press Recognize to start; the result becomes a position code that can be copied or loaded for practice'],
   ['Edit', 'Manual fixes: swap Black and White (click one of each), delete stones, add Black or White stones; Ctrl+Z undoes'],
   ['Image drawer', 'Every uploaded image goes into the drawer automatically (the oldest are dropped past 150), with multi-select, delete and copy']],
  'How to use screen recognition'),
 # 三列，栏宽必须给足（见上表中文的同一条注释）
 ('table', [30, 52, 84],
  [['', 'Normal recognition', 'VC (mate problem) mode'],
   ['Black / White counts', 'Must be equal', 'May differ'],
   ['Add / delete stones', 'Constrained by the game', 'Add Black or White without limit; delete freely'],
   ['After loading', 'Play continues from the position', 'Switches to Endgame mode and presets the attacking side (the side with more stones)'],
   ['Mate search', 'Not started automatically', 'Also not automatic - press VCF or VCT to decide']],
  'VC mode versus normal recognition'),

 # ---------------------------------------------------------------- 10
 ('h1', '10. Rules, Language and Appearance'),
 ('table', [28, 138],
  [['Item', 'Notes'],
   ['Rules', 'The seven rules listed in section 3 (Game Setup / Rules)'],
   ['Language', 'The top-bar EN / 中 button switches the whole UI in one click, including the screenshot-box buttons and the date format in History'],
   ['Colour', 'The palette window manages the board colour, the page colour, the dark and light themes and the preset schemes'],
   ['Layout', 'The right-hand cards can be dragged by the title bar to reorder, folded with the small dash and hidden with the close key; the layout is remembered for next time'],
   ['Text selection', 'Chrome text - buttons, titles, labels - <font color="#0f3f7a">cannot be selected or copied</font>, so dragging the window or the board never leaves a blue smear behind. Game records, history moves, logs and input boxes remain fully selectable and copyable']],
  'Rules, language and appearance'),
 ('fig', 'm-color', 'The palette window: board and page colours, themes and presets'),

 # ---------------------------------------------------------------- 11
 ('h1', '11. Link Mode (assistance inside another playing app)'),
 ('body', 'Link mode is the heart of this release. It puts both "look at the board" and "think about the board" into one fixed-size small window: it reads the game you are playing through screen recognition, then lets the engine think for you. It touches none of the other app\'s internals - it does exactly two things: capture the screen and simulate clicks.'),
 ('fig', ['l-window', 'l-panel'],
  'The Link window (left: whole window; right: the control panel enlarged) - the bar, the panel, the status area and the position mini board on the right'),
 ('h2', '(a) Framing and recognition'),
 ('table', [24, 142],
  [['Key', 'What it does'],
   ['Frame Board', 'Drag a rectangle over the target board on screen; recognition starts once the frame is set'],
   ['Recognize (window bar)', 'Press it on the window bar to start recognising. On success the frame turns from purple to teal and L-shaped corner brackets with anchor points appear'],
   ['Auto Drop', 'When on, the app thinks as soon as it sees the opponent move and plays for you through simulated clicks (see below)'],
   ['x1', 'Clicks per move: 1 to 3, cycling (the tooltip shows the current step)'],
   ['Real Click', 'For programs that accept <font color="#0f3f7a">real mouse input only</font> '
                  '(self-drawn or anti-cheat windows such as QQ Gomoku). When it is on, every move really moves the '
                  'cursor and presses the left button through the system - exactly the same path as a human, with no '
                  'window messages or simulated keystrokes tried first. The switch is remembered. The cost is that it '
                  'takes over your physical mouse while it is on, which is why it is an explicit switch']],
  'Framing and recognition keys'),
 ('fig', 'l-top', 'The Link window bar: Frame Board and Recognize'),
 ('body', 'Recognition runs quietly in the background using <font color="#0f3f7a">inter-frame pixel diffing</font>: nothing is computed while the picture is still, and a re-read happens only when a stone changes. That is why the frame colour never flashes back and forth and why recognition costs no CPU at rest. When the crop box is auto-tightened it leaves <font color="#0f3f7a">0.8 cells</font> of margin outside the board - the outermost stone on a square board is exactly the one that used to get clipped, and this margin keeps it complete without pulling in neighbouring UI.'),
 ('h2', '(b) The control panel'),
 ('fig', 'l-rule', 'The three rule keys: Freestyle / Overline / Renju'),
 ('table', [28, 138],
  [['Control', 'Notes'],
   ['Rule keys', 'Freestyle / Overline / Renju - switches the endgame and forbidden-move rules used by the Link window'],
   ['Frame Board / Auto Drop / x1 / Real Click', 'See the previous section'],
   ['AI Black / AI White', 'Mutually exclusive (you may also select neither and play yourself). The choice is mirrored <font color="#0f3f7a">unconditionally</font> into Game Setup in the main window'],
   ['Think time', '0.2 to 300 s, the <font color="#0f3f7a">same single value</font> as the main window - the two are always in step'],
   ['Swap Balance', 'Gives opening balance points (see below)'],
   ['Swap Eval', 'A feature independent of Swap Balance that scores the current swap position to help you decide whether swapping is worthwhile']],
  'The Link control panel'),
 ('fig', 'l-side', 'AI Black / AI White and Think time (mutually exclusive; the choice mirrors to the main window)'),
 ('fig', 'l-swap', 'Swap Balance and Swap Eval'),
 ('h2', '(c) Status area and position mini board'),
 ('fig', 'l-stats', 'Status figures: Depth / Speed / Nodes / Eval'),
 ('fig', 'l-status', 'The status text area (a dashed box with room for three lines or more, so long English wraps never fold up)'),
 ('table', [28, 138],
  [['Area', 'Contents'],
   ['Status figures', 'Depth / Speed / Nodes / Eval, updating live during any calculation'],
   ['Status text', 'One line saying what is happening (recognising / thinking / balance points marked, ...) in a roomy dashed box'],
   ['Position mini board', 'Mirrors the recognised position live, with the move count beside it. It follows the same rule as the assistant position window: it shows what the current frame recognised and keeps the last good position when nothing is recognised - it is never cleared for no reason']],
  'Status area and position mini board'),
 ('fig', 'l-board', 'The position mini board (mirroring the recognised position) and the move count'),
 ('h2', '(d) Division of labour'),
 ('body', 'The Link window owns all recognition and all AI work (evaluation and auto drop). The main board only <font color="#0f3f7a">mirrors</font> the recognised position and the AI-side setting and never evaluates or drops, so the two can never fight over the same compute. Opening Link mode switches the main window to a 1.16 : 1 layout; closing it restores your own mode and settings.'),
 ('h2', '(e) Auto Drop'),
 ('table', [22, 46, 98],
  [['Stage', 'Method', 'Trigger'],
   ['1', 'PostMessage straight to the target window', 'The default first choice: lightest, and it never disturbs the physical mouse'],
   ['2', 'SendInput', 'Escalated automatically when the next frame says stage 1 failed'],
   ['3', 'SetCursorPos + mouse_event (a real click)', 'The last resort when both earlier stages fail; once it works it is pinned and reused. The pointer <font color="#0f3f7a">glides</font> to the point instead of jumping, and stays there afterwards'],
   ['Real Click mode', 'Skips stages 1 and 2, goes straight to stage 3', 'Active while the Real Click switch is on: the very first attempt is a real mouse action, and a timeout never downgrades it or retries the two earlier stages'],
   ['Verdict', 'Next-frame confirmation', 'Every stage is judged by the following frame; only a failure escalates'],
   ['Retry', 'A whole round restarts (up to 3 rounds)', 'All three stages failing no longer means waiting forever: a full round restarts automatically, and only three failed rounds stop and tell you'],
   ['Finish', 'Ends with the game', 'A finished game (five in a row) switches Auto Drop off; the next game needs it turned on again']],
  'The three-stage click pipeline and its retry'),
 ('body', 'If you play Black and the board is empty when Auto Drop is switched on, it plays the centre opening move for you. The first two stages never disturb your physical mouse; only the last one (a real click) borrows the cursor - it <font color="#0f3f7a">slides</font> from wherever the pointer is to the target point, pauses, presses, and then <font color="#0f3f7a">leaves the pointer there</font>, exactly like a human hand. That is what programs which only accept real mouse input need.'),
 ('h2', '(f) Swap Balance'),
 ('body', 'This is for swap openings: the app computes a set of opening points that are as fair as possible for both sides and draws them on the matching intersections inside the recognition frame. It draws on Rapfi\'s official balanced-opening library - taking the official SWAP2 table as the parent and expanding it through the board\'s eight symmetries (identity, main diagonal, left-right, top-bottom, 180 degrees, clockwise and anticlockwise 90 degrees, anti-diagonal) and de-duplicating the results, giving <font color="#0f3f7a">64</font> usable balanced openings, far more than the 9 listed directly in the official table.'),
 ('table', [30, 26, 26, 84],
  [['Stones on board', 'Points given', 'Colours', 'Notes'],
   ['0 (empty board)', '3 points', '2 Black, 1 White', 'The first stage of a swap opening: place three stones and let the opponent decide whether to swap'],
   ['3 stones (5 moves total)', '2 points', '1 Black, 1 White', 'The second exchange: one Black plus one White, completing a five-move opening'],
   ['More than 5 stones', 'Not used', '-', 'Past the swap window - the feature reports that it is unavailable']],
  'Swap Balance behaviour by move count'),
 ('table', [30, 136],
  [['Interaction', 'Notes'],
   ['Exclusive with AI side', 'Pressing Swap Balance automatically cancels any selected AI Black / AI White, because they would interfere'],
   ['Interaction with Auto Drop', 'Press Swap Balance first, then turn Auto Drop on: if Auto Drop is already on when the evaluation finishes the points are played automatically in order; if Auto Drop is turned on only after the evaluation, the points are played in order the moment it is switched on'],
   ['Marker lifetime', 'The markers stay inside the recognition frame; the balance engine is released immediately and stops using compute; as soon as you have played the stones they ask for (one Black and one White is enough - the points do not have to match the rings pixel for pixel) the markers disappear by themselves, ready for the next position']],
  'How Swap Balance interacts with the rest'),
 ('h2', '(g) On-board marks'),
 ('table', [30, 46, 90],
  [['Mark', 'Appearance', 'Meaning'],
   ['Suggested move', 'Sky-blue ring', 'The move the engine recommends'],
   ['Swap Balance - Black', 'Purple ring + number', 'A Black point of the 2-Black-1-White set; the number 1 / 2 / 3 is the order of play'],
   ['Swap Balance - White', 'Blue ring + number', 'A White point of the same set'],
   ['Capture protection', 'Excluded from screenshots', 'Every mark is drawn directly on the matching intersection inside the recognition frame and is excluded from screen capture - it can never be misread as a stone by the app\'s own recognition']],
  'The marks drawn on the board'),
 ('h2', '(h) Scientific resource allocation'),
 ('body', 'The engine, screen recognition and the UI <font color="#0f3f7a">share every logical core</font> - none of them is locked into a small subset of cores. That is the best arrangement for strength and stability at the same time: the engine gets exactly the same thread count as when you run the standalone trainer on its own. On machines that genuinely need isolation (very old hardware, multiple processor groups) the core quota can be switched on explicitly.'),
 ('table', [30, 38, 98],
  [['Subsystem', 'Share', 'Notes'],
   ['Engine search threads', 'Every logical core', 'The <font color="#0f3f7a">same setting</font> as the standalone trainer. The exact thread count appears under "threads / cap" in the Engine section'],
   ['Borrow and return between lanes', 'On demand, never oversubscribed', 'Only the lanes actually searching hold threads at any moment: when the other lanes are idle the main lane takes the full budget, and when an auxiliary lane is running the main lane gives up exactly the threads that lane holds'],
   ['Dropping / fast play', 'The main lane takes the whole budget', 'An exclusive event such as dropping first lets any searching auxiliary lane finish with its current best move, then the main lane takes the whole core group'],
   ['Screen recognition', 'Shares cores with the engine', 'Recognition is intermittent (inter-frame pixel diffing): it only computes when the picture changes, and only for a short while'],
   ['Screen capture', 'GPU when it pays off, CPU otherwise', 'Capture prefers the GPU desktop-duplication path (the picture already lives in video memory), and when the desktop has not changed the previous frame is simply reused at almost no cost. If that channel cannot be created (multi-monitor stitching, remote desktop, no graphics driver) or <font color="#0f3f7a">measures no faster than the CPU</font>, the app switches to full-CPU capture automatically, and repeated failures of the GPU channel degrade it permanently - it never uses the GPU just for the sake of it. Complex work such as border and line-family detection always runs on the CPU - each side plays to its strength'],
   ['While the opponent thinks', 'The engine keeps working (with a cap)', 'After your move the engine does not idle: it keeps searching the opponent\'s most likely replies, so the transposition table stays warm and your next move reaches a greater depth in the same time. This background thinking has a watchdog and packs up when no new position arrives, so it never spins all night'],
   ['Engine main lane', 'Exclusive hash', 'The working engine lane takes 100% of the transposition table for the selected step while the other lanes drop to a floor value, so the total always equals the chosen step'],
   ['Adaptive hash', 'Derived from available memory', 'Derived from real memory and clamped to a sane range, plus a long-run safety line of "no more than 1/3 of physical memory", so running for a whole day never pushes the system into paging'],
   ['Information flow', 'Reported on demand', 'Only the level of data the UI actually consumes is reported, so the channel is never flooded with redundant detail'],
   ['Congestion guard', 'Ring buffer for marks', 'Mark and curve data live in fixed-capacity ring buffers, so a very long continuous search still cannot grow without bound'],
   ['Long-run behaviour', 'Idle lanes are not kept resident', 'Only the lanes that are genuinely used keep an engine process; the remaining lanes start the first time something asks for them, saving one process worth of memory and transposition-table page-in']],
  'Scientific allocation of engine and recognition resources'),
 ('h2', '(i) The window stays on top'),
 ('body', 'The Link window itself is pinned to the top of the desktop: it is created as a topmost window, pushed back to the top whenever its position changes, and re-raised when it is shown or when the display state changes - so the app you are playing in cannot cover it. The app does not interfere if you minimise it yourself; it only re-raises when you bring it back.'),
 ('table', [30, 136],
  [['Finishing up', 'Notes'],
   ['Closing the Link window', 'The main window restores your own mode and settings, and play, analysis and everything else keep working as before'],
   ['Exiting the app', 'Every engine and related process is shut down at the same time, leaving nothing behind']],
  'Closing the Link window and exiting'),

 # ---------------------------------------------------------------- 12
 ('h1', '12. Frequently Asked Questions'),
 ('table', [42, 58, 66],
  [['Symptom', 'Cause', 'What to do'],
   ['Board not recognised, or recognition unstable', 'The frame does not fully enclose the four corners and the border',
    'Re-run Frame Board and leave a little more margin; on a crowded board the app combines the stones and the border to decide'],
   ['Stones on the board edge are missed', 'Not enough crop margin, so the outermost stone is clipped',
    'This release raises the outward margin to 0.8 cells, which targets exactly that outermost stone on a square board. If it still happens, include the board frame itself in your selection'],
   ['Auto Drop is on but no move is ever played', 'One failed three-stage click used to stop the cycle for good',
    'This release restarts a whole round: after stages 1 to 3 all fail it automatically starts a fresh round, up to 3 rounds, and only then stops and tells you. If it still does not move, press Frame Board to re-lock the board'],
   ['The other app never receives the move (self-drawn or anti-cheat windows such as QQ Gomoku)', 'It ignores window messages and filters even simulated input; it only accepts a real mouse',
    'Turn on the "<font color="#0f3f7a">Real Click</font>" switch in the Link window: from then on every move really moves the cursor and presses the left button through the system, exactly the human path. The cost is that it takes over your physical mouse while it is on, so switch it off when you no longer need it'],
   ['Strength varies, sometimes weak', 'The engine was not getting the cores and memory it should have, and was starved every so often',
    'This release gives the engine <font color="#0f3f7a">the same thread count as the standalone trainer</font> (no more self-imposed core cut); lanes borrow and return threads according to what is actually searching, so the total is never oversubscribed; the hash table is derived from real memory with a long-run safety line, and reporting is tightened. Raising the thinking time also helps immediately'],
   ['An occasional "engine response timeout"', 'Rare, only in the instant when the engine is pre-empted or switching gears',
    'The app re-evaluates automatically about 1.5 s later and retries silently; normal play is unaffected'],
   ['Stuck on "recognizing"', 'A hollow selection window, or the first-run warm-up',
    'Close the hollow window and re-frame the board; recognition warms up on first open, so wait a moment'],
   ['Nothing happens when Swap Balance is pressed', 'The current move count is not inside the swap window',
    'Swap Balance is available only on an <font color="#0f3f7a">empty board</font> (3 points, 2 Black 1 White) or with <font color="#0f3f7a">3 stones present</font> (2 points, 1 Black 1 White). Past five stones the app says plainly that it is outside the swap window'],
   ['Is the Internet required?', '-', 'No: the app and the engines run entirely on your machine and listen on no network port'],
   ['Leftover processes after closing?', '-', 'When the app exits it shuts down every engine and related process, leaving nothing behind']],
  'Frequently asked questions and answers'),

 # ---------------------------------------------------------------- 13
 ('h1', '13. Open-Source Components and Licences'),
 ('body', 'The software is built from several components, each distributed under its <font color="#0f3f7a">original licence</font>. The tables below list every third-party / open-source component shipped with the software, together with its licence and official link, so that everything can be verified and the source obtained.'),
 ('table', [34, 32, 36, 64],
  [['Component', 'Purpose', 'Licence', 'Official link'],
   ['Meter Gomoku interface and companion code', 'Interface, host program and companion scripts (author: Meter)', 'MIT',
    'Licence notice included with this manual'],
   ['Rapfi', 'Playing core (Gomoku / Renju engine); shipped in five instruction-set variants with weights',
    'GNU GPL-3.0', '<a href="https://github.com/dhbloo/rapfi" color="#1457a8"><u>github.com/dhbloo/rapfi</u></a>'],
   ['OpenCV', 'Board and stone recognition, statically linked into GomokuVision.exe with no extra DLL',
    'Apache-2.0', '<a href="https://opencv.org" color="#1457a8"><u>opencv.org</u></a>'],
   ['Microsoft Edge WebView2 Runtime', 'Desktop UI runtime, provided by Windows / Edge and not redistributed by this app',
    'Proprietary (Microsoft)',
    '<a href="https://developer.microsoft.com/microsoft-edge/webview2/" color="#1457a8"><u>microsoft-edge/webview2</u></a>'],
   ['Source Han Serif / Sans (Noto Serif SC / Noto Sans SC)', 'Typesetting fonts for this manual, embedded in the document',
    'SIL OFL 1.1',
    '<a href="https://github.com/adobe-fonts/source-han-serif" color="#1457a8"><u>adobe-fonts</u></a>'],
   ['Inno Setup', 'The tool that builds the Windows installer (used for packaging only, not distributed)',
    'Inno Setup License (free for commercial use)',
    '<a href="https://jrsoftware.org/isinfo.php" color="#1457a8"><u>jrsoftware.org/isinfo.php</u></a>']],
  'Third-party / open-source components shipped with the software'),
 ('table', [26, 140],
  [['Licence', 'Permitted / required / link'],
   ['MIT', 'Permits obtaining, using, copying, modifying, merging, publishing, distributing, sublicensing and selling copies free of charge. <font color="#0f3f7a">Requires</font> the original copyright and licence notices to be kept in the copies. The software is provided "as is", without warranty of any kind, express or implied'],
   ['GNU GPL-3.0',
    'Permits obtaining, using, modifying and redistributing free of charge. <font color="#0f3f7a">Requires</font> the licence and a way to obtain the source to be kept when redistributing (Rapfi source: ' +
    Lk('https://github.com/dhbloo/rapfi', 'github.com/dhbloo/rapfi') + '; full text: ' +
    Lk('https://www.gnu.org/licenses/gpl-3.0.html', 'gnu.org/licenses/gpl-3.0') + ')'],
   ['Apache-2.0',
    'Permits commercial use and redistribution. <font color="#0f3f7a">Requires</font> the copyright and licence notices to be kept and modifications to be stated. Full text: ' +
    Lk('https://www.apache.org/licenses/LICENSE-2.0', 'apache.org/licenses/LICENSE-2.0')],
   ['SIL OFL 1.1',
    'Permits free personal and commercial use, including embedding into redistributed documents. <font color="#0f3f7a">Requires</font> that the font files themselves are not sold on their own and that modified versions are not sold under the original font names. Full text: ' +
    Lk('https://openfontlicense.org', 'openfontlicense.org')],
   ['Proprietary (WebView2)', 'Used under Microsoft\'s own terms; this installer does not redistribute it and only offers the official download page when it is missing']],
  'What each licence permits, requires, and where to read it'),
 ('h3', 'Compliance notes'),
 ('body', '(1) Rapfi - this app calls Rapfi as a compiled separate process; the two communicate only through standard input/output and messages and are not merged into a single work. When Rapfi is distributed with this app, its GPL-3.0 licence text and a source notice are kept alongside it (in the rapfi-native/ folder).'),
 ('body', '(2) OpenCV - statically linked into GomokuVision.exe; no OpenCV dynamic library is distributed separately. Its Apache-2.0 licence requires the copyright and licence notices to be kept, and they are kept with the recognition component.'),
 ('body', '(3) Fonts - neither this manual nor the software uses any non-commercial font (such as Microsoft YaHei or SimHei, both Windows system fonts). Everything is typeset in the open-source, same-origin Source Han Serif / Source Han Sans.'),
 ('body', '(4) Development-only dependencies - the scripts used to build and package the app and their dependencies (NumPy, Pillow, PyMuPDF, reportlab, ...) run on the build machine only and are not distributed with the software, so they are not listed above.'),
 ('body', '(5) Disclaimer - the software is provided "as is"; the author accepts no liability for its fitness, its stability, or any direct or indirect loss. Please use the assistance features in a way that respects the rules of the platform you play on. All component names and trademarks belong to their respective owners.'),
 ('foot', 'Author: Meter. The interface and companion code are released under the MIT licence; the playing core Rapfi under GPL-3.0; the recognition component and OpenCV under Apache-2.0; the manuals are typeset in Source Han Serif / Source Han Sans (SIL OFL 1.1). '
          'Download: ' + DL_URL + '　Password: ' + DL_PWD),
]

main()
print('ALL DONE')
