// ═══════════════════════════════════════════════════════════════════════════
// PVI MEASUREMENT ENGINE — Deep Upgrade
// Provides: Angle, Ruler, Area Lasso, Caliper, Reference Lines
//           Pore Metrics (Circularity, Aspect Ratio, Roundness, Convexity…)
//           Measurement Annotations List with inline edit/delete/colour
//           Extended Pore Types: micro, oxide, cold_shut, manual
// ═══════════════════════════════════════════════════════════════════════════

// ── Pore colour + display name map (extended) ────────────────────────────────
window.PORE_META = {
  gas:       { fill:'rgba(0,120,200,0.7)',   stroke:'#0099cc',  label:'Gas',        icon:'🔵' },
  shrink:    { fill:'rgba(160,100,40,0.7)',  stroke:'#a06428',  label:'Shrinkage',  icon:'🟤' },
  micro:     { fill:'rgba(0,190,100,0.72)', stroke:'#00be64',  label:'Micro',      icon:'🟢' },
  oxide:     { fill:'rgba(220,80,220,0.72)',stroke:'#c040c0',  label:'Oxide',      icon:'🟣' },
  cold_shut: { fill:'rgba(255,160,0,0.75)', stroke:'#ff9900',  label:'Cold Shut',  icon:'🟠' },
  manual:    { fill:'rgba(120,120,120,0.65)',stroke:'#888888', label:'Manual',     icon:'⚪' },
};

function getPoreColorFill(p) {
  const m = window.PORE_META[p.type || 'gas'];
  if (!m) return 'rgba(0,120,200,0.7)';
  // Zone tint override
  if (p.zone === 'hr') return m.fill.replace(/[\d.]+(?=\))/, '0.78');
  if (p.zone === 'hk') return m.fill.replace('200,', '100,').replace('0.7', '0.74');
  return m.fill;
}
window.getPoreColorFill = getPoreColorFill;

function getPoreColorStroke(p) {
  return (window.PORE_META[p.type || 'gas'] || window.PORE_META.gas).stroke;
}
window.getPoreColorStroke = getPoreColorStroke;

// ── Measurement Annotations State ───────────────────────────────────────────
window.MEAS_ANNOTS = [];   // [{id, type, label, color, pts, locked, hidden, result}]
let _measNextId = 1;
let _measActiveTool = null; // 'angle' | 'ruler' | 'lasso' | 'caliper' | 'refline'
let _measPts = [];          // in-progress click points (canvas mm coords)
let _measMouseMm = null;    // current mouse position in mm
let _showMeasLabels = true;
let _snapToPore = false;

// ── Tool activation helpers ──────────────────────────────────────────────────
window.activateMeasureTool = function(toolName) {
  _measActiveTool = toolName;
  _measPts = [];
  _measMouseMm = null;

  // Update button states in the MEASURE toolbar group
  ['angle','ruler','lasso','caliper','refline'].forEach(t => {
    const btn = document.getElementById('meas-tool-' + t);
    if (btn) btn.classList.toggle('on', t === toolName);
  });

  // Delegate to setTool to update cursor, hint, and clear existing measure state
  if (typeof setTool === 'function') setTool('meas_custom');

  const hints = {
    angle:   '∠ Angle: click 3 points — vertex, arm1 end, arm2 end',
    ruler:   '📏 Ruler: click points for a chain path · double-click or press Enter to finish',
    lasso:   '⬡ Lasso Area: click polygon vertices · double-click or press Enter to close',
    caliper: '⊙ Caliper: click two points on a pore edge to measure diameter',
    refline: '— Ref Line: click to place a horizontal (H) or vertical (V) guide — hold Shift to toggle',
  };
  const hintEl = document.getElementById('canvas-hint');
  if (hintEl) hintEl.textContent = hints[toolName] || '';
  const wrap = document.getElementById('canvas-wrap');
  if (wrap) wrap.style.cursor = 'crosshair';
};

window.cancelMeasureTool = function() {
  _measActiveTool = null;
  _measPts = [];
  _measMouseMm = null;
  ['angle','ruler','lasso','caliper','refline'].forEach(t => {
    const btn = document.getElementById('meas-tool-' + t);
    if (btn) btn.classList.remove('on');
  });
  if (typeof drawCanvas === 'function') drawCanvas();
  _renderMeasList();
};

