"""PVI Web — Core Calculations (VW50093) — Deep Checked"""
import math
from typing import List, Optional
from .models import SpecModel, PoreModel


def calc_porosity(pores: List[PoreModel], spec: SpecModel) -> float:
    eff = effective_pores(pores, spec)
    total = sum(math.pi * (p.dia / 2) ** 2 for p in eff)
    return total / max(spec.datum, 0.01) * 100


def calc_max_phi(pores: List[PoreModel], spec: SpecModel) -> float:
    eff = effective_pores(pores, spec)
    return max((p.dia for p in eff), default=0.0)


def calc_min_gap(pores: List[PoreModel], spec: SpecModel) -> Optional[dict]:
    """
    VW50093 §3.4  Gap = edge-to-edge distance between two pore circles.
    H condition triggered when gap < A × Φ_smaller (the 'looseness' condition).
    N condition triggered when gap < Φ_smaller (packing / clustering).
    """
    eff = effective_pores(pores, spec)
    if len(eff) < 2:
        return None
    best = None
    for i in range(len(eff)):
        for j in range(i + 1, len(eff)):
            pi, pj = eff[i], eff[j]
            center_dist = math.hypot(pi.x - pj.x, pi.y - pj.y)
            edge_gap    = center_dist - pi.dia / 2 - pj.dia / 2
            smaller     = min(pi.dia, pj.dia)
            req         = spec.a * smaller          # §3.4 — H condition threshold
            cluster_d   = pi.dia / 2 + pj.dia / 2 + center_dist  # bounding circle span
            is_N        = edge_gap < smaller        # N (packing/cluster)
            if best is None or edge_gap < best['gap']:
                best = {
                    'gap':       edge_gap,
                    'req':       req,
                    'smaller':   smaller,
                    'cluster_d': cluster_d,
                    'is_N':      is_N,
                    'pair':      (pi.id, pj.id),
                }
    return best


def analyse_zone(pores: List[PoreModel], spec: SpecModel, zone: str) -> dict:
    """
    Zone-specific H/N analysis per VW50093.
    HR  = outer thirds (top+bottom t/3).  HK = central t/3.
    NR/NK = packing (cluster diameter > Φ) within that zone.
    """
    eff = [p for p in effective_pores(pores, spec) if p.zone == zone]
    n   = len(eff)
    if n == 0:
        return {'h': False, 'n': False, 'cluster': 0.0, 'pores': 0, 'min_gap': None}
    h_trig     = False
    n_trig     = False
    max_cluster = 0.0
    min_gap_val = None
    for i in range(n):
        for j in range(i + 1, n):
            pi, pj   = eff[i], eff[j]
            dist     = math.hypot(pi.x - pj.x, pi.y - pj.y)
            edge_gap = dist - pi.dia / 2 - pj.dia / 2
            smaller  = min(pi.dia, pj.dia)
            req      = spec.a * smaller
            if edge_gap < req:
                h_trig = True
            if edge_gap < smaller:
                n_trig = True
                cluster = pi.dia / 2 + pj.dia / 2 + dist
                max_cluster = max(max_cluster, cluster)
            if min_gap_val is None or edge_gap < min_gap_val:
                min_gap_val = edge_gap
    return {
        'h': h_trig,
        'n': n_trig,
        'cluster':  max_cluster,
        'pores':    n,
        'min_gap':  min_gap_val,
    }


def effective_pores(pores: List[PoreModel], spec: SpecModel) -> List[PoreModel]:
    """Exclude pores below ignore threshold U (§3.2)."""
    u = spec.u
    return [p for p in pores if p.dia >= u] if u > 0 else list(pores)


def get_zone(y: float, wall_h_mm: float, offset_mm: float = 0.0) -> str:
    """
    VW50093 §2.2 — Wall depth zone assignment.
    HR (outer ⅓): y < t/3  OR  y > 2t/3
    HK (central ⅓): t/3 ≤ y ≤ 2t/3
    offset_mm: applied for cropped images to map local Y back to wall depth.
    """
    y_abs = y + offset_mm
    if wall_h_mm <= 0:
        return 'hr'
    t3 = wall_h_mm / 3.0
    if y_abs < 0 or y_abs > wall_h_mm:
        return 'outside'
    if y_abs < t3:
        return 'hr'
    if y_abs <= t3 * 2:
        return 'hk'
    return 'hr'




