# Bosch Porosity Inspector

Standalone Porosity Inspector package extracted from HPDC-CIP. Features compliance checking against the **VW 50093** and **ISO 10049** porosity validation standards.

The tool provides two user interfaces:
1. **Interactive Streamlit Interface** (Pure Python & Plotly-powered dashboard)
2. **Standard Web Interface** (FastAPI backend + HTML5 Canvas frontend)

---

## Installation & Setup

1. **Install Python 3** (version 3.9+ is recommended).
2. **Install all dependencies** from the root `requirements.txt`:

```bash
pip3 install -r requirements.txt
```

*(Note: On macOS with system-managed environments, you may need to use `pip3 install -r requirements.txt --break-system-packages` if not running inside a virtual environment).*

---

## Running the Application

Use the unified launcher script `launch.py` to start either interface:

### 1. Launching the Streamlit App (Recommended)
This runs the fully native Python-based dashboard with integrated block-adaptive Otsu thresholding, interactive pore data editor, active standard band maps, and PDF export.

```bash
python3 launch.py --streamlit
```

Then open:
```text
http://127.0.0.1:8000
```

---

### 2. Launching the Standard Web App
This runs the original FastAPI server with the highly detailed HTML5 canvas interface.

```bash
python3 launch.py
```

Then open:
```text
http://127.0.0.1:8000
```

---

### Useful Launcher Options

- Change the server port (e.g. if `8000` is already in use):
  ```bash
  python3 launch.py --port 8010
  # Or for streamlit
  python3 launch.py --streamlit --port 8010
  ```
- Start the server without automatically launching your default web browser:
  ```bash
  python3 launch.py --no-browser
  ```

---

## Included Features

- **Pore Calibration**: Custom pixel-to-millimeter ratio calibration tool.
- **Auto-Detection**: Advanced computer-vision adaptive thresholding algorithms.
- **VW50093 / ISO 10049 Compliance Core**: Fully implements the evaluation checks including:
  - Total Porosity %
  - Maximum Pore Diameter ($\Phi$) Limit
  - Looseness group distance checks ($A \times \Phi$)
  - Clustering density checks ($N$ limit)
  - Split band analyses for the outer 1/3 (HR/NR zones) and central 1/3 (HK/NK zones).
- **PDF Report Exporter**: Download official inspection summary reports containing interactive charts, specs, and a compliant pass/fail checklist.
