import streamlit as st
import cv2
import numpy as np
import pandas as pd
import io
import math
from PIL import Image, ImageDraw, ImageFont
import plotly.graph_objects as go
from datetime import datetime

# Import existing core modules
from pvi_web.core.models import SpecModel, PoreModel
from pvi_web.core.calculations import run_evaluation
from pvi_web.core.exporter import generate_pdf

# Set page configuration
st.set_page_config(
    page_title="Bosch Porosity Inspector",
    page_icon="🔍",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Custom CSS for Premium Design Aesthetics
st.markdown("""
<style>
    /* Global Fonts & Styling */
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Inter:wght@300;400;500;600&display=swap');
    
    html, body, [class*="css"] {
        font-family: 'Inter', sans-serif;
    }
    
    .main-title {
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 700;
        background: linear-gradient(135deg, #38bdf8, #818cf8);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        margin-bottom: 2px;
        font-size: 2.2rem;
    }
    
    .subtitle {
        color: #94a3b8;
        font-size: 0.95rem;
        margin-bottom: 2rem;
    }
    
    /* Card Styles */
    .glass-card {
        background: rgba(30, 41, 59, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        padding: 20px;
        margin-bottom: 16px;
    }
    
    /* Verdict Badges */
    .verdict-box {
        text-align: center;
        padding: 24px;
        border-radius: 12px;
        margin-bottom: 20px;
        font-family: 'Space Grotesk', sans-serif;
        font-weight: 700;
        font-size: 2.5rem;
        letter-spacing: 1px;
    }
    .verdict-accept {
        background-color: rgba(16, 185, 129, 0.1);
        border: 2px solid #10b981;
        color: #10b981;
        box-shadow: 0 0 15px rgba(16, 185, 129, 0.15);
    }
    .verdict-reject {
        background-color: rgba(239, 68, 68, 0.1);
        border: 2px solid #ef4444;
        color: #ef4444;
        box-shadow: 0 0 15px rgba(239, 68, 68, 0.15);
    }
    
    /* Tables and list rows */
    .chk-table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 10px;
    }
    .chk-table th {
        background-color: rgba(15, 23, 42, 0.4);
        padding: 10px;
        text-align: left;
        font-size: 0.8rem;
        font-weight: 600;
        color: #94a3b8;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .chk-table td {
        padding: 12px 10px;
        font-size: 0.85rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .badge-pass {
        background-color: rgba(16, 185, 129, 0.12);
        color: #34d399;
        padding: 3px 8px;
        border-radius: 4px;
        font-weight: 600;
        font-size: 0.75rem;
        border: 1px solid rgba(16, 185, 129, 0.2);
    }
    .badge-fail {
        background-color: rgba(239, 68, 68, 0.12);
        color: #f87171;
        padding: 3px 8px;
        border-radius: 4px;
        font-weight: 600;
        font-size: 0.75rem;
        border: 1px solid rgba(239, 68, 68, 0.2);
    }
</style>
""", unsafe_allow_html=True)

# Initialize Session States
if 'pores' not in st.session_state:
    st.session_state.pores = []  # List of dicts: {'id': 1, 'x': 5.2, 'y': 2.1, 'dia': 1.24, 'type': 'gas', 'zone': 'hr'}
if 'image_bytes' not in st.session_state:
    st.session_state.image_bytes = None
if 'scale_px_mm' not in st.session_state:
    st.session_state.scale_px_mm = 50.0  # Default scale
if 'calibrated' not in st.session_state:
    st.session_state.calibrated = False

# ----------------- OpenCV Pore Detection Logic -----------------
def block_adaptive_otsu(gray, block_size, global_thr, sens):
    h, w = gray.shape
    pad_h = (block_size - h % block_size) % block_size
    pad_w = (block_size - w % block_size) % block_size
    
    padded = np.pad(gray, ((0, pad_h), (0, pad_w)), mode='edge')
    ph, pw = padded.shape
    pbin = np.zeros_like(padded)
    
    for by in range(0, ph, block_size):
        for bx in range(0, pw, block_size):
            tile = padded[by:by+block_size, bx:bx+block_size]
            
            # Local Otsu Threshold
            hist = np.bincount(tile.ravel(), minlength=256)
            total = tile.size
            sum_val = np.sum(np.arange(256) * hist)
            sum_b = 0
            w_b = 0
            max_var = 0
            thr = 128
            for t in range(256):
                w_b += hist[t]
                if w_b == 0:
                    continue
                w_f = total - w_b
                if w_f == 0:
                    break
                sum_b += t * hist[t]
                m_b = sum_b / w_b
                m_f = (sum_val - sum_b) / w_f
                var = w_b * w_f * (m_b - m_f) ** 2
                if var > max_var:
                    max_var = var
                    thr = t
            
            std = np.std(tile)
            contrast_weight = min(1.0, max(0.2, std / 28.0))
            uniform = std < 7.0
            
            base_thr = round((global_thr * 0.78 + thr * 0.22) if uniform else (thr * 0.72 + global_thr * 0.28))
            sens_offset = (sens - 50) * 0.42 * contrast_weight
            final_thr = max(15, min(235, round(base_thr + sens_offset)))
            
            pbin[by:by+block_size, bx:bx+block_size] = np.where(tile < final_thr, 255, 0)
            
    return pbin[0:h, 0:w]

def detect_pores_cv(img_np, scale_px_mm, sens, min_dia_mm, aspect_ratio_limit, blur_radius, close_size):
    gray = cv2.cvtColor(img_np, cv2.COLOR_BGR2GRAY)
    
    if blur_radius > 0:
        k_size = blur_radius * 2 + 1
        gray = cv2.GaussianBlur(gray, (k_size, k_size), 0)
        
    _, global_thr = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    
    # Run adaptive tile-based binarization
    binary = block_adaptive_otsu(gray, 32, global_thr, sens)
    
    # Morphological close (dilates then erodes to merge components)
    if close_size > 0:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_size * 2 + 1, close_size * 2 + 1))
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
        
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    detected_pores = []
    pore_id = 1
    
    for c in contours:
        area_px = cv2.contourArea(c)
        if area_px <= 0:
            continue
            
        dia_px = 2.0 * math.sqrt(area_px / math.pi)
        dia_mm = dia_px / scale_px_mm
        
        if dia_mm < min_dia_mm:
            continue
            
        # Centroid
        M = cv2.moments(c)
        if M["m00"] > 0:
            cx_px = M["m10"] / M["m00"]
            cy_px = M["m01"] / M["m00"]
        else:
            pts = c[:, 0, :]
            cx_px, cy_px = np.mean(pts, axis=0)
            
        # Aspect Ratio Filter
        if len(c) >= 5:
            ellipse = cv2.fitEllipse(c)
            minor, major = ellipse[1]
            aspect = major / max(minor, 0.001)
            if aspect > aspect_ratio_limit:
                continue
                
        x_mm = cx_px / scale_px_mm
        y_mm = cy_px / scale_px_mm
        
        detected_pores.append({
            'id': pore_id,
            'x': round(x_mm, 3),
            'y': round(y_mm, 3),
            'dia': round(dia_mm, 3),
            'type': 'gas',
            'zone': 'hr'  # Will be recalculated dynamically by evaluation engine
        })
        pore_id += 1
        
    return detected_pores

