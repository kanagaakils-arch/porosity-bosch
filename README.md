# Bosch Porosity Inspector

Standalone Porosity Inspector package extracted from HPDC-CIP.

## Run

```bash
python3 launch.py
```

Then open:

```text
http://127.0.0.1:8000
```

Use another port if 8000 is busy:

```bash
python3 launch.py --port 8010
```

## Included

- Porosity Inspector UI
- VW50093 / ISO 10049 evaluation logic
- PDF export route
- Image upload, scaling, pore placement, auto-detect, verdict workflow

Defect Analysis, Process Calculator, and 3D Visualiser are not loaded in this standalone package.
