"""Porosity API routes."""

from fastapi import APIRouter
from fastapi.responses import Response

try:
    from ..core.calculations import run_evaluation
    from ..core.exporter import generate_pdf
    from ..core.models import EvalRequest
except ImportError:
    from core.calculations import run_evaluation
    from core.exporter import generate_pdf
    from core.models import EvalRequest

router = APIRouter(tags=["porosity"])


@router.post("/evaluate")
def evaluate(req: EvalRequest):
    """Run the existing VW50093 porosity evaluation engine."""
    return run_evaluation(req.pores, req.spec, req.wall_h_mm, req.exclusion_zones, req.datum_rect)


@router.post("/export-pdf")
def export_pdf(req: EvalRequest):
    """Export the current porosity evaluation report as PDF bytes."""
    pdf_bytes = generate_pdf(req.pores, req.spec, req.wall_h_mm, req.exclusion_zones, req.datum_rect)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": (
                f"attachment; filename=PVI_Report_{getattr(req.spec, 'pno', 'Part')}.pdf"
            )
        },
    )