# ----------------- Streamlit UI Setup -----------------

# Sidebar Title
st.sidebar.markdown("<h2 style='font-family: Space Grotesk; font-weight:700;'>🔍 Bosch Porosity</h2>", unsafe_allow_html=True)
st.sidebar.markdown("<p style='color:#64748b; font-size:0.8rem; margin-top:-10px; margin-bottom:1.5rem;'>Porosity Validation Inspection</p>", unsafe_allow_html=True)

# Upload Image File
uploaded_file = st.sidebar.file_uploader("Upload Casting Section Image", type=["png", "jpg", "jpeg"])
if uploaded_file is not None:
    st.session_state.image_bytes = uploaded_file.read()

# Sidebar: Specification limits
st.sidebar.subheader("Drawing Specs (VW50093)")
pno = st.sidebar.text_input("Part Number", value="PART-001")
zone = st.sidebar.text_input("Zone / Feature", value="Zone A")
rev = st.sidebar.text_input("Revision", value="—")
insp = st.sidebar.text_input("Inspector", value="—")

pct_limit = st.sidebar.slider("Porosity Limit (%)", min_value=0.1, max_value=20.0, value=5.0, step=0.1)
phi_limit = st.sidebar.slider("Max Pore diameter Φ (mm)", min_value=0.1, max_value=10.0, value=1.5, step=0.05)
a_coeff = st.sidebar.slider("Spacing Coeff. A", min_value=1.0, max_value=5.0, value=2.0, step=0.1)
u_thresh = st.sidebar.slider("Ignore Threshold U (mm)", min_value=0.0, max_value=2.0, value=0.2, step=0.05)
wall_t_mm = st.sidebar.slider("Wall Thickness t (mm)", min_value=1.0, max_value=50.0, value=6.0, step=0.5)
datum_area = st.sidebar.number_input("Datum Area (mm²)", min_value=1.0, max_value=5000.0, value=100.0, step=10.0)

