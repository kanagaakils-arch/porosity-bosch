"""PVI Web — Data Models."""

from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

class SpecModel(BaseModel):
    pno: str = 'PART-001'
    zone: str = 'Zone A'
    rev: str = '—'
    insp: str = '—'
    pct: float = 5.0
    phi: float = 1.5
    a: float = 2.0
    u: float = 0.2
    t: float = 6.0
    datum: float = 100.0
    h: int = 0
    n: int = 0
    hr: int = 0
    nr: int = 0
    hk: int = 1
    nk: int = 1
    method: str = 'visual_machined'
    zone_disabled: bool = False
    # ── Type-specific limits (optional — fall back to phi/pct if None) ──
    phi_gas: Optional[float] = None      # max single gas pore Φ (mm)
    pct_gas: Optional[float] = None      # max gas porosity %
    phi_shrink: Optional[float] = None   # max single shrink pore Φ (mm)
    pct_shrink: Optional[float] = None   # max shrink porosity %

class PoreModel(BaseModel):
    id: int
    x: float
    y: float
    dia: float
    type: str = 'gas'
    zone: str = 'hr'
    is_excluded: Optional[bool] = None
    is_cropped: Optional[bool] = None
    effective_dia: Optional[float] = None
    crop_fraction: Optional[float] = None

class ExclusionZoneModel(BaseModel):
    type: Literal["rect", "circle", "polygon"]
    x: Optional[float] = None
    y: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None
    cx: Optional[float] = None
    cy: Optional[float] = None
    r: Optional[float] = None
    points: Optional[List[dict]] = None   # polygon vertices [{x, y}, ...]

class DatumRectModel(BaseModel):
    x: float
    y: float
    w: float
    h: float

class EvalRequest(BaseModel):
    spec: SpecModel
    pores: List[PoreModel]
    wall_h_mm: float
    exclusion_zones: Optional[List[ExclusionZoneModel]] = None
    datum_rect: Optional[DatumRectModel] = None
    pore_offset_mm: float = 0.0   # for cropped images — Y offset before zone assignment


# ── Workspace export models (multi-spec × multi-image PDF) ─────────────────

class WorkspaceImageModel(BaseModel):
    name: str = 'Image'
    pores: List[PoreModel]
    wall_h_mm: float
    exclusion_zones: Optional[List[ExclusionZoneModel]] = None
    datum_rect: Optional[DatumRectModel] = None
    pore_offset_mm: float = 0.0

class WorkspaceSpecModel(BaseModel):
    name: str = 'Specification'
    spec: SpecModel
    images: List[WorkspaceImageModel]

class WorkspaceExportRequest(BaseModel):
    specs: List[WorkspaceSpecModel]


class DefectCellModel(BaseModel):
    cause_id: str
    defect_id: str
    relationship: Literal["primary", "secondary", "possible", "beneficial"]
    corrective_action: str
    severity: int = Field(ge=1, le=3)


class PQ2Input(BaseModel):
    p_hyd_bar: float = Field(gt=0, le=2000)
    d_shot_mm: float = Field(gt=1, le=200)
    d_plunger_mm: float = Field(gt=1, le=200)
    v_max_ms: float = Field(gt=0.1, le=20)
    gate_area_mm2: float = Field(gt=1, le=5000)
    cd: float = Field(gt=0.05, le=1.0)
    rho_kgm3: float = Field(gt=500, le=10000)
    n_points: int = Field(default=50, ge=10, le=400)


class GateInput(BaseModel):
    part_volume_cm3: float = Field(gt=0.1, le=100000)
    fill_time_ms: float = Field(gt=1, le=1000)
    gate_velocity_ms: float = Field(gt=10, le=100)


class FillTimeInput(BaseModel):
    wall_thickness_mm: float = Field(gt=0.2, le=20)
    alloy: str
    method: str = "NADCA"