// ── Canvas click handler for measure tools ───────────────────────────────────
window.handleMeasToolClick = function(mm, dblClick, shiftKey) {
  if (!_measActiveTool) return false;

  // Snap to nearest pore edge if snap enabled
  let pt = snapPoint(mm);

  if (_measActiveTool === 'refline') {
    const orient = shiftKey ? 'V' : 'H';
    _commitAnnot({
      type: 'refline',
      label: (orient === 'H' ? 'H Ref ' : 'V Ref ') + _measNextId,
      color: '#f59e0b',
      pts: [{ ...pt }],
      orient,
      result: { orient, pos: orient === 'H' ? pt.y : pt.x }
    });
    return true;
  }

  _measPts.push({ ...pt });

  if (_measActiveTool === 'angle' && _measPts.length === 3) {
    _finishAngle();
    return true;
  }
  if (_measActiveTool === 'caliper' && _measPts.length === 2) {
    _finishCaliper();
    return true;
  }
  if ((_measActiveTool === 'ruler' || _measActiveTool === 'lasso') && dblClick && _measPts.length >= 2) {
    _measPts.pop(); // remove the duplicate from dblclick
    if (_measActiveTool === 'ruler') _finishRuler();
    else _finishLasso();
    return true;
  }
  if (typeof drawCanvas === 'function') drawCanvas();
  return true;
};

// Keyboard finish for ruler / lasso
window.handleMeasToolKey = function(key) {
  if (!_measActiveTool) return false;
  if (key === 'Enter' && _measPts.length >= 2) {
    if (_measActiveTool === 'ruler') { _finishRuler(); return true; }
    if (_measActiveTool === 'lasso') { _finishLasso(); return true; }
  }
  if (key === 'Escape') { cancelMeasureTool(); return true; }
  return false;
};

window.handleMeasToolMouseMove = function(mm) {
  _measMouseMm = mm;
};

// ── Snap logic ───────────────────────────────────────────────────────────────
function snapPoint(mm) {
  if (!_snapToPore) return mm;
  const pores = (typeof AP === 'function') ? AP() : [];
  let best = null, bestDist = 999;
  const snapRadiusMm = 1.5;
  pores.forEach(p => {
    const r = p.dia / 2;
    const dx = mm.x - p.x, dy = mm.y - p.y;
    const dist = Math.hypot(dx, dy);
    const edgeDist = Math.abs(dist - r);
    if (edgeDist < snapRadiusMm && edgeDist < bestDist) {
      bestDist = edgeDist;
      // project onto edge
      const ang = Math.atan2(dy, dx);
      best = { x: p.x + r * Math.cos(ang), y: p.y + r * Math.sin(ang) };
    }
  });
  return best || mm;
}

// ── Finish helpers ───────────────────────────────────────────────────────────
function _finishAngle() {
  const [v, a1, a2] = _measPts;
  const ang1 = Math.atan2(a1.y - v.y, a1.x - v.x);
  const ang2 = Math.atan2(a2.y - v.y, a2.x - v.x);
  let deg = Math.abs(((ang1 - ang2) * 180 / Math.PI + 360)) % 360;
  if (deg > 180) deg = 360 - deg;
  _commitAnnot({
    type: 'angle',
    label: '∠ ' + deg.toFixed(1) + '°',
    color: '#a78bfa',
    pts: [..._measPts],
    result: { deg: +deg.toFixed(2) }
  });
}

function _finishRuler() {
  let total = 0;
  for (let i = 0; i < _measPts.length - 1; i++) {
    total += Math.hypot(_measPts[i+1].x - _measPts[i].x, _measPts[i+1].y - _measPts[i].y);
  }
  _commitAnnot({
    type: 'ruler',
    label: '📏 ' + total.toFixed(3) + ' mm',
    color: '#34d399',
    pts: [..._measPts],
    result: { length: +total.toFixed(4), segments: _measPts.length - 1 }
  });
}

function _finishLasso() {
  // Shoelace area
  const pts = _measPts;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  area = Math.abs(area) / 2;
  _commitAnnot({
    type: 'lasso',
    label: '⬡ ' + area.toFixed(3) + ' mm²',
    color: '#fb923c',
    pts: [..._measPts],
    result: { area: +area.toFixed(4) }
  });
}

function _finishCaliper() {
  const [p1, p2] = _measPts;
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  _commitAnnot({
    type: 'caliper',
    label: '⊙ Ø ' + dist.toFixed(3) + ' mm',
    color: '#22d3ee',
    pts: [..._measPts],
    result: { diameter: +dist.toFixed(4) }
  });
}

function _commitAnnot(obj) {
  const annot = { id: _measNextId++, locked: false, hidden: false, ...obj };
  window.MEAS_ANNOTS.push(annot);
  _measPts = [];
  _measActiveTool = null;
  ['angle','ruler','lasso','caliper','refline'].forEach(t => {
    const btn = document.getElementById('meas-tool-' + t);
    if (btn) btn.classList.remove('on');
  });
  if (typeof drawCanvas === 'function') drawCanvas();
  _renderMeasList();
  _updateMeasHUD();
}

