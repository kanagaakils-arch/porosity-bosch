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
            r = z_dict.get('r', 0.0)
            total += math.pi * r * r
    return total

def pore_in_exclusion_zone(p: PoreModel, zones: list) -> bool:
    if not zones:
        return False
    for z in zones:
        z_dict = z if isinstance(z, dict) else z.model_dump()
        if z_dict.get('type') == 'rect':
            zx, zy = z_dict.get('x', 0.0), z_dict.get('y', 0.0)
            zw, zh = z_dict.get('w', 0.0), z_dict.get('h', 0.0)
            if zx <= p.x <= (zx + zw) and zy <= p.y <= (zy + zh):
                return True
        elif z_dict.get('type') == 'circle':
            cx, cy = z_dict.get('cx', 0.0), z_dict.get('cy', 0.0)
            r = z_dict.get('r', 0.0)
            dx = p.x - cx
            dy = p.y - cy
            if (dx*dx + dy*dy) <= r*r:
                return True
    return False

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
        p.zone = get_zone(p.y, wall_h_mm, pore_offset_mm)

    # ── NET (excl. zone filtered) evaluation ──
    net_pores = [p for p in pores if not pore_in_exclusion_zone(p, exclusion_zones)]
    dr_dict = datum_rect if isinstance(datum_rect, dict) else (datum_rect.model_dump() if datum_rect else None)
    if dr_dict and dr_dict.get('w', 0) > 0:
        net_pores = [
            p for p in net_pores
            if dr_dict.get('x', 0) <= p.x <= (dr_dict.get('x', 0) + dr_dict.get('w', 0))
            and dr_dict.get('y', 0) <= p.y <= (dr_dict.get('y', 0) + dr_dict.get('h', 0))
        ]

    x_vals = [p.x for p in pores] if pores else []
    wall_w = max(max(x_vals) * 1.2 if x_vals else 20.0, 20.0)

    # Calculate net datum area
    base_datum = dr_dict.get('w', 0) * dr_dict.get('h', 0) if (dr_dict and dr_dict.get('w', 0) > 0) else spec.datum
    net_datum_area = max(base_datum, 0.01)

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

    # Update zone info on pores
    for p in pores:
        found = False
        for np in net_pores:
            if np.id == p.id:
                p.zone = np.zone
                found = True
                break
        if not found:
            p.zone = 'hr'

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
        'datum_type': 'drawn' if (dr_dict and dr_dict.get('w', 0) > 0) else 'spec',
    }
