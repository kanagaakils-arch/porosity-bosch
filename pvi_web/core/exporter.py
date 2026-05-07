"""PVI Web — Deep Upgraded Professional PDF Exporter (ReportLab)"""
import io
import math
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether
)
from reportlab.graphics.shapes import (
    Drawing, Rect, Circle, Line, String, PolyLine, Group
)
from reportlab.graphics import renderPDF
from .calculations import run_evaluation

# ── Colour palette ─────────────────────────────────────────────────────────
C_DARK    = colors.HexColor('#1a1a1a')
C_MID     = colors.HexColor('#555555')
C_DIM     = colors.HexColor('#888888')
C_BORDER  = colors.HexColor('#dddddd')
C_BG      = colors.HexColor('#f8f8f8')
C_PASS    = colors.HexColor('#00c278')
C_PASS_BG = colors.HexColor('#eafbf4')
C_FAIL    = colors.HexColor('#e03535')
C_FAIL_BG = colors.HexColor('#fff1f1')
C_HR      = colors.HexColor('#cc8800')
C_HR_BG   = colors.HexColor('#fff8e6')
C_HK      = colors.HexColor('#7740ee')
C_HK_BG   = colors.HexColor('#f4efff')
C_IGN     = colors.HexColor('#aaaaaa')
C_ACCENT  = colors.HexColor('#1a1a1a')

PAGE_W, PAGE_H = A4
MARGIN = 32 * mm
CONTENT_W = PAGE_W - 2 * MARGIN


def _styles():
    base = getSampleStyleSheet()
    return {
        'doc_title': ParagraphStyle(
            'dt', parent=base['Normal'],
            fontSize=20, fontName='Helvetica-Bold',
            textColor=C_DARK, spaceAfter=8, leading=24
        ),
        'doc_sub': ParagraphStyle(
            'ds', parent=base['Normal'],
            fontSize=9, textColor=C_DIM, spaceAfter=16
        ),
        'section': ParagraphStyle(
            'sec', parent=base['Normal'],
            fontSize=8, fontName='Helvetica-Bold',
            textColor=C_DIM, spaceBefore=14, spaceAfter=4,
            letterSpacing=1.2
        ),
        'normal': ParagraphStyle(
            'n', parent=base['Normal'],
            fontSize=9, textColor=C_DARK, leading=13
        ),
        'small': ParagraphStyle(
            'sm', parent=base['Normal'],
            fontSize=7.5, textColor=C_MID, leading=11
        ),
        'bold': ParagraphStyle(
            'b', parent=base['Normal'],
            fontSize=9, fontName='Helvetica-Bold', textColor=C_DARK
        ),
        'verdict_pass': ParagraphStyle(
            'vp', parent=base['Normal'],
            fontSize=28, fontName='Helvetica-Bold',
            textColor=C_PASS, alignment=TA_CENTER, leading=34
        ),
        'verdict_fail': ParagraphStyle(
            'vf', parent=base['Normal'],
            fontSize=28, fontName='Helvetica-Bold',
            textColor=C_FAIL, alignment=TA_CENTER, leading=34
        ),
        'label': ParagraphStyle(
            'lbl', parent=base['Normal'],
            fontSize=7.5, fontName='Helvetica-Bold',
            textColor=C_DIM, letterSpacing=0.5
        ),
        'value': ParagraphStyle(
            'val', parent=base['Normal'],
            fontSize=10, fontName='Helvetica-Bold',
            textColor=C_DARK
        ),
        'footer': ParagraphStyle(
            'ft', parent=base['Normal'],
            fontSize=7, textColor=C_DIM, alignment=TA_CENTER
        ),
    }


def _section_hr():
    return HRFlowable(width='100%', thickness=0.5,
                      color=C_BORDER, spaceAfter=6, spaceBefore=0)