// ── Draw measurement annotations on canvas ───────────────────────────────────
window.drawMeasAnnotations = function(ctx) {
  if (!ctx) return;
  ctx.save();

  // Draw committed annotations
  window.MEAS_ANNOTS.forEach(a => {
    if (a.hidden) return;
    ctx.save();
    ctx.strokeStyle = a.color || '#fff';
    ctx.fillStyle = a.color || '#fff';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([]);

    if (a.type === 'ruler') {
      _drawPolyline(ctx, a.pts, a.color, false);
      if (_showMeasLabels) _drawMidLabel(ctx, a.pts, a.label, a.color);
    }
    else if (a.type === 'lasso') {
      _drawPolyline(ctx, a.pts, a.color, true);
      const cx = a.pts.reduce((s,p)=>s+p.x,0)/a.pts.length;
      const cy = a.pts.reduce((s,p)=>s+p.y,0)/a.pts.length;
      if (_showMeasLabels) _drawLabel(ctx, cx, cy, a.label, a.color);
    }
    else if (a.type === 'angle') {
      _drawAngle(ctx, a.pts, a.label, a.color);
    }
    else if (a.type === 'caliper') {
      _drawCaliper(ctx, a.pts, a.label, a.color);
    }
    else if (a.type === 'refline') {
      _drawRefLine(ctx, a, a.color);
    }
    ctx.restore();
  });

  // Draw in-progress annotation
  if (_measActiveTool && _measPts.length > 0) {
    ctx.save();
    const inProgressColor = '#ffffff';
    ctx.strokeStyle = inProgressColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);

    const allPts = _measMouseMm ? [..._measPts, _measMouseMm] : _measPts;

    if (_measActiveTool === 'refline' && _measMouseMm) {
      // Just show crosshair
    } else {
      _drawPolyline(ctx, allPts, inProgressColor, _measActiveTool === 'lasso');
    }
    // Draw click points
    _measPts.forEach(pt => {
      if (typeof mmToCanvas === 'function') {
        const c = mmToCanvas(pt.x, pt.y);
        ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = inProgressColor; ctx.fill();
      }
    });
    ctx.restore();
  }

  // Draw reference lines (full canvas-span)
  window.MEAS_ANNOTS.filter(a => a.type === 'refline' && !a.hidden).forEach(a => {
    _drawRefLine(ctx, a, a.color);
  });

  ctx.restore();
};

function _canvPt(mm) {
  if (typeof mmToCanvas === 'function') return mmToCanvas(mm.x, mm.y);
  return { x: mm.x, y: mm.y };
}

function _drawPolyline(ctx, pts, color, close) {
  if (pts.length < 2) return;
  ctx.beginPath();
  const c0 = _canvPt(pts[0]); ctx.moveTo(c0.x, c0.y);
  for (let i = 1; i < pts.length; i++) {
    const ci = _canvPt(pts[i]); ctx.lineTo(ci.x, ci.y);
  }
  if (close) ctx.closePath();
  ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
  if (close) { ctx.fillStyle = color.replace('1)', '0.08)').replace(')', ',0.08)'); ctx.fill(); }
  // Vertex dots
  pts.forEach(p => {
    const c = _canvPt(p);
    ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();
  });
}

function _drawMidLabel(ctx, pts, label, color) {
  if (pts.length < 2) return;
  const mid = Math.floor(pts.length / 2);
  const cx = (pts[mid-1].x + pts[mid].x) / 2;
  const cy = (pts[mid-1].y + pts[mid].y) / 2;
  _drawLabel(ctx, cx, cy, label, color);
}

function _drawLabel(ctx, mx, my, label, color) {
  const c = _canvPt({ x: mx, y: my });
  ctx.save();
  ctx.font = 'bold 10px Space Grotesk, system-ui';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.beginPath(); ctx.roundRect(c.x - tw/2 - 5, c.y - 22, tw + 10, 16, 3); ctx.fill();
  ctx.fillStyle = color || '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, c.x, c.y - 14);
  ctx.restore();
}

function _drawAngle(ctx, pts, label, color) {
  if (pts.length < 3) {
    _drawPolyline(ctx, pts, color, false);
    return;
  }
  const [v, a1, a2] = pts.map(p => _canvPt(p));
  ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(v.x, v.y); ctx.lineTo(a2.x, a2.y);
  ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
  // Arc
  const r = 18;
  const ang1 = Math.atan2(a1.y - v.y, a1.x - v.x);
  const ang2 = Math.atan2(a2.y - v.y, a2.x - v.x);
  ctx.beginPath(); ctx.arc(v.x, v.y, r, Math.min(ang1,ang2), Math.max(ang1,ang2));
  ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
  // Label at vertex
  if (_showMeasLabels) _drawLabel(ctx, pts[0].x, pts[0].y, label, color);
  // Dots
  [v, a1, a2].forEach(c => {
    ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI*2);
    ctx.fillStyle = color; ctx.fill();
  });
}

