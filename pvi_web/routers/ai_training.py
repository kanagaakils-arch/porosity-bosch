"""AI Training routes — image submission, history, admin."""

from __future__ import annotations

import base64
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

router = APIRouter(tags=["ai-training"])

# ── Paths ────────────────────────────────────────────────────────────────────
BASE_DIR   = Path(__file__).resolve().parent.parent
DATA_DIR   = BASE_DIR / "data"
IMG_DIR    = DATA_DIR / "images"
LBL_DIR    = DATA_DIR / "labels"
MODEL_DIR  = DATA_DIR / "models"
DB_FILE    = DATA_DIR / "submissions.json"
STATUS_FILE = DATA_DIR / "train_status.json"
TRAIN_LOG   = DATA_DIR / "train.log"

for d in (IMG_DIR, LBL_DIR, MODEL_DIR):
    d.mkdir(parents=True, exist_ok=True)


def _normalize_record(r: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce any legacy key names to the canonical schema."""
    return {
        "id":         r.get("id", ""),
        "ts":         r.get("ts") or r.get("timestamp", ""),
        "submitter":  r.get("submitter") or r.get("submitted_by", "Unknown"),
        "notes":      r.get("notes", ""),
        "pore_count": r.get("pore_count") if r.get("pore_count") is not None
                      else r.get("porosity_count", 0),
        "img_file":   r.get("img_file") or r.get("filename", ""),
        "lbl_file":   r.get("lbl_file", ""),
    }


def _load_db() -> List[Dict[str, Any]]:
    if DB_FILE.exists():
        try:
            raw = json.loads(DB_FILE.read_text())
            return [_normalize_record(r) for r in raw]
        except Exception:
            pass
    return []


def _save_db(records: List[Dict[str, Any]]) -> None:
    DB_FILE.write_text(json.dumps(records, indent=2))


def _current_model_version() -> Optional[str]:
    models = sorted(MODEL_DIR.glob("*.onnx"))
    return models[-1].name if models else None


# ── Pydantic models ───────────────────────────────────────────────────────────
class Pore(BaseModel):
    x: float       # mm
    y: float       # mm
    dia: float     # mm


class SubmitRequest(BaseModel):
    submitter:    str
    notes:        Optional[str] = ""
    image_base64: str           # full data-URL or raw base64 PNG/JPEG
    pores:        List[Pore]    # approved pore detections
    image_width_mm:  float      # physical width of image in mm
    image_height_mm: float      # physical height of image in mm


# ── POST /api/ai/submit ───────────────────────────────────────────────────────
@router.post("/submit")
def submit_for_training(req: SubmitRequest):
    """Save image + YOLO labels from an approved inspection."""
    sid = str(uuid.uuid4())[:8]
    ts  = datetime.now(timezone.utc).isoformat()

    # Decode image
    raw = req.image_base64
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[1]
    img_bytes = base64.b64decode(raw)

    img_path = IMG_DIR / f"{sid}.jpg"
    img_path.write_bytes(img_bytes)

    # Generate YOLO label file (normalised x_c y_c w h — class 0 = pore)
    lbl_lines: List[str] = []
    for p in req.pores:
        x_c = p.x / req.image_width_mm
        y_c = p.y / req.image_height_mm
        w   = p.dia / req.image_width_mm
        h   = p.dia / req.image_height_mm
        # clamp to [0,1]
        x_c = max(0.0, min(1.0, x_c))
        y_c = max(0.0, min(1.0, y_c))
        w   = max(0.001, min(1.0, w))
        h   = max(0.001, min(1.0, h))
        lbl_lines.append(f"0 {x_c:.6f} {y_c:.6f} {w:.6f} {h:.6f}")

    lbl_path = LBL_DIR / f"{sid}.txt"
    lbl_path.write_text("\n".join(lbl_lines))

    # Persist record
    records = _load_db()
    records.append({
        "id":          sid,
        "ts":          ts,
        "submitter":   req.submitter.strip() or "Anonymous",
        "notes":       req.notes or "",
        "pore_count":  len(req.pores),
        "img_file":    img_path.name,
        "lbl_file":    lbl_path.name,
    })
    _save_db(records)

    return JSONResponse({"ok": True, "id": sid, "pore_count": len(req.pores)})


# ── GET /api/ai/history ───────────────────────────────────────────────────────
@router.get("/history")
def get_history():
    """Return all submission records (newest first)."""
    records = _load_db()
    return JSONResponse(list(reversed(records)))


# ── GET /api/ai/stats ─────────────────────────────────────────────────────────
@router.get("/stats")
def get_stats():
    """Summary stats for the admin panel — always returns valid JSON."""
    try:
        records = _load_db()
        by_user: Dict[str, int] = {}
        total_pores = 0
        for r in records:
            name = r.get("submitter") or "Unknown"
            by_user[name] = by_user.get(name, 0) + 1
            total_pores += int(r.get("pore_count") or 0)

        return JSONResponse({
            "total_submissions": len(records),
            "total_pores":       total_pores,
            "by_user":           by_user,
            "model_version":     _current_model_version() or "No model yet",
            "ready_to_train":    len(records) >= 20,
        })
    except Exception as exc:
        import traceback
        return JSONResponse(
            {"error": str(exc), "detail": traceback.format_exc()},
            status_code=500
        )


# ── DELETE /api/ai/submission/{sid} ──────────────────────────────────────────
@router.delete("/submission/{sid}")
def delete_submission(sid: str):
    """Delete a training sample (admin only)."""
    records = _load_db()
    new_records = [r for r in records if r["id"] != sid]
    if len(new_records) == len(records):
        return JSONResponse({"ok": False, "error": "Not found"}, status_code=404)

    # Remove files
    for ext, folder in [(".jpg", IMG_DIR), (".txt", LBL_DIR)]:
        p = folder / f"{sid}{ext}"
        if p.exists():
            p.unlink()

    _save_db(new_records)
    return JSONResponse({"ok": True})


# ── GET /api/ai/image/{sid} ───────────────────────────────────────────────────
@router.get("/image/{sid}")
def get_image(sid: str):
    """Serve a training image by its short ID."""
    p = IMG_DIR / f"{sid}.jpg"
    if not p.exists():
        return JSONResponse({"error": "Not found"}, status_code=404)
    return FileResponse(str(p), media_type="image/jpeg")


# ── GET /api/ai/train-status ──────────────────────────────────────────────────
@router.get("/train-status")
def get_train_status():
    """Return live training progress, ETA, and metrics."""
    if STATUS_FILE.exists():
        try:
            return JSONResponse(json.loads(STATUS_FILE.read_text()))
        except Exception:
            pass
    return JSONResponse({"status": "idle", "message": "No training in progress."})


# ── POST /api/ai/retrain ──────────────────────────────────────────────────────
@router.post("/retrain")
def trigger_retrain():
    """Launch train.py as a background process with real-time JSON status reporting."""
    import subprocess, sys
    records = _load_db()
    if len(records) < 20:
        return JSONResponse(
            {"ok": False, "error": f"Need at least 20 images. Have {len(records)}."},
            status_code=400
        )
    train_script = BASE_DIR / "train.py"
    if not train_script.exists():
        return JSONResponse(
            {"ok": False, "error": "train.py not found in project root."},
            status_code=404
        )
    try:
        # Initialize status file
        init_status = {
            "status": "training",
            "current_epoch": 0,
            "total_epochs": 25,
            "progress_pct": 1.0,
            "elapsed_sec": 0,
            "eta_sec": 45,
            "device": "Initializing Apple Metal GPU...",
            "message": f"🚀 Starting background training on {len(records)} images...",
            "metrics": {"precision": 0, "recall": 0, "mAP50": 0, "box_loss": 0},
            "history": []
        }
        STATUS_FILE.write_text(json.dumps(init_status, indent=2))

        log_f = open(TRAIN_LOG, "w")
        subprocess.Popen(
            [sys.executable, "-u", str(train_script)],
            cwd=str(BASE_DIR),
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )
        return JSONResponse({
            "ok": True,
            "message": f"Training started on {len(records)} images with Apple Metal GPU acceleration."
        })
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


# ── POST /api/ai/analyze ──────────────────────────────────────────────────────
class AnalyzeRequest(BaseModel):
    image_base64: str   # data-URL or raw base64


def _safe_json(obj):
    """Recursively convert numpy scalars to native Python types for JSON safety."""
    import numpy as np
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, dict):
        return {k: _safe_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_safe_json(v) for v in obj]
    return obj


@router.post("/analyze")
def analyze_image(req: AnalyzeRequest):
    """Run YOLOv8n ONNX inference on the uploaded image."""
    # Find latest ONNX model
    models = sorted(MODEL_DIR.glob("*.onnx"))
    if not models:
        return JSONResponse(
            {"ok": False, "error": "No trained model found. Upload images first, then retrain via Admin panel."},
            status_code=404
        )
    model_path = models[-1]

    # Decode image
    raw = req.image_base64
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        img_bytes = base64.b64decode(raw)
    except Exception:
        return JSONResponse({"ok": False, "error": "Invalid image data."}, status_code=400)

    try:
        import onnxruntime as ort
        import numpy as np
        import io
        from PIL import Image as PILImage

        pil_img = PILImage.open(io.BytesIO(img_bytes)).convert("RGB")
        orig_w, orig_h = int(pil_img.size[0]), int(pil_img.size[1])

        # Letterbox to 640x640
        scale  = min(640 / orig_w, 640 / orig_h)
        nw     = int(orig_w * scale)
        nh     = int(orig_h * scale)
        resized = pil_img.resize((nw, nh), PILImage.BILINEAR)
        padded  = PILImage.new("RGB", (640, 640), (114, 114, 114))
        pad_x   = (640 - nw) // 2
        pad_y   = (640 - nh) // 2
        padded.paste(resized, (pad_x, pad_y))

        arr = np.array(padded, dtype=np.float32) / 255.0
        arr = arr.transpose(2, 0, 1)[np.newaxis, ...]

        sess    = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        outputs = sess.run(None, {sess.get_inputs()[0].name: arr})
        pred    = outputs[0][0].T  # shape: (8400, 4 + num_classes)

        conf_thresh = 0.25
        boxes: list = []
        confs: list = []

        for row in pred:
            cls_conf = float(np.max(row[4:]))
            if cls_conf < conf_thresh:
                continue
            # Convert from padded-640 space to original image space
            x_c = float(row[0])
            y_c = float(row[1])
            w   = float(row[2])
            h   = float(row[3])
            x1 = max(0.0, (x_c - w / 2 - pad_x) / scale)
            y1 = max(0.0, (y_c - h / 2 - pad_y) / scale)
            x2 = min(float(orig_w), (x_c + w / 2 - pad_x) / scale)
            y2 = min(float(orig_h), (y_c + h / 2 - pad_y) / scale)
            if x2 > x1 and y2 > y1:
                boxes.append([x1, y1, x2, y2])
                confs.append(cls_conf)

        # Simple NMS
        def nms(bxs: list, cfs: list, iou_thr: float) -> list:
            if not bxs:
                return []
            order = sorted(range(len(cfs)), key=lambda i: -cfs[i])
            keep: List[int] = []
            while order:
                i = order.pop(0)
                keep.append(i)
                new_order = []
                for j in order:
                    b1, b2 = bxs[i], bxs[j]
                    inter = (max(0.0, min(b1[2], b2[2]) - max(b1[0], b2[0])) *
                             max(0.0, min(b1[3], b2[3]) - max(b1[1], b2[1])))
                    union = ((b1[2]-b1[0])*(b1[3]-b1[1]) +
                             (b2[2]-b2[0])*(b2[3]-b2[1]) - inter)
                    if inter / max(1e-6, union) < iou_thr:
                        new_order.append(j)
                order = new_order
            return keep

        keep = nms(boxes, confs, 0.45)

        # Build detections - ALL values explicitly cast to native Python float
        detections = sorted(
            [{"x1": round(boxes[i][0],1), "y1": round(boxes[i][1],1),
              "x2": round(boxes[i][2],1), "y2": round(boxes[i][3],1),
              "conf": round(confs[i], 4)} for i in keep],
            key=lambda d: -d["conf"]
        )
        return JSONResponse({
            "ok":            True,
            "detections":    detections,
            "model_version": model_path.name,
            "image_size":    f"{orig_w}\u00d7{orig_h}px",
        })

    except ImportError as e:
        pkg = str(e).split("'")[1] if "'" in str(e) else str(e)
        return JSONResponse({
            "ok":    False,
            "error": f"Missing: {pkg}. Run: pip install onnxruntime Pillow"
        }, status_code=500)
    except Exception as e:
        return JSONResponse({"ok": False, "error": f"Inference error: {e}"}, status_code=500)