def rect_intersection_area(a: dict, b: dict) -> float:
    ax2, ay2 = a['x'] + a['w'], a['y'] + a['h']
    bx2, by2 = b['x'] + b['w'], b['y'] + b['h']
    w = max(0.0, min(ax2, bx2) - max(a['x'], b['x']))
    h = max(0.0, min(ay2, by2) - max(a['y'], b['y']))
    return w * h

def circle_rect_intersect_area(cx: float, cy: float, r: float, rx: float, ry: float, rw: float, rh: float) -> float:
    closest_x = max(rx, min(cx, rx + rw))
    closest_y = max(ry, min(cy, ry + rh))
    dist = math.hypot(cx - closest_x, cy - closest_y)
    if dist >= r:
        return 0.0
    steps = 60
    count = 0
    r2 = r * r
    for i in range(steps):
        angle = (i / steps) * math.pi * 2
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        for ri in range(1, steps + 1):
            pr = (ri / steps) * r
            px = cx + cos_a * pr
            py = cy + sin_a * pr
            if rx <= px <= rx + rw and ry <= py <= ry + rh:
                count += 1
    return (count / (steps * steps)) * math.pi * r2

def circle_circle_intersect_area(cx1: float, cy1: float, r1: float, cx2: float, cy2: float, r2: float) -> float:
    d = math.hypot(cx1 - cx2, cy1 - cy2)
    if d >= r1 + r2:
        return 0.0
    if d <= abs(r1 - r2):
        return math.pi * min(r1, r2) * min(r1, r2)
    arg1 = (d * d + r1 * r1 - r2 * r2) / (2 * d * r1)
    arg2 = (d * d + r2 * r2 - r1 * r1) / (2 * d * r2)
    a1 = r1 * r1 * math.acos(max(-1.0, min(1.0, arg1)))
    a2 = r2 * r2 * math.acos(max(-1.0, min(1.0, arg2)))
    a3 = 0.5 * math.sqrt(max(0.0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)))
    return a1 + a2 - a3

# ── Polygon geometry ────────────────────────────────────────────────────────

def point_in_polygon(px: float, py: float, points: list) -> bool:
    """Ray casting algorithm — True if (px,py) is inside the polygon."""
    if not points or len(points) < 3:
        return False
    n = len(points)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = points[i]['x'], points[i]['y']
        xj, yj = points[j]['x'], points[j]['y']
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def polygon_area(points: list) -> float:
    """Shoelace formula for signed polygon area (returns absolute value)."""
    if not points or len(points) < 3:
        return 0.0
    n = len(points)
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += points[i]['x'] * points[j]['y']
        area -= points[j]['x'] * points[i]['y']
    return abs(area) / 2.0

def polygon_bbox(points: list) -> dict:
    """Returns bounding box of polygon points."""
    if not points:
        return {'x': 0, 'y': 0, 'w': 0, 'h': 0}
    xs = [p['x'] for p in points]
    ys = [p['y'] for p in points]
    return {'x': min(xs), 'y': min(ys), 'w': max(xs) - min(xs), 'h': max(ys) - min(ys)}

def _poly_edge_inside(p: dict, edge: str, rx: float, ry: float, rw: float, rh: float) -> bool:
    """Sutherland-Hodgman clip: is point inside this clip edge?"""
    if edge == 'left':   return p['x'] >= rx
    if edge == 'right':  return p['x'] <= rx + rw
    if edge == 'top':    return p['y'] >= ry
    if edge == 'bottom': return p['y'] <= ry + rh
    return True