def _verdict_banner(all_pass):
    """Coloured verdict banner as a Table."""
    bg   = C_PASS_BG if all_pass else C_FAIL_BG
    bord = C_PASS    if all_pass else C_FAIL
    txt  = "✔  ACCEPT" if all_pass else "✘  REJECT"
    col  = C_PASS    if all_pass else C_FAIL
    s = ParagraphStyle('vb', fontSize=22, fontName='Helvetica-Bold',
                       textColor=col, alignment=TA_CENTER, leading=28)
    t = Table([[Paragraph(txt, s)]], colWidths=[CONTENT_W], rowHeights=[44])
    t.setStyle(TableStyle([
        ('BACKGROUND',  (0,0), (-1,-1), bg),
        ('LINEABOVE',   (0,0), (-1, 0), 1.5, bord),
        ('LINEBELOW',   (0,-1), (-1,-1), 1.5, bord),
        ('LINEBEFORE',  (0,0), (0,-1),  1.5, bord),
        ('LINEAFTER',   (-1,0), (-1,-1), 1.5, bord),
        ('ALIGN',       (0,0), (-1,-1), 'CENTER'),
        ('VALIGN',      (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING',  (0,0), (-1,-1), 8),
        ('BOTTOMPADDING',(0,0),(-1,-1), 8),
    ]))
    return t


def _info_table(spec, res, st):
    """Two-column Part Info + Acceptance Limits table."""
    method_map = {
        'visual': 'Visual / Optical', 'section': 'Section Cut',
        'xray':   'X-Ray / DR',       'ct':      'CT Scan 3D'
    }
    left_rows = [
        [Paragraph("PART INFORMATION", st['label']), ''],
        [Paragraph("Part Number", st['small']),  Paragraph(spec.get('pno','—'), st['bold'])],
        [Paragraph("Zone / Feature", st['small']), Paragraph(spec.get('zone','—'), st['bold'])],
        [Paragraph("Drawing Rev.",  st['small']), Paragraph(spec.get('rev','—'), st['bold'])],
        [Paragraph("Inspector",     st['small']), Paragraph(spec.get('insp','—'), st['bold'])],
        [Paragraph("Method",        st['small']), Paragraph(method_map.get(spec.get('method','visual'),'—'), st['bold'])],
        [Paragraph("Date",          st['small']), Paragraph(datetime.now().strftime('%d %b %Y'), st['bold'])],
    ]
    right_rows = [
        [Paragraph("ACCEPTANCE LIMITS", st['label']), ''],
        [Paragraph("Max pore area (%)", st['small']),  Paragraph(f"{spec.get('pct',5)} %", st['bold'])],
        [Paragraph("Max pore Φ",        st['small']),  Paragraph(f"{spec.get('phi',1.5)} mm", st['bold'])],
        [Paragraph("Spacing coeff. A",  st['small']),  Paragraph(f"{spec.get('a',2)}", st['bold'])],
        [Paragraph("Ignore threshold U",st['small']),  Paragraph(f"{spec.get('u',0.2)} mm", st['bold'])],
        [Paragraph("Wall thickness t",  st['small']),  Paragraph(f"{spec.get('t',6)} mm", st['bold'])],
        [Paragraph("Datum area",        st['small']),  Paragraph(f"{spec.get('datum',100)} mm²", st['bold'])],
    ]
    tl = Table(left_rows,  colWidths=[70, 85])
    tr = Table(right_rows, colWidths=[80, 80])
    tl.setStyle(TableStyle([
        ('SPAN',   (0,0),(1,0)), ('BOTTOMPADDING',(0,0),(1,0),6),
        ('GRID',   (0,1),(1,-1), 0.3, C_BORDER),
        ('TOPPADDING',(0,1),(1,-1),4), ('BOTTOMPADDING',(0,1),(1,-1),4),
        ('LEFTPADDING',(0,0),(1,-1),4), ('RIGHTPADDING',(0,0),(1,-1),4),
        ('BACKGROUND',(0,1),(1,-1), colors.white),
    ]))
    tr.setStyle(TableStyle([
        ('SPAN',   (0,0),(1,0)), ('BOTTOMPADDING',(0,0),(1,0),6),
        ('GRID',   (0,1),(1,-1), 0.3, C_BORDER),
        ('TOPPADDING',(0,1),(1,-1),4), ('BOTTOMPADDING',(0,1),(1,-1),4),
        ('LEFTPADDING',(0,0),(1,-1),4), ('RIGHTPADDING',(0,0),(1,-1),4),
        ('BACKGROUND',(0,1),(1,-1), colors.white),
    ]))
    outer = Table([[tl, '', tr]], colWidths=[165, 14, 166])
    outer.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP')]))
    return outer


def _checks_table(checks, st):
    """Parameter Evaluation table with coloured result cells."""
    header = [
        Paragraph("PARAMETER", st['label']),
        Paragraph("MEASURED", st['label']),
        Paragraph("LIMIT", st['label']),
        Paragraph("DETAIL", st['label']),
        Paragraph("RESULT", st['label']),
    ]
    rows = [header]
    row_styles = []
    for i, c in enumerate(checks, start=1):
        ok = c['pass']
        res_txt = Paragraph(
            f"<b>{'PASS' if ok else 'FAIL'}</b>",
            ParagraphStyle('rc', fontSize=8, fontName='Helvetica-Bold',
                           textColor=C_PASS if ok else C_FAIL, alignment=TA_CENTER)
        )
        rows.append([
            Paragraph(c['n'], st['normal']),
            Paragraph(c['meas'], st['normal']),
            Paragraph(c['limit'], st['normal']),
            Paragraph(c['detail'], st['small']),
            res_txt,
        ])
        bg = C_PASS_BG if ok else C_FAIL_BG
        row_styles.append(('BACKGROUND', (4,i), (4,i), bg))

    col_w = [90, 70, 72, 170, 45]
    t = Table(rows, colWidths=col_w, repeatRows=1)
    style = [
        ('BACKGROUND',   (0,0), (-1,0), C_BG),
        ('FONTNAME',     (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE',     (0,0), (-1,0), 7.5),
        ('GRID',         (0,0), (-1,-1), 0.3, C_BORDER),
        ('TOPPADDING',   (0,0), (-1,-1), 5),
        ('BOTTOMPADDING',(0,0), (-1,-1), 5),
        ('LEFTPADDING',  (0,0), (-1,-1), 5),
        ('RIGHTPADDING', (0,0), (-1,-1), 5),
        ('VALIGN',       (0,0), (-1,-1), 'MIDDLE'),
        ('ALIGN',        (4,0), (4,-1), 'CENTER'),
    ] + row_styles
    t.setStyle(TableStyle(style))
    return t


def _zone_map_drawing(pores, spec, wall_h_mm):
    """Precision cross-section zone map as a ReportLab Drawing."""
    dw, dh = CONTENT_W, 200
    d = Drawing(dw, dh)

    # Wall extents
    wx, wy   = 55, 18
    ww, wh   = dw - 80, dh - 36
    t3       = wh / 3.0
    w_h_mm   = max(wall_h_mm or 6, 0.01)

    # Try to determine actual wall width from pores if available
    x_vals = [p['x'] for p in pores] if pores else []
    w_w_mm = max(max(x_vals) * 1.2 if x_vals else 1, 1)

    # -- Zone fills --
    d.add(Rect(wx, wy + t3*2, ww, t3, fillColor=C_HR_BG, strokeColor=None))
    d.add(Rect(wx, wy + t3,   ww, t3, fillColor=C_HK_BG, strokeColor=None))
    d.add(Rect(wx, wy,        ww, t3, fillColor=C_HR_BG, strokeColor=None))

    # -- Wall border --
    d.add(Rect(wx, wy, ww, wh, fillColor=None,
               strokeColor=colors.HexColor('#bbbbbb'), strokeWidth=1.2))

    # -- Zone dividers --
    for yi in [wy + t3, wy + t3*2]:
        d.add(Line(wx, yi, wx+ww, yi,
                   strokeColor=colors.HexColor('#cccccc'),
                   strokeDashArray=[4, 3], strokeWidth=0.8))

    # -- Zone labels (top-left of each zone, clear of pores) --
    d.add(String(wx+4, wy+wh-10, "HR  OUTER ⅓",
                 fontSize=7, fontName='Helvetica-Bold', fillColor=C_HR))
    d.add(String(wx+4, wy+t3*2-10, "HK  CENTRAL ⅓",
                 fontSize=7, fontName='Helvetica-Bold', fillColor=C_HK))
    d.add(String(wx+4, wy+t3-10, "HR  OUTER ⅓",
                 fontSize=7, fontName='Helvetica-Bold', fillColor=C_HR))

    # -- Surface labels --
    d.add(String(wx+2, wy+wh+5, "SURFACE A",
                 fontSize=7, fontName='Helvetica-Bold', fillColor=C_DIM))
    d.add(String(wx+2, wy-12,   "SURFACE B",
                 fontSize=7, fontName='Helvetica-Bold', fillColor=C_DIM))

    # -- Dimension brackets --
    bx = wx + ww + 8
    for i in range(3):
        y1 = wy + i*t3
        y2 = wy + (i+1)*t3
        mid = (y1+y2)/2
        d.add(Line(bx, y1, bx, y2,
                   strokeColor=colors.HexColor('#bbbbbb'), strokeWidth=0.8))
        d.add(Line(bx-3, y1, bx+3, y1,
                   strokeColor=colors.HexColor('#bbbbbb'), strokeWidth=0.8))
        d.add(Line(bx-3, y2, bx+3, y2,
                   strokeColor=colors.HexColor('#bbbbbb'), strokeWidth=0.8))
        d.add(String(bx+5, mid-3, "t/3",
                     fontSize=7, fillColor=C_DIM))

    # -- Depth ruler on left --
    rx = wx - 12
    d.add(Line(rx, wy, rx, wy+wh,
               strokeColor=colors.HexColor('#cccccc'), strokeWidth=0.6))
    d.add(String(rx-18, wy+wh/2-4, "DEPTH",
                 fontSize=6, fillColor=C_DIM))

    # -- Pores --
    u_thresh = spec.get('u', 0.2)
    phi_lim  = spec.get('phi', 1.5)

    for p in pores:
        raw_x = p.get('x', 0)
        raw_y = p.get('y', 0)
        dia   = p.get('dia', 0.5)
        zone  = p.get('zone', 'hr')

        # Map mm → SVG units (ReportLab Y=0 at bottom)
        svg_x = wx + (raw_x / w_w_mm) * ww
        svg_y = wy + wh - (raw_y / w_h_mm) * wh  # flip Y
        r     = max(3, min(16, (dia / w_h_mm) * wh * 0.5))

        ign  = u_thresh > 0 and dia < u_thresh
        fail = not ign and dia > phi_lim

        if ign:
            stroke, fill = C_IGN, colors.HexColor('#f0f0f0')
        elif fail:
            stroke, fill = C_FAIL, colors.HexColor('#fff0f0')
        elif zone == 'hk':
            stroke, fill = C_HK,   C_HK_BG
        else:
            stroke, fill = C_HR,   C_HR_BG

        # Fail ring
        if fail:
            d.add(Circle(svg_x, svg_y, r+4,
                         fillColor=None, strokeColor=colors.HexColor('#ffbbbb'),
                         strokeWidth=1, strokeDashArray=[3,2]))

        d.add(Circle(svg_x, svg_y, r,
                     fillColor=fill, strokeColor=stroke, strokeWidth=1.2))

        # Diameter label inside pore (no overlap with zone labels)
        if r >= 7:
            d.add(String(svg_x, svg_y-3, f"{dia:.1f}",
                         fontSize=6, fontName='Helvetica-Bold',
                         fillColor=stroke, textAnchor='middle'))

    # -- Legend --
    lx = wx
    ly = wy - 28
    legend = [
        (C_HR,   C_HR_BG, "HR zone pore"),
        (C_HK,   C_HK_BG, "HK zone pore"),
        (C_FAIL, colors.HexColor('#fff0f0'), "Exceeds Φ limit"),
        (C_IGN,  colors.HexColor('#f0f0f0'), "Below threshold U"),
    ]
    for j, (sc, fc, lbl) in enumerate(legend):
        ox = lx + j*100
        d.add(Circle(ox+5, ly+4, 5, fillColor=fc, strokeColor=sc, strokeWidth=1))
        d.add(String(ox+14, ly, lbl, fontSize=7, fillColor=C_DIM))

    return d


def generate_pdf(pores: list, spec: dict, wall_h_mm: float) -> bytes:
    """Generate a professional A4 PDF report and return bytes."""
    # Pydantic models → plain dicts for exporter (calculations handles models)
    from .models import PoreModel, SpecModel
    pore_models = [PoreModel(**p) if not isinstance(p, PoreModel) else p for p in pores]
    spec_model  = SpecModel(**spec) if isinstance(spec, dict) else spec
    spec_dict   = spec if isinstance(spec, dict) else spec.model_dump()

    res = run_evaluation(pore_models, spec_model, wall_h_mm)
    all_pass = res['all_pass']

    # Update pores with computed zones
    pore_dicts = res['updated_pores']

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=MARGIN, leftMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=MARGIN
    )
    st = _styles()
    elems = []

    # ── Header ──────────────────────────────────────────────────────────────
    elems.append(Paragraph("Porosity Validation Inspection", st['doc_title']))
    elems.append(Paragraph(
        f"VW 50093 Compliance Report  ·  "
        f"Generated {datetime.now().strftime('%d %b %Y, %H:%M')}",
        st['doc_sub']
    ))
    elems.append(_section_hr())

    # ── Verdict Banner ───────────────────────────────────────────────────────
    elems.append(_verdict_banner(all_pass))
    n_fail = len([c for c in res['checks'] if not c['pass']])
    elems.append(Spacer(1, 4))
    sub_txt = (
        "Part meets all VW50093 porosity requirements." if all_pass
        else f"{n_fail} parameter(s) outside specification — part does not conform."
    )
    sub_s = ParagraphStyle('vs', fontSize=9, textColor=C_MID, alignment=TA_CENTER, spaceAfter=14)
    elems.append(Paragraph(sub_txt, sub_s))

    # ── Part Information & Limits ────────────────────────────────────────────
    elems.append(Paragraph("IDENTIFICATION & LIMITS", st['section']))
    elems.append(_section_hr())
    elems.append(_info_table(spec_dict, res, st))
    elems.append(Spacer(1, 18))

    # ── Evaluation Summary Statistics ───────────────────────────────────────
    elems.append(Paragraph("MEASUREMENT SUMMARY", st['section']))
    elems.append(_section_hr())
    n_pass = len([c for c in res['checks'] if c['pass']])
    stats = [
        [Paragraph("Total Pores", st['label']),   Paragraph("Effective Pores", st['label']),
         Paragraph("Porosity %", st['label']),     Paragraph("Largest Φ", st['label']),
         Paragraph("Parameters", st['label'])],
        [Paragraph(str(len(pores)),                st['value']),
         Paragraph(str(res['eff_pores']),          st['value']),
         Paragraph(f"{res['pct']:.2f}%",           st['value']),
         Paragraph(f"{res['max_phi']:.2f} mm",     st['value']),
         Paragraph(f"{n_pass}/{len(res['checks'])} PASS", 
                   ParagraphStyle('sp', fontSize=10, fontName='Helvetica-Bold',
                                  textColor=C_PASS if n_pass==len(res['checks']) else C_FAIL))],
    ]
    stat_w = [CONTENT_W/5]*5
    ts = Table(stats, colWidths=stat_w)
    ts.setStyle(TableStyle([
        ('BACKGROUND',   (0,0),(-1,0), C_BG),
        ('GRID',         (0,0),(-1,-1), 0.3, C_BORDER),
        ('TOPPADDING',   (0,0),(-1,-1), 8),
        ('BOTTOMPADDING',(0,0),(-1,-1), 8),
        ('ALIGN',        (0,0),(-1,-1), 'CENTER'),
        ('VALIGN',       (0,0),(-1,-1), 'MIDDLE'),
    ]))
    elems.append(ts)
    elems.append(Spacer(1, 18))

    # ── Parameter Evaluation ────────────────────────────────────────────────
    elems.append(Paragraph("PARAMETER EVALUATION", st['section']))
    elems.append(_section_hr())
    elems.append(_checks_table(res['checks'], st))
    elems.append(Spacer(1, 18))

    # ── Cross-Section Zone Map ───────────────────────────────────────────────
    elems.append(Paragraph("CROSS-SECTION — ZONE MAP", st['section']))
    elems.append(_section_hr())
    elems.append(_zone_map_drawing(pore_dicts, spec_dict, wall_h_mm))
    elems.append(Spacer(1, 18))

    # ── Method Capability ────────────────────────────────────────────────────
    elems.append(Paragraph("INSPECTION METHOD CAPABILITY", st['section']))
    elems.append(_section_hr())
    method_notes = {
        'visual':  'Visual/Optical (ISO 10049): Polished section at Rz=0. HR/HK zone boundaries require precise sectioning. Destructive.',
        'section': 'Section Cut (VW50093 primary): CNC-controlled plane. Full zone accuracy. Destructive.',
        'xray':    'X-Ray / DR (ASTM E505): 2D projection; HR/HK zone depth NOT determinable. Supplement with CT or section cut.',
        'ct':      'CT Scan 3D (VDI 2630): All parameters fully determinable including 3D zone assignment. Non-destructive.',
    }
    elems.append(Paragraph(method_notes.get(spec_dict.get('method','visual'),'—'), st['normal']))
    elems.append(Spacer(1, 30))

    # ── Footer ───────────────────────────────────────────────────────────────
    elems.append(_section_hr())
    elems.append(Paragraph(
        "Porosity Validation Inspector (PVI) Web Engine  ·  "
        "VW 50093 / ISO 10049 / ASTM E505 / VDI 2630  ·  "
        f"Report generated {datetime.now().strftime('%d %b %Y %H:%M:%S')}",
        st['footer']
    ))

    doc.build(elems)
    buffer.seek(0)
    return buffer.getvalue()