class ShotSleeveInput(BaseModel):
    sleeve_bore_mm: float = Field(gt=10, le=200)
    sleeve_length_mm: float = Field(gt=20, le=2000)
    metal_volume_cm3: float = Field(gt=1, le=100000)


class IntensInput(BaseModel):
    p_intens_bar: float = Field(gt=1, le=2000)
    d_plunger_mm: float = Field(gt=5, le=200)
    a_proj_cm2: float = Field(gt=1, le=10000)
    f_clamp_kN: float = Field(gt=1, le=100000)


class ThermalInput(BaseModel):
    shot_weight_kg: float = Field(gt=0.001, le=100)
    t_pour_C: float = Field(gt=500, le=900)
    t_eject_C: float = Field(gt=20, le=700)
    water_flow_lmin: float = Field(gt=0.1, le=1000)
    t_water_in_C: float = Field(gt=0, le=100)


class CycleTimeInput(BaseModel):
    t_fill_ms: float = Field(gt=0.1, le=1000)
    t_intens_s: float = Field(ge=0, le=120)
    t_solid_s: float = Field(ge=0, le=120)
    t_open_s: float = Field(ge=0, le=60)
    t_eject_s: float = Field(ge=0, le=60)
    t_spray_s: float = Field(ge=0, le=60)
    t_close_s: float = Field(ge=0, le=60)
    t_ladle_s: float = Field(ge=0, le=60)


class PQ2Result(BaseModel):
    machine_line: List[dict]
    die_line: List[dict]
    intersection: dict
    gate_velocity_status: str
    recommendations: List[str]
    gate_area_mm2: float


class GateResult(BaseModel):
    area_mm2: float
    width_mm: float
    thickness_mm: float
    aspect_ratio: float
    recommendation: str


class FillTimeResult(BaseModel):
    t_min_ms: float
    t_max_ms: float
    t_optimal_ms: float
    basis: str


class ShotSleeveResult(BaseModel):
    fill_pct: float
    phase1_length_mm: float
    v1_min_ms: float
    v1_max_ms: float
    switchover_mm: float
    air_risk: str
    recommendation: str


class IntensResult(BaseModel):
    p_cavity_bar: float
    f_parting_kN: float
    safety_factor: float
    flash_risk: str
    recommendation: str


class ThermalResult(BaseModel):
    q_in_kJ: float
    q_water_kJ: float
    t_water_out_C: float
    balance_status: str
    delta_t_die: float


class CycleTimeResult(BaseModel):
    total_s: float
    parts_per_hour: float
    bottleneck_phase: str
    breakdown_list: List[dict]


class GeometryInput(BaseModel):
    part_type: str
    length_mm: float = Field(gt=10, le=5000)
    width_mm: float = Field(gt=10, le=5000)
    height_mm: float = Field(gt=5, le=3000)
    wall_thickness_mm: float = Field(gt=0.5, le=50)
    draft_angle_deg: float = Field(ge=0, le=15)
    n_cores: int = Field(ge=0, le=6)
    core_diameter_mm: float = Field(ge=0, le=500)
    alloy: str = "ADC12"


class GateConfigInput(BaseModel):
    gate_type: str
    gate_area_mm2: float = Field(gt=1, le=5000)
    part_length_mm: float = Field(gt=10, le=5000)
    part_width_mm: float = Field(gt=10, le=5000)


class ThermalMapInput(BaseModel):
    vertices: List[List[float]]
    gate_positions: List[dict]
    cooling_channel_positions: List[dict]
    wall_thicknesses: List[float]


class FillFramesInput(BaseModel):
    gate_positions: List[dict]
    part_bbox: dict
    fill_time_ms: float = Field(gt=1, le=1000)
    n_frames: int = Field(default=60, ge=10, le=240)


class PageStateModel(BaseModel):
    page: str


class AlloySelectionModel(BaseModel):
    alloy: str

    @field_validator("alloy")
    @classmethod
    def uppercase_alloy(cls, value: str) -> str:
        return value.upper()
