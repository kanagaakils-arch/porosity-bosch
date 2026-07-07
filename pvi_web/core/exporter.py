"""PVI Web — Professional PDF Exporter (ReportLab) — Multi-image workspace support"""
import io
import math
from datetime import datetime
from typing import List, Optional
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether, PageBreak
)
from reportlab.graphics.shapes import (
    Drawing, Rect, Circle, Line, String, PolyLine, Group, Polygon
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
C_AMBER   = colors.HexColor('#b45309')
C_AMBER_BG= colors.HexColor('#fffbf0')
C_AMBER_BD= colors.HexColor('#f59f00')
C_RED_BG  = colors.HexColor('#fff5f5')
C_RED_BD  = colors.HexColor('#fa5252')

PAGE_W, PAGE_H = A4
MARGIN = 32 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

METHOD_MAP = {
    'visual':          'Visual / Optical',
    'visual_machined': 'Visual (Machined Section)',
    'visual_cast':     'Visual (As-Cast Surface)',
    'section':         'Section Cut',
    'xray':            'X-Ray / DR',
    'ct':              'CT Scan 3D',
}

METHOD_NOTES = {
    'visual':          'Visual/Optical (ISO 10049): Polished section at Rz=0. HR/HK zone boundaries require precise sectioning. Destructive.',
    'visual_machined': 'Visual / Machined section (VW50093 primary): Polished metallographic section cut at Rz=0. Direct measurement of %, Φ, U, A, H, N. HR/HK zone assignment requires precise sectioning at exact zone boundaries. Destructive.',
    'visual_cast':     'Visual / As-Cast surface: Direct visual inspection of the as-cast surface without machining. No Rz requirement. Best for general surface evaluation. HR/HK depth zones cannot be determined. Non-destructive.',
    'section':         'Section Cut (VW50093 primary): CNC-controlled plane. Full zone accuracy. Destructive.',
    'xray':            'X-Ray / DR (ASTM E505): 2D projection; HR/HK zone depth NOT determinable. Supplement with CT or section cut.',
    'ct':              'CT Scan 3D (VDI 2630): All parameters fully determinable including 3D zone assignment. Non-destructive.',
}


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
        'section2': ParagraphStyle(
            'sec2', parent=base['Normal'],
            fontSize=9, fontName='Helvetica-Bold',
            textColor=C_AMBER, spaceBefore=10, spaceAfter=4,
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
        'img_title': ParagraphStyle(
            'it', parent=base['Normal'],
            fontSize=11, fontName='Helvetica-Bold',
            textColor=C_DARK, spaceBefore=16, spaceAfter=4
        ),
        'spec_title': ParagraphStyle(
            'st', parent=base['Normal'],
            fontSize=14, fontName='Helvetica-Bold',
            textColor=C_DARK, spaceBefore=0, spaceAfter=6
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


def _info_table(spec, res, st, actual_datum_area=None):
    """Two-column Part Info + Acceptance Limits table.
    actual_datum_area: the REAL datum used in the evaluation (calibrated image area or drawn datum).
    Falls back to spec['datum'] when None.
    """
    if actual_datum_area is None:
        actual_datum_area = spec.get('datum', 100)
    left_rows = [
        [Paragraph("PART INFORMATION", st['label']), ''],
        [Paragraph("Part Number", st['small']),  Paragraph(spec.get('pno','—'), st['bold'])],
        [Paragraph("Zone / Feature", st['small']), Paragraph(spec.get('zone','—'), st['bold'])],
        [Paragraph("Drawing Rev.",  st['small']), Paragraph(spec.get('rev','—'), st['bold'])],
        [Paragraph("Inspector",     st['small']), Paragraph(spec.get('insp','—'), st['bold'])],
        [Paragraph("Method",        st['small']), Paragraph(METHOD_MAP.get(spec.get('method','visual_machined'), spec.get('method','—')), st['bold'])],
        [Paragraph("Date",          st['small']), Paragraph(datetime.now().strftime('%d %b %Y'), st['bold'])],
    ]
    right_rows = [
        [Paragraph("ACCEPTANCE LIMITS", st['label']), ''],
        [Paragraph("Max pore area (%)", st['small']),  Paragraph(f"{spec.get('pct',5)} %", st['bold'])],
        [Paragraph("Max pore Φ",        st['small']),  Paragraph(f"{spec.get('phi',1.5)} mm", st['bold'])],
        [Paragraph("Spacing coeff. A",  st['small']),  Paragraph(f"{spec.get('a',2)}", st['bold'])],
        [Paragraph("Ignore threshold U",st['small']),  Paragraph(f"{spec.get('u',0.2)} mm", st['bold'])],
        [Paragraph("Wall thickness t",  st['small']),  Paragraph(f"{spec.get('t',6)} mm", st['bold'])],
        [Paragraph("Datum area",        st['small']),  Paragraph(f"{actual_datum_area:.2f} mm²", st['bold'])],
    ]
    # Add gas/shrink limits if present
    if spec.get('phi_gas') is not None:
        right_rows.append([Paragraph("Gas Φ limit", st['small']), Paragraph(f"{spec['phi_gas']} mm", st['bold'])])
    if spec.get('pct_gas') is not None:
        right_rows.append([Paragraph("Gas % limit", st['small']), Paragraph(f"{spec['pct_gas']} %", st['bold'])])
    if spec.get('phi_shrink') is not None:
        right_rows.append([Paragraph("Shrink Φ limit", st['small']), Paragraph(f"{spec['phi_shrink']} mm", st['bold'])])
    if spec.get('pct_shrink') is not None:
        right_rows.append([Paragraph("Shrink % limit", st['small']), Paragraph(f"{spec['pct_shrink']} %", st['bold'])])

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


def _datum_excl_table(res, spec_dict, datum_rect, excl_zones, st):
    """Dedicated □ Datum & 🚫 Exclusion Analysis two-column table."""
    has_datum = res.get('has_datum', False)
    excl_count = res.get('excl_zone_count', 0)
    datum_type_val = res.get('datum_type', 'spec')
    # Show the datum panel when: user drew a datum, image is calibrated, or exclusion zones exist
    if datum_type_val == 'spec' and excl_count == 0:
        return None

    datum_area = res.get('datum_area', spec_dict.get('datum', 100))
    datum_type = ('Drawn □ (measured)' if res.get('datum_type') == 'drawn' else
                  'Full image (calibrated scale)' if res.get('datum_type') == 'calibrated_image' else
                  'Spec default (no calibration)')
    lim_pct    = spec_dict.get('pct', 5)
    net_pct    = res.get('net_pct', res.get('pct', 0))
    raw_pct    = res.get('raw_pct', res.get('pct', 0))
    net_n      = res.get('net_pore_count', 0)
    raw_n      = res.get('raw_pore_count', 0)
    excl_masked= res.get('excl_masked_pores', 0)

    # Datum panel rows
    net_ok = net_pct <= lim_pct
    net_col = C_PASS if net_ok else C_FAIL
    net_bg  = C_PASS_BG if net_ok else C_FAIL_BG

    datum_rows = [
        [Paragraph("□  DATUM ZONE", ParagraphStyle('dh', fontSize=8, fontName='Helvetica-Bold', textColor=C_AMBER)), ''],
        [Paragraph("Type", st['small']),    Paragraph(datum_type, st['bold'])],
        [Paragraph("Area", st['small']),    Paragraph(f"{datum_area:.2f} mm²", st['bold'])],
        [Paragraph("Pores", st['small']),   Paragraph(str(net_n), st['bold'])],
        [Paragraph("Porosity %", st['small']),
         Paragraph(f"{net_pct:.2f}%  {'PASS' if net_ok else 'FAIL'} ≤{lim_pct}%",
                   ParagraphStyle('dp', fontSize=9, fontName='Helvetica-Bold', textColor=net_col))],
    ]
    if has_datum and res.get('raw_pct') is not None:
        full_ok = raw_pct <= lim_pct
        datum_rows.append([Paragraph("Full image %", st['small']),
                           Paragraph(f"{raw_pct:.2f}%  {'PASS' if full_ok else 'FAIL'}",
                                     ParagraphStyle('fp', fontSize=9, fontName='Helvetica-Bold',
                                                    textColor=C_PASS if full_ok else C_FAIL))])

    dt = Table(datum_rows, colWidths=[70, 100])
    dt.setStyle(TableStyle([
        ('SPAN',        (0,0),(1,0)), ('BOTTOMPADDING',(0,0),(1,0),6),
        ('BACKGROUND',  (0,0),(1,0), C_AMBER_BG),
        ('GRID',        (0,1),(1,-1), 0.3, C_AMBER_BD),
        ('TOPPADDING',  (0,0),(1,-1), 4), ('BOTTOMPADDING',(0,0),(1,-1), 4),
        ('LEFTPADDING', (0,0),(1,-1), 5), ('RIGHTPADDING', (0,0),(1,-1), 5),
        ('BACKGROUND',  (0,1),(1,-1), colors.white),
        ('LINEABOVE',   (0,0),(1,0), 1.2, C_AMBER_BD),
        ('LINEBEFORE',  (0,0),(0,-1), 1.2, C_AMBER_BD),
        ('LINEAFTER',   (1,0),(1,-1), 1.2, C_AMBER_BD),
        ('LINEBELOW',   (0,-1),(1,-1), 1.2, C_AMBER_BD),
    ]))

    # Exclusion panel rows
    if excl_count > 0:
        raw_ok2 = raw_pct <= lim_pct
        delta   = raw_pct - net_pct
        excl_rows = [
            [Paragraph("🚫  EXCLUSION ZONES", ParagraphStyle('eh', fontSize=8, fontName='Helvetica-Bold', textColor=C_FAIL)), ''],
            [Paragraph("Zones defined", st['small']),  Paragraph(str(excl_count), st['bold'])],
            [Paragraph("Pores masked", st['small']),   Paragraph(f"{excl_masked} of {raw_n}", st['bold'])],
            [Paragraph("Before (Raw %)", st['small']),
             Paragraph(f"{raw_pct:.2f}%  {'PASS' if raw_ok2 else 'FAIL'}",
                       ParagraphStyle('rp', fontSize=9, fontName='Helvetica-Bold',
                                      textColor=C_PASS if raw_ok2 else C_FAIL))],
            [Paragraph("After (Net %)", st['small']),
             Paragraph(f"{net_pct:.2f}%  {'PASS' if net_ok else 'FAIL'}",
                       ParagraphStyle('np', fontSize=9, fontName='Helvetica-Bold', textColor=net_col))],
            [Paragraph("Δ Impact", st['small']),
             Paragraph(f"{'▼' if delta > 0 else '▲' if delta < 0 else '≈'} {abs(delta):.2f}% {'reduction' if delta >= 0 else 'increase'}",
                       ParagraphStyle('di', fontSize=9, fontName='Helvetica-Bold',
                                      textColor=C_PASS if delta >= 0 else C_FAIL))],
        ]
    else:
        excl_rows = [
            [Paragraph("🚫  EXCLUSION ZONES", ParagraphStyle('eh2', fontSize=8, fontName='Helvetica-Bold', textColor=C_DIM)), ''],
            [Paragraph("No exclusion zones defined for this image", st['small']), ''],
        ]

    et = Table(excl_rows, colWidths=[70, 100])
    et.setStyle(TableStyle([
        ('SPAN',        (0,0),(1,0)), ('BOTTOMPADDING',(0,0),(1,0),6),
        ('BACKGROUND',  (0,0),(1,0), C_RED_BG if excl_count > 0 else C_BG),
        ('GRID',        (0,1),(1,-1), 0.3, C_RED_BD if excl_count > 0 else C_BORDER),
        ('TOPPADDING',  (0,0),(1,-1), 4), ('BOTTOMPADDING',(0,0),(1,-1), 4),
        ('LEFTPADDING', (0,0),(1,-1), 5), ('RIGHTPADDING', (0,0),(1,-1), 5),
        ('BACKGROUND',  (0,1),(1,-1), colors.white),
        ('LINEABOVE',   (0,0),(1,0), 1.2, C_RED_BD if excl_count > 0 else C_BORDER),
        ('LINEBEFORE',  (0,0),(0,-1), 1.2, C_RED_BD if excl_count > 0 else C_BORDER),
        ('LINEAFTER',   (1,0),(1,-1), 1.2, C_RED_BD if excl_count > 0 else C_BORDER),
        ('LINEBELOW',   (0,-1),(1,-1), 1.2, C_RED_BD if excl_count > 0 else C_BORDER),
        ('SPAN',        (0,1),(1,1)) if excl_count == 0 else ('NOOP', (0,0),(0,0)),
    ]))

    outer = Table([[dt, '', et]], colWidths=[180, 10, 180])
    outer.setStyle(TableStyle([('VALIGN',(0,0),(-1,-1),'TOP')]))
    return outer


def _zone_map_drawing(pores, spec, wall_h_mm, exclusion_zones=None, datum_rect=None):
    """Precision cross-section zone map as a ReportLab Drawing."""
    dw, dh = CONTENT_W, 200
    d = Drawing(dw, dh)

    # Wall extents
    wx, wy   = 55, 18
    ww, wh   = dw - 80, dh - 36
    t3       = wh / 3.0
    w_h_mm   = max(wall_h_mm or 6, 0.01)

    x_vals = [p['x'] for p in pores] if pores else []
    w_w_mm = max(max(x_vals) * 1.2 if x_vals else 1, 1)

    # -- Zone fills --
    if spec.get('zone_disabled'):
        d.add(Rect(wx, wy, ww, wh, fillColor=C_HR_BG, strokeColor=None))
    else:
        d.add(Rect(wx, wy + t3*2, ww, t3, fillColor=C_HR_BG, strokeColor=None))
        d.add(Rect(wx, wy + t3,   ww, t3, fillColor=C_HK_BG, strokeColor=None))
        d.add(Rect(wx, wy,        ww, t3, fillColor=C_HR_BG, strokeColor=None))

    # -- Datum rectangle overlay --
    dr_dict = datum_rect if isinstance(datum_rect, dict) else (datum_rect.model_dump() if datum_rect else None)
    if dr_dict and dr_dict.get('w', 0) > 0:
        dx = wx + (dr_dict.get('x', 0) / w_w_mm) * ww
        dy = wy + wh - ((dr_dict.get('y', 0) + dr_dict.get('h', 0)) / w_h_mm) * wh
        dw2 = (dr_dict.get('w', 0) / w_w_mm) * ww
        dh2 = (dr_dict.get('h', 0) / w_h_mm) * wh
        d.add(Rect(dx, dy, dw2, dh2,
                   fillColor=colors.HexColor('#fffbf0'),
                   strokeColor=C_AMBER_BD, strokeWidth=1.2,
                   strokeDashArray=[4, 2]))
        d.add(String(dx + 3, dy + dh2 + 3, "DATUM □",
                     fontSize=6, fontName='Helvetica-Bold', fillColor=C_AMBER))

    # -- Exclusion zone overlays --
    if exclusion_zones:
        for z in exclusion_zones:
            z_dict = z if isinstance(z, dict) else z.model_dump()
            if z_dict.get('type') == 'rect':
                zx = wx + (z_dict.get('x', 0) / w_w_mm) * ww
                zy = wy + wh - ((z_dict.get('y', 0) + z_dict.get('h', 0)) / w_h_mm) * wh
                zw2 = (z_dict.get('w', 0) / w_w_mm) * ww
                zh2 = (z_dict.get('h', 0) / w_h_mm) * wh
                d.add(Rect(zx, zy, zw2, zh2,
                           fillColor=colors.HexColor('#fff5f5'),
                           strokeColor=C_RED_BD, strokeWidth=1.0,
                           strokeDashArray=[3, 2]))
            elif z_dict.get('type') == 'circle':
                cx = wx + (z_dict.get('cx', 0) / w_w_mm) * ww
                cy = wy + wh - (z_dict.get('cy', 0) / w_h_mm) * wh
                r  = (z_dict.get('r', 0) / w_h_mm) * wh
                d.add(Circle(cx, cy, r, fillColor=colors.HexColor('#fff5f5'),
                             strokeColor=C_RED_BD, strokeWidth=1.0,
                             strokeDashArray=[3, 2]))
            elif z_dict.get('type') == 'polygon':
                pts = z_dict.get('points', [])
                if pts and len(pts) >= 3:
                    coords = []
                    for p in pts:
                        px = wx + (p.get('x', 0.0) / w_w_mm) * ww
                        py = wy + wh - (p.get('y', 0.0) / w_h_mm) * wh
                        coords.extend([px, py])
                    d.add(Polygon(coords, fillColor=colors.HexColor('#fff5f5'),
                                  strokeColor=C_RED_BD, strokeWidth=1.0,
                                  strokeDashArray=[3, 2]))

    # -- Wall border --
    d.add(Rect(wx, wy, ww, wh, fillColor=None,
               strokeColor=colors.HexColor('#bbbbbb'), strokeWidth=1.2))

    # -- Zone dividers --
    if not spec.get('zone_disabled'):
        for yi in [wy + t3, wy + t3*2]:
            d.add(Line(wx, yi, wx+ww, yi,
                       strokeColor=colors.HexColor('#cccccc'),
                       strokeDashArray=[4, 3], strokeWidth=0.8))

    # -- Zone labels --
    if spec.get('zone_disabled'):
        d.add(String(wx+4, wy+wh-10, "■ FLAT AREA MODE — No HR/HK zones",
                     fontSize=7, fontName='Helvetica-Bold', fillColor=C_HR))
    else:
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
        ptype = p.get('type', 'gas')
        is_excl = p.get('is_excluded', False)
        is_cropped = p.get('is_cropped', False)
        eff_dia = p.get('effective_dia', dia)

        # Check outside datum
        is_out_datum = False
        if dr_dict and dr_dict.get('w', 0) > 0:
            is_out_datum = not (dr_dict.get('x', 0) <= raw_x <= (dr_dict.get('x', 0) + dr_dict.get('w', 0))
                                and dr_dict.get('y', 0) <= raw_y <= (dr_dict.get('y', 0) + dr_dict.get('h', 0)))

        svg_x = wx + (raw_x / w_w_mm) * ww
        svg_y = wy + wh - (raw_y / w_h_mm) * wh
        r_orig = max(3, min(16, (dia / w_h_mm) * wh * 0.5))
        r_eff  = max(2, min(16, (eff_dia / w_h_mm) * wh * 0.5)) if is_cropped else r_orig

        if is_excl or is_out_datum:
            d.add(Circle(svg_x, svg_y, r_orig,
                         fillColor=colors.HexColor('#f9f9f9'),
                         strokeColor=C_IGN, strokeWidth=0.8,
                         strokeDashArray=[2,2], opacity=0.5))
            d.add(String(svg_x, svg_y-2.5, "✕",
                         fontSize=max(6, min(10, r_orig*1.2)), fontName='Helvetica',
                         fillColor=C_DIM, textAnchor='middle', opacity=0.6))
            continue

        ign  = u_thresh > 0 and (eff_dia if is_cropped else dia) < u_thresh
        fail = not ign and (eff_dia if is_cropped else dia) > phi_lim

        if ign:
            stroke, fill = C_IGN, colors.HexColor('#f0f0f0')
        elif fail:
            stroke, fill = C_FAIL, colors.HexColor('#fff0f0')
        elif zone == 'hk':
            stroke, fill = C_HK, C_HK_BG
        else:
            stroke, fill = C_HR, C_HR_BG

        # Shrink pore — dotted border override
        if ptype == 'shrink':
            stroke = colors.HexColor('#7c3aed')

        if is_cropped:
            # Draw ghost circle first
            d.add(Circle(svg_x, svg_y, r_orig,
                         fillColor=None, strokeColor=colors.HexColor('#ffa8a8'),
                         strokeWidth=0.8, strokeDashArray=[2, 2], opacity=0.6))
            # Draw actual active portion
            d.add(Circle(svg_x, svg_y, r_eff,
                         fillColor=fill, strokeColor=stroke, strokeWidth=1.2))
            # Draw scissor badge next to the pore
            d.add(String(svg_x + r_eff + 1, svg_y - 2, "✂",
                         fontSize=6, fontName='Helvetica',
                         fillColor=colors.HexColor('#e03131'), textAnchor='start'))
            # Draw text label inside effective circle if large enough
            if r_eff >= 7:
                d.add(String(svg_x, svg_y-3, f"{eff_dia:.1f}",
                             fontSize=5.5, fontName='Helvetica-Bold',
                             fillColor=stroke, textAnchor='middle'))
        else:
            if fail:
                d.add(Circle(svg_x, svg_y, r_orig+4,
                             fillColor=None, strokeColor=colors.HexColor('#ffbbbb'),
                             strokeWidth=1, strokeDashArray=[3,2]))

            d.add(Circle(svg_x, svg_y, r_orig,
                         fillColor=fill, strokeColor=stroke, strokeWidth=1.2))

            if r_orig >= 7:
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


def _build_image_elements(img_data: dict, spec_dict: dict, image_label: str, st: dict) -> list:
    """Build ReportLab flowable elements for one image page."""
    pores       = img_data.get('pores', [])
    wall_h_mm   = img_data.get('wall_h_mm', 6.0)
    excl_zones  = img_data.get('exclusion_zones') or []
    datum_rect  = img_data.get('datum_rect')
    pore_offset = img_data.get('pore_offset_mm', 0.0)

    from .models import PoreModel, SpecModel
    pore_models = [PoreModel(**p) if isinstance(p, dict) else p for p in pores]
    spec_model  = SpecModel(**spec_dict) if isinstance(spec_dict, dict) else spec_dict

    dr_dict = datum_rect if isinstance(datum_rect, dict) else (datum_rect.model_dump() if datum_rect else None)
    excl_list = [z if isinstance(z, dict) else z.model_dump() for z in excl_zones]

    res = run_evaluation(pore_models, spec_model, wall_h_mm, excl_zones or [], datum_rect, pore_offset)
    all_pass = res['all_pass']
    pore_dicts = res['updated_pores']

    elems = []

    # Image title
    elems.append(Spacer(1, 6))
    elems.append(Paragraph(image_label, st['img_title']))
    elems.append(_verdict_banner(all_pass))
    elems.append(Spacer(1, 6))

    # Mini summary row
    n_pass = len([c for c in res['checks'] if c['pass']])
    stats = [
        [Paragraph("Total Pores", st['label']),   Paragraph("Eff. Pores", st['label']),
         Paragraph("Porosity %", st['label']),     Paragraph("Largest Φ", st['label']),
         Paragraph("Parameters", st['label'])],
        [Paragraph(str(len(pore_models)),          st['value']),
         Paragraph(str(res['eff_pores']),           st['value']),
         Paragraph(f"{res['pct']:.2f}%",            st['value']),
         Paragraph(f"{res['max_phi']:.2f} mm",      st['value']),
         Paragraph(f"{n_pass}/{len(res['checks'])} PASS",
                   ParagraphStyle('sp', fontSize=10, fontName='Helvetica-Bold',
                                  textColor=C_PASS if n_pass == len(res['checks']) else C_FAIL))],
    ]
    ts = Table(stats, colWidths=[CONTENT_W/5]*5)
    ts.setStyle(TableStyle([
        ('BACKGROUND', (0,0),(-1,0), C_BG),
        ('GRID', (0,0),(-1,-1), 0.3, C_BORDER),
        ('TOPPADDING', (0,0),(-1,-1), 7), ('BOTTOMPADDING', (0,0),(-1,-1), 7),
        ('ALIGN', (0,0),(-1,-1), 'CENTER'), ('VALIGN', (0,0),(-1,-1), 'MIDDLE'),
    ]))
    elems.append(ts)
    elems.append(Spacer(1, 10))

    # Parameter checks
    elems.append(Paragraph("PARAMETER EVALUATION", st['section']))
    elems.append(_section_hr())
    elems.append(_checks_table(res['checks'], st))
    elems.append(Spacer(1, 10))

    # Datum & Exclusion Analysis
    de_table = _datum_excl_table(res, spec_dict, dr_dict, excl_list, st)
    if de_table:
        elems.append(Paragraph("□ DATUM & EXCLUSION ANALYSIS", st['section']))
        elems.append(_section_hr())
        elems.append(de_table)
        elems.append(Spacer(1, 10))

    # Zone map
    elems.append(Paragraph("CROSS-SECTION — ZONE MAP", st['section']))
    elems.append(_section_hr())
    elems.append(_zone_map_drawing(pore_dicts, spec_dict, wall_h_mm, excl_zones, datum_rect))
    elems.append(Spacer(1, 15))

    # Top Pores List
    elems.append(Paragraph("TOP PORES LIST (BY EFFECTIVE DIAMETER)", st['section']))
    elems.append(_section_hr())
    elems.append(_pore_table(pore_dicts, st))
    elems.append(Spacer(1, 10))

    return elems


def generate_pdf(
    pores: list,
    spec: dict,
    wall_h_mm: float,
    exclusion_zones: Optional[list] = None,
    datum_rect: Optional[dict] = None,
    pore_offset_mm: float = 0.0,
) -> bytes:
    """Generate a single-image professional A4 PDF report and return bytes."""
    from .models import PoreModel, SpecModel
    pore_models = [PoreModel(**p) if not isinstance(p, PoreModel) else p for p in pores]
    spec_model  = SpecModel(**spec) if isinstance(spec, dict) else spec
    spec_dict   = spec if isinstance(spec, dict) else spec.model_dump()

    res = run_evaluation(pore_models, spec_model, wall_h_mm, exclusion_zones, datum_rect, pore_offset_mm)
    all_pass = res['all_pass']
    pore_dicts = res['updated_pores']

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=MARGIN, leftMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=MARGIN
    )
    st = _styles()
    elems = []

    # Header
    elems.append(Paragraph("Porosity Validation Inspection", st['doc_title']))
    elems.append(Paragraph(
        f"VW 50093 Compliance Report  ·  "
        f"Generated {datetime.now().strftime('%d %b %Y, %H:%M')}",
        st['doc_sub']
    ))
    elems.append(_section_hr())
    elems.append(_verdict_banner(all_pass))
    n_fail = len([c for c in res['checks'] if not c['pass']])
    elems.append(Spacer(1, 4))
    sub_txt = (
        "Part meets all VW50093 porosity requirements." if all_pass
        else f"{n_fail} parameter(s) outside specification — part does not conform."
    )
    sub_s = ParagraphStyle('vs', fontSize=9, textColor=C_MID, alignment=TA_CENTER, spaceAfter=14)
    elems.append(Paragraph(sub_txt, sub_s))

    # Part info
    elems.append(Paragraph("IDENTIFICATION & LIMITS", st['section']))
    elems.append(_section_hr())
    elems.append(_info_table(spec_dict, res, st, actual_datum_area=res.get('datum_area', spec_dict.get('datum', 100))))
    elems.append(Spacer(1, 14))

    # Summary stats
    elems.append(Paragraph("MEASUREMENT SUMMARY", st['section']))
    elems.append(_section_hr())
    n_pass = len([c for c in res['checks'] if c['pass']])
    stats = [
        [Paragraph("Total Pores", st['label']),   Paragraph("Effective Pores", st['label']),
         Paragraph("Porosity %", st['label']),     Paragraph("Largest Φ", st['label']),
         Paragraph("Parameters", st['label'])],
        [Paragraph(str(len(pores)),               st['value']),
         Paragraph(str(res['eff_pores']),          st['value']),
         Paragraph(f"{res['pct']:.2f}%",           st['value']),
         Paragraph(f"{res['max_phi']:.2f} mm",     st['value']),
         Paragraph(f"{n_pass}/{len(res['checks'])} PASS",
                   ParagraphStyle('sp', fontSize=10, fontName='Helvetica-Bold',
                                  textColor=C_PASS if n_pass==len(res['checks']) else C_FAIL))],
    ]
    ts = Table(stats, colWidths=[CONTENT_W/5]*5)
    ts.setStyle(TableStyle([
        ('BACKGROUND', (0,0),(-1,0), C_BG),
        ('GRID', (0,0),(-1,-1), 0.3, C_BORDER),
        ('TOPPADDING', (0,0),(-1,-1), 8), ('BOTTOMPADDING', (0,0),(-1,-1), 8),
        ('ALIGN', (0,0),(-1,-1), 'CENTER'), ('VALIGN', (0,0),(-1,-1), 'MIDDLE'),
    ]))
    elems.append(ts)
    elems.append(Spacer(1, 12))

    # Parameter Evaluation
    elems.append(Paragraph("PARAMETER EVALUATION", st['section']))
    elems.append(_section_hr())
    elems.append(_checks_table(res['checks'], st))
    elems.append(Spacer(1, 12))

    # Datum & Exclusion Analysis
    dr_dict = datum_rect if isinstance(datum_rect, dict) else (datum_rect.model_dump() if datum_rect else None)
    de_table = _datum_excl_table(res, spec_dict, dr_dict, exclusion_zones or [], st)
    if de_table:
        elems.append(Paragraph("□ DATUM & EXCLUSION ANALYSIS", st['section']))
        elems.append(_section_hr())
        elems.append(de_table)
        elems.append(Spacer(1, 12))

    # Zone map
    elems.append(Paragraph("CROSS-SECTION — ZONE MAP", st['section']))
    elems.append(_section_hr())
    elems.append(_zone_map_drawing(pore_dicts, spec_dict, wall_h_mm, exclusion_zones, datum_rect))
    elems.append(Spacer(1, 18))

    # Method Capability
    elems.append(Paragraph("INSPECTION METHOD CAPABILITY", st['section']))
    elems.append(_section_hr())
    elems.append(Paragraph(METHOD_NOTES.get(spec_dict.get('method', 'visual_machined'), '—'), st['normal']))
    elems.append(Spacer(1, 30))

    # Footer
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


def generate_workspace_pdf(workspace_specs: list) -> bytes:
    """
    Generate a full multi-spec × multi-image A4 PDF workspace report.
    workspace_specs: list of WorkspaceSpecModel-like dicts with keys:
        name, spec (dict), images (list of WorkspaceImageModel-like dicts)
    """
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer, pagesize=A4,
        rightMargin=MARGIN, leftMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=MARGIN
    )
    st = _styles()
    elems = []

    # Cover header
    elems.append(Paragraph("Porosity Validation Inspection", st['doc_title']))
    elems.append(Paragraph(
        f"VW 50093 Workspace Report  ·  "
        f"Generated {datetime.now().strftime('%d %b %Y, %H:%M')}  ·  "
        f"{len(workspace_specs)} specification(s)",
        st['doc_sub']
    ))
    elems.append(_section_hr())
    elems.append(Spacer(1, 8))

    total_images = sum(len(s.get('images', [])) for s in workspace_specs)
    elems.append(Paragraph(
        f"Workspace summary: {len(workspace_specs)} spec tab(s) · {total_images} image(s)",
        ParagraphStyle('ws', fontSize=9, textColor=C_MID, spaceAfter=16)
    ))
    elems.append(Spacer(1, 10))

    for si, spec_entry in enumerate(workspace_specs):
        spec_name  = spec_entry.get('name', f'Specification {si+1}')
        spec_dict  = spec_entry.get('spec', {})
        images     = spec_entry.get('images', [])

        # Spec section header (page break after first)
        if si > 0:
            elems.append(PageBreak())

        elems.append(Paragraph(f"Specification {si+1}: {spec_name}", st['spec_title']))
        elems.append(_section_hr())

        # Spec info table
        from .models import SpecModel
        spec_model = SpecModel(**spec_dict) if isinstance(spec_dict, dict) else spec_dict
        elems.append(_info_table(spec_dict, {}, st))
        elems.append(Spacer(1, 14))

        if not images:
            elems.append(Paragraph("No images recorded for this specification.", st['small']))
            continue

        # Per-image sections
        for ii, img_entry in enumerate(images):
            img_name  = img_entry.get('name', f'Image {ii+1}')
            image_label = f"{si+1}.{ii+1} — {img_name}"

            img_data = {
                'pores':           img_entry.get('pores', []),
                'wall_h_mm':       img_entry.get('wall_h_mm', 6.0),
                'exclusion_zones': img_entry.get('exclusion_zones') or [],
                'datum_rect':      img_entry.get('datum_rect'),
                'pore_offset_mm':  img_entry.get('pore_offset_mm', 0.0),
            }

            img_elems = _build_image_elements(img_data, spec_dict, image_label, st)
            elems.extend(img_elems)

            if ii < len(images) - 1:
                elems.append(Spacer(1, 16))
                elems.append(HRFlowable(width='100%', thickness=0.3, color=C_BORDER))

        # Spec method capability note
        elems.append(Spacer(1, 14))
        elems.append(Paragraph("INSPECTION METHOD CAPABILITY", st['section']))
        elems.append(_section_hr())
        elems.append(Paragraph(
            METHOD_NOTES.get(spec_dict.get('method', 'visual_machined'), '—'), st['normal']
        ))

    # Footer
    elems.append(Spacer(1, 20))
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

def _pore_table(pore_dicts: list, st: dict) -> Table:
    """Create a table for the top 10 largest pores (or all if < 10) for PDF export."""
    from reportlab.platypus import Table, TableStyle, Paragraph
    from reportlab.lib import colors
    
    # Sort by effective diameter descending
    sorted_pores = sorted(pore_dicts, key=lambda p: p.get('effective_dia', p.get('dia', 0)), reverse=True)
    # Take up to top 20
    top_pores = sorted_pores[:20]
    
    if not top_pores:
        return Paragraph("No pores detected.", st['small'])
        
    data = [
        [Paragraph("<b>ID</b>", st['label']),
         Paragraph("<b>Zone</b>", st['label']),
         Paragraph("<b>Raw Dia (mm)</b>", st['label']),
         Paragraph("<b>Eff Dia (mm)</b>", st['label']),
         Paragraph("<b>Eff Area (mm²)</b>", st['label'])]
    ]
    
    import math
    for p in top_pores:
        pid = p.get('id', '')[:6]
        zone = p.get('zone', '—')
        dia = p.get('dia', 0.0)
        e_dia = p.get('effective_dia', dia)
        e_area = p.get('effective_area', math.pi * (e_dia / 2) ** 2)
        
        data.append([
            Paragraph(f"<font name='Courier'>{pid}</font>", st['value']),
            Paragraph(zone, st['value']),
            Paragraph(f"{dia:.3f}", st['value']),
            Paragraph(f"{e_dia:.3f}", st['value']),
            Paragraph(f"{e_area:.4f}", st['value']),
        ])
        
    t = Table(data, colWidths=[100, 100, 100, 100, 100])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.HexColor('#f8f9fa')),
        ('GRID', (0,0), (-1,-1), 0.5, colors.HexColor('#dddddd')),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
    ]))
    return t
