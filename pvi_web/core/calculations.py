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


def get_zone(y: float, wall_h_mm: float) -> str:
    """
    VW50093 §2.2 — Wall depth zone assignment.
    HR (outer ⅓): y < t/3  OR  y > 2t/3
    HK (central ⅓): t/3 ≤ y ≤ 2t/3
    """
    if wall_h_mm <= 0:
        return 'hr'
    t3 = wall_h_mm / 3.0
    if y < 0 or y > wall_h_mm:
        return 'outside'
    if y < t3:
        return 'hr'
    if y <= t3 * 2:
        return 'hk'
    return 'hr'


def run_evaluation(pores: List[PoreModel], spec: SpecModel, wall_h_mm: float) -> dict:
    """Full VW50093 compliance evaluation."""
    # Recompute zones from current wall height
    for p in pores:
        p.zone = get_zone(p.y, wall_h_mm)

    pct     = calc_porosity(pores, spec)
    max_phi = calc_max_phi(pores, spec)
    gap_d   = calc_min_gap(pores, spec)
    eff     = effective_pores(pores, spec)

    # Global H/N (full cross-section)
    h_trig  = gap_d is not None and gap_d['gap'] < gap_d['req']
    n_trig  = gap_d is not None and gap_d['is_N']

    # Zone-specific analysis
    hr_z = analyse_zone(pores, spec, 'hr')
    hk_z = analyse_zone(pores, spec, 'hk')

    # NR/NK — cluster diameter > Φ within zone
    nr_trig = hr_z['n'] and hr_z['cluster'] > spec.phi
    nk_trig = hk_z['n'] and hk_z['cluster'] > spec.phi

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
            'pass':   pct <= spec.pct,
            'meas':   f'{pct:.2f}%',
            'limit':  f'≤{spec.pct}%',
            'detail': f'Σπr² / Datum = {pct:.3f}%  (limit {spec.pct}%)',
        },
        # §3.2 – Maximum single pore diameter
        {
            'n':      'Max pore Φ',
            'par':    'Φ',
            'pass':   max_phi <= spec.phi,
            'meas':   f'{max_phi:.3f} mm',
            'limit':  f'≤{spec.phi} mm',
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
            'pass':   not h_trig or spec.h == 1,
            'meas':   'TRIGGERED' if h_trig else 'None',
            'limit':  f'H{spec.h}',
            'detail': 'Pore group spacing below A×Φ_smaller' if h_trig else 'No looseness group',
        },
        # §3.5 – N (cluster / packing, full section)
        {
            'n':      'N — Packing cluster (full)',
            'par':    'N',
            'pass':   not n_trig or spec.n == 1,
            'meas':   f'Cluster span {gap_d["cluster_d"]:.2f} mm' if n_trig and gap_d else 'None',
            'limit':  f'N{spec.n}',
            'detail': 'Edge gap < Φ_smaller — packing cluster formed' if n_trig else 'No packing cluster',
        },
        # §3.6 – HR / NR (outer ⅓)
        {
            'n':      'HR / NR (outer ⅓)',
            'par':    'HR',
            'pass':   (spec.hr == 2) or (not hr_z['h']) or
                      (spec.hr == 1 and (not nr_trig or spec.nr == 1)),
            'meas':   (f'H-group ({hr_z["pores"]} pores, gap {hr_z["min_gap"]:.2f}mm)'
                       if hr_z['h'] else 'Clean'),
            'limit':  'N/A' if spec.hr == 2 else f'HR{spec.hr} / NR{spec.nr}',
            'detail': ('Not specified' if spec.hr == 2 else
                       f'Outer ⅓: looseness detected, cluster {hr_z["cluster"]:.2f} mm'
                       if hr_z['h'] else 'Outer ⅓ clean'),
        },
        # §3.6 – HK / NK (central ⅓)
        {
            'n':      'HK / NK (central ⅓)',
            'par':    'HK',
            'pass':   (spec.hk == 2) or (not hk_z['h']) or
                      (spec.hk == 1 and (not nk_trig or spec.nk == 1)),
            'meas':   (f'H-group ({hk_z["pores"]} pores, gap {hk_z["min_gap"]:.2f}mm)'
                       if hk_z['h'] else 'Clean'),
            'limit':  'N/A' if spec.hk == 2 else f'HK{spec.hk} / NK{spec.nk}',
            'detail': ('Not specified' if spec.hk == 2 else
                       f'Central ⅓: looseness detected, cluster {hk_z["cluster"]:.2f} mm'
                       if hk_z['h'] else 'Central ⅓ clean'),
        },
    ]

    all_pass = all(c['pass'] for c in checks)
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
    }