function _drawCaliper(ctx, pts, label, color) {
  if (pts.length < 2) { _drawPolyline(ctx, pts, color, false); return; }
  const [c1, c2] = pts.map(p => _canvPt(p));
  // Main line
  ctx.beginPath(); ctx.moveTo(c1.x, c1.y); ctx.lineTo(c2.x, c2.y);
  ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.stroke();
  // Perpendicular ticks at ends
  const ang = Math.atan2(c2.y - c1.y, c2.x - c1.x) + Math.PI / 2;
  const tk = 7;
  [c1, c2].forEach(c => {
    ctx.beginPath();
    ctx.moveTo(c.x + Math.cos(ang)*tk, c.y + Math.sin(ang)*tk);
    ctx.lineTo(c.x - Math.cos(ang)*tk, c.y - Math.sin(ang)*tk);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  });
  if (_showMeasLabels) {
    const mx = (pts[0].x + pts[1].x)/2, my = (pts[0].y + pts[1].y)/2;
    _drawLabel(ctx, mx, my, label, color);
  }
}

function _drawRefLine(ctx, a, color) {
  const MC = document.getElementById('main-canvas');
  if (!MC) return;
  const W = MC.offsetWidth || 800, H = MC.offsetHeight || 600;
  const isH = a.orient === 'H';
  const c = typeof mmToCanvas === 'function' ? mmToCanvas(a.pts[0].x, a.pts[0].y) : { x: a.pts[0].x, y: a.pts[0].y };
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
  ctx.beginPath();
  if (isH) { ctx.moveTo(0, c.y); ctx.lineTo(W, c.y); }
  else      { ctx.moveTo(c.x, 0); ctx.lineTo(c.x, H); }
  ctx.stroke();
  ctx.setLineDash([]);
  if (_showMeasLabels) {
    const lbl = (isH ? 'H' : 'V') + ' ' + (isH ? a.pts[0].y : a.pts[0].x).toFixed(2) + ' mm';
    ctx.font = '9px Space Grotesk, system-ui';
    ctx.fillStyle = color;
    ctx.fillText(lbl, isH ? 4 : c.x + 4, isH ? c.y - 4 : 12);
  }
  ctx.restore();
}

// ── Measurements HUD update ──────────────────────────────────────────────────
function _updateMeasHUD() {
  const hud = document.getElementById('meas-hud');
  if (!hud) return;
  if (window.MEAS_ANNOTS.length === 0) {
    hud.style.display = 'none';
    return;
  }
  hud.style.display = 'flex';
  hud.innerHTML = window.MEAS_ANNOTS.map(a => `
    <span class="meas-hud-item" onclick="highlightAnnot(${a.id})" title="${a.label}">
      <span style="color:${a.color};font-weight:700">${a.label}</span>
    </span>
  `).join('<span style="color:rgba(255,255,255,.2);margin:0 4px">|</span>');
}

// ── Measurements List Panel ──────────────────────────────────────────────────
function _renderMeasList() {
  const container = document.getElementById('meas-list-panel');
  if (!container) return;
  if (window.MEAS_ANNOTS.length === 0) {
    container.innerHTML = '<div style="font-size:10px;color:var(--dim);text-align:center;padding:16px">No measurements yet.<br>Use MEASURE tools in the toolbar.</div>';
    return;
  }
  container.innerHTML = window.MEAS_ANNOTS.map(a => `
    <div class="meas-list-item ${a.hidden ? 'meas-hidden' : ''}" id="meas-item-${a.id}">
      <div style="display:flex;align-items:center;gap:5px;flex:1;min-width:0">
        <div class="meas-color-dot" style="background:${a.color};flex-shrink:0" onclick="cycleMeasColor(${a.id})"></div>
        <input class="meas-label-input" value="${_esc(a.label)}" onchange="renameMeasAnnot(${a.id}, this.value)" style="background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,.12);color:var(--tx);font-size:10px;width:100%;outline:none" />
      </div>
      <div style="display:flex;align-items:center;gap:3px;flex-shrink:0">
        <span style="font-size:9px;color:${a.color};font-weight:700;background:rgba(255,255,255,.06);padding:1px 5px;border-radius:3px">${_measResultLabel(a)}</span>
        <button class="meas-btn" title="${a.hidden?'Show':'Hide'}" onclick="toggleMeasHidden(${a.id})">${a.hidden ? '👁' : '👁'}</button>
        <button class="meas-btn meas-btn-del" title="Delete" onclick="deleteMeasAnnot(${a.id})">✕</button>
      </div>
    </div>
  `).join('');
}

