"""Porosity API routes."""

from fastapi import APIRouter
from fastapi.responses import Response

try:
    from ..core.calculations import run_evaluation
    from ..core.exporter import generate_pdf, generate_workspace_pdf
    from ..core.models import EvalRequest, WorkspaceExportRequest
except ImportError:
    from core.calculations import run_evaluation
    from core.exporter import generate_pdf, generate_workspace_pdf
    from core.models import EvalRequest, WorkspaceExportRequest

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


@router.post("/export-workspace-pdf")
def export_workspace_pdf(req: WorkspaceExportRequest):
    """Export the workspace (all spec tabs and their images) as a single ReportLab A4 PDF."""
    workspace_data = req.dict()["specs"]
    pdf_bytes = generate_workspace_pdf(workspace_data)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": "attachment; filename=PVI_Workspace_Report.pdf"
        },
    )