def _poly_edge_intersect(p1: dict, p2: dict, edge: str, rx: float, ry: float, rw: float, rh: float) -> dict:
    """Sutherland-Hodgman clip: intersection of segment p1→p2 with clip edge."""
    x1, y1 = p1['x'], p1['y']
    x2, y2 = p2['x'], p2['y']
    if edge == 'left':
        t = (rx - x1) / (x2 - x1) if x2 != x1 else 0.0
        return {'x': rx, 'y': y1 + t * (y2 - y1)}
    if edge == 'right':
        t = (rx + rw - x1) / (x2 - x1) if x2 != x1 else 0.0
        return {'x': rx + rw, 'y': y1 + t * (y2 - y1)}
    if edge == 'top':
        t = (ry - y1) / (y2 - y1) if y2 != y1 else 0.0
        return {'x': x1 + t * (x2 - x1), 'y': ry}
    # bottom
    t = (ry + rh - y1) / (y2 - y1) if y2 != y1 else 0.0
    return {'x': x1 + t * (x2 - x1), 'y': ry + rh}

def clip_polygon_to_rect(pts: list, rx: float, ry: float, rw: float, rh: float) -> list:
    """Sutherland-Hodgman: clip polygon to axis-aligned rectangle.
    Returns the clipped polygon vertex list (may be empty if no overlap)."""
    output = list(pts)
    for edge in ('left', 'right', 'top', 'bottom'):
        if not output:
            return []
        inp = output
        output = []
        for i in range(len(inp)):
            curr = inp[i]
            prev = inp[i - 1]
            curr_in = _poly_edge_inside(curr, edge, rx, ry, rw, rh)
            prev_in = _poly_edge_inside(prev, edge, rx, ry, rw, rh)
            if curr_in:
                if not prev_in:
                    output.append(_poly_edge_intersect(prev, curr, edge, rx, ry, rw, rh))
                output.append(curr)
            elif prev_in:
                output.append(_poly_edge_intersect(prev, curr, edge, rx, ry, rw, rh))
    return output