function _measResultLabel(a) {
  if (!a.result) return '';
  if (a.result.deg !== undefined) return a.result.deg.toFixed(1) + '°';
  if (a.result.length !== undefined) return a.result.length.toFixed(3) + ' mm';
  if (a.result.area !== undefined) return a.result.area.toFixed(3) + ' mm²';
  if (a.result.diameter !== undefined) return 'Ø' + a.result.diameter.toFixed(3) + ' mm';
  if (a.result.orient !== undefined) return (a.result.orient === 'H' ? 'y=' : 'x=') + (a.result.pos || 0).toFixed(2) + ' mm';
  return '';
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

window.renameMeasAnnot = function(id, val) {
  const a = window.MEAS_ANNOTS.find(x => x.id === id);
  if (a) { a.label = val; drawCanvas && drawCanvas(); _updateMeasHUD(); }
};

window.toggleMeasHidden = function(id) {
  const a = window.MEAS_ANNOTS.find(x => x.id === id);
  if (a) { a.hidden = !a.hidden; _renderMeasList(); drawCanvas && drawCanvas(); }
};

window.deleteMeasAnnot = function(id) {
  window.MEAS_ANNOTS = window.MEAS_ANNOTS.filter(x => x.id !== id);
  _renderMeasList(); drawCanvas && drawCanvas(); _updateMeasHUD();
};

window.clearAllMeasAnnots = function() {
  window.MEAS_ANNOTS = [];
  _measPts = []; _measActiveTool = null;
  _renderMeasList(); drawCanvas && drawCanvas(); _updateMeasHUD();
};

const MEAS_COLORS = ['#22d3ee','#a78bfa','#34d399','#fb923c','#f59e0b','#f87171','#60a5fa','#ffffff'];
let _measColorIdx = {};
window.cycleMeasColor = function(id) {
  const a = window.MEAS_ANNOTS.find(x => x.id === id);
  if (!a) return;
  _measColorIdx[id] = ((_measColorIdx[id] || 0) + 1) % MEAS_COLORS.length;
  a.color = MEAS_COLORS[_measColorIdx[id]];
  _renderMeasList(); drawCanvas && drawCanvas();
};

window.highlightAnnot = function(id) {
  const el = document.getElementById('meas-item-' + id);
  if (el) { el.classList.add('meas-highlight'); setTimeout(() => el.classList.remove('meas-highlight'), 900); }
  if (typeof switchRegTab === 'function') switchRegTab('measurements');
};

window.toggleMeasLabels = function() {
  _showMeasLabels = !_showMeasLabels;
  const btn = document.getElementById('meas-labels-toggle');
  if (btn) btn.classList.toggle('on', _showMeasLabels);
  if (typeof drawCanvas === 'function') drawCanvas();
};

window.toggleSnapToPore = function() {
  _snapToPore = !_snapToPore;
  const btn = document.getElementById('meas-snap-toggle');
  if (btn) btn.classList.toggle('on', _snapToPore);
};

// ── Export measurements to CSV ───────────────────────────────────────────────
window.exportMeasCSV = function() {
  const rows = [['ID','Type','Label','Color','Result','Points']];
  window.MEAS_ANNOTS.forEach(a => {
    rows.push([
      a.id, a.type, a.label, a.color,
      JSON.stringify(a.result),
      a.pts.map(p => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`).join(' → ')
    ]);
  });
  const csv = rows.map(r => r.map(c => '"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = 'pvi_measurements_' + Date.now() + '.csv';
  a.click(); URL.revokeObjectURL(url);
};

// ── Per-Pore Extended Metrics (JS computation) ───────────────────────────────
window.computePoreMetrics = function(p) {
  const r = p.dia / 2;
  const area = Math.PI * r * r;
  const fmax = (p.max_length || p._maxLength || p.dia);
  let perim, fmin, circ, ar, roundness, convexity;

  const contourPts = _getPoreContourMm(p);
  if (contourPts && contourPts.length >= 3) {
    perim = _polygonPerim(contourPts);
    const polyArea = _shoelaceArea(contourPts);
    fmin = _feretMin(contourPts);
    circ = perim > 0 ? (4 * Math.PI * polyArea) / (perim * perim) : 1.0;
    ar = fmin > 0 ? fmax / fmin : 1.0;
    roundness = fmax > 0 ? (4 * polyArea) / (Math.PI * fmax * fmax) : 1.0;
    const hullA = _bboxEllipseArea(contourPts);
    convexity = hullA > 0 ? Math.min(1, polyArea / hullA) : 1.0;
  } else {
    perim = 2 * Math.PI * r;
    fmin = p.dia;
    circ = 1.0;
    ar = fmax > 0 ? fmax / fmin : 1.0;
    roundness = 1.0;
    convexity = 1.0;
  }

  // Nearest neighbor
  const pores = (typeof AP === 'function') ? AP() : [];
  let nn = null;
  pores.forEach(q => {
    if (q.id === p.id) return;
    const d = Math.hypot(q.x - p.x, q.y - p.y) - p.dia/2 - q.dia/2;
    if (nn === null || d < nn) nn = d;
  });

  return {
    dia: p.dia,
    fmax: +fmax.toFixed(4),
    fmin: +fmin.toFixed(4),
    area: +area.toFixed(4),
    perim: +perim.toFixed(4),
    circ: +Math.max(0, Math.min(1, circ)).toFixed(4),
    ar: +ar.toFixed(3),
    roundness: +Math.max(0, Math.min(1, roundness)).toFixed(4),
    convexity: +Math.max(0, Math.min(1, convexity)).toFixed(4),
    nn: nn !== null ? +nn.toFixed(4) : null,
    zone: p.zone,
    x: p.x, y: p.y
  };
};

function _getPoreContourMm(p) {
  if (p._polyVerts) {
    return p._polyVerts.map(v => ({ x: v.x, y: v.y }));
  }
  if (p._contour && p._contour.length >= 4) {
    return p._contour.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy }));
  }
  // Circle fallback — 24 pts
  const r = p.dia / 2, N = 24;
  return Array.from({length:N}, (_, i) => ({
    x: p.x + r * Math.cos(2 * Math.PI * i / N),
    y: p.y + r * Math.sin(2 * Math.PI * i / N)
  }));
}

function _polygonPerim(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    s += Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
  }
  return s;
}

function _shoelaceArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y;
    a -= pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}

function _feretMin(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

function _bboxEllipseArea(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  return Math.max(Math.PI * (w/2) * (h/2), 1e-9);
}

// ── Metrics panel renderer ───────────────────────────────────────────────────
window.renderPoreMetricsPanel = function(poreId) {
  const panel = document.getElementById('pore-metrics-panel');
  if (!panel) return;
  const pores = (typeof AP === 'function') ? AP() : [];
  const p = pores.find(q => q.id === poreId);
  if (!p) { panel.style.display = 'none'; return; }

  panel.style.display = 'block';
  const m = window.computePoreMetrics(p);
  const meta = window.PORE_META[p.type || 'gas'] || window.PORE_META.gas;

  const bar = (val, max, color) => {
    const pct = Math.min(100, Math.max(0, (val/max)*100));
    return `<div style="height:3px;background:rgba(255,255,255,.1);border-radius:2px;margin-top:2px"><div style="width:${pct.toFixed(1)}%;height:100%;background:${color};border-radius:2px"></div></div>`;
  };
  const row = (lbl, val, unit='', hint='', color='var(--tx)', barMax=0) => `
    <div style="display:grid;grid-template-columns:100px 1fr;gap:4px;align-items:start;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04)">
      <span style="font-size:9px;color:var(--dim)" title="${hint}">${lbl}</span>
      <span style="font-size:10px;font-weight:700;color:${color};font-family:monospace">${val}${unit}</span>
      ${barMax > 0 ? `<span></span>${bar(parseFloat(val), barMax, color)}` : ''}
    </div>`;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
      <div style="width:10px;height:10px;border-radius:50%;background:${meta.fill};border:1.5px solid ${meta.stroke}"></div>
      <span style="font-size:10px;font-weight:800;color:var(--tx)">Pore #${poreId} — ${meta.label}</span>
      <span style="margin-left:auto;font-size:9px;color:var(--dim)">${p.zone.toUpperCase()}</span>
    </div>
    ${row('Equiv. Φ', p.dia.toFixed(3), ' mm', 'Equivalent circle diameter (calibrated)', 'var(--blu)')}
    ${row('Feret Max ↔', m.fmax.toFixed(3), ' mm', 'Longest calliper dimension (max length)', '#0ea5e9')}
    ${row('Feret Min ↕', m.fmin.toFixed(3), ' mm', 'Shortest calliper dimension', '#38bdf8')}
    ${row('Area', m.area.toFixed(4), ' mm²', 'Equivalent circle area', 'var(--tx)')}
    ${row('Perimeter', m.perim.toFixed(4), ' mm', 'Estimated polygon perimeter', 'var(--tx)')}
    <div style="height:4px"></div>
    ${row('Circularity', m.circ.toFixed(3), '', '4π·A/P² — 1.0 = perfect circle · <0.5 = very elongated', m.circ > 0.7 ? 'var(--g)' : m.circ > 0.4 ? 'var(--amb)' : 'var(--red)', 1)}
    ${row('Aspect Ratio', m.ar.toFixed(2), ':1', 'Feret Max / Feret Min — 1=circle · higher=elongated', m.ar <= 1.5 ? 'var(--g)' : m.ar <= 3 ? 'var(--amb)' : 'var(--red)')}
    ${row('Roundness', m.roundness.toFixed(3), '', '4·A/(π·Major²) — 1.0 = perfect', m.roundness > 0.7 ? 'var(--g)' : 'var(--amb)', 1)}
    ${row('Convexity', m.convexity.toFixed(3), '', 'Area / hull area — 1.0 = convex · lower = complex/branched', m.convexity > 0.85 ? 'var(--g)' : 'var(--amb)', 1)}
    <div style="height:4px"></div>
    ${row('Position X', m.x.toFixed(3), ' mm', 'Centroid X from image left edge', 'var(--dim)')}
    ${row('Position Y', m.y.toFixed(3), ' mm', 'Centroid Y (depth from Surface A)', 'var(--dim)')}
    ${m.nn !== null ? row('Nearest Pore', m.nn.toFixed(3), ' mm', 'Edge-to-edge distance to closest pore', m.nn >= 0 ? 'var(--tx)' : 'var(--red)') : ''}
  `;
};

// ── Wire canvas events ────────────────────────────────────────────────────────
// Called from app.js bindCanvasEvents() / handleCanvasClick() sections
window._measHandleClick = function(mm, evt) {
  if (!_measActiveTool) return false;
  const dbl = evt && evt.detail >= 2;
  return window.handleMeasToolClick(mm, dbl, evt && evt.shiftKey);
};

window._measHandleMouseMove = function(mm) {
  window.handleMeasToolMouseMove(mm);
};

window._measHandleKey = function(key, ctrl, shift) {
  if (ctrl && key === 'z') { undoMeas(); return true; }
  if (ctrl && (key === 'y' || (shift && key === 'z'))) { redoMeas(); return true; }
  return window.handleMeasToolKey(key);
};

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  _renderMeasList();
  _updateMeasHUD();
});


// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 1: HEAT MAP OVERLAY
// ═══════════════════════════════════════════════════════════════════════════════

let _heatMapEnabled = false;
let _heatMapOpacity = 0.55;

window.toggleHeatMap = function() {
  _heatMapEnabled = !_heatMapEnabled;
  const btn = document.getElementById('btn-heatmap');
  if (btn) btn.classList.toggle('on', _heatMapEnabled);
  const slider = document.getElementById('heatmap-opacity');
  if (slider) slider.style.display = _heatMapEnabled ? 'inline-block' : 'none';
  if (typeof drawCanvas === 'function') drawCanvas();
};

window.setHeatMapOpacity = function(val) {
  _heatMapOpacity = parseFloat(val) / 100;
  if (typeof drawCanvas === 'function') drawCanvas();
};

window.renderHeatMap = function(ctx, pores) {
  if (!_heatMapEnabled || !pores || pores.length === 0) return;
  const MC = document.getElementById('main-canvas');
  if (!MC) return;
  const W = MC.offsetWidth || 800, H = MC.offsetHeight || 600;

  // Offscreen canvas for heat accumulation
  const off = document.createElement('canvas');
  off.width = Math.round(W); off.height = Math.round(H);
  const octx = off.getContext('2d');

  // Build heat layer — each pore contributes a radial gradient weighted by dia²
  pores.forEach(p => {
    const c = (typeof mmToCanvas === 'function') ? mmToCanvas(p.x, p.y) : { x: p.x, y: p.y };
    const drawScale = (typeof S !== 'undefined' && S.imgMode && S.imgState && S.imgState.scalePxPerMm)
      ? S.imgState.scalePxPerMm
      : (typeof S !== 'undefined' ? S.cv.scale : 40);
    const r = Math.max(16, p.dia * drawScale * 2.5); // influence radius
    const weight = Math.min(1, p.dia * p.dia / 4);   // larger pores = hotter

    const grad = octx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
    grad.addColorStop(0,    `rgba(255,30,0,${(0.28 * weight).toFixed(3)})`);
    grad.addColorStop(0.25, `rgba(255,160,0,${(0.20 * weight).toFixed(3)})`);
    grad.addColorStop(0.55, `rgba(80,180,255,${(0.12 * weight).toFixed(3)})`);
    grad.addColorStop(1,    'rgba(0,0,0,0)');

    octx.beginPath();
    octx.arc(c.x, c.y, r, 0, Math.PI * 2);
    octx.fillStyle = grad;
    octx.fill();
  });

  // Composite onto main canvas at controlled opacity
  ctx.save();
  ctx.globalAlpha = _heatMapOpacity;
  ctx.drawImage(off, 0, 0);
  ctx.globalAlpha = 1;

  // Colour-scale legend (bottom-right)
  const lx = W - 90, ly = H - 50;
  const lgrd = ctx.createLinearGradient(lx, 0, lx + 70, 0);
  lgrd.addColorStop(0,   'rgba(80,180,255,0.9)');
  lgrd.addColorStop(0.5, 'rgba(255,160,0,0.9)');
  lgrd.addColorStop(1,   'rgba(255,30,0,0.9)');
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath(); ctx.roundRect(lx - 6, ly - 16, 84, 34, 4); ctx.fill();
  ctx.fillStyle = lgrd;
  ctx.fillRect(lx, ly, 70, 8);
  ctx.font = '8px Space Grotesk, system-ui';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'left';  ctx.fillText('Low',  lx,     ly - 4);
  ctx.textAlign = 'right'; ctx.fillText('High', lx + 70, ly - 4);
  ctx.textAlign = 'start';
  ctx.restore();
};


// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 2: UNDO / REDO FOR MEASUREMENT ANNOTATIONS
// ═══════════════════════════════════════════════════════════════════════════════

const MEAS_HISTORY  = [];  // stack of snapshot arrays
const MEAS_REDO_STK = [];
const MEAS_MAX_HIST = 25;

function _snapMeas() {
  return JSON.parse(JSON.stringify(window.MEAS_ANNOTS));
}

// Call this BEFORE every mutating operation
window.pushMeasHistory = function() {
  MEAS_HISTORY.push(_snapMeas());
  MEAS_REDO_STK.length = 0; // clear redo on new action
  if (MEAS_HISTORY.length > MEAS_MAX_HIST) MEAS_HISTORY.shift();
  _syncMeasUndoButtons();
};

function undoMeas() {
  if (MEAS_HISTORY.length === 0) return;
  MEAS_REDO_STK.push(_snapMeas());
  window.MEAS_ANNOTS = MEAS_HISTORY.pop();
  _renderMeasList(); _updateMeasHUD();
  if (typeof drawCanvas === 'function') drawCanvas();
  _syncMeasUndoButtons();
}

function redoMeas() {
  if (MEAS_REDO_STK.length === 0) return;
  MEAS_HISTORY.push(_snapMeas());
  window.MEAS_ANNOTS = MEAS_REDO_STK.pop();
  _renderMeasList(); _updateMeasHUD();
  if (typeof drawCanvas === 'function') drawCanvas();
  _syncMeasUndoButtons();
}

function _syncMeasUndoButtons() {
  const btnU = document.getElementById('meas-undo-btn');
  const btnR = document.getElementById('meas-redo-btn');
  if (btnU) btnU.disabled = MEAS_HISTORY.length === 0;
  if (btnR) btnR.disabled = MEAS_REDO_STK.length === 0;
}

window.undoMeas = undoMeas;
window.redoMeas = redoMeas;

// Patch _commitAnnot to push history before each commit
const _origCommitAnnot = window._measCommitAnnotRef || null;
// Wrap the internal commit function to auto-push history
const _origWrapRef = window.clearAllMeasAnnots;
window.clearAllMeasAnnots = function() {
  window.pushMeasHistory();
  window.MEAS_ANNOTS = [];
  _measPts = []; _measActiveTool = null;
  _renderMeasList(); drawCanvas && drawCanvas(); _updateMeasHUD();
};
window.deleteMeasAnnot = function(id) {
  window.pushMeasHistory();
  window.MEAS_ANNOTS = window.MEAS_ANNOTS.filter(x => x.id !== id);
  _renderMeasList(); drawCanvas && drawCanvas(); _updateMeasHUD();
};


// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 5 HELPERS: REPORT EXPORT DATA
// ═══════════════════════════════════════════════════════════════════════════════

window.getMeasAnnotsForReport = function() {
  return window.MEAS_ANNOTS.map(a => ({
    id:     a.id,
    type:   a.type,
    label:  a.label,
    result: a.result,
    pts:    a.pts,
    color:  a.color,
  }));
};

window.getPoreMetricsForReport = function(pores) {
  return (pores || []).map(p => {
    const m = window.computePoreMetrics ? window.computePoreMetrics(p) : {};
    const meta = (window.PORE_META || {})[p.type || 'gas'] || { label: p.type || 'gas' };
    return {
      id:          p.id,
      dia:         p.dia,
      fmax:        m.fmax   || p.dia,
      fmin:        m.fmin   || p.dia,
      area:        m.area   || (Math.PI * (p.dia/2) ** 2),
      circularity: m.circ   || 1,
      aspect_ratio:m.ar     || 1,
      roundness:   m.roundness || 1,
      convexity:   m.convexity || 1,
      zone:        p.zone   || '—',
      type:        meta.label,
      x:           p.x,
      y:           p.y,
      nn:          m.nn,
    };
  });
};