method = st.sidebar.selectbox("Inspection Method", ["visual", "section", "xray", "ct"], format_func=lambda x: {
    "visual": "Visual / Optical",
    "section": "Section Cut",
    "xray": "X-Ray / DR",
    "ct": "CT Scan 3D"
}[x])

st.sidebar.markdown("---")
st.sidebar.subheader("Allowable Group Grading")
col_s1, col_s2 = st.sidebar.columns(2)
h_limit = col_s1.selectbox("Allowable H", [0, 1])
n_limit = col_s2.selectbox("Allowable N", [0, 1])

col_s3, col_s4 = st.sidebar.columns(2)
hr_limit = col_s3.selectbox("Allowable HR", [0, 1, 2], index=0)
nr_limit = col_s4.selectbox("Allowable NR", [0, 1], index=0)

col_s5, col_s6 = st.sidebar.columns(2)
hk_limit = col_s5.selectbox("Allowable HK", [0, 1, 2], index=1)
nk_limit = col_s6.selectbox("Allowable NK", [0, 1], index=1)

# Build Spec dictionary matching SpecModel
spec_dict = {
    'pno': pno, 'zone': zone, 'rev': rev, 'insp': insp,
    'pct': pct_limit, 'phi': phi_limit, 'a': a_coeff, 'u': u_thresh,
    't': wall_t_mm, 'datum': datum_area, 'h': h_limit, 'n': n_limit,
    'hr': hr_limit, 'nr': nr_limit, 'hk': hk_limit, 'nk': nk_limit,
    'method': method
}

# Image Calibration Controls in Sidebar (if image exists)
if st.session_state.image_bytes:
    st.sidebar.markdown("---")
    st.sidebar.subheader("Image Scale Calibration")
    calib_mode = st.sidebar.selectbox("Calibration Method", ["Wall Height matches Thickness", "Manual Scale (pixels/mm)"])
    
    # Read Image size to calibrate
    img_pil = Image.open(io.BytesIO(st.session_state.image_bytes))
    img_w_px, img_h_px = img_pil.size
    
    if calib_mode == "Wall Height matches Thickness":
        st.session_state.scale_px_mm = img_h_px / wall_t_mm
        st.session_state.calibrated = True
        st.sidebar.info(f"Calibrated: Height of {img_h_px}px mapped to {wall_t_mm}mm")
    else:
        st.session_state.scale_px_mm = st.sidebar.number_input("Scale (pixels per mm)", min_value=1.0, max_value=500.0, value=st.session_state.scale_px_mm, step=1.0)
        st.session_state.calibrated = True
        
    st.sidebar.metric("Scale Factor", f"{st.session_state.scale_px_mm:.2f} px/mm")

# --- Main Dashboard Setup ---
st.markdown("<h1 class='main-title'>Bosch Porosity Inspector</h1>", unsafe_allow_html=True)
st.markdown("<p class='subtitle'>Industrial Quality Assessment for Casting Integrity (VW50093 / ISO 10049)</p>", unsafe_allow_html=True)

# Navigation Tabs
tab_dash, tab_cv, tab_map, tab_export = st.tabs([
    "📊 Compliance Dashboard", 
    "🎯 Pores & Auto-Detect", 
    "🗺️ Cross-Section Zone Map", 
    "📥 PDF Report Export"
])

# Run mathematical compliance check
spec_model = SpecModel(**spec_dict)
pore_models = [PoreModel(**p) for p in st.session_state.pores]
results = run_evaluation(pore_models, spec_model, wall_t_mm)