def _point_to_segment_dist_sq(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    """Squared distance from point to line segment."""
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return (px - ax)**2 + (py - ay)**2
    t = max(0.0, min(1.0, ((px - ax)*dx + (py - ay)*dy) / (dx*dx + dy*dy)))
    return (px - ax - t*dx)**2 + (py - ay - t*dy)**2

def circle_polygon_intersect_area(cx: float, cy: float, r: float, points: list, steps: int = 72) -> float:
    """Circle-polygon intersection area.

    Fast path:
     - Pore entirely inside polygon (centre inside AND nearest edge > r away) → π·r²
     - Pore entirely outside polygon (centre outside AND nearest edge > r away) → 0

    Fallback: polar-grid Monte Carlo (steps × steps samples).
    """
    if not points or len(points) < 3 or r <= 0:
        return 0.0
    pore_area = math.pi * r * r
    n = len(points)
    centre_in = point_in_polygon(cx, cy, points)

    # Min squared distance from pore centre to any polygon edge
    min_dsq = float('inf')
    for i in range(n):
        j = (i + 1) % n
        dsq = _point_to_segment_dist_sq(cx, cy,
                                        points[i]['x'], points[i]['y'],
                                        points[j]['x'], points[j]['y'])
        if dsq < min_dsq:
            min_dsq = dsq

    min_dist = math.sqrt(min_dsq)

    if min_dist >= r:
        # Pore doesn't straddle any edge
        return pore_area if centre_in else 0.0

    # Pore straddles polygon boundary — use polar Monte Carlo
    count = 0
    total = steps * steps
    for i in range(steps):
        angle = (i / steps) * math.pi * 2
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        for ri in range(1, steps + 1):
            pr = (ri / steps) * r
            px_s = cx + cos_a * pr
            py_s = cy + sin_a * pr
            if point_in_polygon(px_s, py_s, points):
                count += 1
    return (count / total) * pore_area if total > 0 else 0.0


def pore_excl_crop_status(p: PoreModel, zones: list) -> dict:
    if not zones:
        return {'status': 'none', 'effectiveDia': p.dia, 'effectiveArea': math.pi * (p.dia / 2) ** 2, 'fraction': 1.0}
    r = p.dia / 2
    pore_area = math.pi * r * r
    total_intersect = 0.0
    centre_inside = False
    for z in zones:
        z_dict = z if isinstance(z, dict) else z.model_dump()
        intersect = 0.0
        if z_dict.get('type') == 'rect':
            zx, zy = z_dict.get('x', 0.0), z_dict.get('y', 0.0)
            zw, zh = z_dict.get('w', 0.0), z_dict.get('h', 0.0)
            intersect = circle_rect_intersect_area(p.x, p.y, r, zx, zy, zw, zh)
            if zx <= p.x <= (zx + zw) and zy <= p.y <= (zy + zh):
                centre_inside = True
        elif z_dict.get('type') == 'circle':
            cx, cy = z_dict.get('cx', 0.0), z_dict.get('cy', 0.0)
            zr = z_dict.get('r', 0.0)
            intersect = circle_circle_intersect_area(p.x, p.y, r, cx, cy, zr)
            dx = p.x - cx
            dy = p.y - cy
            if (dx*dx + dy*dy) <= zr*zr:
                centre_inside = True
        elif z_dict.get('type') == 'polygon':
            pts = z_dict.get('points', [])
            if pts and len(pts) >= 3:
                intersect = circle_polygon_intersect_area(p.x, p.y, r, pts)
                if point_in_polygon(p.x, p.y, pts):
                    centre_inside = True
        total_intersect = min(pore_area, total_intersect + intersect)

    if total_intersect <= 0:
        return {'status': 'none', 'effectiveDia': p.dia, 'effectiveArea': pore_area, 'fraction': 1.0}
    effective_area = max(0.0, pore_area - total_intersect)
    fraction = effective_area / pore_area
    if fraction < 0.05:
        return {'status': 'full', 'effectiveDia': 0.0, 'effectiveArea': 0.0, 'fraction': 0.0}
    effective_dia = 2 * math.sqrt(effective_area / math.pi)
    return {'status': 'partial', 'effectiveDia': effective_dia, 'effectiveArea': effective_area, 'fraction': fraction, 'centreInside': centre_inside}


def exclusion_area_for_datum(zones: list, datum_rect: dict, wall_w: float, wall_h: float) -> float:
    if not zones:
        return 0.0
    bounds = datum_rect if (datum_rect and datum_rect.get('w', 0) > 0) else {
        'x': 0.0, 'y': 0.0, 'w': max(wall_w, 0.0), 'h': max(wall_h, 0.0)
    }
    if not bounds.get('w') or not bounds.get('h'):
        return 0.0
    total = 0.0
    for z in zones:
        z_dict = z if isinstance(z, dict) else z.model_dump()
        if z_dict.get('type') == 'rect':
            total += rect_intersection_area(bounds, z_dict)
        elif z_dict.get('type') == 'circle':
            cx, cy = z_dict.get('cx', 0.0), z_dict.get('cy', 0.0)
            r = z_dict.get('r', 0.0)
            total += circle_rect_intersect_area(cx, cy, r, bounds['x'], bounds['y'], bounds['w'], bounds['h'])
        elif z_dict.get('type') == 'polygon':
            pts = z_dict.get('points', [])
            if pts and len(pts) >= 3:
                # Exact area using Sutherland-Hodgman polygon clipping + Shoelace formula
                clipped = clip_polygon_to_rect(
                    pts, bounds['x'], bounds['y'], bounds['w'], bounds['h']
                )
                if len(clipped) >= 3:
                    total += polygon_area(clipped)
    return total



def pore_in_exclusion_zone(p: PoreModel, zones: list) -> bool:
    cs = pore_excl_crop_status(p, zones)
    return cs['status'] == 'full'

def run_evaluation(
    pores: List[PoreModel],
    spec: SpecModel,
    wall_h_mm: float,
    exclusion_zones: Optional[list] = None,
    datum_rect: Optional[dict] = None,
    pore_offset_mm: float = 0.0,
) -> dict:
    """Full VW50093 compliance evaluation supporting exclusion zones, datum rect, pore offset,
    and gas/shrink type-specific limit checks."""

    # Recompute zones from current wall height + offset
    for p in pores:
        p.zone = 'hr' if spec.zone_disabled else get_zone(p.y, wall_h_mm, pore_offset_mm)

    # ── NET (excl. zone filtered) evaluation ──
    # Apply visual cropping logic: fully-excluded are dropped, partially-excluded are cropped (dia set to effectiveDia)
    net_pores = []
    for p in pores:
        cs = pore_excl_crop_status(p, exclusion_zones)
        if cs['status'] == 'full':
            continue
        elif cs['status'] == 'partial':
            p_copy = PoreModel(
                id=p.id,
                x=p.x,
                y=p.y,
                dia=cs['effectiveDia'],
                type=p.type,
                zone=p.zone
            )
            # Add custom markers
            p_copy._effectiveDia = cs['effectiveDia']
            p_copy._cropFraction = cs['fraction']
            p_copy._isCropped = True
            net_pores.append(p_copy)
        else:
            p_copy = PoreModel(
                id=p.id,
                x=p.x,
                y=p.y,
                dia=p.dia,
                type=p.type,
                zone=p.zone
            )
            p_copy._effectiveDia = p.dia
            p_copy._cropFraction = 1.0
            p_copy._isCropped = False
            net_pores.append(p_copy)

    dr_dict = datum_rect if isinstance(datum_rect, dict) else (datum_rect.model_dump() if datum_rect else None)
    if dr_dict and dr_dict.get('w', 0) > 0:
        net_pores = [
            p for p in net_pores
            if dr_dict.get('x', 0) <= p.x <= (dr_dict.get('x', 0) + dr_dict.get('w', 0))
            and dr_dict.get('y', 0) <= p.y <= (dr_dict.get('y', 0) + dr_dict.get('h', 0))
        ]

    x_vals = [p.x for p in pores] if pores else []
    wall_w = max(max(x_vals) * 1.2 if x_vals else 20.0, 20.0)

    # Calculate net datum area by subtracting the exclusion zone areas inside the datum bounds
    base_datum = dr_dict.get('w', 0) * dr_dict.get('h', 0) if (dr_dict and dr_dict.get('w', 0) > 0) else spec.datum
    excl_area = exclusion_area_for_datum(exclusion_zones, dr_dict, wall_w, wall_h_mm)
    net_datum_area = max(base_datum - excl_area, 0.01)

    # Run net evaluation
    spec_net = spec.model_copy(update={'datum': net_datum_area})
    pct = calc_porosity(net_pores, spec_net)
    max_phi = calc_max_phi(net_pores, spec_net)
    gap_d = calc_min_gap(net_pores, spec_net)
    eff = effective_pores(net_pores, spec_net)

    # ── RAW (all pores, NO exclusion zone filter) ──
    raw_pores = list(pores)
    if dr_dict and dr_dict.get('w', 0) > 0:
        raw_pores = [
            p for p in raw_pores
            if dr_dict.get('x', 0) <= p.x <= (dr_dict.get('x', 0) + dr_dict.get('w', 0))
            and dr_dict.get('y', 0) <= p.y <= (dr_dict.get('y', 0) + dr_dict.get('h', 0))
        ]
    spec_raw = spec.model_copy(update={'datum': base_datum})
    raw_pct = calc_porosity(raw_pores, spec_raw)

    # Global H/N (full cross-section)
    h_trig  = gap_d is not None and gap_d['gap'] < gap_d['req']
    n_trig  = gap_d is not None and gap_d['is_N']

    # Zone-specific analysis
    hr_z = analyse_zone(net_pores, spec_net, 'hr')
    hk_z = analyse_zone(net_pores, spec_net, 'hk')

    # NR/NK — cluster diameter > Φ within zone
    nr_trig = hr_z['n'] and hr_z['cluster'] > spec_net.phi
    nk_trig = hk_z['n'] and hk_z['cluster'] > spec_net.phi

    def gap_meas():
        if gap_d is None:
            return 'N/A'
        g = gap_d['gap']
        return f"{g:.3f} mm" if g > 0 else f"OVERLAP ({abs(g):.3f}mm)"

    def gap_limit():
        if gap_d is None:
            return 'A×Φ_smaller'
        return f"≥{gap_d['req']:.2f} mm"

    checks = [
        # §3.1 – Porosity percentage
        {
            'n':      'Porosity %',
            'par':    '%',
            'pass':   pct <= spec_net.pct,
            'meas':   f'{pct:.2f}%',
            'limit':  f'≤{spec_net.pct}%',
            'detail': f'Σπr² / Datum = {pct:.3f}%  (limit {spec_net.pct}%)',
        },
        # §3.2 – Maximum single pore diameter
        {
            'n':      'Max pore Φ',
            'par':    'Φ',
            'pass':   max_phi <= spec_net.phi,
            'meas':   f'{max_phi:.3f} mm',
            'limit':  f'≤{spec_net.phi} mm',
            'detail': f'Largest effective pore {max_phi:.3f} mm',
        },
        # §3.4 – Spacing (H condition, global)
        {
            'n':      'Spacing A (global)',
            'par':    'A',
            'pass':   not h_trig,
            'meas':   gap_meas(),
            'limit':  gap_limit(),
            'detail': (
                f'Closest pair gap {gap_d["gap"]:.3f} mm < A×Φs {gap_d["req"]:.2f} mm'
                if h_trig else 'All pores adequately spaced'
            ),
        },
        # §3.5 – H (looseness / packing group, full section)
        {
            'n':      'H — Looseness (full)',
            'par':    'H',
            'pass':   not h_trig or spec_net.h == 1,
            'meas':   'TRIGGERED' if h_trig else 'None',
            'limit':  f'H{spec_net.h}',
            'detail': 'Pore group spacing below A×Φ_smaller' if h_trig else 'No looseness group',
        },
        # §3.5 – N (cluster / packing, full section)
        {
            'n':      'N — Packing cluster (full)',
            'par':    'N',
            'pass':   not n_trig or spec_net.n == 1,
            'meas':   f'Cluster span {gap_d["cluster_d"]:.2f} mm' if n_trig and gap_d else 'None',
            'limit':  f'N{spec_net.n}',
            'detail': 'Edge gap < Φ_smaller — packing cluster formed' if n_trig else 'No packing cluster',
        },
        # §3.6 – HR / NR (outer ⅓)
        {
            'n':      'HR / NR (outer ⅓)',
            'par':    'HR',
            'pass':   (spec_net.hr == 2) or (not hr_z['h']) or
                      (spec_net.hr == 1 and (not nr_trig or spec_net.nr == 1)),
            'meas':   (f'H-group ({hr_z["pores"]} pores, gap {hr_z["min_gap"]:.2f}mm)'
                       if hr_z['h'] else 'Clean'),
            'limit':  'N/A' if spec_net.hr == 2 else f'HR{spec_net.hr} / NR{spec_net.nr}',
            'detail': ('Not specified' if spec_net.hr == 2 else
                       f'Outer ⅓: looseness detected, cluster {hr_z["cluster"]:.2f} mm'
                       if hr_z['h'] else 'Outer ⅓ clean'),
        },
        # §3.6 – HK / NK (central ⅓)
        {
            'n':      'HK / NK (central ⅓)',
            'par':    'HK',
            'pass':   (spec_net.hk == 2) or (not hk_z['h']) or
                      (spec_net.hk == 1 and (not nk_trig or spec_net.nk == 1)),
            'meas':   (f'H-group ({hk_z["pores"]} pores, gap {hk_z["min_gap"]:.2f}mm)'
                       if hk_z['h'] else 'Clean'),
            'limit':  'N/A' if spec_net.hk == 2 else f'HK{spec_net.hk} / NK{spec_net.nk}',
            'detail': ('Not specified' if spec_net.hk == 2 else
                       f'Central ⅓: looseness detected, cluster {hk_z["cluster"]:.2f} mm'
                       if hk_z['h'] else 'Central ⅓ clean'),
        },
    ]

    # ── Gas-type specific checks ─────────────────────────────────────────────
    gas_pores  = [p for p in effective_pores(net_pores, spec_net) if (p.type or 'gas') == 'gas']
    shrink_pores = [p for p in effective_pores(net_pores, spec_net) if p.type == 'shrink']

    if gas_pores:
        phi_g   = spec_net.phi_gas    if spec_net.phi_gas    is not None else spec_net.phi
        pct_g   = spec_net.pct_gas    if spec_net.pct_gas    is not None else spec_net.pct
        max_g   = max(p.dia for p in gas_pores)
        area_g  = sum(math.pi * (p.dia / 2) ** 2 for p in gas_pores)
        pct_gv  = area_g / net_datum_area * 100
        checks.append({
            'n':      f'Gas Φ max ({len(gas_pores)}p)',
            'par':    'Φ_G',
            'pass':   max_g <= phi_g,
            'meas':   f'{max_g:.3f} mm',
            'limit':  f'≤{phi_g} mm',
            'detail': f'{len(gas_pores)} gas pore(s) — largest Φ {max_g:.3f} mm',
        })
        checks.append({
            'n':      'Gas porosity %',
            'par':    '%_G',
            'pass':   pct_gv <= pct_g,
            'meas':   f'{pct_gv:.2f}%',
            'limit':  f'≤{pct_g}%',
            'detail': f'Gas area {area_g:.2f} mm² / {net_datum_area:.1f} mm² datum',
        })

    # ── Shrink-type specific checks ──────────────────────────────────────────
    if shrink_pores:
        phi_s   = spec_net.phi_shrink if spec_net.phi_shrink is not None else spec_net.phi
        pct_s   = spec_net.pct_shrink if spec_net.pct_shrink is not None else spec_net.pct
        max_s   = max(p.dia for p in shrink_pores)
        area_s  = sum(math.pi * (p.dia / 2) ** 2 for p in shrink_pores)
        pct_sv  = area_s / net_datum_area * 100
        checks.append({
            'n':      f'Shrink Φ max ({len(shrink_pores)}p)',
            'par':    'Φ_S',
            'pass':   max_s <= phi_s,
            'meas':   f'{max_s:.3f} mm',
            'limit':  f'≤{phi_s} mm',
            'detail': f'{len(shrink_pores)} shrink pore(s) — largest Φ {max_s:.3f} mm',
        })
        checks.append({
            'n':      'Shrink porosity %',
            'par':    '%_S',
            'pass':   pct_sv <= pct_s,
            'meas':   f'{pct_sv:.2f}%',
            'limit':  f'≤{pct_s}%',
            'detail': f'Shrink area {area_s:.2f} mm² / {net_datum_area:.1f} mm² datum',
        })

    all_pass = all(c['pass'] for c in checks)

    # Update zone info and crop metadata on pores
    for p in pores:
        cs = pore_excl_crop_status(p, exclusion_zones)
        p.is_excluded = (cs['status'] == 'full')
        p.is_cropped = (cs['status'] == 'partial')
        p.effective_dia = cs['effectiveDia']
        p.crop_fraction = cs['fraction']
        found = False
        for np in net_pores:
            if np.id == p.id:
                p.zone = np.zone
                found = True
                break
        if not found:
            p.zone = 'hr' if spec.zone_disabled else get_zone(p.y, wall_h_mm, pore_offset_mm)

    return {
        'all_pass':      all_pass,
        'checks':        checks,
        'pct':           pct,
        'max_phi':       max_phi,
        'gap_data':      gap_d,
        'h_triggered':   h_trig,
        'n_triggered':   n_trig,
        'hr_zone':       hr_z,
        'hk_zone':       hk_z,
        'eff_pores':     len(eff),
        'updated_pores': [p.model_dump() for p in pores],
        'raw_pct':       raw_pct,
        'raw_pore_count': len(raw_pores),
        'raw_datum':     base_datum,
        'net_pct':       pct,
        'net_pore_count': len(net_pores),
        'net_datum':     net_datum_area,
        'has_excl_zone':  (len(exclusion_zones) > 0) if exclusion_zones else False,
        'excl_zone_count': len(exclusion_zones) if exclusion_zones else 0,
        'excl_masked_pores': len(pores) - len(net_pores),
        'total_pores_before_excl': len(pores),
        'has_datum': dr_dict is not None and dr_dict.get('w', 0) > 0,
        'datum_area': net_datum_area,
        # datum_type: 'drawn' = user drew a square; 'calibrated_image' = full image area from calibrated scale;
        # 'spec' = fell back to spec.datum (no datum rect, no calibration).
        'datum_type': (
            'drawn'            if (dr_dict and dr_dict.get('w', 0) > 0 and (dr_dict.get('x', 0) != 0 or dr_dict.get('y', 0) != 0))
            else 'calibrated_image' if (dr_dict and dr_dict.get('w', 0) > 0)
            else 'spec'
        ),
    }