# ----------------- TAB 1: Compliance Dashboard -----------------
with tab_dash:
    col_v1, col_v2 = st.columns([1.2, 2.0])
    
    with col_v1:
        # Verdict Box
        if results['all_pass']:
            st.markdown("<div class='verdict-box verdict-accept'>ACCEPT</div>", unsafe_allow_html=True)
        else:
            st.markdown("<div class='verdict-box verdict-reject'>REJECT</div>", unsafe_allow_html=True)
            
        # Summary statistics
        st.markdown("<div class='glass-card'>", unsafe_allow_html=True)
        st.subheader("Summary Metrics")
        st.metric("Overall Porosity", f"{results['pct']:.3f} %", delta=f"Limit: {pct_limit}%", delta_color="inverse")
        st.metric("Maximum Pore Diameter Φ", f"{results['max_phi']:.3f} mm", delta=f"Limit: {phi_limit}mm", delta_color="inverse")
        st.metric("Total Pores (Effective / Total)", f"{results['eff_pores']} / {len(st.session_state.pores)}")
        st.markdown("</div>", unsafe_allow_html=True)
        
    with col_v2:
        # Visual Gauge (Plotly)
        st.markdown("<div class='glass-card'>", unsafe_allow_html=True)
        st.subheader("Porosity Percentage Gauge")
        
        max_gauge = max(pct_limit * 1.5, 5.0)
        fig = go.Figure(go.Indicator(
            mode = "gauge+number",
            value = results['pct'],
            domain = {'x': [0, 1], 'y': [0, 1]},
            title = {'text': "Calculated Porosity %", 'font': {'size': 18, 'family': 'Space Grotesk'}},
            gauge = {
                'axis': {'range': [None, max_gauge], 'tickwidth': 1, 'tickcolor': "#475569"},
                'bar': {'color': "#ef4444" if results['pct'] > pct_limit else "#10b981"},
                'bgcolor': "rgba(0,0,0,0.1)",
                'borderwidth': 2,
                'bordercolor': "#475569",
                'steps': [
                    {'range': [0, pct_limit * 0.8], 'color': 'rgba(16, 185, 129, 0.08)'},
                    {'range': [pct_limit * 0.8, pct_limit], 'color': 'rgba(245, 158, 11, 0.1)'},
                    {'range': [pct_limit, max_gauge], 'color': 'rgba(239, 68, 68, 0.08)'}
                ],
                'threshold': {
                    'line': {'color': "#f43f5e", 'width': 4},
                    'thickness': 0.75,
                    'value': pct_limit
                }
            }
        ))
        fig.update_layout(
            paper_bgcolor='rgba(0,0,0,0)',
            plot_bgcolor='rgba(0,0,0,0)',
            font={'color': "#f1f5f9", 'family': "Inter"},
            height=260,
            margin=dict(l=15, r=15, t=15, b=15)
        )
        st.plotly_chart(fig, use_container_width=True)
        st.markdown("</div>", unsafe_allow_html=True)
        
    # Compliance checks table
    st.subheader("Compliance Standard Checks (VW50093)")
    
    checks_html = """
    <table class='chk-table'>
        <thead>
            <tr>
                <th>Standard Parameter</th>
                <th>Measured Value</th>
                <th>Required Limit</th>
                <th>Status</th>
                <th>Detail & Explanation</th>
            </tr>
        </thead>
        <tbody>
    """
    
    for c in results['checks']:
        badge_cls = 'badge-pass' if c['pass'] else 'badge-fail'
        badge_txt = 'PASS' if c['pass'] else 'FAIL'
        
        checks_html += f"""
            <tr>
                <td style='font-weight:600; color:#f1f5f9;'>{c['n']}</td>
                <td style='font-family: monospace; font-size:0.9rem;'>{c['meas']}</td>
                <td style='color:#94a3b8;'>{c['limit']}</td>
                <td><span class='{badge_cls}'>{badge_txt}</span></td>
                <td style='color:#cbd5e1; font-size:0.8rem;'>{c['detail']}</td>
            </tr>
        """
        
    checks_html += "</tbody></table>"
    st.markdown(checks_html, unsafe_allow_html=True)

# ----------------- TAB 2: Pores & Auto-Detect -----------------
with tab_cv:
    if st.session_state.image_bytes is None:
        st.info("💡 Please upload a casting cross-section image in the sidebar to start.")
        
        # Fallback empty canvas option: create default empty pores list
        st.subheader("Or work with a virtual canvas:")
        if st.checkbox("Generate sample pores list without uploading image"):
            st.session_state.pores = [
                {'id': 1, 'x': 5.0, 'y': 1.5, 'dia': 1.12, 'type': 'gas', 'zone': 'hr'},
                {'id': 2, 'x': 10.0, 'y': 3.0, 'dia': 0.85, 'type': 'gas', 'zone': 'hk'},
                {'id': 3, 'x': 12.0, 'y': 2.8, 'dia': 0.72, 'type': 'shrink', 'zone': 'hk'},
                {'id': 4, 'x': 2.0, 'y': 4.5, 'dia': 1.62, 'type': 'gas', 'zone': 'hr'},
                {'id': 5, 'x': 8.5, 'y': 0.5, 'dia': 0.15, 'type': 'gas', 'zone': 'hr'},
            ]
            st.success("Loaded 5 sample pores. Switch back to 'Compliance Dashboard' to view calculations.")
    else:
        col_c1, col_c2 = st.columns([2.2, 1.8])
        
        # Load image once
        img_pil = Image.open(io.BytesIO(st.session_state.image_bytes))
        img_np = np.array(img_pil)
        
        with col_c2:
            st.subheader("Auto-Detection Parameters")
            preset = st.selectbox("Detection Preset", ["Custom", "Fine (Small pores)", "Balanced", "Coarse (Large voids)"])
            
            # Preset handler
            if preset == "Fine (Small pores)":
                sens = 58
                min_dia = 0.08
                aspect = 8.0
                blur = 0
                close = 1
            elif preset == "Balanced":
                sens = 50
                min_dia = 0.12
                aspect = 6.0
                blur = 1
                close = 2
            elif preset == "Coarse (Large voids)":
                sens = 42
                min_dia = 0.25
                aspect = 5.0
                blur = 2
                close = 3
            else:
                # Custom sliders
                col_sl1, col_sl2 = st.columns(2)
                sens = col_sl1.slider("Sensitivity (Threshold)", min_value=10, max_value=90, value=50, step=2)
                min_dia = col_sl2.slider("Min Diameter (mm)", min_value=0.02, max_value=2.0, value=0.1, step=0.02)
                
                col_sl3, col_sl4 = st.columns(2)
                aspect = col_sl3.slider("Aspect Ratio Limit", min_value=2.0, max_value=15.0, value=6.0, step=0.5)
                blur = col_sl4.slider("Gaussian Noise Blur", min_value=0, max_value=4, value=1, step=1)
                close = st.slider("Morphological Close size (dilation/erosion)", min_value=0, max_value=6, value=2, step=1)
                
            if st.button("🚀 Run Auto-Detect Pores", use_container_width=True):
                with st.spinner("Processing computer vision pipeline..."):
                    detected = detect_pores_cv(
                        img_np, 
                        st.session_state.scale_px_mm, 
                        sens, 
                        min_dia, 
                        aspect, 
                        blur, 
                        close
                    )
                    st.session_state.pores = detected
                    st.success(f"Successfully auto-detected {len(detected)} pores!")
                    st.rerun()
                    
            st.markdown("---")
            st.subheader("Pores Table Editor")
            st.caption("You can directly edit, add, or delete pores below. Measurements are in physical millimeters (mm).")
            
            # Map pores list to dataframe
            df_pores = pd.DataFrame(st.session_state.pores)
            if df_pores.empty:
                df_pores = pd.DataFrame(columns=['id', 'x', 'y', 'dia', 'type'])
            else:
                # Clean up columns for UI
                df_pores = df_pores[['id', 'x', 'y', 'dia', 'type']]
                
            # Render interactive table
            edited_df = st.data_editor(
                df_pores, 
                num_rows="dynamic",
                use_container_width=True,
                column_config={
                    "id": st.column_config.NumberColumn("ID", disabled=True),
                    "x": st.column_config.NumberColumn("X (mm)", format="%.3f"),
                    "y": st.column_config.NumberColumn("Y (mm)", format="%.3f"),
                    "dia": st.column_config.NumberColumn("Diameter (mm)", format="%.3f"),
                    "type": st.column_config.SelectboxColumn("Type", options=["gas", "shrink"])
                }
            )
            
            # Save back to session state on change
            if not edited_df.equals(df_pores):
                new_pores = []
                for idx, row in edited_df.iterrows():
                    # Handle nan values
                    if pd.isna(row['x']) or pd.isna(row['y']) or pd.isna(row['dia']):
                        continue
                    new_pores.append({
                        'id': int(row['id']) if not pd.isna(row['id']) else len(new_pores)+1,
                        'x': float(row['x']),
                        'y': float(row['y']),
                        'dia': float(row['dia']),
                        'type': str(row['type']) if row['type'] in ["gas", "shrink"] else 'gas',
                        'zone': 'hr'  # recalculated
                    })
                st.session_state.pores = new_pores
                st.rerun()

        with col_c1:
            st.subheader("Casting Image & Pore Overlay")
            
            # Draw overlay on image
            annotated_img = img_pil.copy().convert("RGBA")
            overlay = Image.new("RGBA", annotated_img.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(overlay)
            
            scale = st.session_state.scale_px_mm
            
            # Draw HK / HR division lines
            line_y1 = (wall_t_mm / 3.0) * scale
            line_y2 = (2.0 * wall_t_mm / 3.0) * scale
            
            # Dotted lines
            for x_dot in range(0, annotated_img.width, 10):
                draw.line([(x_dot, line_y1), (x_dot+5, line_y1)], fill=(241, 245, 249, 130), width=2)
                draw.line([(x_dot, line_y2), (x_dot+5, line_y2)], fill=(241, 245, 249, 130), width=2)
                
            # Draw pores
            for p in results['updated_pores']:
                cx = p['x'] * scale
                cy = p['y'] * scale
                r = (p['dia'] / 2.0) * scale
                
                ign = u_thresh > 0 and p['dia'] < u_thresh
                fail = not ign and p['dia'] > phi_limit
                
                if ign:
                    color = (170, 170, 170, 80)      # Gray
                    stroke = (170, 170, 170, 255)
                elif fail:
                    color = (239, 68, 68, 80)        # Red fill
                    stroke = (239, 68, 68, 255)
                elif p['zone'] == 'hk':
                    color = (119, 64, 238, 70)       # Purple
                    stroke = (119, 64, 238, 255)
                else:
                    color = (204, 136, 0, 80)        # Orange (HR)
                    stroke = (204, 136, 0, 255)
                    
                # Draw Circle
                draw.ellipse([cx-r, cy-r, cx+r, cy-r+p['dia']*scale], fill=color, outline=stroke, width=2)
                
                # Draw outer ring for failed pores
                if fail:
                    draw.ellipse([cx-r-4, cy-r-4, cx+r+4, cy-r+p['dia']*scale+4], fill=None, outline=(239, 68, 68, 140), width=1)
                
                # Add ID text
                if r >= 8:
                    draw.text((cx - 3, cy - 6), str(p['id']), fill=(255, 255, 255, 255), font=None)
                    
            # Combine image and overlay
            combined = Image.alpha_composite(annotated_img, overlay)
            st.image(combined, use_container_width=True)
            
            # Color Legend
            col_l1, col_l2, col_l3, col_l4 = st.columns(4)
            col_l1.markdown("🟠 **HR Outer Zone**")
            col_l2.markdown("🟣 **HK Central Zone**")
            col_l3.markdown("🔴 **Exceeds Φ Limit**")
            col_l4.markdown("⚪ **Ignored (< U)**")

# ----------------- TAB 3: Cross-Section Zone Map -----------------
with tab_map:
    st.subheader("Standard Compliance Cross-Section Zone Map")
    st.markdown("VW50093 divides the wall cross section into outer thirds (**HR**) and a central third (**HK**).")
    
    # We will generate a Plotly drawing representing the cross section mapping
    fig_map = go.Figure()
    
    w_h = wall_t_mm
    # Find bounding box of pores in X
    x_max = max((p['x'] for p in results['updated_pores']), default=10.0)
    w_w = max(x_max * 1.25, 20.0)
    
    # Add HR/HK Background bands
    # Top HR
    fig_map.add_shape(type="rect", x0=0, y0=0, x1=w_w, y1=w_h/3.0,
                      fillcolor="rgba(245, 158, 11, 0.08)", line_width=0)
    # Middle HK
    fig_map.add_shape(type="rect", x0=0, y0=w_h/3.0, x1=w_w, y1=2*w_h/3.0,
                      fillcolor="rgba(124, 58, 237, 0.07)", line_width=0)
    # Bottom HR
    fig_map.add_shape(type="rect", x0=0, y0=2*w_h/3.0, x1=w_w, y1=w_h,
                      fillcolor="rgba(245, 158, 11, 0.08)", line_width=0)
                      
    # Boundary lines
    fig_map.add_shape(type="line", x0=0, y0=w_h/3.0, x1=w_w, y1=w_h/3.0,
                      line=dict(color="#cbd5e1", width=1.5, dash="dash"))
    fig_map.add_shape(type="line", x0=0, y0=2*w_h/3.0, x1=w_w, y1=2*w_h/3.0,
                      line=dict(color="#cbd5e1", width=1.5, dash="dash"))
                      
    # Plot pores as scatter markers with variable sizes
    px_vals = [p['x'] for p in results['updated_pores']]
    py_vals = [p['y'] for p in results['updated_pores']]
    pdia_vals = [p['dia'] for p in results['updated_pores']]
    pids = [f"ID {p['id']}: Φ{p['dia']:.2f}mm" for p in results['updated_pores']]
    
    colors_list = []
    for p in results['updated_pores']:
        ign = u_thresh > 0 and p['dia'] < u_thresh
        fail = not ign and p['dia'] > phi_limit
        if ign:
            colors_list.append("#94a3b8")
        elif fail:
            colors_list.append("#f87171")
        elif p['zone'] == 'hk':
            colors_list.append("#a78bfa")
        else:
            colors_list.append("#fbbf24")
            
    fig_map.add_trace(go.Scatter(
        x=px_vals,
        y=py_vals,
        mode='markers+text',
        text=[str(p['id']) for p in results['updated_pores']],
        textposition="top center",
        hoverinfo='text',
        hovertext=pids,
        marker=dict(
            size=[d * 12 for d in pdia_vals],  # scale diameter for visualization
            color=colors_list,
            line=dict(width=1.5, color="#1e293b")
        )
    ))
    
    # Layout adjustments
    fig_map.update_layout(
        xaxis=dict(title="Width coordinate X (mm)", range=[0, w_w], gridcolor="rgba(255,255,255,0.05)"),
        yaxis=dict(title="Depth coordinate Y (mm) (Top to Bottom)", range=[w_h, 0], gridcolor="rgba(255,255,255,0.05)"), # Inverted Y
        paper_bgcolor='rgba(0,0,0,0)',
        plot_bgcolor='rgba(0,0,0,0)',
        font={'color': "#f1f5f9", 'family': "Inter"},
        height=380,
        margin=dict(l=40, r=40, t=10, b=40),
        showlegend=False
    )
    
    st.plotly_chart(fig_map, use_container_width=True)
    
    # Instructions/Legend
    st.info("💡 Vertical bands represent depth zones: orange edges are **HR (Outer 1/3)**, purple center is **HK (Central 1/3)**. Circles indicate pores sized proportionally to physical diameter.")

# ----------------- TAB 4: PDF Report Export -----------------
with tab_export:
    st.subheader("Generate & Download PDF Audit Report")
    st.markdown("You can export the official porosity check audit report complying with industrial standards. The report includes identification, calculated parameters, validation results, and a graphical cross-section zone diagram.")
    
    # Compile final specs and pores to pass to ReportLab generator
    if len(st.session_state.pores) == 0:
        st.warning("⚠️ No pores are currently defined. The report will have no pore listings.")
        
    # PDF generation trigger
    pdf_bytes = generate_pdf(st.session_state.pores, spec_dict, wall_t_mm)
    
    # Format date string for filename
    dt_str = datetime.now().strftime("%Y%m%d_%H%M")
    filename = f"PVI_Report_{pno.replace(' ', '_')}_{dt_str}.pdf"
    
    st.markdown("<br>", unsafe_allow_html=True)
    
    st.download_button(
        label="📥 Download Official A4 PDF Report",
        data=pdf_bytes,
        file_name=filename,
        mime="application/pdf",
        use_container_width=True
    )
    
    st.success("Report bytes compiled successfully. Click the button above to download the PDF.")
