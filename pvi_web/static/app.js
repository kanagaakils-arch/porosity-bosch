// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
const HPDC_STATE = {
  partNo: null, zone: null, specPhi: null, specPct: null,
  lastVerdict: null, wallThickness: null,
  gateArea: null, fillTime: null, partVolume: null, gateVelocity: null, machineType: null,
  partDimensions: null, alloyType: 'ADC12',
  set(key, value, source){
    this[key] = value;
    this._showToast(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value} — shared from ${source}`);
    localStorage.setItem('hpdc_state', JSON.stringify(this._serialise()));
  },
  _serialise(){
    return {
      partNo:this.partNo, zone:this.zone, specPhi:this.specPhi, specPct:this.specPct,
      lastVerdict:this.lastVerdict, wallThickness:this.wallThickness,
      gateArea:this.gateArea, fillTime:this.fillTime, partVolume:this.partVolume,
      gateVelocity:this.gateVelocity, machineType:this.machineType,
      partDimensions:this.partDimensions, alloyType:this.alloyType
    };
  },
  _showToast(msg){
    const n=document.createElement('div');
    n.className='hpdc-toast';
    n.textContent=msg;
    document.body.appendChild(n);
    setTimeout(()=>n.remove(),3000);
  },
  load(){
    const saved=localStorage.getItem('hpdc_state');
    if(saved){
      try{ Object.assign(this, JSON.parse(saved)); }catch(_err){}
    }
  }
};
HPDC_STATE.load();

const S = {
  spec: { pno:'', zone:'', rev:'', insp:'', pct:5, phi:1.5, a:2, u:0.2, t:6, datum:100,
          h:0, n:0, hr:0, nr:0, hk:1, nk:1, method:'visual', specSaved:false,
          phi_gas:null, phi_shrink:null, pct_gas:null, pct_shrink:null },
  pores: [],           // draw-mode pore objects {id,x,y,dia,type,zone}
  imgPores: [],        // image-mode pore objects (independent list)
  selectedId: null,
  history: [],
  redoHistory: [],
  nextPhi: 1.0,
  poreType: 'gas',
  tool: 'select',      // place | select | measure | datum
  measurePt1: null,
  datumRect: null,     // {x,y,w,h} in mm (wall-relative)
  // Canvas state
  cv: { scale: 50, panX: 0, panY: 0, W: 0, H: 0,
        wallTop: 0,  // px from canvas top (base, before pan)
        wallH:   0,  // px
        wallW:   0,  // px
        wallL:   0,  // px left margin (base, before pan)
        originX: 0,  // pan offset X px
        originY: 0,  // pan offset Y px
  },
  evaluated: false,
  verdict: null,
  // Image mode
  imgMode: true,
  imgState: {
    image: null,          // HTMLImageElement
    scalePxPerMm: null,   // calibrated px/mm
    calibPts: [],         // [{x,y}] canvas-relative
    calibrating: false,
    brightness: 100,
    contrast: 100,
    imgX: 0, imgY: 0,
    imgW: 0, imgH: 0,
    fitScale: 1,
    imgTool: null,        // 'scale_line'|'crop'|null
    scaleLine: null,      // {x1,y1,x2,y2}
    scaleRect: null,      // {x,y,w,h}
    scaleDrawing: false,
    cropRect: null,       // {x,y,w,h}
    cropDrawing: false,
    imgOffsetX: 0,
    imgOffsetY: 0,
    imgDragging: false,
    offscreen: null,      // cached filtered image canvas
    cacheValid: false     // true = offscreen is current
  }
};

const SCALE_BASE = 50; // px per mm at zoom=1

// ── Status bar scale display helper ──────────────────────────────────────────
function _updateScaleDisplay(){
  const el = document.getElementById('sb-scale');
  const banner = document.getElementById('scale-warn-banner');
  if(S.imgMode && S.imgState.scalePxPerMm){
    // Image mode + scale calibrated ✓
    const mmPerPx = (1/S.imgState.scalePxPerMm).toFixed(4);
    if(el){ el.textContent = S.imgState.scalePxPerMm.toFixed(2) + ' px/mm · ' + mmPerPx + ' mm/px'; el.style.color = 'var(--g)'; el.title = 'Calibrated — draw a new scale line to recalibrate'; }
    if(banner) banner.classList.remove('show'); // Hide warning when scale is set
  } else if(S.imgMode && S.imgState.image){
    // Image loaded but NOT yet calibrated — show the warning banner
    if(el){ el.textContent = '⚠ Scale not set'; el.style.color = 'var(--red)'; el.title = 'Set scale before measuring'; }
    if(banner) banner.classList.add('show');
  } else if(S.imgMode){
    // Image mode, no image yet
    if(el){ el.textContent = '— upload image'; el.style.color = 'var(--dim)'; el.title = ''; }
    if(banner) banner.classList.remove('show');
  } else {
    // Manual draw mode
    if(el){ el.textContent = S.cv.scale.toFixed(0) + ' px/mm'; el.style.color = 'var(--dim)'; el.title = 'Canvas scale (manual mode)'; }
    if(banner) banner.classList.remove('show');
  }
}

function makeImageState(){
  return {
    image: null, scalePxPerMm: null, calibPts: [], calibrating: false,
    brightness: 100, contrast: 100, imgX: 0, imgY: 0, imgW: 0, imgH: 0,
    fitScale: 1, imgTool: null, scaleLine: null, scaleRect: null,
    scaleDrawing: false, cropRect: null, cropDrawing: false,
    imgOffsetX: 0, imgOffsetY: 0, imgDragging: false,
    offscreen: null, cacheValid: false, autoDetected: false
  };
}

function cloneSpec(spec){
  return JSON.parse(JSON.stringify(spec || S.spec));
}

function makeImagePage(index){
  return {
    id: 'img-'+Date.now()+'-'+Math.random().toString(16).slice(2),
    name: 'Image '+index,
    pores: [],
    imgState: makeImageState(),
    history: [],
    redoHistory: [],
    evaluated: false,
    verdict: null,
    datumRect: null,         // per-image datum zone — never shared across tabs
    imgOffsetMm: 0           // mm offset from Surface A for cropped images
  };
}

function makeSpecTab(index, baseSpec){
  return {
    id: 'spec-'+Date.now()+'-'+Math.random().toString(16).slice(2),
    name: 'Spec '+index,
    spec: cloneSpec(baseSpec || S.spec),
    drawPores: [],
    images: [makeImagePage(1)],
    activeImage: 0,
    evaluated: false,
    verdict: null
  };
}

const Workspace = {
  specs: [makeSpecTab(1, S.spec)],
  activeSpec: 0
};
Workspace.specs[0].spec = S.spec;
Workspace.specs[0].drawPores = S.pores;
Workspace.specs[0].images[0].pores = S.imgPores;
Workspace.specs[0].images[0].imgState = S.imgState;
Workspace.specs[0].images[0].history = S.history;
Workspace.specs[0].images[0].redoHistory = S.redoHistory;
Workspace.specs[0].images[0].datumRect = S.datumRect;  // sync initial datum

function activeSpecTab(){ return Workspace.specs[Workspace.activeSpec]; }
function activeImagePage(){ const tab=activeSpecTab(); return tab.images[tab.activeImage]; }

function bindActiveWorkspace(){
  const tab=activeSpecTab();
  const page=activeImagePage();
  S.spec = tab.spec;
  S.pores = tab.drawPores;
  S.imgPores = page.pores;
  S.imgState = page.imgState;
  S.history = page.history;
  S.redoHistory = page.redoHistory;
  S.evaluated = S.imgMode ? page.evaluated : tab.evaluated;
  S.verdict = S.imgMode ? page.verdict : tab.verdict;
  // Restore per-image datum — prevents cross-tab leakage
  S.datumRect = (page.datumRect !== undefined) ? page.datumRect : null;
}

function persistActiveResults(){
  const tab=activeSpecTab();
  const page=activeImagePage();
  tab.evaluated = S.imgMode ? tab.evaluated : S.evaluated;
  tab.verdict = S.imgMode ? tab.verdict : S.verdict;
  page.evaluated = S.imgMode ? S.evaluated : page.evaluated;
  page.verdict = S.imgMode ? S.verdict : page.verdict;
  // Save datum per image-page so it is never shared across spec tabs or image tabs
  page.datumRect = S.datumRect || null;
}

function setToggleValue(gid, value){
  const group=document.getElementById(gid);
  if(!group) return;
  group.querySelectorAll('.tgl-opt').forEach((o,i)=>o.classList.toggle('on',i===value));
  TV[gid]=value;
}

function loadSpecIntoForm(){
  const s=S.spec;
  const fields=['pno','zone','rev','insp','pct','phi','a','u','t','datum'];
  fields.forEach(f=>{ const el=document.getElementById('sp-'+f); if(el) el.value=s[f] ?? ''; });
  // Type-specific limits
  const gs=document.getElementById('sp-phi-gas');    if(gs) gs.value = s.phi_gas    != null ? s.phi_gas    : '';
  const ss=document.getElementById('sp-phi-shrink'); if(ss) ss.value = s.phi_shrink != null ? s.phi_shrink : '';
  const gp=document.getElementById('sp-pct-gas');    if(gp) gp.value = s.pct_gas    != null ? s.pct_gas    : '';
  const sp2=document.getElementById('sp-pct-shrink'); if(sp2) sp2.value = s.pct_shrink != null ? s.pct_shrink : '';
  setToggleValue('tg-h', s.h||0); setToggleValue('tg-n', s.n||0);
  setToggleValue('tg-hr', s.hr||0); setToggleValue('tg-nr', s.nr||0);
  setToggleValue('tg-hk', s.hk||0); setToggleValue('tg-nk', s.nk||0);
  setMethod(s.method || 'visual_machined');
  _syncZoneToggleUI();
}

function loadSpecIntoSidebar(){
  const s=S.spec;
  const set=(id,val)=>{ const el=document.getElementById(id); if(el) el.value=val ?? ''; };
  set('side-sp-pno',s.pno);
  set('side-sp-zone',s.zone);
  set('side-sp-pct',s.pct);
  set('side-sp-phi',s.phi);
  set('side-sp-a',s.a);
  set('side-sp-u',s.u);
  set('side-sp-t',s.t);
  set('side-sp-datum',s.datum);
  set('side-sp-hn',`${s.h||0}/${s.n||0}`);
  set('side-sp-zones',`${s.hr||0}/${s.nr||0} ${s.hk||0}/${s.nk||0}`);
}

function parsePair(text, fallbackA=0, fallbackB=0){
  const nums=String(text||'').match(/\d+/g);
  return [nums&&nums[0]!==undefined?+nums[0]:fallbackA, nums&&nums[1]!==undefined?+nums[1]:fallbackB];
}

function applySideSpecDetails(){
  const s=S.spec;
  const val=id=>document.getElementById(id)?.value;
  s.pno=val('side-sp-pno')||'';
  s.zone=val('side-sp-zone')||'';
  s.pct=+val('side-sp-pct')||5;
  s.phi=+val('side-sp-phi')||1.5;
  s.a=+val('side-sp-a')||2;
  s.u=+val('side-sp-u')||0;
  s.t=+val('side-sp-t')||6;
  if(val('side-sp-datum') !== undefined) s.datum = +val('side-sp-datum') || 100;
  const hn=parsePair(val('side-sp-hn'),s.h||0,s.n||0);
  const zones=String(val('side-sp-zones')||'').match(/\d+/g)||[];
  s.h=hn[0]; s.n=hn[1];
  s.hr=zones[0]!==undefined?+zones[0]:(s.hr||0);
  s.nr=zones[1]!==undefined?+zones[1]:(s.nr||0);
  s.hk=zones[2]!==undefined?+zones[2]:(s.hk||1);
  s.nk=zones[3]!==undefined?+zones[3]:(s.nk||1);
  s.specSaved=true;
  activeSpecTab().name=s.pno||activeSpecTab().name;
  loadSpecIntoForm();
  recomputeZones();
  refreshWorkspaceUI();
}

function syncSideSpecToFullForm(){
  loadSpecIntoForm();
  nav('spec');
}

function updateSpecSummaryUI(){
  const s=S.spec;
  document.getElementById('tb-part').textContent=s.specSaved ? `${s.pno} / ${s.zone}` : '—';
  document.getElementById('sb-spec-body').innerHTML=s.specSaved ?
    `<div class="sb-spec-row"><span class="sb-spec-key">Tab</span><span class="sb-spec-val">${activeSpecTab().name}</span></div>`+
    `<div class="sb-spec-row"><span class="sb-spec-key">Part</span><span class="sb-spec-val">${s.pno}</span></div>`+
    `<div class="sb-spec-row"><span class="sb-spec-key">%</span><span class="sb-spec-val">≤${s.pct}%</span></div>`+
    `<div class="sb-spec-row"><span class="sb-spec-key">Φ</span><span class="sb-spec-val">${s.phi} mm</span></div>`+
    `<div class="sb-spec-row"><span class="sb-spec-key">A · U</span><span class="sb-spec-val">${s.a} · ${s.u}mm</span></div>`+
    `<div class="sb-spec-row"><span class="sb-spec-key">H/N</span><span class="sb-spec-val">H${s.h}/N${s.n}</span></div>` :
    '<div style="font-size:10px;color:var(--dim)">No spec loaded</div>';
  document.getElementById('ms-pct').textContent=s.pct+'%';
  document.getElementById('ms-phi').textContent=s.phi+' mm';
  document.getElementById('sb-wall').textContent=s.t+' mm';
  document.getElementById('sb-datum').textContent=(S.imgMode?getEffectiveDatum().toFixed(1)+' mm² (img)':s.datum+' mm²');
  loadSpecIntoSidebar();
}

function updateImageControlsUI(){
  const info=document.getElementById('img-scale-info');
  if(info){
    if(S.imgState.scalePxPerMm){
      info.style.display='inline-flex';
      info.textContent=`Scale: ${(1/S.imgState.scalePxPerMm).toFixed(4)} mm/px  ·  ${S.imgState.scalePxPerMm.toFixed(2)} px/mm`;
    } else {
      info.style.display='none';
    }
  }
  document.getElementById('img-overlay-info').textContent = S.imgState.image
    ? `${activeImagePage().name} · ${S.imgState.image.naturalWidth}×${S.imgState.image.naturalHeight}px`
    : `${activeImagePage().name} — upload to begin`;
  document.getElementById('btn-undo').disabled=!S.history.length;
  document.getElementById('btn-redo').disabled=!S.redoHistory.length;
}

function renderSpecTabs(){
  const host=document.getElementById('spec-tabs'); if(!host) return;
  host.innerHTML=Workspace.specs.map((tab,i)=>{
    const label=tab.spec.specSaved ? (tab.spec.pno || tab.name) : tab.name;
    return `<button class="spec-tab ${i===Workspace.activeSpec?'on':''}" onclick="switchSpecTab(${i})" title="Own specification">${label}</button>`;
  }).join('');
}

function renderImageTabs(){
  const host=document.getElementById('image-tabs'); if(!host) return;
  const tab=activeSpecTab();
  host.innerHTML=tab.images.map((img,i)=>{
    const count=img.pores.length;
    const hasImg=img.imgState.image ? 'photo' : 'empty';
    return `<button class="image-tab ${i===tab.activeImage?'on':''}" onclick="switchImageTab(${i})">
      <span>${img.name}</span><span class="image-tab-meta">${count} pores · ${hasImg}</span>
    </button>`;
  }).join('');
}

function refreshWorkspaceUI(){
  persistActiveResults();
  bindActiveWorkspace();
  const _drEl = document.getElementById('sb-datum');
  if(_drEl) _drEl.textContent = S.imgMode ? getEffectiveDatum().toFixed(1)+' mm² (img)' : (S.spec.datum||100)+' mm²';
  if(typeof _updateScaleDisplay === 'function') _updateScaleDisplay();
  if(typeof renderSpecTabs === 'function') renderSpecTabs();
  if(typeof renderImageTabs === 'function') renderImageTabs();
  if(typeof updateSpecSummaryUI === 'function') updateSpecSummaryUI();
  if(typeof updateImageControlsUI === 'function') updateImageControlsUI();
  if(typeof updateImgHint === 'function') updateImgHint();
  if(typeof updatePoreRegistry === 'function') updatePoreRegistry();
  if(typeof updateLiveMetrics === 'function') updateLiveMetrics();
  if(typeof showEditPanel === 'function') showEditPanel();
  if(typeof refreshImgOffsetUI === 'function') refreshImgOffsetUI();
  if(typeof renderExclList === 'function') renderExclList();
  if(typeof updateExclZoneBadge === 'function') updateExclZoneBadge();
  if(mctx) drawCanvas();
}

// ── Image Position in Wall — Upgraded JS Engine ─────────────────────────────
let _ipiwStep = 0.5; // current nudge step in mm

function _ipiwSetStep(val, btn) {
  _ipiwStep = val;
  // Update step button states
  document.querySelectorAll('.ipiw-step-opt').forEach(b => b.classList.remove('on'));
  if (btn) btn.classList.add('on');
  // Update nudge button labels
  const upLbl = document.getElementById('ipiw-nudge-up-lbl');
  const dnLbl = document.getElementById('ipiw-nudge-dn-lbl');
  if (upLbl) upLbl.textContent = '−' + val + ' mm';
  if (dnLbl) dnLbl.textContent = '+' + val + ' mm';
}

function refreshImgOffsetUI() {
  const rows = document.querySelectorAll('#img-offset-row');
  const input = document.getElementById('img-offset-mm');
  if (!input) return;
  const page = activeImagePage();
  const show = S.imgMode || (page.imgOffsetMm > 0);
  rows.forEach(r => r.style.display = show ? '' : 'none');
  if (show) {
    input.value = (page.imgOffsetMm || 0).toFixed(1);
    _updateOffsetZoneLabel(page.imgOffsetMm || 0);
    _checkCroppedImageWarning(page.imgOffsetMm || 0);
    _updateWallStripWindow(page.imgOffsetMm || 0);
  }
}

function _getImageHeightMm() {
  if (S.imgState && S.imgState.scalePxPerMm && S.imgState.image) {
    return S.imgState.image.naturalHeight / (S.imgState.scalePxPerMm / (S.imgState.fitScale || 1));
  }
  return 0;
}

function _updateOffsetZoneLabel(offsetMm) {
  const badges = document.querySelectorAll('#img-offset-zones');
  const t = S.spec.t || 6;
  const t3 = t / 3;
  const imgH = _getImageHeightMm();

  let label = 'Full Section';
  let badgeClass = 'zone-full';

  if (offsetMm === 0 && imgH === 0) {
    label = 'Full Section';
    badgeClass = 'zone-full';
  } else {
    const top = offsetMm;
    const bot = offsetMm + (imgH || t);
    const covPct = Math.round(
      Math.max(0, Math.min(bot, t) / t * 100 - Math.max(top, 0) / t * 100)
    );
    const zones = [];
    if (top < t3) zones.push('HR↑');
    if (bot > t3 && top < t3 * 2) zones.push('HK');
    if (bot > t3 * 2) zones.push('HR↓');

    if (zones.length === 0) {
      label = '— out of wall';
      badgeClass = '';
    } else if (zones.length === 3 || (top <= 0 && bot >= t)) {
      label = 'Full · ' + covPct + '% wall';
      badgeClass = 'zone-full';
    } else if (zones.length === 1 && zones[0] === 'HK') {
      label = 'HK · ' + covPct + '% wall';
      badgeClass = 'zone-hk';
    } else if (zones.every(z => z.startsWith('HR'))) {
      label = zones.join('+') + ' · ' + covPct + '% wall';
      badgeClass = 'zone-hr';
    } else {
      label = zones.join('+') + ' · ' + covPct + '% wall';
      badgeClass = 'zone-mix';
    }

    // Update coverage bar + text
    const fill = document.getElementById('ipiw-cov-fill');
    const txt = document.getElementById('ipiw-cov-text');
    if (fill) fill.style.width = covPct + '%';
    if (txt) txt.textContent = covPct + '%';
  }

  badges.forEach(el => {
    el.textContent = label;
    el.className = 'ipiw-badge ' + badgeClass;
  });

  _updateActivePresetHighlight(offsetMm);
}

function _updateActivePresetHighlight(offsetMm) {
  const t = S.spec.t || 6;
  const eps = 0.05;
  const presets = {
    'ipiw-pre-full': 0,
    'ipiw-pre-hr-top': 0,
    'ipiw-pre-hk': t / 3,
    'ipiw-pre-hr-bot': (t / 3) * 2
  };
  Object.entries(presets).forEach(([id, val]) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active-preset', Math.abs(offsetMm - val) < eps);
  });
}

function _checkCroppedImageWarning(offsetMm) {
  const warnEls = document.querySelectorAll('#img-offset-warn');
  const t = S.spec.t || 6;
  const imgH = _getImageHeightMm();

  if (imgH === 0) { warnEls.forEach(w => { w.classList.remove('show'); w.innerHTML=''; }); return; }

  const isCropped = imgH < t * 0.85;
  if (isCropped && offsetMm === 0) {
    const guessOffset = (t - imgH) / 2;
    const msg = '⚠ Image spans ~' + imgH.toFixed(1) + ' mm of the ' + t + ' mm wall. '
      + 'Zone classification will be incorrect without an offset. '
      + 'For an HK-centred crop, try offset ≈ ' + guessOffset.toFixed(1) + ' mm.';
    warnEls.forEach(w => { w.innerHTML = msg; w.classList.add('show'); });
  } else {
    warnEls.forEach(w => { w.classList.remove('show'); w.innerHTML = ''; });
  }
}

function applyImgOffset(val) {
  const t = S.spec.t || 6;
  const mm = Math.max(0, Math.min(t, parseFloat(val) || 0));
  const page = activeImagePage();
  page.imgOffsetMm = mm;
  // Sync all Top inputs
  document.querySelectorAll('#img-offset-mm').forEach(inp => inp.value = mm.toFixed(1));
  _updateOffsetZoneLabel(mm);
  _checkCroppedImageWarning(mm);
  _updateWallStripWindow(mm);
  if (S.imgMode) recomputeZones();
  refreshWorkspaceUI();
}

function _updateWallStripWindow(offsetMm) {
  const wins = document.querySelectorAll('#wall-strip-window');
  const strips = document.querySelectorAll('#wall-vstrip');
  const t = S.spec.t || 6;
  const imgH = _getImageHeightMm() || t;

  const pctTop = Math.max(0, Math.min(100, (offsetMm / t) * 100));
  const rawBot = ((offsetMm + imgH) / t) * 100;
  const pctBot = Math.min(100, rawBot);
  const pctHeight = Math.max(2, pctBot - pctTop);

  wins.forEach(win => {
    win.style.top = pctTop + '%';
    win.style.height = pctHeight + '%';
    win.style.display = 'block';
  });

  // Update coverage bar position in strip
  document.querySelectorAll('#wall-cov-fill').forEach(fill => {
    fill.style.top = pctTop + '%';
    fill.style.height = pctHeight + '%';
    fill.style.bottom = 'auto';
  });

  // Update bottom offset input
  const botGapMm = Math.max(0, t - (offsetMm + imgH));
  document.querySelectorAll('#img-offset-bot-val').forEach(el => {
    if (el.tagName === 'INPUT') el.value = botGapMm.toFixed(1);
    else el.textContent = botGapMm.toFixed(1) + ' mm from B';
  });
}

// ── Vertical strip drag ───────────────────────────────────────────────────────
let _vStripDrag = null;
function _wallVStripDragStart(e) {
  const strip = e.currentTarget; // use the actual element that was clicked, not getElementById
  if (!strip) return;
  e.preventDefault();
  e.stopPropagation(); // only stop during drag initiation, not on passive scroll
  const rect = strip.getBoundingClientRect();
  _vStripDrag = { rect };
  strip.classList.add('dragging');
  document.body.style.cursor = 'ns-resize';

  const onMove = (ev) => {
    if (!_vStripDrag) return;
    const frac = Math.max(0, Math.min(1, (ev.clientY - _vStripDrag.rect.top) / _vStripDrag.rect.height));
    const t = S.spec.t || 6;
    const clamped = +(frac * t).toFixed(2);
    document.querySelectorAll('#img-offset-mm').forEach(inp => inp.value = clamped.toFixed(1));
    applyImgOffset(clamped.toFixed(1));
  };

  const onUp = () => {
    _vStripDrag = null;
    document.querySelectorAll('.ipiw-vstrip').forEach(s => s.classList.remove('dragging'));
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Allow mouse wheel on the vstrip to scroll the parent #pore-panel
// (called once at init — see initIpiwWheelPassthrough)
function _ipiwWheelOnStrip(e) {
  const panel = document.getElementById('pore-panel');
  if (panel) {
    panel.scrollTop += e.deltaY;
    e.stopPropagation();
  }
}

function _nudgeOffset(deltaMm) {
  const page = activeImagePage();
  const t = S.spec.t || 6;
  const maxOffset = t;
  const current = page.imgOffsetMm || 0;
  const next = Math.max(0, Math.min(maxOffset, +(current + deltaMm).toFixed(2)));
  document.querySelectorAll('#img-offset-mm').forEach(inp => inp.value = next.toFixed(1));
  applyImgOffset(next.toFixed(1));
}

function applyImgOffsetFromBot(val) {
  const t = S.spec.t || 6;
  const imgH = _getImageHeightMm();
  const botMm = Math.max(0, parseFloat(val) || 0);
  const topOffset = Math.max(0, Math.min(t, t - (imgH || 0) - botMm));
  document.querySelectorAll('#img-offset-mm').forEach(inp => inp.value = topOffset.toFixed(1));
  applyImgOffset(topOffset.toFixed(1));
}

function _wallStripClick(e) {} // legacy no-op

function _setOffsetPreset(preset) {
  const t = S.spec.t || 6;
  let offset = 0;
  if (preset === 'full')    offset = 0;
  else if (preset === 'hr_top') offset = 0;
  else if (preset === 'hk')     offset = t / 3;
  else if (preset === 'hr_bot') offset = (t / 3) * 2;
  document.querySelectorAll('#img-offset-mm').forEach(inp => inp.value = offset.toFixed(1));
  applyImgOffset(offset.toFixed(1));
}


function switchSpecTab(index){
  persistActiveResults();
  Workspace.activeSpec=index;
  bindActiveWorkspace();
  loadSpecIntoForm();
  S.selectedId=null;
  refreshWorkspaceUI();
  updateHeaderButtons();
}

function switchImageTab(index){
  persistActiveResults();
  activeSpecTab().activeImage=index;
  bindActiveWorkspace();
  S.selectedId=null;
  refreshWorkspaceUI();
  switchCanvasMode('image');
  updateHeaderButtons();
}

function addSpecTab(){
  persistActiveResults();
  if(Workspace.specs.length>=10){ toast('Maximum 10 specification tabs','warn'); return; }
  const next=Workspace.specs.length+1;
  const tab=makeSpecTab(next, S.spec);
  tab.name='Spec '+next;
  tab.spec.pno='';
  tab.spec.zone='';
  tab.spec.specSaved=false;
  Workspace.specs.push(tab);
  switchSpecTab(Workspace.specs.length-1);
  nav('spec');
}

function addImageTab(){
  persistActiveResults();
  const tab=activeSpecTab();
  if(tab.images.length>=10){ toast('Maximum 10 images for this specification','warn'); return; }
  tab.images.push(makeImagePage(tab.images.length+1));
  switchImageTab(tab.images.length-1);
}

const PLATFORM_META = {
  home:{tool:'Porosity Inspector', route:'Tool 01 / Measurement'},
  porosity:{tool:'Porosity Inspector', route:'Tool 01 / Measurement'},
  defects:{tool:'Defect Analysis', route:'Tool 02 / Defect Matrix'},
  process:{tool:'Process Calculator', route:'Tool 03 / Engineering Calculator'},
  visualiser:{tool:'3D Visualiser', route:'Tool 04 / Cavity Workspace'}
};

function setPlatformBadge(tool){
  const badge=document.getElementById('tb-badge');
  const dot=document.getElementById('tb-dot');
  const verdict=(HPDC_STATE.lastVerdict || S.verdict || '').toString().toUpperCase();
  if(tool==='porosity'){
    if(verdict==='ACCEPT' || verdict==='PASS'){
      badge.textContent='PASS';
      badge.className='t-badge tb-pass';
      dot.className='t-dot td-pass';
      return;
    }
    if(verdict==='REJECT' || verdict==='FAIL'){
      badge.textContent='FAIL';
      badge.className='t-badge tb-fail';
      dot.className='t-dot td-fail';
      return;
    }
  }
  badge.textContent=tool==='home' ? 'READY' : 'READY';
  badge.className='t-badge tb-idle';
  dot.className='t-dot td-idle';
}

function setPlatformContext(tool, routeOverride){
  const meta=PLATFORM_META[tool] || PLATFORM_META.home;
  document.getElementById('tb-tool').textContent=meta.tool;
  document.getElementById('tb-route').textContent=routeOverride || meta.route;
  localStorage.setItem('hpdc_platform_page', JSON.stringify({ tool, route: routeOverride || meta.route }));
  setPlatformBadge(tool);
  syncSidebarMode();
}

function syncSidebarMode(){
  const block = document.getElementById('porosity-sidebar-block');
  const summary = document.getElementById('porosity-spec-summary');
  const footer = document.getElementById('porosity-sidebar-footer');
  if(block) block.style.display = '';
  if(summary) summary.style.display = '';
  if(footer) footer.style.display = '';
}

function showPlatformPage(tool, opts={}){
  if(tool==='home'){ nav('meas', { platformRoute:'Tool 01 / Measurement' }); return; }
  if(tool==='porosity'){ nav(opts.subpage || 'meas', { platformRoute: opts.route || 'Tool 01 / Measurement' }); return; }
  nav('meas', { platformRoute:'Tool 01 / Measurement' });
  return;
  document.querySelectorAll('.page').forEach(p=>{
    p.classList.remove('on');
    p.style.display='none';
    p.style.opacity='0';
    p.style.pointerEvents='none';
  });
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('on'));
  const target=document.getElementById('pg-'+tool);
  if(target){
    target.classList.add('on');
    target.style.display='flex';
    target.style.opacity='1';
    target.style.pointerEvents='auto';
  }
  setPlatformContext(tool, opts.route || PLATFORM_META[tool]?.route);
  if(tool==='defects' && typeof window.initDefectTool==='function') window.initDefectTool();
  if(tool==='process' && typeof window.initProcessTool==='function') window.initProcessTool(opts);
  if(tool==='visualiser' && typeof window.initVisualiserTool==='function') window.initVisualiserTool();
}
window.showPlatformPage = showPlatformPage;
window.showPage = showPlatformPage;

function updateHomeVerdictBadge(){
  const el=document.getElementById('home-last-verdict');
  if(!el) return;
  const verdict=(HPDC_STATE.lastVerdict || '').toString().toUpperCase();
  if(verdict==='ACCEPT' || verdict==='PASS'){
    el.className='status-pill status-ok';
    el.textContent='Verdict ACCEPT';
  } else if(verdict==='REJECT' || verdict==='FAIL'){
    el.className='status-pill status-bad';
    el.textContent='Verdict REJECT';
  } else {
    el.className='status-pill status-warn';
    el.textContent='Verdict —';
  }
}

// ═══════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════
function nav(id, opts={}){
  if(id==='home'){
    id='meas';
    opts={...opts, platformRoute: opts.platformRoute || 'Tool 01 / Measurement'};
  }
  document.querySelectorAll('.page').forEach(p=>{
    p.classList.remove('on');
    p.style.display='none';
    p.style.opacity='0';
    p.style.pointerEvents='none';
  });
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('on'));
  const page=document.getElementById('pg-'+id);
  page.classList.add('on');
  page.style.display='flex';
  page.style.opacity='1';
  page.style.pointerEvents='auto';
  const nb=document.getElementById('nb-'+id);
  if(nb) nb.classList.add('on');
  if(['spec','meas','verdict','presets','ref'].includes(id)){
    const routeLabel = {
      spec:'Tool 01 / Drawing Spec',
      meas:'Tool 01 / Measurement',
      verdict:'Tool 01 / Verdict',
      presets:'Tool 01 / Presets',
      ref:'Tool 01 / Quick Ref'
    }[id];
    setPlatformContext('porosity', opts.platformRoute || routeLabel);
  }
  if(id==='meas'){ requestAnimationFrame(initCanvas); }
  if(id==='verdict'){ renderVerdict(); }
  if(id==='ref'){ buildRef(); }
  
  // Wait a tick for DOM updates
  setTimeout(updateHeaderButtons, 0);
}

// ═══════════════════════════════════════════════════
// CLOCK
// ═══════════════════════════════════════════════════
(function tick(){
  const t=new Date();
  document.getElementById('tb-time').textContent=
    t.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'})+' '+
    t.toTimeString().slice(0,8);
  setTimeout(tick,1000);
})();

// ═══════════════════════════════════════════════════
// METHOD
// ═══════════════════════════════════════════════════
const MNOTES = {
  visual_machined:'Polished metallographic section cut at Rz=0. Measure pores at 10×–200× magnification. HR/HK zones require precise sectioning at exact zone boundaries. Destructive.',
  visual_cast:'Direct visual inspection of as-cast surface without machining. No Rz requirement. Best for general surface evaluation. Non-destructive.',
  xray:'2D projection — internal porosity visible but wall-zone (HR/HK) depth assignment NOT possible. Supplement with section cut or CT if zone conditions are specified.',
  ct:'Full 3D voxel volume. All VW50093 parameters including HR/HK/NR/NK auto-assigned by position. Non-destructive. Gold standard for PPAP qualification.'
};
function setMethod(m){
  S.spec.method=m;
  document.querySelectorAll('.method-opt').forEach(el=>{
    el.classList.toggle('on',el.dataset.m===m);
  });
  const noteEl = document.getElementById('method-note');
  if(noteEl) noteEl.textContent=MNOTES[m];
}
setMethod('visual_machined');

// ═══════════════════════════════════════════════════
// TOGGLE
// ═══════════════════════════════════════════════════
const TV = {}; // toggle values
function tog(gid, v, el){
  document.querySelectorAll('#'+gid+' .tgl-opt').forEach((o,i)=>o.classList.toggle('on',i===v));
  TV[gid]=v;
}
function getv(gid, def=0){ return TV[gid]??def; }

// ═══════════════════════════════════════════════════
// PRESETS
// ═══════════════════════════════════════════════════
const PRESETS = {
  seal:    {pct:2, phi:0.5, a:3, u:0.2, t:4,  datum:50,  h:0,n:0,hr:0,nr:0,hk:0,nk:0},
  struct:  {pct:10,phi:2.0, a:1, u:0,   t:8,  datum:200, h:1,n:0,hr:0,nr:0,hk:1,nk:1},
  bearing: {pct:5, phi:1.5, a:2, u:0.2, t:6,  datum:100, h:0,n:0,hr:0,nr:0,hk:1,nk:1},
  jacket:  {pct:5, phi:1.0, a:2, u:0.2, t:5,  datum:80,  h:0,n:0,hr:0,nr:0,hk:1,nk:1},
};
let customPresets = JSON.parse(localStorage.getItem('pvi_custom_presets') || '{}');

function saveCustomPresetSpec() {
  const nameInput = document.getElementById('lib-name-spec');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) return;
  
  const p = {
    pct: document.getElementById('sp-pct').value !== '' ? +document.getElementById('sp-pct').value : 5,
    phi: document.getElementById('sp-phi').value !== '' ? +document.getElementById('sp-phi').value : 1.5,
    a:   document.getElementById('sp-a').value !== '' ? +document.getElementById('sp-a').value : 2,
    u:   document.getElementById('sp-u').value !== '' ? +document.getElementById('sp-u').value : 0.2,
    t:   document.getElementById('sp-t').value !== '' ? +document.getElementById('sp-t').value : 6,
    datum: document.getElementById('sp-datum')?.value !== undefined && document.getElementById('sp-datum')?.value !== '' ? +document.getElementById('sp-datum').value : (S.spec.datum || 100),
    phi_gas:    document.getElementById('sp-phi-gas')?.value    ? +document.getElementById('sp-phi-gas').value    : null,
    phi_shrink: document.getElementById('sp-phi-shrink')?.value ? +document.getElementById('sp-phi-shrink').value : null,
    pct_gas:    document.getElementById('sp-pct-gas')?.value    ? +document.getElementById('sp-pct-gas').value    : null,
    pct_shrink: document.getElementById('sp-pct-shrink')?.value ? +document.getElementById('sp-pct-shrink').value : null,
    h: getv('tg-h'), n: getv('tg-n'),
    hr: getv('tg-hr'), nr: getv('tg-nr'),
    hk: getv('tg-hk'), nk: getv('tg-nk')
  };
  
  customPresets[name] = p;
  localStorage.setItem('pvi_custom_presets', JSON.stringify(customPresets));
  if (nameInput) nameInput.value = '';
  renderCustomPresets();
}

function applyCustomPreset(k) {
  const p = customPresets[k];
  if (!p) return;
  
  // Load general fields
  ['pct','phi','a','u','t','datum'].forEach(f=>{ 
    const el=document.getElementById('sp-'+f); 
    if(el) el.value=p[f] !== undefined ? p[f] : ''; 
  });
  
  // Load gas/shrink override fields
  ['phi_gas','pct_gas','phi_shrink','pct_shrink'].forEach(f=>{
    const el=document.getElementById('sp-'+f.replace('_', '-'));
    if(el) el.value=p[f] !== undefined && p[f] !== null ? p[f] : '';
  });
  
  // Load toggle zone settings
  ['h','n','hr','nr','hk','nk'].forEach(f=>{ 
    if(p[f] !== undefined) tog('tg-'+f, p[f], null); 
  });
  saveSpec();
}

function deleteCustomPreset(k) {
  delete customPresets[k];
  localStorage.setItem('pvi_custom_presets', JSON.stringify(customPresets));
  renderCustomPresets();
}

function renderCustomPresets() {
  const list = document.getElementById('user-presets-list-spec');
  if (!list) return;
  const keys = Object.keys(customPresets);
  if (keys.length === 0) {
    list.innerHTML = '<div style="font-size:10px;color:var(--dim);">No custom presets saved.</div>';
    return;
  }
  list.innerHTML = keys.map(k => `
    <div class="preset-chip-wrapper" style="display:inline-flex;align-items:center;gap:4px;background:var(--c2);border:1px solid var(--bd);border-radius:20px;padding:3px 8px;">
      <button class="btn-preset-load" onclick="applyCustomPreset('${k}')" style="background:none;border:none;color:var(--tx);font-size:11px;font-weight:600;cursor:pointer;padding:0;display:flex;align-items:center;">◈ ${k}</button>
      <button class="btn-preset-del" onclick="deleteCustomPreset('${k}')" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:11px;padding:0 2px;margin-left:4px;" onmouseover="this.style.color='#ef4444'" onmouseout="this.style.color='var(--dim)'">✕</button>
    </div>
  `).join('');
}
// Render on load
renderCustomPresets();

function applyPreset(k){
  const p=PRESETS[k];
  if(!p) return;
  
  // Load general fields
  ['pct','phi','a','u','t','datum'].forEach(f=>{ 
    const el=document.getElementById('sp-'+f); 
    if(el) el.value=p[f]; 
  });
  
  // Reset overrides to empty
  ['sp-phi-gas','sp-pct-gas','sp-phi-shrink','sp-pct-shrink'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.value='';
  });
  
  // Load toggle zone settings
  ['h','n','hr','nr','hk','nk'].forEach(f=>{ 
    tog('tg-'+f, p[f], null); 
  });
  saveSpec();
}

// ═══════════════════════════════════════════════════
// SAVE SPEC
// ═══════════════════════════════════════════════════
function saveSpec(){
  const s=S.spec;
  s.pno  = document.getElementById('sp-pno').value||'PART-001';
  s.zone = document.getElementById('sp-zone').value||'Zone A';
  s.rev  = document.getElementById('sp-rev').value||'—';
  s.insp = document.getElementById('sp-insp').value||'—';
  const _pctVal = document.getElementById('sp-pct').value;   s.pct   = _pctVal !== '' ? +_pctVal : 5;
  const _phiVal = document.getElementById('sp-phi').value;   s.phi   = _phiVal !== '' ? +_phiVal : 1.5;
  const _aVal   = document.getElementById('sp-a').value;     s.a     = _aVal   !== '' ? +_aVal   : 2;
  const _uVal   = document.getElementById('sp-u').value;     s.u     = _uVal   !== '' ? +_uVal   : 0.2;
  const _tVal   = document.getElementById('sp-t').value;     s.t     = _tVal   !== '' ? +_tVal   : 6;
  const _datEl  = document.getElementById('sp-datum');       if(_datEl && _datEl.value !== '') s.datum = +_datEl.value;
  // Zone mode: zone_disabled is managed by the toggle, not a direct input — just preserve it
  // (do NOT overwrite from checkbox directly; toggleZoneMode manages it)
  // Type-specific limits — persist only when the field has a value
  const _gPhi = document.getElementById('sp-phi-gas');     s.phi_gas    = _gPhi    && _gPhi.value    !== '' ? +_gPhi.value    : null;
  const _sPhi = document.getElementById('sp-phi-shrink');  s.phi_shrink = _sPhi    && _sPhi.value    !== '' ? +_sPhi.value    : null;
  const _gPct = document.getElementById('sp-pct-gas');     s.pct_gas    = _gPct    && _gPct.value    !== '' ? +_gPct.value    : null;
  const _sPct = document.getElementById('sp-pct-shrink');  s.pct_shrink = _sPct    && _sPct.value    !== '' ? +_sPct.value    : null;
  s.h=getv('tg-h'); s.n=getv('tg-n');
  s.hr=getv('tg-hr'); s.nr=getv('tg-nr');
  s.hk=getv('tg-hk'); s.nk=getv('tg-nk');
  s.specSaved=true;
  activeSpecTab().name = s.pno || activeSpecTab().name;
  HPDC_STATE.set('partNo', s.pno, 'Tool 01');
  HPDC_STATE.set('zone', s.zone, 'Tool 01');
  HPDC_STATE.set('specPhi', s.phi, 'Tool 01');
  HPDC_STATE.set('specPct', s.pct, 'Tool 01');
  HPDC_STATE.set('wallThickness', s.t, 'Tool 01');

  // Topbar
  document.getElementById('tb-part').textContent=s.pno+' / '+s.zone;
  // Badge
  document.getElementById('bsp').textContent='SET';
  document.getElementById('bsp').className='nb-badge nbb-set';
  document.getElementById('bme').textContent='ACTIVE';
  document.getElementById('bme').className='nb-badge nbb-idle';
  // Sidebar spec
  document.getElementById('sb-spec-body').innerHTML=
    `<div class="sb-spec-row"><span class="sb-spec-key">Part</span><span class="sb-spec-val">${s.pno}</span></div>`+
    `<div class="sb-spec-row"><span class="sb-spec-key">%</span><span class="sb-spec-val">≤${s.pct}%</span></div>`+
    `<div class="sb-spec-row"><span class="sb-spec-key">Φ</span><span class="sb-spec-val">${s.phi} mm</span></div>`+
    `<div class="sb-spec-row"><span class="sb-spec-key">A · U</span><span class="sb-spec-val">${s.a} · ${s.u}mm</span></div>`+
    `<div class="sb-spec-row"><span class="sb-spec-key">H/N</span><span class="sb-spec-val">H${s.h}/N${s.n}</span></div>`;
  // Home status
  document.getElementById('h-sp-st').innerHTML='<span style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;background:var(--ga);color:var(--tx)">CONFIGURED</span>';
  document.getElementById('h-me-st').innerHTML='<span style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;background:var(--aa);color:var(--amb)">READY</span>';
  // Meter limits
  document.getElementById('ms-pct').textContent=s.pct+'%';
  document.getElementById('ms-phi').textContent=s.phi+' mm';
  document.getElementById('sb-wall').textContent=s.t+' mm';
  document.getElementById('sb-datum').textContent=s.datum+' mm²';
  // Reset canvas pore zones (spec changed)
  recomputeZones();
  // Sync zone toggle UI to match newly loaded spec
  if(typeof _syncZoneToggleUI === 'function') _syncZoneToggleUI();
  refreshWorkspaceUI();
  nav('meas');
}

// ═══════════════════════════════════════════════════
// CANVAS — INIT & DRAW
// ═══════════════════════════════════════════════════
let MC, OC, mctx, octx;
let dpr = 1;
let isPointerDown = false;
let lastMoveEvent = null;
let dragState = null; // {pore, startMx, startMy, origX, origY}

function resizeCanvas(){
  // Only resizes the canvas — does NOT rebind events (prevents duplicate listeners)
  MC = document.getElementById('main-canvas');
  OC = document.getElementById('overlay-canvas');
  const wrap = document.getElementById('canvas-wrap');
  dpr = window.devicePixelRatio||1;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if(W<1||H<1){ setTimeout(resizeCanvas, 50); return; }
  MC.width  = Math.round(W*dpr); MC.height = Math.round(H*dpr);
  OC.width  = Math.round(W*dpr); OC.height = Math.round(H*dpr);
  MC.style.width  = W+'px'; MC.style.height = H+'px';
  OC.style.width  = W+'px'; OC.style.height = H+'px';
  mctx = MC.getContext('2d');
  octx = OC.getContext('2d');
  // CRITICAL: reset transform before scale to prevent accumulation on resize
  mctx.setTransform(1,0,0,1,0,0); mctx.scale(dpr,dpr);
  octx.setTransform(1,0,0,1,0,0); octx.scale(dpr,dpr);
  S.cv.W=W; S.cv.H=H;
  fitWall();
  drawCanvas();
  console.log(`[PVI] Canvas resize: ${W}×${H}px, dpr=${dpr}`);
}

function initCanvas(){
  // Full init: resize canvas + bind events (events bound only once via evtsBound guard)
  resizeCanvas();
  bindCanvasEvents();
  console.log('[PVI] Canvas init complete');
  
  // Ensure that any Flexbox layout shifts trigger a resize
  const wrap = document.getElementById('canvas-wrap');
  if(wrap && window.ResizeObserver && !wrap._hasObserver){
    wrap._hasObserver = true;
    new ResizeObserver(() => {
      // only redraw if the actual size changed
      if(wrap.clientWidth !== S.cv.W || wrap.clientHeight !== S.cv.H){
        resizeCanvas();
      }
    }).observe(wrap);
  }
}

function fitWall(){
  const {W,H}=S.cv;
  const margin = 40;
  const wallDisplayH = H - margin*2;
  const wallDisplayW = W - 140;
  S.cv.wallL  = 80;
  S.cv.wallTop= margin;
  S.cv.wallH  = wallDisplayH;
  S.cv.wallW  = wallDisplayW;
  S.cv.scale  = SCALE_BASE;
  S.cv.originX = 0;
  S.cv.originY = 0;
  document.getElementById('sb-datum').textContent=(S.imgMode?getEffectiveDatum().toFixed(1)+' mm² (img)':S.spec.datum+' mm²');
  _updateScaleDisplay();
}

function resetView(){ fitWall(); drawCanvas(); }

function zoom(f, cx, cy){
  const oldScale = S.cv.scale;
  const newScale = Math.max(10, Math.min(200, oldScale*f));
  // zoom toward cursor point (cx,cy) in canvas CSS coords
  if(cx!==undefined && cy!==undefined){
    // adjust origin so the point under cursor stays fixed
    S.cv.originX = cx - (cx - S.cv.originX) * (newScale/oldScale);
    S.cv.originY = cy - (cy - S.cv.originY) * (newScale/oldScale);
  }
  S.cv.scale = newScale;
  document.getElementById('sb-zoom').textContent=Math.round(newScale/SCALE_BASE*100)+'%';
  document.getElementById('sb-datum').textContent=(S.imgMode?getEffectiveDatum().toFixed(1)+' mm² (img)':S.spec.datum+' mm²');
  _updateScaleDisplay();
  drawCanvas();
}

// Convert canvas CSS coords → mm (wall-relative: 0,0 = top-left of wall)
function _imgScale(){ return S.imgState.scalePxPerMm || S.cv.scale; }
function _imgOriginX(){ return S.imgState.imgX !== undefined ? S.imgState.imgX : (S.cv.wallL + S.cv.originX); }
function _imgOriginY(){ return S.imgState.imgY !== undefined ? S.imgState.imgY : (S.cv.wallTop + S.cv.originY); }

function canvasToMm(cx, cy){
  if(S.imgMode && S.imgState.scalePxPerMm){
    return { x:(cx - _imgOriginX())/_imgScale(), y:(cy - _imgOriginY())/_imgScale() };
  }
  return {
    x: (cx - S.cv.wallL - S.cv.originX) / S.cv.scale,
    y: (cy - S.cv.wallTop - S.cv.originY) / S.cv.scale
  };
}
function mmToCanvas(mx, my){
  if(S.imgMode && S.imgState.scalePxPerMm){
    return { x: mx*_imgScale() + _imgOriginX(), y: my*_imgScale() + _imgOriginY() };
  }
  return {
    x: mx * S.cv.scale + S.cv.wallL + S.cv.originX,
    y: my * S.cv.scale + S.cv.wallTop + S.cv.originY
  };
}
function wallHeightMm(){ return S.cv.wallH / S.cv.scale; }
function wallWidthMm(){  return S.cv.wallW / S.cv.scale; }

// ── DRAW ──────────────────────────────────────────
function drawCanvas(){
  if(!mctx) return;
  const {W,H,scale}=S.cv;
  if(W < 1 || H < 1){ console.warn('[PVI] drawCanvas: canvas not sized yet, skipping'); return; }
  // Apply pan to all wall coords
  const wallL   = S.cv.wallL   + S.cv.originX;
  const wallTop = S.cv.wallTop + S.cv.originY;
  const wallH   = S.cv.wallH;
  const wallW   = S.cv.wallW;
  mctx.clearRect(0,0,W,H);
  mctx.save();

  // Background — professional light
  mctx.fillStyle='#f5f6f8'; mctx.fillRect(0,0,W,H);
  


  // ── IMAGE BACKGROUND (image mode) ──────────────────────────────────────────
  if(S.imgMode){
    if(!S.imgState.image){
      mctx.fillStyle='rgba(0,0,0,.04)'; mctx.fillRect(wallL,wallTop,wallW,wallH);
      mctx.fillStyle='rgba(0,0,0,.3)'; mctx.font='bold 14px system-ui'; mctx.textAlign='center';
      mctx.fillText('📷  Upload a casting photo using the toolbar above', wallL+wallW/2, wallTop+wallH/2-14);
      mctx.font='11px system-ui'; mctx.fillStyle='rgba(0,0,0,.2)';
      mctx.fillText('Then: Set Scale → place pores on the image → Evaluate', wallL+wallW/2, wallTop+wallH/2+14);
      mctx.textAlign='start';
    } else {
      const img = S.imgState.image;
      const iW=Math.max(1, img.naturalWidth), iH=Math.max(1, img.naturalHeight);
      const fit=Math.min(Math.max(10, wallW)/iW, Math.max(10, wallH)/iH);
      const dw=Math.max(1, iW*fit), dh=Math.max(1, iH*fit);
      const ix=wallL+(wallW-dw)/2 + (S.imgState.imgOffsetX || 0);
      const iy=wallTop+(wallH-dh)/2 + (S.imgState.imgOffsetY || 0);
      // ── Rescale calibration when canvas resize changes fit ─────────────────
      if(S.imgState.fitScale && Math.abs(fit - S.imgState.fitScale) > 1e-6 && S.imgState.scalePxPerMm){
        S.imgState.scalePxPerMm = S.imgState.scalePxPerMm * (fit / S.imgState.fitScale);
        S.imgState.cacheValid = false; // force re-render
        // Update scale info pill
        const pill = document.getElementById('img-scale-info');
        if(pill) pill.innerHTML = `<span>Scale: ${(1/S.imgState.scalePxPerMm).toFixed(4)}<br>mm/px · ${S.imgState.scalePxPerMm.toFixed(2)} px/mm</span>`;
      }
      S.imgState.imgX=ix; S.imgState.imgY=iy; S.imgState.imgW=dw; S.imgState.imgH=dh; S.imgState.fitScale=fit;
  
      // Direct draw (safer, avoids offscreen canvas crashes)
      mctx.save();
      // Apply filters if supported
      if(mctx.filter !== undefined) {
        mctx.filter=`brightness(${S.imgState.brightness||100}%) contrast(${S.imgState.contrast||100}%)`;
      }
      try { mctx.drawImage(img, ix, iy, dw, dh); } catch(e) { console.error("DRAW CRASH", e); }
      mctx.restore();
      

      // Image border
      mctx.strokeStyle='rgba(0,100,255,.3)'; mctx.lineWidth=1; mctx.setLineDash([4,4]);
      mctx.strokeRect(ix,iy,dw,dh); mctx.setLineDash([]);

      // Scale line overlay
      if(S.imgState.scaleLine){
        const sl=S.imgState.scaleLine;
        const pxLen=Math.hypot(sl.x2-sl.x1, sl.y2-sl.y1);
        const mmLen=S.imgState.scalePxPerMm?(pxLen/S.imgState.scalePxPerMm).toFixed(2):null;
        const lbl=mmLen?`${mmLen} mm`:`${pxLen.toFixed(0)} px`;
        // Detect if constrained (horizontal or vertical)
        const isConstrained = window._scaleShift && S.imgState.scaleDrawing;
        const isH = Math.abs(sl.x2-sl.x1) >= Math.abs(sl.y2-sl.y1);
        mctx.save();
        mctx.strokeStyle = isConstrained ? '#00ccff' : '#ff3333';
        mctx.lineWidth=2.5;
        mctx.beginPath(); mctx.moveTo(sl.x1,sl.y1); mctx.lineTo(sl.x2,sl.y2); mctx.stroke();
        // tick ends
        const ang=Math.atan2(sl.y2-sl.y1,sl.x2-sl.x1)+Math.PI/2;
        [[sl.x1,sl.y1],[sl.x2,sl.y2]].forEach(([px,py])=>{
          mctx.beginPath(); mctx.moveTo(px+Math.cos(ang)*7,py+Math.sin(ang)*7);
          mctx.lineTo(px-Math.cos(ang)*7,py-Math.sin(ang)*7); mctx.stroke();
        });
        // label
        const mx=(sl.x1+sl.x2)/2, my=(sl.y1+sl.y2)/2-14;
        mctx.font='bold 11px system-ui'; const tw=mctx.measureText(lbl).width;
        mctx.fillStyle='rgba(0,0,0,.75)'; mctx.fillRect(mx-tw/2-5,my-13,tw+10,17);
        mctx.fillStyle='#fff'; mctx.textAlign='center'; mctx.textBaseline='middle';
        mctx.fillText(lbl,mx,my); mctx.textAlign='start'; mctx.textBaseline='alphabetic';
        // Constrain hint shown while drawing
        if(S.imgState.scaleDrawing){
          const hint = isConstrained
            ? (isH ? '⇔ Horizontal locked' : '⇕ Vertical locked')
            : '⇧ Hold Shift to constrain H/V';
          mctx.font='bold 10px system-ui';
          const hw=mctx.measureText(hint).width;
          const hx=(sl.x1+sl.x2)/2, hy=(sl.y1+sl.y2)/2+20;
          mctx.fillStyle = isConstrained ? 'rgba(0,180,255,.85)' : 'rgba(60,60,60,.75)';
          mctx.fillRect(hx-hw/2-6, hy-11, hw+12, 18);
          mctx.fillStyle='#fff'; mctx.textAlign='center'; mctx.textBaseline='middle';
          mctx.fillText(hint,hx,hy); mctx.textAlign='start'; mctx.textBaseline='alphabetic';
        }
        mctx.restore();
      }

      // Scale area rect overlay
      if(S.imgState.scaleRect){
        const r=S.imgState.scaleRect;
        const pxArea=Math.abs(r.w*r.h);
        const mmArea=S.imgState.scalePxPerMm?(pxArea/(S.imgState.scalePxPerMm**2)).toFixed(1):null;
        const lbl=mmArea?`${mmArea} mm²`:`${pxArea.toFixed(0)} px²`;
        mctx.save(); mctx.strokeStyle='#ff7700'; mctx.lineWidth=2; mctx.setLineDash([5,3]);
        mctx.strokeRect(r.x,r.y,r.w,r.h); mctx.setLineDash([]);
        mctx.fillStyle='rgba(255,119,0,.1)'; mctx.fillRect(r.x,r.y,r.w,r.h);
        mctx.font='bold 11px system-ui'; const tw=mctx.measureText(lbl).width;
        const cx=r.x+r.w/2, cy=r.y+r.h/2;
        mctx.fillStyle='rgba(0,0,0,.7)'; mctx.fillRect(cx-tw/2-5,cy-10,tw+10,18);
        mctx.fillStyle='#fff'; mctx.textAlign='center'; mctx.textBaseline='middle';
        mctx.fillText(lbl,cx,cy); mctx.textAlign='start'; mctx.textBaseline='alphabetic';
        mctx.restore();
      }

      // Crop overlay
      if(S.imgState.cropRect){
        const r=S.imgState.cropRect;
        mctx.save();
        mctx.fillStyle='rgba(0,0,0,.5)';
        mctx.fillRect(ix,iy,dw,dh);
        mctx.clearRect(r.x,r.y,Math.abs(r.w),Math.abs(r.h));
        mctx.drawImage(img,(r.x-ix)/fit,(r.y-iy)/fit,Math.abs(r.w)/fit,Math.abs(r.h)/fit,r.x,r.y,Math.abs(r.w),Math.abs(r.h));
        mctx.strokeStyle='#fff'; mctx.lineWidth=1.5; mctx.setLineDash([4,3]);
        mctx.strokeRect(r.x,r.y,r.w,r.h); mctx.setLineDash([]);
        // thirds
        mctx.strokeStyle='rgba(255,255,255,.3)'; mctx.lineWidth=0.5;
        for(let i=1;i<3;i++){
          mctx.beginPath();mctx.moveTo(r.x+r.w*i/3,r.y);mctx.lineTo(r.x+r.w*i/3,r.y+r.h);mctx.stroke();
          mctx.beginPath();mctx.moveTo(r.x,r.y+r.h*i/3);mctx.lineTo(r.x+r.w,r.y+r.h*i/3);mctx.stroke();
        }
        mctx.restore();
      }

      // Permanent scale bar — proper alignment (bottom-left of image)
      if(S.imgState.scalePxPerMm){
        // Update status bar scale every draw
        _updateScaleDisplay();
        const pxPerMm=S.imgState.scalePxPerMm;
        const barMm=[1,2,5,10,20,50].find(v=>v*pxPerMm>70)||10;
        const barPx=barMm*pxPerMm;
        const bx=ix+16, by=iy+dh-20; // bottom-left with padding
        const lbl=`${barMm} mm`;
        mctx.save();
        mctx.font='bold 10px system-ui';
        const tw=mctx.measureText(lbl).width;
        const boxW=Math.max(barPx+16, tw+16);
        // Background pill
        mctx.fillStyle='rgba(0,0,0,.6)';
        mctx.beginPath();
        mctx.roundRect(bx-6, by-22, boxW, 28, 4);
        mctx.fill();
        // Scale bar line
        mctx.strokeStyle='#fff'; mctx.lineWidth=2;
        mctx.beginPath(); mctx.moveTo(bx,by); mctx.lineTo(bx+barPx,by); mctx.stroke();
        mctx.beginPath(); mctx.moveTo(bx,by-5); mctx.lineTo(bx,by+3); mctx.stroke();
        mctx.beginPath(); mctx.moveTo(bx+barPx,by-5); mctx.lineTo(bx+barPx,by+3); mctx.stroke();
        // Label — centered above bar, vertically inside pill
        mctx.fillStyle='#fff'; mctx.textAlign='center'; mctx.textBaseline='bottom';
        mctx.fillText(lbl, bx+barPx/2, by-7);
        mctx.textAlign='start'; mctx.textBaseline='alphabetic';
        mctx.restore();
      }
    }
  }
  // ── END IMAGE BACKGROUND ──────────────────────────────────────────────────


  // Fine grid — draw mode: standard dots; image mode: very subtle background grid
  if(!S.imgMode){
    mctx.strokeStyle='rgba(0,0,0,.06)'; mctx.lineWidth=0.5;
    const gs=24;
    for(let x=0;x<W;x+=gs){
      mctx.beginPath(); mctx.moveTo(x,0); mctx.lineTo(x,H); mctx.stroke();
    }
    for(let y=0;y<H;y+=gs){
      mctx.beginPath(); mctx.moveTo(0,y); mctx.lineTo(W,y); mctx.stroke();
    }
    // Crosshair dots at intersections
    mctx.fillStyle='rgba(0,0,0,.09)';
    for(let x=0;x<W;x+=gs) for(let y=0;y<H;y+=gs){
      mctx.fillRect(x-0.5,y-0.5,1,1);
    }
  } else {
    // Image mode: very subtle dot grid on background only (outside image area)
    mctx.fillStyle='rgba(0,0,0,.055)';
    const gs=28;
    for(let x=0;x<W;x+=gs) for(let y=0;y<H;y+=gs){
      mctx.fillRect(x-0.5,y-0.5,1,1);
    }
  }

  // ── ZONE LINES (image-aware, correctly positioned) ─────────────────────
  const t = S.spec.t || 6;
  const t3mm = t / 3;
  const wR = wallL + wallW, wB = wallTop + wallH;

  // In image mode, use actual image bounds for zone positioning
  const page = activeImagePage ? activeImagePage() : null;
  const offsetMm = (page && page.imgOffsetMm) || 0;

  // Determine the canvas rect where the image actually lives
  // (ix,iy,dw,dh): set by the image draw block above, or fall back to wall rect
  const imgX  = (S.imgMode && S.imgState.image && S.imgState.imgW > 0) ? S.imgState.imgX : wallL;
  const imgY  = (S.imgMode && S.imgState.image && S.imgState.imgH > 0) ? S.imgState.imgY : wallTop;
  const imgDW = (S.imgMode && S.imgState.image && S.imgState.imgW > 0) ? S.imgState.imgW : wallW;
  const imgDH = (S.imgMode && S.imgState.image && S.imgState.imgH > 0) ? S.imgState.imgH : wallH;
  const imgRight = imgX + imgDW;

  let zoneY1, zoneY2;
  let imgTopMm = 0, imgBotMm = t;

  if(S.imgMode && S.imgState.scalePxPerMm && S.imgState.image){
    const rawPxPerMm = S.imgState.scalePxPerMm / (S.imgState.fitScale || 1);
    const imgHmm = rawPxPerMm > 0 ? S.imgState.image.naturalHeight / rawPxPerMm : t;
    imgTopMm = offsetMm;
    imgBotMm = offsetMm + imgHmm;
    // ALWAYS compute zone lines at absolute wall t/3 and 2t/3 boundaries,
    // expressed as fractions within the IMAGE canvas space.
    // f = (absWallBoundary - offsetMm) / imgHmm gives fraction within image.
    // Zone lines only drawn when the boundary falls inside the image.
    const f1 = imgHmm > 0 ? (t3mm       - offsetMm) / imgHmm : 1/3;
    const f2 = imgHmm > 0 ? (t3mm * 2   - offsetMm) / imgHmm : 2/3;
    zoneY1 = imgY + f1 * imgDH;
    zoneY2 = imgY + f2 * imgDH;
  } else {
    // Draw mode: zones are thirds of the WALL height
    const t3px = wallH / 3;
    zoneY1 = wallTop + t3px;
    zoneY2 = wallTop + t3px * 2;
  }

  const clipTop = (S.imgMode && S.imgState.image) ? imgY : wallTop;
  const clipBot = (S.imgMode && S.imgState.image) ? imgY + imgDH : wallTop + wallH;
  const y1c = Math.max(clipTop, Math.min(clipBot, zoneY1));
  const y2c = Math.max(clipTop, Math.min(clipBot, zoneY2));

  if(!S.imgMode){
    // ── DRAW MODE ONLY: zone fills, wall border, surface lines, dimension labels ──
    const zoneDisabled = !!(S.spec && S.spec.zone_disabled);

    if(!zoneDisabled){
      // Zone fills
      mctx.fillStyle='rgba(255,165,0,.07)';
      mctx.fillRect(wallL, clipTop, wallW, y1c - clipTop);
      mctx.fillStyle='rgba(120,90,230,.06)';
      mctx.fillRect(wallL, y1c, wallW, y2c - y1c);
      mctx.fillStyle='rgba(255,165,0,.07)';
      mctx.fillRect(wallL, y2c, wallW, clipBot - y2c);

      // Zone dividers
      mctx.setLineDash([7,4]); mctx.lineWidth=1;
      mctx.strokeStyle='rgba(0,0,0,.18)';
      mctx.beginPath(); mctx.moveTo(wallL,y1c); mctx.lineTo(wR,y1c); mctx.stroke();
      mctx.beginPath(); mctx.moveTo(wallL,y2c); mctx.lineTo(wR,y2c); mctx.stroke();
      mctx.setLineDash([]);

      // Zone labels
      mctx.font='8px Space Grotesk'; mctx.textBaseline='top'; mctx.textAlign='left';
      mctx.fillStyle='rgba(180,110,0,.55)';
      mctx.fillText('HR  OUTER \u2153', wallL+5, clipTop+5);
      mctx.fillStyle='rgba(100,60,200,.55)';
      mctx.fillText('HK  CENTRAL \u2153', wallL+5, y1c+5);
      mctx.fillStyle='rgba(180,110,0,.55)';
      mctx.fillText('HR  OUTER \u2153', wallL+5, y2c+5);
    } else {
      // Flat area mode: no zone fills, show subtle badge instead
      mctx.font='bold 9px Space Grotesk'; mctx.textBaseline='top'; mctx.textAlign='left';
      mctx.fillStyle='rgba(255,100,60,.55)';
      mctx.fillText('\u25a0  FLAT AREA MODE \u2014 No HR/HK zones', wallL+5, clipTop+5);
    }

    // Surface A / B lines
    mctx.strokeStyle='rgba(30,100,200,.5)'; mctx.lineWidth=2;
    mctx.beginPath(); mctx.moveTo(wallL,wallTop); mctx.lineTo(wR,wallTop); mctx.stroke();
    mctx.strokeStyle='rgba(30,100,200,.25)'; mctx.lineWidth=1.5;
    mctx.beginPath(); mctx.moveTo(wallL,wB); mctx.lineTo(wR,wB); mctx.stroke();

    // Wall border
    mctx.strokeStyle='rgba(0,0,0,.25)'; mctx.lineWidth=1.5;
    mctx.strokeRect(wallL,wallTop,wallW,wallH);

    // Surface labels
    mctx.font='9px Space Grotesk'; mctx.textAlign='center'; mctx.textBaseline='bottom';
    mctx.fillStyle='rgba(30,100,200,.7)';
    mctx.fillText('SURFACE A', wallL+wallW*.5, wallTop-4);
    mctx.textBaseline='top';
    mctx.fillStyle='rgba(30,100,200,.4)';
    mctx.fillText('SURFACE B', wallL+wallW*.5, wB+5);

    // Wall thickness dimension
    const dimX=wallL-28;
    mctx.strokeStyle='rgba(0,0,0,.2)'; mctx.lineWidth=1;
    mctx.beginPath(); mctx.moveTo(dimX,wallTop); mctx.lineTo(dimX,wB); mctx.stroke();
    [wallTop,wB].forEach(y=>{
      mctx.beginPath(); mctx.moveTo(dimX-4,y); mctx.lineTo(dimX+4,y); mctx.stroke();
    });
    mctx.save(); mctx.translate(dimX-10,wallTop+wallH/2); mctx.rotate(-Math.PI/2);
    mctx.fillStyle='rgba(0,0,0,.4)'; mctx.font='9px Space Grotesk'; mctx.textAlign='center';
    mctx.fillText('t = '+t+' mm',0,0); mctx.restore();

    // t/3 brackets (right)
    const bX=wR+12;
    const t3px = wallH / 3;
    mctx.strokeStyle='rgba(0,0,0,.18)'; mctx.lineWidth=1;
    [[wallTop,wallTop+t3px,'t/3','rgba(180,110,0,.6)'],
     [wallTop+t3px,wallTop+t3px*2,'t/3','rgba(100,60,200,.6)'],
     [wallTop+t3px*2,wB,'t/3','rgba(180,110,0,.6)']].forEach(([y1,y2,lbl,col])=>{
      mctx.strokeStyle=col; mctx.beginPath(); mctx.moveTo(bX,y1); mctx.lineTo(bX,y2); mctx.stroke();
      [y1,y2].forEach(y=>{ mctx.beginPath(); mctx.moveTo(bX-3,y); mctx.lineTo(bX+3,y); mctx.stroke(); });
      mctx.fillStyle=col; mctx.font='9px Space Grotesk'; mctx.textAlign='left'; mctx.textBaseline='middle';
      mctx.fillText(lbl,bX+6,(y1+y2)/2);
    });

  } else if(S.imgState.image) {
    // ── IMAGE MODE with image loaded: zone dividers on image ──────────────
    const zoneDisabledImg = !!(S.spec && S.spec.zone_disabled);
    if(!zoneDisabledImg){
      // Zone dividers — span only the image width, not the full canvas
      mctx.setLineDash([8,4]); mctx.lineWidth=1.5;
      mctx.strokeStyle='rgba(255,255,255,.55)';
      if(zoneY1 >= clipTop && zoneY1 <= clipBot){
        mctx.beginPath(); mctx.moveTo(imgX,zoneY1); mctx.lineTo(imgRight,zoneY1); mctx.stroke();
      }
      if(zoneY2 >= clipTop && zoneY2 <= clipBot){
        mctx.beginPath(); mctx.moveTo(imgX,zoneY2); mctx.lineTo(imgRight,zoneY2); mctx.stroke();
      }
      mctx.setLineDash([]);

      // Zone labels — anchored to image left edge, not canvas left
      mctx.font='bold 9px Space Grotesk'; mctx.textBaseline='top'; mctx.textAlign='left';
      const lx = imgX + 8;
      if(imgTopMm < t3mm){
        mctx.fillStyle='rgba(255,210,80,.95)';
        mctx.fillText('HR  OUTER \u2153', lx, imgY + 8);
      }
      if(imgBotMm > t3mm && imgTopMm < t3mm*2){
        mctx.fillStyle='rgba(210,170,255,.95)';
        mctx.fillText('HK  CENTRAL \u2153', lx, Math.max(imgY + 8, y1c + 8));
      }
      if(imgBotMm > t3mm*2){
        mctx.fillStyle='rgba(255,210,80,.95)';
        mctx.fillText('HR  OUTER \u2153', lx, Math.max(imgY + 8, y2c + 8));
      }
    } else {
      // Flat area mode — show badge on image, no zone lines
      mctx.font='bold 9px Space Grotesk'; mctx.textBaseline='top'; mctx.textAlign='left';
      mctx.fillStyle='rgba(255,100,60,.9)';
      mctx.fillText('\u25a0  FLAT AREA MODE \u2014 No HR/HK zones', imgX + 8, imgY + 8);
    }

    // Offset badge — top-right of image
    if(offsetMm > 0){
      mctx.save();
      mctx.font='bold 8px Space Grotesk'; mctx.fillStyle='rgba(120,200,255,.95)';
      mctx.textAlign='right'; mctx.textBaseline='top';
      mctx.fillText(`+${offsetMm.toFixed(1)} mm from Surface A`, imgRight - 6, imgY + 6);
      mctx.restore();
    }
  }

  // Datum rectangle / square
  const dr = S.datumRect;
  if(dr){
    const dp = mmToCanvas(dr.x, dr.y);
    // Use image scale in image mode, draw scale otherwise
    const drawSc = (S.imgMode && S.imgState.scalePxPerMm) ? S.imgState.scalePxPerMm : scale;
    const dw = dr.w * drawSc;
    const dh = dr.h * drawSc; // h == w (square enforced)
    mctx.fillStyle='rgba(255,173,0,.07)'; mctx.fillRect(dp.x,dp.y,dw,dh);
    mctx.setLineDash([6,4]); mctx.strokeStyle='rgba(255,173,0,.7)'; mctx.lineWidth=2;
    mctx.strokeRect(dp.x,dp.y,dw,dh); mctx.setLineDash([]);
    // Corner tick marks for square indicator
    const tk=8;
    mctx.strokeStyle='rgba(255,173,0,.9)'; mctx.lineWidth=2;
    [[dp.x,dp.y],[dp.x+dw,dp.y],[dp.x,dp.y+dh],[dp.x+dw,dp.y+dh]].forEach(([cx2,cy2])=>{
      mctx.beginPath(); mctx.moveTo(cx2,cy2+Math.sign(cy2-dp.y-dh/2)*tk); mctx.lineTo(cx2,cy2); mctx.lineTo(cx2+Math.sign(cx2-dp.x-dw/2)*tk,cy2); mctx.stroke();
    });
    mctx.fillStyle='rgba(255,173,0,.85)'; mctx.font='bold 9px Space Grotesk'; mctx.textAlign='left'; mctx.textBaseline='bottom';
    mctx.fillText('DATUM □  '+(dr.w*dr.h).toFixed(1)+'mm²  ('+dr.w.toFixed(2)+'×'+dr.h.toFixed(2)+'mm)',dp.x+4,dp.y-3);
    // ── Draw 8 resize handles when datum tool is active ──────────────────────
    if(S.tool==='datum' || S.tool==='select'){
      const drawSc2 = (S.imgMode && S.imgState.scalePxPerMm) ? S.imgState.scalePxPerMm : scale;
      const dw2 = dr.w * drawSc2, dh2 = dr.h * drawSc2;
      mctx.save();
      mctx.strokeStyle='rgba(255,173,0,.95)'; mctx.lineWidth=2; mctx.setLineDash([]);
      mctx.strokeRect(dp.x, dp.y, dw2, dh2);
      const hPts = [
        [dp.x,       dp.y],       [dp.x+dw2/2, dp.y],       [dp.x+dw2,   dp.y],
        [dp.x,       dp.y+dh2/2],                             [dp.x+dw2,   dp.y+dh2/2],
        [dp.x,       dp.y+dh2],   [dp.x+dw2/2, dp.y+dh2],   [dp.x+dw2,   dp.y+dh2],
      ];
      hPts.forEach(([hx,hy])=>{
        mctx.fillStyle='#fff'; mctx.strokeStyle='rgba(255,173,0,.95)'; mctx.lineWidth=1.5;
        mctx.fillRect(hx-4,hy-4,8,8); mctx.strokeRect(hx-4,hy-4,8,8);
      });
      mctx.restore();
    }

  } else if(!S.imgMode) {
    // Default datum centred in wall
    const dw2=Math.sqrt(S.spec.datum||100)*scale*.8;
    const dh2=((S.spec.datum||100)/dw2*scale*.8)||dw2;
    const dx=(wallW-dw2)/2+wallL, dy=wallTop+(wallH-dh2)/2;
    mctx.fillStyle='rgba(255,173,0,.03)'; mctx.fillRect(dx,dy,dw2,dh2);
    mctx.setLineDash([5,4]); mctx.strokeStyle='rgba(255,173,0,.22)'; mctx.lineWidth=1;
    mctx.strokeRect(dx,dy,dw2,dh2); mctx.setLineDash([]);
    mctx.fillStyle='rgba(255,173,0,.3)'; mctx.font='9px Space Grotesk'; mctx.textAlign='center'; mctx.textBaseline='bottom';
    mctx.fillText('DATUM □ '+S.spec.datum+'mm²',dx+dw2/2,dy-3);
  }

  // -- EXCLUSION ZONES (canvas) --
  (function(){
    var _pg=typeof activeImagePage==='function'?activeImagePage():null;
    var _ez=(_pg&&_pg.exclusionZones)||[];
    var _sc=(S.imgMode&&S.imgState.scalePxPerMm)?S.imgState.scalePxPerMm:scale;
    if(S.imgMode&&_ez.length){
      mctx.save();
      _ez.forEach(function(z,zi){
        const isSelected = (S.tool==='excl_select' && S._exclSelected===zi);
        const inEditPts  = isSelected && S._exclEditPts && S._exclEditPts.zi===zi;

        // ── Draw zone fill + hatching ─────────────────────────────────────
        if(z.type==='circle'){
          var _cp=mmToCanvas(z.cx,z.cy),_r=z.r*_sc;
          mctx.fillStyle='rgba(239,68,68,.08)';
          mctx.beginPath(); mctx.arc(_cp.x,_cp.y,_r,0,Math.PI*2); mctx.fill();
          mctx.setLineDash(isSelected?[]:[5,3]); mctx.strokeStyle=isSelected?'rgba(239,68,68,1)':'rgba(239,68,68,.6)'; mctx.lineWidth=isSelected?2:1.5;
          mctx.beginPath(); mctx.arc(_cp.x,_cp.y,_r,0,Math.PI*2); mctx.stroke(); mctx.setLineDash([]);
          mctx.strokeStyle='rgba(239,68,68,.12)'; mctx.lineWidth=0.5;
          mctx.save();
          mctx.beginPath(); mctx.arc(_cp.x,_cp.y,_r,0,Math.PI*2); mctx.clip();
          for(var _d=-_r;_d<_r*2;_d+=10){ mctx.beginPath(); mctx.moveTo(_cp.x+_d-_r,_cp.y-_r); mctx.lineTo(_cp.x+_d-_r-_r*2,_cp.y+_r); mctx.stroke(); }
          mctx.restore();
          mctx.fillStyle='rgba(239,68,68,.85)'; mctx.font='bold 8px system-ui';
          mctx.textAlign='center'; mctx.textBaseline='middle';
          mctx.fillText('EXCL #'+(zi+1),_cp.x,_cp.y);
        } else if(z.type==='polygon'){
          const pts=z.points||[];
          if(pts.length>=3){
            // Fill
            mctx.fillStyle='rgba(239,68,68,.09)';
            mctx.beginPath();
            const _pp0=mmToCanvas(pts[0].x,pts[0].y); mctx.moveTo(_pp0.x,_pp0.y);
            for(let _pi=1;_pi<pts.length;_pi++){ const _ppi=mmToCanvas(pts[_pi].x,pts[_pi].y); mctx.lineTo(_ppi.x,_ppi.y); }
            mctx.closePath(); mctx.fill();
            // Hatching inside polygon using clip
            mctx.save();
            mctx.beginPath();
            const _pp0c=mmToCanvas(pts[0].x,pts[0].y); mctx.moveTo(_pp0c.x,_pp0c.y);
            for(let _pi=1;_pi<pts.length;_pi++){ const _ppi=mmToCanvas(pts[_pi].x,pts[_pi].y); mctx.lineTo(_ppi.x,_ppi.y); }
            mctx.closePath(); mctx.clip();
            const _bb=polyBBox(pts);
            const _bbp0=mmToCanvas(_bb.minX,_bb.minY), _bbp1=mmToCanvas(_bb.maxX,_bb.maxY);
            const _span=Math.max(_bbp1.x-_bbp0.x,_bbp1.y-_bbp0.y);
            mctx.strokeStyle='rgba(239,68,68,.12)'; mctx.lineWidth=0.5;
            for(let _d=-_span;_d<_span*2;_d+=10){ mctx.beginPath(); mctx.moveTo(_bbp0.x+_d,_bbp0.y); mctx.lineTo(_bbp0.x+_d-_span,_bbp0.y+_span); mctx.stroke(); }
            mctx.restore();
            // Outline
            mctx.setLineDash(isSelected?[]:[5,3]); mctx.strokeStyle=isSelected?'rgba(239,68,68,1)':'rgba(239,68,68,.65)'; mctx.lineWidth=isSelected?2:1.5;
            mctx.beginPath();
            const _ppo=mmToCanvas(pts[0].x,pts[0].y); mctx.moveTo(_ppo.x,_ppo.y);
            for(let _pi=1;_pi<pts.length;_pi++){ const _ppi=mmToCanvas(pts[_pi].x,pts[_pi].y); mctx.lineTo(_ppi.x,_ppi.y); }
            mctx.closePath(); mctx.stroke(); mctx.setLineDash([]);
            // Label at centroid
            const _cen=polyCentroid(pts), _cenC=mmToCanvas(_cen.x,_cen.y);
            mctx.fillStyle='rgba(239,68,68,.9)'; mctx.font='bold 8px system-ui';
            mctx.textAlign='center'; mctx.textBaseline='middle';
            mctx.fillText('EXCL #'+(zi+1)+' ✦',_cenC.x,_cenC.y);
          }
        } else {
          var _p=mmToCanvas(z.x,z.y),_w=z.w*_sc,_h=z.h*_sc;
          mctx.fillStyle='rgba(239,68,68,.08)'; mctx.fillRect(_p.x,_p.y,_w,_h);
          mctx.setLineDash(isSelected?[]:[5,3]); mctx.strokeStyle=isSelected?'rgba(239,68,68,1)':'rgba(239,68,68,.6)'; mctx.lineWidth=isSelected?2:1.5;
          mctx.strokeRect(_p.x,_p.y,_w,_h); mctx.setLineDash([]);
          mctx.strokeStyle='rgba(239,68,68,.12)'; mctx.lineWidth=0.5;
          for(var _d=-Math.max(_w,_h);_d<Math.max(_w,_h)*2;_d+=10){ mctx.beginPath();mctx.moveTo(_p.x+_d,_p.y);mctx.lineTo(_p.x+_d-_h,_p.y+_h);mctx.stroke(); }
          mctx.fillStyle='rgba(239,68,68,.85)'; mctx.font='bold 8px system-ui';
          mctx.textAlign='left'; mctx.textBaseline='top';
          mctx.fillText('EXCL #'+(zi+1),_p.x+3,_p.y+2);
        }

        // ── Selection resize handles (non-edit-pts mode) ──────────────────
        if(isSelected && !inEditPts){
          mctx.save();
          mctx.strokeStyle='rgba(239,68,68,.9)'; mctx.lineWidth=2; mctx.setLineDash([]);
          if(z.type==='circle'){
            const _sp=mmToCanvas(z.cx,z.cy), _sr=z.r*_sc;
            _drawExclHandle(mctx,_sp.x,_sp.y,'#ef4444');
            _drawExclHandle(mctx,_sp.x+_sr,_sp.y,'#ef4444');
            _drawExclHandle(mctx,_sp.x-_sr,_sp.y,'#ef4444');
            _drawExclHandle(mctx,_sp.x,_sp.y-_sr,'#ef4444');
            _drawExclHandle(mctx,_sp.x,_sp.y+_sr,'#ef4444');
          } else if(z.type==='rect'){
            const _sp=mmToCanvas(z.x,z.y), _sw=z.w*_sc, _sh=z.h*_sc;
            const _hx=[_sp.x, _sp.x+_sw/2, _sp.x+_sw];
            const _hy=[_sp.y, _sp.y+_sh/2, _sp.y+_sh];
            [[0,0],[1,0],[2,0],[0,1],[2,1],[0,2],[1,2],[2,2]].forEach(([hxi,hyi])=>{ _drawExclHandle(mctx,_hx[hxi],_hy[hyi],'#ef4444'); });
          } else if(z.type==='polygon'){
            // Polygon selected but NOT in edit mode: show bounding box handles
            const pts=z.points||[];
            if(pts.length>=2){
              const _bb=polyBBox(pts);
              const _bbl=mmToCanvas(_bb.minX,_bb.minY), _bbr=mmToCanvas(_bb.maxX,_bb.maxY);
              const _bw=_bbr.x-_bbl.x, _bh=_bbr.y-_bbl.y;
              mctx.setLineDash([3,3]); mctx.strokeStyle='rgba(239,68,68,.4)'; mctx.lineWidth=1;
              mctx.strokeRect(_bbl.x,_bbl.y,_bw,_bh); mctx.setLineDash([]);
              const _hx=[_bbl.x,_bbl.x+_bw/2,_bbr.x];
              const _hy=[_bbl.y,_bbl.y+_bh/2,_bbr.y];
              [[0,0],[1,0],[2,0],[0,1],[2,1],[0,2],[1,2],[2,2]].forEach(([hxi,hyi])=>{ _drawExclHandle(mctx,_hx[hxi],_hy[hyi],'#ef4444'); });
            }
          }
          // ── Rotation handle: circle above bounding box ──────────────────
          if(S._exclRotating && S._exclRotating.zi===zi && S._exclRotating.active){
            const _rState = S._exclRotating;
            const _rCx = mmToCanvas(_rState.cx, _rState.cy);
            // Rotation handle is 36px above the topmost point
            let _topY = _rCx.y - 40;
            if(z.type==='polygon'){ const _bb2=polyBBox(z.points); _topY=mmToCanvas(_bb2.minX,_bb2.minY).y - 40; }
            else if(z.type==='circle'){ _topY=mmToCanvas(z.cx,z.cy-z.r).y-40; }
            else { _topY=mmToCanvas(z.x,z.y).y - 40; }
            // Stem line
            mctx.setLineDash([3,3]); mctx.strokeStyle='rgba(255,200,0,.7)'; mctx.lineWidth=1;
            mctx.beginPath(); mctx.moveTo(_rCx.x, _rCx.y); mctx.lineTo(_rCx.x, _topY+9); mctx.stroke(); mctx.setLineDash([]);
            // Rotation circle handle
            mctx.fillStyle='#fbbf24'; mctx.strokeStyle='rgba(255,255,255,.9)'; mctx.lineWidth=1.5;
            mctx.beginPath(); mctx.arc(_rCx.x, _topY, 9, 0, Math.PI*2); mctx.fill(); mctx.stroke();
            mctx.fillStyle='#fff'; mctx.font='bold 9px system-ui'; mctx.textAlign='center'; mctx.textBaseline='middle';
            mctx.fillText('↻', _rCx.x, _topY);
          }
          mctx.restore();
        }

        // ── Edit Points mode: vertex + midpoint handles ────────────────────
        if(inEditPts && z.type==='polygon'){
          const pts = z.points||[];
          mctx.save();
          // Draw each vertex handle (filled orange square)
          for(let _vi=0; _vi<pts.length; _vi++){
            const _vc = mmToCanvas(pts[_vi].x, pts[_vi].y);
            mctx.fillStyle='#ef4444'; mctx.strokeStyle='#fff'; mctx.lineWidth=1.5;
            mctx.fillRect(_vc.x-5,_vc.y-5,10,10);
            mctx.strokeRect(_vc.x-5,_vc.y-5,10,10);
            // Vertex index label
            if(pts.length<=16){
              mctx.fillStyle='#fff'; mctx.font='bold 7px system-ui'; mctx.textAlign='center'; mctx.textBaseline='middle';
              mctx.fillText(_vi+1, _vc.x, _vc.y);
            }
          }
          // Draw midpoint "+" handles (hollow cyan circles) for adding new vertices
          for(let _vi=0; _vi<pts.length; _vi++){
            const _vj=(_vi+1)%pts.length;
            const _mx=(pts[_vi].x+pts[_vj].x)/2, _my=(pts[_vi].y+pts[_vj].y)/2;
            const _mc=mmToCanvas(_mx,_my);
            mctx.fillStyle='rgba(30,200,255,.22)'; mctx.strokeStyle='rgba(30,200,255,.85)'; mctx.lineWidth=1.2;
            mctx.beginPath(); mctx.arc(_mc.x,_mc.y,5,0,Math.PI*2); mctx.fill(); mctx.stroke();
            mctx.fillStyle='rgba(30,200,255,.95)'; mctx.font='bold 9px system-ui'; mctx.textAlign='center'; mctx.textBaseline='middle';
            mctx.fillText('+',_mc.x,_mc.y);
          }
          // Tip label
          const _bb3=polyBBox(pts), _topC=mmToCanvas(_bb3.minX,_bb3.minY);
          mctx.fillStyle='rgba(255,255,255,.7)'; mctx.font='10px system-ui'; mctx.textAlign='left'; mctx.textBaseline='bottom';
          mctx.fillText('✏ Edit Points — Right-click to finish/delete vertex',_topC.x,_topC.y-4);
          mctx.restore();
        }
      });
      mctx.restore();
    }
    if(S._exclDraw&&S._exclDraw.active){
      mctx.save();
      if(S._exclDraw.type==='circle'){
        var _d2=S._exclDraw,_cp2=mmToCanvas(_d2.cx,_d2.cy),_r2=_d2.r*_sc;
        mctx.fillStyle='rgba(239,68,68,.12)';
        mctx.beginPath(); mctx.arc(_cp2.x,_cp2.y,_r2,0,Math.PI*2); mctx.fill();
        mctx.setLineDash([4,2]); mctx.strokeStyle='rgba(239,68,68,.8)'; mctx.lineWidth=2;
        mctx.beginPath(); mctx.arc(_cp2.x,_cp2.y,_r2,0,Math.PI*2); mctx.stroke(); mctx.setLineDash([]);
        mctx.fillStyle='rgba(239,68,68,.9)'; mctx.font='bold 9px system-ui';
        mctx.textAlign='left'; mctx.textBaseline='bottom';
        mctx.fillText('Drawing exclusion circle...',_cp2.x+_r2+4,_cp2.y);
      } else {
        var _d2=S._exclDraw,_p2=mmToCanvas(_d2.x,_d2.y);
        var _w2=_d2.w*_sc,_h2=_d2.h*_sc;
        mctx.fillStyle='rgba(239,68,68,.12)'; mctx.fillRect(_p2.x,_p2.y,_w2,_h2);
        mctx.setLineDash([4,2]); mctx.strokeStyle='rgba(239,68,68,.8)'; mctx.lineWidth=2;
        mctx.strokeRect(_p2.x,_p2.y,_w2,_h2); mctx.setLineDash([]);
        mctx.fillStyle='rgba(239,68,68,.9)'; mctx.font='bold 9px system-ui';
        mctx.textAlign='left'; mctx.textBaseline='bottom';
        mctx.fillText('Drawing exclusion zone...',_p2.x+4,_p2.y-3);
      }
      mctx.restore();
    }
  })();

  // Spacing lines: controlled by "Links" slider
  const eff = effectivePores();
  const drawnPairs = new Set();
  const linkSlider = document.getElementById('link-range');
  const maxGapSetting = linkSlider ? +linkSlider.value : 0;

  const drawGapLine = (pi, pj, gapMm, isPacking, isViolating) => {
    const pc1=mmToCanvas(pi.x,pi.y), pc2=mmToCanvas(pj.x,pj.y);
    
    // Style: Packing = Red Solid, Everything else = Orange Dashed (Original Design)
    const col = isPacking ? 'rgba(255,61,61,.55)' : 'rgba(255,173,0,.4)';
    const textCol = isPacking ? 'rgba(255,61,61,.9)' : 'rgba(255,173,0,.8)';
    const dash = isPacking ? [] : [4,3];
    const lw = isPacking ? 1.5 : 1;
    
    mctx.strokeStyle = col;
    mctx.lineWidth = lw; 
    mctx.setLineDash(dash);
    mctx.beginPath(); mctx.moveTo(pc1.x,pc1.y); mctx.lineTo(pc2.x,pc2.y); mctx.stroke();
    mctx.setLineDash([]);
    
    // Gap label (Original horizontal design)
    const mx=(pc1.x+pc2.x)/2, my=(pc1.y+pc2.y)/2-8;
    mctx.fillStyle = textCol;
    mctx.font = '9px Space Grotesk'; 
    mctx.textAlign = 'center'; 
    mctx.textBaseline = 'middle';
    mctx.fillText(gapMm.toFixed(2)+'mm', mx, my);
  };

  if(maxGapSetting === 0){
    // Nearest neighbor only
    for(let i=0;i<eff.length;i++){
      const pi=eff[i];
      let minGap = Infinity;
      let nearestJ = -1;
      
      for(let j=0;j<eff.length;j++){
        if(i===j) continue;
        const pj=eff[j];
        const distMm = Math.hypot(pi.x-pj.x, pi.y-pj.y);
        const edgeGapMm = distMm - (pi.dia/2) - (pj.dia/2);
        if(edgeGapMm < minGap){
          minGap = edgeGapMm;
          nearestJ = j;
        }
      }
      
      if(nearestJ !== -1){
        const pj = eff[nearestJ];
        const reqGap = (S.spec.a||2)*Math.min(pi.dia, pj.dia);
        if(minGap < reqGap){
          const pairKey = i < nearestJ ? `${i}-${nearestJ}` : `${nearestJ}-${i}`;
          if(!drawnPairs.has(pairKey)){
            drawnPairs.add(pairKey);
            const isPacking = minGap < Math.min(pi.dia,pj.dia);
            drawGapLine(pi, pj, minGap, isPacking, true);
          }
        }
      }
    }
  } else {
    // Show all gaps up to the slider setting (exploratory mode)
    for(let i=0;i<eff.length;i++){
      for(let j=i+1;j<eff.length;j++){
        const pi=eff[i], pj=eff[j];
        const distMm = Math.hypot(pi.x-pj.x, pi.y-pj.y);
        const edgeGapMm = distMm - (pi.dia/2) - (pj.dia/2);
        
        if(edgeGapMm <= maxGapSetting){
          const reqGap = (S.spec.a||2)*Math.min(pi.dia, pj.dia);
          const isPacking = edgeGapMm < Math.min(pi.dia,pj.dia);
          const isViolating = edgeGapMm < reqGap;
          drawGapLine(pi, pj, edgeGapMm, isPacking, isViolating);
        }
      }
    }
  }

  // Draw pores
  AP().forEach(p=>{
    drawPore(p, p.id===S.selectedId);
  });

  // Measure tool active line
  if(S.tool==='measure' && S.measurePt1 && lastMoveEvent){
    const mp=getCanvasPos(lastMoveEvent);
    const p1c=mmToCanvas(S.measurePt1.x,S.measurePt1.y);
    const dist=Math.hypot(mp.x-p1c.x,mp.y-p1c.y)/scale;
    mctx.strokeStyle='rgba(0,80,200,.8)'; mctx.lineWidth=1.5; mctx.setLineDash([5,3]);
    mctx.beginPath(); mctx.moveTo(p1c.x,p1c.y); mctx.lineTo(mp.x,mp.y); mctx.stroke();
    mctx.setLineDash([]);
    mctx.fillStyle='rgba(0,80,200,.9)'; mctx.font='11px Space Grotesk';
    mctx.textAlign='center'; mctx.textBaseline='bottom';
    mctx.fillText(dist.toFixed(3)+' mm',(p1c.x+mp.x)/2,(p1c.y+mp.y)/2-5);
    mctx.beginPath(); mctx.arc(p1c.x,p1c.y,5,0,Math.PI*2);
    mctx.fillStyle='rgba(0,150,255,.8)'; mctx.fill();
  }

  // Scale ruler (bottom-left)
  drawRuler();
  mctx.restore();

  // Force GPU Compositor refresh to fix Chrome rendering freeze bugs
  if(MC) MC.style.opacity = (MC.style.opacity === '0.999') ? '1' : '0.999';
  if(OC) OC.style.opacity = (OC.style.opacity === '0.999') ? '1' : '0.999';
}

function drawPore(p, selected){
  const {scale}=S.cv;
  const drawScale=(S.imgMode&&S.imgState.scalePxPerMm)?S.imgState.scalePxPerMm:scale;
  const r=p.dia*drawScale/2;
  const c=mmToCanvas(p.x,p.y);
  const cx=c.x, cy=c.y;
  const ignored=S.spec.u>0&&(p.dia+0.005)<S.spec.u;
  const failing=!ignored&&p.dia>S.spec.phi;
  // ── Exclusion zone crop status ────────────────────────────────────────────
  const _cs = _poreExclCropStatus(p);
  if(_cs.status === 'full'){
    // Pore is excluded or outside datum: draw full ghost only
    mctx.save();
    mctx.globalAlpha = 0.22;
    buildPath(0);
    mctx.fillStyle='rgba(100,100,100,0.12)'; mctx.fill();
    mctx.strokeStyle='#aaa'; mctx.lineWidth=1.2; mctx.setLineDash([2,3]); mctx.stroke(); mctx.setLineDash([]);
    if(r>8){
      mctx.fillStyle='#aaa'; mctx.font=`bold ${Math.max(7,Math.min(10,r*.55))}px Space Grotesk`;
      mctx.textAlign='center'; mctx.textBaseline='middle';
      mctx.fillText('✕',cx,cy);
    }
    mctx.restore();
    return;
  }
  if(_cs.status === 'partial'){
    // ── PARTIAL: pore straddles a zone boundary — draw cropped outside, ghost inside ──
    const _page = (typeof activeImagePage==='function') ? activeImagePage() : null;
    const _zones = (_page && _page.exclusionZones) || [];
    const _sc = (S.imgMode && S.imgState.scalePxPerMm) ? S.imgState.scalePxPerMm : drawScale;
    // 1. Ghost the FULL pore shape (entire area, very faint)
    mctx.save();
    mctx.globalAlpha = 0.15;
    buildPath(0);
    mctx.strokeStyle='rgba(239,68,68,0.5)'; mctx.lineWidth=1; mctx.setLineDash([2,2]); mctx.stroke(); mctx.setLineDash([]);
    mctx.restore();
    // 2. Draw the OUTSIDE portion with full color using clip
    // Build clip = datum box (or canvas) minus all exclusion zones (evenodd)
    mctx.save();
    mctx.beginPath();
    const _dr = (S.datumRect && S.datumRect.w > 0) ? S.datumRect : null;
    if(_dr){
      const dp = mmToCanvas(_dr.x, _dr.y);
      const dw = _dr.w * _sc, dh = _dr.h * _sc;
      mctx.rect(dp.x, dp.y, dw, dh);
    } else {
      mctx.rect(-10,-10,S.cv.W+20,S.cv.H+20);
    }
    _zones.forEach(z=>{
      if(z.type==='circle'){
        const zcp=mmToCanvas(z.cx,z.cy); const zr=z.r*_sc;
        mctx.moveTo(zcp.x+zr,zcp.y);
        mctx.arc(zcp.x,zcp.y,zr,0,Math.PI*2);
      } else if(z.type==='polygon'){
        const pts=z.points||[];
        if(pts.length>=3){
          const p0=mmToCanvas(pts[0].x,pts[0].y); mctx.moveTo(p0.x,p0.y);
          for(let _pi=1;_pi<pts.length;_pi++){ const _pp=mmToCanvas(pts[_pi].x,pts[_pi].y); mctx.lineTo(_pp.x,_pp.y); }
          mctx.closePath();
        }
      } else {
        const zp=mmToCanvas(z.x,z.y); const zw=z.w*_sc, zh=z.h*_sc;
        mctx.rect(zp.x,zp.y,zw,zh);
      }
    });
    mctx.clip('evenodd');
    // Now draw the pore normally within the clip
    const zoneCol2=p.zone==='hr'?'#b87000':p.zone==='hk'?'#6a3ecc':'#0099cc';
    const strokeCol2=ignored?'#999999':failing?'#cc2222':zoneCol2;
    const fillAlpha2=ignored?.10:failing?.22:.18;
    const fillBase2=ignored?'150,150,150':failing?'220,50,50':p.type==='gas'?'0,120,200':'160,100,40';
    const grad2=mctx.createRadialGradient(cx-r*.3,cy-r*.3,0,cx,cy,Math.max(1,r));
    grad2.addColorStop(0,`rgba(${fillBase2},${fillAlpha2*1.5})`);
    grad2.addColorStop(1,`rgba(${fillBase2},${fillAlpha2*.4})`);
    buildPath(0);
    if(S.imgMode){
      mctx.strokeStyle='rgba(255,255,255,0.9)'; mctx.lineWidth=4; mctx.stroke();
    }
    mctx.fillStyle=grad2; mctx.fill();
    mctx.strokeStyle=strokeCol2;
    mctx.lineWidth=S.imgMode?(selected?3.5:2):(selected?2:1.2);
    mctx.stroke();
    // Crop label
    if(r>9){
      mctx.fillStyle=strokeCol2;
      mctx.font=`${Math.max(7,Math.min(10,r*.55))}px Space Grotesk`;
      mctx.textAlign='center'; mctx.textBaseline='middle';
      mctx.fillText((_cs.effectiveDia).toFixed(2),cx,cy);
    }
    mctx.restore();
    // 3. Crop scissor badge at zone boundary crossing point
    mctx.save();
    mctx.font=`${Math.max(9,Math.min(13,r*.7))}px Arial`;
    mctx.textAlign='center'; mctx.textBaseline='middle';
    mctx.fillStyle='rgba(239,68,68,0.85)';
    mctx.fillText('✂',cx+(r*0.55),cy-(r*0.55));
    mctx.restore();
    return;
  }
  const zoneCol=p.zone==='hr'?'#b87000':p.zone==='hk'?'#6a3ecc':'#0099cc';
  const strokeCol=ignored?'#999999':failing?'#cc2222':zoneCol;
  const fillAlpha=ignored?.10:failing?.22:.18;
  const fillBase=ignored?'150,150,150':failing?'220,50,50':p.type==='gas'?'0,120,200':'160,100,40';

  // ── Build shape path ──────────────────────────────────────────────────────
  // Prefer real blob contour (auto-detected), else fallback to circle/ellipse
  function buildPath(expand){
    if(p._contour && p._contour.length>=4){
      // Real blob contour — smooth closed polyline (Catmull-Rom)
      const pts=p._contour.map(([dx,dy])=>{
        const cc=mmToCanvas(p.x+dx, p.y+dy);
        if(expand){
          // push outward from centroid by expand px
          const ex=cc.x-cx, ey=cc.y-cy;
          const dist=Math.sqrt(ex*ex+ey*ey)||1;
          return {x:cx+ex*(1+expand/dist), y:cy+ey*(1+expand/dist)};
        }
        return cc;
      });
      const n=pts.length;
      mctx.beginPath();
      mctx.moveTo((pts[0].x+pts[n-1].x)/2,(pts[0].y+pts[n-1].y)/2);
      for(let i=0;i<n;i++){
        const p0=pts[(i+n-1)%n], p1=pts[i], p2=pts[(i+1)%n];
        const mx=(p1.x+p2.x)/2, my=(p1.y+p2.y)/2;
        mctx.quadraticCurveTo(p1.x,p1.y,mx,my);
      }
      mctx.closePath();
    } else {
      // Fallback: circle
      mctx.beginPath(); mctx.arc(cx,cy,Math.max(1,r+(expand||0)),0,Math.PI*2);
    }
  }

  // ── Selection ring ────────────────────────────────────────────────────────
  if(selected){
    buildPath(6); mctx.strokeStyle='rgba(0,0,0,.15)'; mctx.lineWidth=1; mctx.stroke();
    buildPath(3); mctx.strokeStyle=strokeCol+'88'; mctx.lineWidth=1.5; mctx.stroke();
  }
  // ── Fail dashed ring ─────────────────────────────────────────────────────
  if(failing){
    buildPath(5); mctx.strokeStyle='rgba(255,61,61,.25)';
    mctx.lineWidth=2; mctx.setLineDash([3,3]); mctx.stroke(); mctx.setLineDash([]);
  }

  // ── Fill ─────────────────────────────────────────────────────────────────
  const grad=mctx.createRadialGradient(cx-r*.3,cy-r*.3,0,cx,cy,Math.max(1,r));
  grad.addColorStop(0,`rgba(${fillBase},${fillAlpha*1.5})`);
  grad.addColorStop(1,`rgba(${fillBase},${fillAlpha*.4})`);
  buildPath(0);
  if(S.imgMode){
    mctx.strokeStyle='rgba(255,255,255,0.9)'; mctx.lineWidth=4; mctx.stroke();
  }
  mctx.fillStyle=grad; mctx.fill();
  mctx.strokeStyle=strokeCol;
  mctx.lineWidth=S.imgMode?(selected?3.5:2):(selected?2:1.2);
  mctx.stroke();

  // ── Diameter label ────────────────────────────────────────────────────────
  if(r>7){
    mctx.fillStyle=strokeCol;
    mctx.font=`${Math.max(8,Math.min(11,r*.6))}px Space Grotesk`;
    mctx.textAlign='center'; mctx.textBaseline='middle';
    mctx.fillText(p.dia.toFixed(2),cx,cy);
  }
  if(ignored&&r>5){
    mctx.fillStyle='rgba(42,64,56,.9)'; mctx.font='10px Space Grotesk';
    mctx.textAlign='center'; mctx.textBaseline='middle';
    mctx.fillText('U',cx,cy);
  }
}

function drawRuler(){
  const {scale,W,wallTop,wallH}=S.cv;
  // In image mode use the calibrated scale; in draw mode use canvas scale
  const rulerScale = (S.imgMode && S.imgState.scalePxPerMm) ? S.imgState.scalePxPerMm : scale;
  // Choose a nice tick length: pick the largest power-of-2/5/10 that renders >= 60px
  const niceSteps = [0.5,1,2,5,10,20,50];
  const mmW = niceSteps.find(v => v * rulerScale >= 60) || 10;
  const px = mmW * rulerScale;

  // Position ruler below the image (or below the wall in draw mode)
  const imgBot = (S.imgMode && S.imgState.image && S.imgState.imgH > 0)
    ? S.imgState.imgY + S.imgState.imgH
    : wallTop + wallH;
  const rx = (S.imgMode && S.imgState.image && S.imgState.imgX > 0)
    ? S.imgState.imgX
    : S.cv.wallL;
  const ry = imgBot + 18;

  mctx.strokeStyle='rgba(0,0,0,.4)'; mctx.lineWidth=1.5;
  mctx.beginPath(); mctx.moveTo(rx,ry); mctx.lineTo(rx+px,ry); mctx.stroke();
  // Tick marks at 0, half, end
  [rx, rx+px/2, rx+px].forEach(x=>{
    mctx.beginPath(); mctx.moveTo(x,ry-4); mctx.lineTo(x,ry+4); mctx.stroke();
  });
  mctx.fillStyle='rgba(0,0,0,.5)'; mctx.font='bold 8px Space Grotesk';
  mctx.textAlign='center'; mctx.textBaseline='top';
  mctx.fillText('0', rx, ry+5);
  mctx.fillText(mmW >= 1 ? mmW+'mm' : (mmW*10).toFixed(0)+'×0.1mm', rx+px, ry+5);
}

// ═══════════════════════════════════════════════════
// PORE ZONE ASSIGNMENT
// ═══════════════════════════════════════════════════
function getPoreZone(p){
  // If zones are disabled (flat area mode), all pores are in 'hr' (treated uniformly)
  if(S.spec && S.spec.zone_disabled) return 'hr';

  // p.y is position within the image/wall in mm from the top of the visible area.
  // In image mode: account for imgOffsetMm so zones are relative to the full wall,
  // not relative to the cropped image frame.
  const page = (typeof activeImagePage === 'function') ? activeImagePage() : null;
  const offsetMm = (S.imgMode && page) ? (page.imgOffsetMm || 0) : 0;
  const specT = S.spec && S.spec.t ? S.spec.t : 0;

  if(S.imgMode && specT > 0){
    // Absolute wall position from Surface A
    const absY = p.y + offsetMm;
    const t3 = specT / 3;
    if(absY < 0 || absY > specT) return 'outside';
    if(absY < t3) return 'hr';
    if(absY <= t3 * 2) return 'hk';
    return 'hr'; // bottom outer third = HR
  }

  // Draw mode: y is in draw-canvas mm units (wall height from spec)
  const wH = wallHeightMm();
  const t3 = wH / 3;
  const y = p.y;
  if(y < 0 || y > wH) return 'outside';
  if(y < t3) return 'hr';
  if(y < t3 * 2) return 'hk';
  return 'hr'; // bottom outer third is also HR
}

function recomputeZones(){
  AP().forEach(p=>{ p.zone=getPoreZone(p); });
}

function toggleZoneMode(){
  S.spec.zone_disabled = !S.spec.zone_disabled;
  _syncZoneToggleUI();
  recomputeZones();
  drawCanvas(); updateLiveMetrics(); updatePoreRegistry();
  toast(S.spec.zone_disabled ? 'Zone analysis disabled — flat area mode' : 'HR/HK zone analysis enabled');
}

function _syncZoneToggleUI(){
  const on = !!(S.spec && S.spec.zone_disabled);

  // 1. Front page button
  const btn = document.getElementById('sp-zone-toggle-btn');
  const icon = document.getElementById('sp-zone-toggle-icon');
  const lbl = document.getElementById('sp-zone-toggle-lbl');
  if (btn) {
    if (on) {
      btn.style.background = 'rgba(239, 68, 68, 0.12)';
      btn.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      btn.style.color = '#ef4444';
      if (icon) icon.textContent = '✅';
      if (lbl) lbl.textContent = 'HR/HK Zones: Disabled';
    } else {
      btn.style.background = 'var(--c3)';
      btn.style.borderColor = 'var(--bd)';
      btn.style.color = 'var(--tx)';
      if (icon) icon.textContent = '🚫';
      if (lbl) lbl.textContent = 'Disable HR/HK zones';
    }
  }

  // 2. Workspace toolbar icon button (tab-strip)
  const twBtn = document.getElementById('toolbar-zone-toggle');
  const twIcon = document.getElementById('toolbar-zone-icon');
  const twLbl = document.getElementById('toolbar-zone-lbl');
  if (twBtn) {
    if (on) {
      twBtn.style.background = 'rgba(239, 68, 68, 0.15)';
      twBtn.style.borderColor = 'rgba(239, 68, 68, 0.5)';
      twBtn.style.color = '#ef4444';
      if (twIcon) twIcon.textContent = '🚫';
      if (twLbl) twLbl.textContent = 'Zones: Off';
      twBtn.title = "HR/HK zones are disabled (Flat Area Mode). Click to enable.";
    } else {
      twBtn.style.background = 'var(--c3)';
      twBtn.style.borderColor = 'var(--bd)';
      twBtn.style.color = 'var(--tx)';
      if (twIcon) twIcon.textContent = '🌐';
      if (twLbl) twLbl.textContent = 'Zones: On';
      twBtn.title = "HR/HK zones are active. Click to disable.";
    }
  }
}

// ═══════════════════════════════════════════════════
// CANVAS EVENTS
// ═══════════════════════════════════════════════════
let evtsBound=false;
function bindCanvasEvents(){
  if(evtsBound) return; evtsBound=true;
  const wrap=document.getElementById('canvas-wrap');


  // Escape key: cancel active image tool or scale input
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape'){
      // Priority 1: cancel scale input dialog
      if(document.getElementById('scale-input-overlay').style.display!=='none'){
        cancelScale();
      }
      // Priority 2: cancel crop selection (don't exit crop tool, just clear selection)
      else if(S.imgState.imgTool==='crop' && S.imgState.cropRect){
        cancelCrop();
      }
      // Priority 3: exit polygon Edit Points mode
      else if(S._exclEditPts!=null){
        S._exclEditPts=null; refreshWorkspaceUI();
        toast('Edit Points mode exited');
      }
      // Priority 4: exit rotation mode
      else if(S._exclRotating!=null){
        S._exclRotating=null; refreshWorkspaceUI();
      }
      // Priority 5: exit any active image tool
      else if(S.imgState.imgTool){
        imgToolActivate(S.imgState.imgTool); // toggles off
      }
    }
    if((e.ctrlKey||e.metaKey) && e.key==='z' && !e.shiftKey){ e.preventDefault(); undoPore(); }
    if((e.ctrlKey||e.metaKey) && (e.key==='y'||(e.shiftKey&&e.key==='z'))){ e.preventDefault(); redoPore(); }
    // Delete/Backspace: remove selected exclusion zone
    if((e.key==='Delete'||e.key==='Backspace') && S.tool==='excl_select' && S._exclSelected!=null){
      const tag=e.target.tagName;
      if(tag==='INPUT'||tag==='TEXTAREA') return;
      e.preventDefault();
      removeExclZone(S._exclSelected);
      S._exclSelected=null; S._exclEditPts=null; S._exclRotating=null;
    }
    // Shift held during scale_line draw → constrain to H/V, redraw live
    if(e.key==='Shift' && S.imgState.imgTool==='scale_line' && S.imgState.scaleDrawing){
      window._scaleShift=true; drawCanvas();
    }
  });

  // Global shift tracking for scale line constraint
  document.addEventListener('keydown', e=>{
    if(e.key==='Shift') { window._scaleShift=true;
      if(S.imgState.imgTool==='scale_line' && S.imgState.scaleDrawing) drawCanvas();
    }
  });
  document.addEventListener('keyup', e=>{
    if(e.key==='Shift') { window._scaleShift=false;
      if(S.imgState.imgTool==='scale_line' && S.imgState.scaleDrawing) drawCanvas();
    }
  });
  wrap.addEventListener('contextmenu',e=>{
    e.preventDefault();
    const p=getCanvasPos(e);
    const mm=canvasToMm(p.x,p.y);
    // ── Exclusion zone right-click: show context menu ────────────────────
    if(S.imgMode){
      const _page=activeImagePage();
      const _zones=_page?(_page.exclusionZones||[]):[];
      if(_zones.length){
        // If in polygon edit mode, check if right-clicking on a vertex
        let _ptIdx=null;
        if(S._exclEditPts!=null){
          const _epz=_zones[S._exclEditPts.zi];
          if(_epz&&_epz.type==='polygon'){
            const _epts=_epz.points||[];
            for(let _vi=0;_vi<_epts.length;_vi++){
              const _vc=mmToCanvas(_epts[_vi].x,_epts[_vi].y);
              if(Math.hypot(p.x-_vc.x,p.y-_vc.y)<=9){ _ptIdx=_vi; break; }
            }
            if(_ptIdx!=null){ showExclContextMenu(e,S._exclEditPts.zi,_ptIdx); return; }
          }
        }
        // General zone right-click
        const _zi=exclZoneAtCanvas(p.x,p.y,_zones);
        if(_zi>=0){ showExclContextMenu(e,_zi,null); return; }
      }
    }
    // Right-click on datum square → remove it
    if(S.datumRect && S.datumRect.w>0){
      const dr=S.datumRect;
      if(mm.x>=dr.x && mm.x<=(dr.x+dr.w) && mm.y>=dr.y && mm.y<=(dr.y+dr.h)){
        clearDatum(); return;
      }
    }
    const pore=poreAtCanvas(p.x,p.y);
    if(pore){ removePore(pore.id); }
  });

  wrap.addEventListener('mousedown',e=>{
    const p=getCanvasPos(e);
    
    // Pan logic: middle click OR left click in Pan mode
    // Image mode tool intercept
    if(S.imgMode && e.button===0){
      if(handleImageToolMousedown(p)) return;
      if(handleImageModeClick(p.x, p.y)) return;
      // Image drag: only when Pan tool active (so Select/Place work normally)
      if(!S.imgState.imgTool && S.imgState.image && S.tool==='pan'){
        const ix=S.imgState.imgX, iy=S.imgState.imgY, iw=S.imgState.imgW, ih=S.imgState.imgH;
        if(p.x>=ix && p.x<=ix+iw && p.y>=iy && p.y<=iy+ih){
          S.imgState.imgDragging=true;
          dragState={ type:'imgmove', startMx:p.x, startMy:p.y,
            origOffX:S.imgState.imgOffsetX, origOffY:S.imgState.imgOffsetY };
          wrap.style.cursor='move';
          return;
        }
      }
    }

    if(e.button===1 || (e.button===0 && S.tool==='pan')){
      e.preventDefault();
      dragState = { type: 'pan', startMx: p.x, startMy: p.y, origPanX: S.cv.originX, origPanY: S.cv.originY };
      isPointerDown = true;
      wrap.style.cursor = 'grabbing';
      return;
    }
    
    if(e.button!==0) return;
    const pore=poreAtCanvas(p.x,p.y);
    const mm=canvasToMm(p.x,p.y);

    if(S.tool==='select'){
      if(pore){
        S.selectedId=pore.id;
        // Begin drag
        dragState={pore, startMx:p.x, startMy:p.y, origX:pore.x, origY:pore.y};
        pushHistory();
      } else {
        S.selectedId=null;
        dragState=null;
      }
      drawCanvas(); updateLiveMetrics(); showEditPanel();
    } else if(S.tool==='place'){
      if(pore){ S.selectedId=pore.id; drawCanvas(); }
      else { placePore(mm.x, mm.y); }
    } else if(S.tool==='measure'){
      if(!S.measurePt1){ S.measurePt1=mm; drawCanvas(); }
      else { S.measurePt1=null; drawCanvas(); }
    } else if(S.tool==='excl_select'){
      // --- Exclusion zone select/move/resize/vertex-edit/rotate ---
      const _page = activeImagePage();
      const _zones = _page ? (_page.exclusionZones||[]) : [];
      // Check for handle first (resize, vertex, midpoint, rotate)
      const _hinfo = exclZoneHandleAtCanvas(p.x, p.y, _zones);
      if(_hinfo){
        S._exclSelected = _hinfo.zi;
        const _zSnap = JSON.parse(JSON.stringify(_zones[_hinfo.zi]));
        // Rotation handle
        if(_hinfo.handle==='rotate'){
          if(S._exclRotating && S._exclRotating.zi===_hinfo.zi){
            dragState={ type:'excl_rotate', zi:_hinfo.zi, startMx:p.x, startMy:p.y,
              cx:S._exclRotating.cx, cy:S._exclRotating.cy,
              origPts:S._exclRotating.origPts?JSON.parse(JSON.stringify(S._exclRotating.origPts)):null,
              origProps:S._exclRotating.origProps?JSON.parse(JSON.stringify(S._exclRotating.origProps)):null,
              zone:_zSnap };
          }
          isPointerDown=true; drawCanvas(); renderExclList(); return;
        }
        // Polygon vertex drag
        if(_hinfo.handle==='poly_vtx'){
          pushHistory();
          dragState={ type:'excl_vtx_drag', zi:_hinfo.zi, ptIdx:_hinfo.ptIdx,
            startMx:p.x, startMy:p.y, zone:_zSnap };
          isPointerDown=true; drawCanvas(); return;
        }
        // Polygon midpoint insert
        if(_hinfo.handle==='poly_mid'){
          pushHistory();
          const _mz = _zones[_hinfo.zi];
          if(_mz && _mz.type==='polygon'){
            // Insert new vertex at midpoint position, right after midIdx
            const _insertPt = { x:_hinfo.midX, y:_hinfo.midY };
            _mz.points.splice(_hinfo.midIdx+1, 0, _insertPt);
            // Now immediately drag this new vertex
            dragState={ type:'excl_vtx_drag', zi:_hinfo.zi, ptIdx:_hinfo.midIdx+1,
              startMx:p.x, startMy:p.y, zone:JSON.parse(JSON.stringify(_mz)) };
          }
          isPointerDown=true; drawCanvas(); return;
        }
        // Polygon bounding-box scale handles
        if(_hinfo.handle && _hinfo.handle.startsWith('poly_bbox_')){
          pushHistory();
          dragState={ type:'excl_poly_scale', zi:_hinfo.zi, handle:_hinfo.handle.replace('poly_bbox_',''),
            startMx:p.x, startMy:p.y, zone:_zSnap,
            origMinX:_hinfo.origMinX, origMinY:_hinfo.origMinY,
            origW:_hinfo.origW, origH:_hinfo.origH };
          isPointerDown=true; drawCanvas(); renderExclList(); return;
        }
        // Standard resize handles (circle/rect)
        pushHistory();
        dragState = { type:'excl_resize', zi:_hinfo.zi, handle:_hinfo.handle,
          startMx: p.x, startMy: p.y,
          zone: _zSnap };
        isPointerDown = true; drawCanvas(); renderExclList(); return;
      }
      // Check for zone body (move)
      const _zi = exclZoneAtCanvas(p.x, p.y, _zones);
      if(_zi >= 0){
        S._exclSelected = _zi;
        // Exit edit-pts mode if clicking a different zone
        if(S._exclEditPts && S._exclEditPts.zi !== _zi) S._exclEditPts = null;
        const _z = _zones[_zi];
        pushHistory();
        dragState = { type:'excl_move', zi:_zi,
          origZone: JSON.parse(JSON.stringify(_z)),
          startMx: p.x, startMy: p.y };
        isPointerDown = true;
      } else {
        S._exclSelected = null;
        S._exclEditPts = null;
        S._exclRotating = null;
      }
      drawCanvas(); renderExclList();
    } else if(S.tool==='exclude_rect'){
      S._exclDraw={active:true,type:'rect',ox:mm.x,oy:mm.y,x:mm.x,y:mm.y,w:0,h:0};
      isPointerDown=true; drawCanvas();
    } else if(S.tool==='exclude_circle'){
      S._exclDraw={active:true,type:'circle',ox:mm.x,oy:mm.y,cx:mm.x,cy:mm.y,r:0};
      isPointerDown=true; drawCanvas();
    } else if(S.tool==='datum' || (S.tool==='select' && S.datumRect && S.datumRect.w > 0)){
      if(S.datumRect && S.datumRect.w > 0){
        // 1. Check resize handles first
        const _dh = datumHandleAtCanvas(p.x, p.y);
        if(_dh){
          pushHistory();
          dragState = { type:'datum_resize', handle:_dh.name, startMx:p.x, startMy:p.y,
            origDatum: {...S.datumRect} };
          isPointerDown=true; wrap.style.cursor=_dh.cur; drawCanvas(); return;
        }
        // 2. Click inside body → move
        const dr=S.datumRect;
        if(mm.x>=dr.x && mm.x<=(dr.x+dr.w) && mm.y>=dr.y && mm.y<=(dr.y+dr.h)){
          if(S.tool==='datum' || !poreAtCanvas(p.x, p.y)){
            pushHistory();
            dragState={type:'datum_move', startMx:p.x, startMy:p.y, origDX:dr.x, origDY:dr.y};
            isPointerDown=true; wrap.style.cursor='move'; drawCanvas(); return;
          }
        }
      }
      if(S.tool==='datum'){
        if(S.datumRect && S.datumRect.w > 0.01){
          toast('Datum square already exists — drag handle to resize or drag inside to move. Use Clear Datum to remove.', 'info');
          return;
        }
        // 3. Outside → start drawing a NEW datum square (n square constraint)
        S.datumRect={_ox:mm.x, _oy:mm.y, x:mm.x, y:mm.y, w:0, h:0};
        isPointerDown=true; drawCanvas();
      }
    }
  });

  wrap.addEventListener('mousemove',e=>{
    lastMoveEvent=e;
    const p=getCanvasPos(e);
    const mm=canvasToMm(p.x,p.y);
    document.getElementById('sb-cursor').textContent=`x:${mm.x.toFixed(2)} y:${mm.y.toFixed(2)} mm`;
    
    // Image tool mousemove
    if(S.imgMode && handleImageToolMousemove(p)) return;
    // Image position drag
    if(S.imgState.imgDragging && dragState && dragState.type==='imgmove'){
      S.imgState.imgOffsetX = dragState.origOffX + (p.x - dragState.startMx);
      S.imgState.imgOffsetY = dragState.origOffY + (p.y - dragState.startMy);
      wrap.style.cursor='move';
      drawCanvas(); return;
    }
    // Handle panning
    if(dragState && dragState.type === 'pan') {
      S.cv.originX = dragState.origPanX + (p.x - dragState.startMx);
      S.cv.originY = dragState.origPanY + (p.y - dragState.startMy);
      drawCanvas();
      return;
    }

    // Drag selected pore — use image scale in image mode for correct 1:1 feel
    if(dragState && S.tool==='select' && dragState.pore){
      const sc = (S.imgMode && S.imgState.scalePxPerMm) ? S.imgState.scalePxPerMm : S.cv.scale;
      const dx=(p.x - dragState.startMx)/sc;
      const dy=(p.y - dragState.startMy)/sc;
      const wH=wallHeightMm(), wW=wallWidthMm();
      dragState.pore.x = dragState.origX+dx;
      dragState.pore.y = dragState.origY+dy;
      dragState.pore.zone = getPoreZone(dragState.pore);
      // rAF throttle — smooth 60fps
      if(!S._dragRaf){
        S._dragRaf=requestAnimationFrame(()=>{
          S._dragRaf=null;
          drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); showEditPanel();
        });
      }
      return;
    }
    // Datum MOVE drag
    if(dragState && dragState.type==='datum_move' && S.datumRect){
      const sc=(S.imgMode && S.imgState.scalePxPerMm)?S.imgState.scalePxPerMm:S.cv.scale;
      S.datumRect.x = dragState.origDX + (p.x-dragState.startMx)/sc;
      S.datumRect.y = dragState.origDY + (p.y-dragState.startMy)/sc;
      const a=(S.datumRect.w*S.datumRect.h).toFixed(1);
      document.getElementById('sb-datum').textContent=`${a} mm² (datum □)`;
      drawCanvas(); updateLiveMetrics(); return;
    }
    // Datum RESIZE drag
    if(dragState && dragState.type==='datum_resize' && S.datumRect){
      const sc=(S.imgMode && S.imgState.scalePxPerMm)?S.imgState.scalePxPerMm:S.cv.scale;
      const dxmm = (p.x - dragState.startMx) / sc;
      const dymm = (p.y - dragState.startMy) / sc;
      _applyDatumResize(dragState.handle, dxmm, dymm, dragState.origDatum);
      const a=(S.datumRect.w*S.datumRect.h).toFixed(1);
      document.getElementById('sb-datum').textContent=`${a} mm² (datum □)`;
      drawCanvas(); updateLiveMetrics(); return;
    }
    const pore=poreAtCanvas(p.x,p.y);
    showCanvasTip(pore,e);
    // Datum draw: enforced square (n square constraint)
    if(S.tool==='datum' && isPointerDown && S.datumRect && S.datumRect._ox!==undefined){
      const ox=S.datumRect._ox, oy=S.datumRect._oy;
      const dx=mm.x-ox, dy=mm.y-oy;
      const side=Math.max(Math.abs(dx), Math.abs(dy), 0.01);
      const nx=dx>=0 ? ox : ox - side;
      const ny=dy>=0 ? oy : oy - side;
      S.datumRect={_ox:ox,_oy:oy,x:nx,y:ny,w:side,h:side};
      document.getElementById('sb-datum').textContent=`${(side*side).toFixed(1)} mm² (datum □)`;
    }
    // Image tool mode hover cursor
    if(S.imgState.imgTool){
      wrap.style.cursor = 'crosshair';
    } else if((S.tool==='datum' || S.tool==='select') && !isPointerDown && S.datumRect && S.datumRect.w>0){
      const _dh2 = datumHandleAtCanvas(p.x, p.y);
      if(_dh2){ wrap.style.cursor = _dh2.cur; return; }
      else if(S.tool==='datum' || !poreAtCanvas(p.x, p.y)) {
        const dr2=S.datumRect;
        const _inD = mm.x>=dr2.x && mm.x<=(dr2.x+dr2.w) && mm.y>=dr2.y && mm.y<=(dr2.y+dr2.h);
        if(_inD) { wrap.style.cursor = 'move'; return; }
        else if(S.tool==='datum') { wrap.style.cursor = 'crosshair'; }
      }
    } else if(S.tool==='datum'){
      wrap.style.cursor = 'crosshair';
    }
    // excl_select: move, resize, vertex drag, rotate, scale
    if(S.tool==='excl_select' && isPointerDown && dragState){
      const _page2 = activeImagePage();
      const _zones2 = _page2 ? (_page2.exclusionZones||[]) : [];
      const _sc2 = (S.imgMode && S.imgState.scalePxPerMm) ? S.imgState.scalePxPerMm : S.cv.scale;

      // ── Move ─────────────────────────────────────────────────────────────
      if(dragState.type==='excl_move' && _zones2[dragState.zi]){
        const _dxmm = (p.x - dragState.startMx)/_sc2;
        const _dymm = (p.y - dragState.startMy)/_sc2;
        const _oz = dragState.origZone;
        const _tz = _zones2[dragState.zi];
        if(_oz.type==='circle'){
          _tz.cx = _oz.cx + _dxmm; _tz.cy = _oz.cy + _dymm;
        } else if(_oz.type==='polygon'){
          _tz.points = (_oz.points||[]).map(pt=>({x:pt.x+_dxmm,y:pt.y+_dymm}));
        } else {
          _tz.x = _oz.x + _dxmm; _tz.y = _oz.y + _dymm;
        }
        drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); renderExclList();

      // ── Standard resize ───────────────────────────────────────────────────
      } else if(dragState.type==='excl_resize' && _zones2[dragState.zi]){
        const _dxmm = (p.x - dragState.startMx)/_sc2;
        const _dymm = (p.y - dragState.startMy)/_sc2;
        _applyExclResize(_zones2[dragState.zi], dragState.handle, _dxmm, _dymm, dragState.zone);
        drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); renderExclList();

      // ── Vertex drag ───────────────────────────────────────────────────────
      } else if(dragState.type==='excl_vtx_drag' && _zones2[dragState.zi]){
        const _tz2 = _zones2[dragState.zi];
        if(_tz2.type==='polygon' && _tz2.points && dragState.ptIdx<_tz2.points.length){
          _tz2.points[dragState.ptIdx] = mm; // directly set to cursor mm position
        }
        drawCanvas(); updateLiveMetrics(); updatePoreRegistry();

      // ── Rotation ──────────────────────────────────────────────────────────
      } else if(dragState.type==='excl_rotate' && _zones2[dragState.zi]){
        const _tz3 = _zones2[dragState.zi];
        const _rcx = mmToCanvas(dragState.cx, dragState.cy);
        // Current angle from centroid to mouse
        const _curAngle = Math.atan2(p.y-_rcx.y, p.x-_rcx.x) * 180/Math.PI;
        const _startAngle = Math.atan2(dragState.startMy-_rcx.y, dragState.startMx-_rcx.x) * 180/Math.PI;
        const _delta = _curAngle - _startAngle;
        if(_tz3.type==='polygon' && dragState.origPts){
          _tz3.points = rotatePolyPoints(dragState.origPts, _delta, dragState.cx, dragState.cy);
        } else if(_tz3.type==='rect' && dragState.origProps){
          // Convert rect → polygon, then rotate
          const _rPoly = rectToPolygon(dragState.origProps);
          _rPoly.points = rotatePolyPoints(_rPoly.points, _delta, dragState.cx, dragState.cy);
          // Replace zone in-place with polygon
          _zones2[dragState.zi] = _rPoly;
          // Update dragState for next frame (still rotating)
          // (origProps stays to allow reverting)
        } else if(_tz3.type==='circle'){
          // Circle is rotationally symmetric, rotation is identity — do nothing special
        }
        drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); renderExclList();

      // ── Polygon bounding-box scale ────────────────────────────────────────
      } else if(dragState.type==='excl_poly_scale' && _zones2[dragState.zi]){
        const _tz4 = _zones2[dragState.zi];
        if(_tz4.type==='polygon' && dragState.zone.type==='polygon'){
          const _dxmm = (p.x-dragState.startMx)/_sc2;
          const _dymm = (p.y-dragState.startMy)/_sc2;
          const _origPts = dragState.zone.points||[];
          const _oW = dragState.origW, _oH = dragState.origH;
          const _oMinX = dragState.origMinX, _oMinY = dragState.origMinY;
          const h = dragState.handle;
          // Determine new width/height from handle direction
          let _nW=_oW, _nH=_oH, _nMinX=_oMinX, _nMinY=_oMinY;
          if(h.includes('e')){ _nW=Math.max(0.5,_oW+_dxmm); }
          if(h.includes('w')){ _nMinX=_oMinX+_dxmm; _nW=Math.max(0.5,_oW-_dxmm); }
          if(h.includes('s')){ _nH=Math.max(0.5,_oH+_dymm); }
          if(h.includes('n')){ _nMinY=_oMinY+_dymm; _nH=Math.max(0.5,_oH-_dymm); }
          // Scale each point proportionally
          const _scX = _oW>0 ? _nW/_oW : 1;
          const _scY = _oH>0 ? _nH/_oH : 1;
          _tz4.points = _origPts.map(pt=>({
            x: _nMinX + (pt.x-_oMinX)*_scX,
            y: _nMinY + (pt.y-_oMinY)*_scY
          }));
        }
        drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); renderExclList();
      }
      // Update cursor based on hover
      const _hov = exclZoneHandleAtCanvas(p.x, p.y, _zones2);
      if(_hov) wrap.style.cursor = _hov.cursor;
      else { const _zi2 = exclZoneAtCanvas(p.x,p.y,_zones2); wrap.style.cursor = _zi2>=0?'move':'default'; }
      return;
    }
    // excl_select: hover cursor (no drag)
    if(S.tool==='excl_select' && !isPointerDown){
      const _page3 = activeImagePage();
      const _zones3 = _page3 ? (_page3.exclusionZones||[]) : [];
      const _hov2 = exclZoneHandleAtCanvas(p.x, p.y, _zones3);
      if(_hov2) wrap.style.cursor = _hov2.cursor;
      else { const _zi3 = exclZoneAtCanvas(p.x,p.y,_zones3); wrap.style.cursor = _zi3>=0?'move':'default'; }
    }
    if(S.tool==='exclude_rect'&&isPointerDown&&S._exclDraw&&S._exclDraw.active){
      var _emx=mm.x-S._exclDraw.ox,_emy=mm.y-S._exclDraw.oy;
      S._exclDraw.x=_emx>=0?S._exclDraw.ox:mm.x; S._exclDraw.y=_emy>=0?S._exclDraw.oy:mm.y;
      S._exclDraw.w=Math.abs(_emx); S._exclDraw.h=Math.abs(_emy);
      drawCanvas();
    }
    if(S.tool==='exclude_circle'&&isPointerDown&&S._exclDraw&&S._exclDraw.active){
      const dx=mm.x-S._exclDraw.ox, dy=mm.y-S._exclDraw.oy;
      S._exclDraw.r=Math.sqrt(dx*dx+dy*dy);
      drawCanvas();
    }
    if(S.tool==='measure') drawCanvas();
    if(isPointerDown&&S.tool==='datum') drawCanvas();
  });

  wrap.addEventListener('mouseup',e=>{
    const p=getCanvasPos(e);
    if(S.imgState.imgDragging){ S.imgState.imgDragging=false; wrap.style.cursor='default'; isPointerDown=false; dragState=null; return; }
    if(S.imgMode && handleImageToolMouseup(p)){ isPointerDown=false; dragState=null; return; }
    if(dragState && dragState.type==='datum_move'){
      isPointerDown=false; dragState=null; wrap.style.cursor='default';
      // Sync global S.datumRect to per-page datumRect so export always reads latest position
      const _movePage = activeImagePage(); if(_movePage) _movePage.datumRect = S.datumRect;
      refreshWorkspaceUI(); return;
    }
    if(dragState && dragState.type==='datum_resize'){
      isPointerDown=false; dragState=null; wrap.style.cursor='default';
      refreshWorkspaceUI();
      const page=activeImagePage(); if(page) page.datumRect=S.datumRect;
      return;
    }
    if(dragState && (dragState.type==='excl_move'||dragState.type==='excl_resize'
      ||dragState.type==='excl_vtx_drag'||dragState.type==='excl_rotate'||dragState.type==='excl_poly_scale')){
      isPointerDown=false;
      // After rotation, update S._exclRotating origin so handle redraws correctly
      if(dragState.type==='excl_rotate' && S._exclRotating){
        const _page3=activeImagePage();
        if(_page3&&_page3.exclusionZones&&_page3.exclusionZones[dragState.zi]){
          const _tz5=_page3.exclusionZones[dragState.zi];
          if(_tz5.type==='polygon'){
            const _nc=polyCentroid(_tz5.points);
            S._exclRotating.cx=_nc.x; S._exclRotating.cy=_nc.y;
            S._exclRotating.origPts=JSON.parse(JSON.stringify(_tz5.points));
          }
        }
      }
      dragState=null;
      refreshWorkspaceUI();
      return;
    }
    isPointerDown=false; dragState=null;
    if(S.tool==='exclude_rect'&&S._exclDraw&&S._exclDraw.active&&S._exclDraw.w>0.05&&S._exclDraw.h>0.05){
      var _eu=S._exclDraw,_pu=activeImagePage();
      if(!_pu){ toast('Load an image first to draw exclusion zones','warn'); S._exclDraw=null; refreshWorkspaceUI(); }
      else {
        // Snapshot history BEFORE adding the zone so Undo can remove it
        pushHistory();
        if(!_pu.exclusionZones)_pu.exclusionZones=[];
        _pu.exclusionZones.push({type:'rect',x:_eu.x,y:_eu.y,w:_eu.w,h:_eu.h});
        S._exclDraw=null; updateExclZoneBadge(); renderExclList();
        toast('Excl. zone #'+_pu.exclusionZones.length+' added ('+_eu.w.toFixed(1)+'×'+_eu.h.toFixed(1)+' mm) — Undo to remove');
        refreshWorkspaceUI();
      }
    } else if(S.tool==='exclude_circle'&&S._exclDraw&&S._exclDraw.active&&S._exclDraw.r>0.05){
      var _eu=S._exclDraw,_pu=activeImagePage();
      if(!_pu){ toast('Load an image first to draw exclusion zones','warn'); S._exclDraw=null; refreshWorkspaceUI(); }
      else {
        // Snapshot history BEFORE adding the zone so Undo can remove it
        pushHistory();
        if(!_pu.exclusionZones)_pu.exclusionZones=[];
        _pu.exclusionZones.push({type:'circle',cx:_eu.cx,cy:_eu.cy,r:_eu.r});
        S._exclDraw=null; updateExclZoneBadge(); renderExclList();
        toast('Excl. zone #'+_pu.exclusionZones.length+' added (Circle r='+_eu.r.toFixed(1)+' mm) — Undo to remove');
        refreshWorkspaceUI();
      }
    } else if(S._exclDraw){S._exclDraw=null; refreshWorkspaceUI();}
    if(S.tool==='pan') wrap.style.cursor='grab'; else wrap.style.cursor='default';
    // If datum was just drawn, show the clear button, auto-switch to Place Pore, and recalculate
    if(S.tool==='datum' && S.datumRect && S.datumRect.w>0.01){
      // Sync newly-drawn datum to per-page datumRect for export consistency
      const _drawPage = activeImagePage();
      if(_drawPage){ _drawPage.datumRect = {x:S.datumRect.x, y:S.datumRect.y, w:S.datumRect.w, h:S.datumRect.h}; }
      const btn=document.getElementById('btn-clear-datum');
      if(btn) btn.style.display='inline-flex';
      refreshWorkspaceUI();
      toast('Datum □ set — '+S.datumRect.w.toFixed(2)+'×'+S.datumRect.h.toFixed(2)+'mm · Now place pores or evaluate');
    }
  });

  // Double-click: instantly select pore + open edit panel
  wrap.addEventListener('dblclick',e=>{
    const p=getCanvasPos(e);
    const pore=poreAtCanvas(p.x,p.y);
    if(pore){
      S.selectedId=pore.id;
      setTool('select');
      refreshWorkspaceUI();
    } else {
      S.selectedId=null;
      refreshWorkspaceUI();
      const ep=document.getElementById('pore-edit-panel');
      if(ep) ep.style.display='none';
    }
  });

  // Close advanced dropdown when clicking outside
  document.addEventListener('click',e=>{
    const adv=document.getElementById('detect-advanced');
    const btn=document.getElementById('btn-adv-toggle');
    if(adv && adv.style.display==='flex' && !adv.contains(e.target) && e.target!==btn){
      adv.style.display='none';
      if(btn) btn.style.background='';
    }
  });

  wrap.addEventListener('wheel',e=>{
    e.preventDefault();
    const p=getCanvasPos(e);
    const pore=poreAtCanvas(p.x,p.y);
    if(pore && (S.tool==='place'||S.tool==='select')){
      // scroll over a pore → resize it
      pushHistory();
      pore.dia=+(Math.max(.1,Math.min(6, pore.dia-(e.deltaY>0?.1:-.1))).toFixed(2));
      pore.zone=getPoreZone(pore);
      drawCanvas(); updateLiveMetrics(); updatePoreRegistry();
    } else {
      // scroll over empty area → zoom entire view toward cursor
      zoom(e.deltaY>0?1/1.15:1.15, p.x, p.y);
    }
  },{passive:false});

  wrap.addEventListener('mouseleave',()=>{ hideTip(); });
}

function getCanvasPos(e){
  const wrap=document.getElementById('canvas-wrap');
  const r=wrap.getBoundingClientRect();
  return {x:e.clientX-r.left, y:e.clientY-r.top};
}

function poreAtCanvas(cx,cy){
  const {scale}=S.cv;
  const hitScale=(S.imgMode && S.imgState.scalePxPerMm)?S.imgState.scalePxPerMm:scale;
  const extra = S.imgMode ? 14 : 4;
  return AP().slice().reverse().find(p=>{
    const c=mmToCanvas(p.x,p.y);
    return Math.hypot(cx-c.x,cy-c.y)<=p.dia*hitScale/2+extra;
  })||null;
}

// ═══════════════════════════════════════════════════
// PORE OPERATIONS
// refreshWorkspaceUI is defined at line 328

function placePore(mx,my){
  // Clamp within wall
  const wH=wallHeightMm(), wW=wallWidthMm();
  const x=Math.max(0,Math.min(wW,mx));
  const y=Math.max(0,Math.min(wH,my));
  pushHistory();
  const pore={id:Date.now()+Math.random(), x, y, dia:S.nextPhi, type:S.poreType, zone:''};
  pore.zone=getPoreZone(pore);
  AP().push(pore);
  refreshWorkspaceUI();
  document.getElementById('btn-undo').disabled=false;
}

function addManualPore(){
  const dia=+document.getElementById('me-phi').value||0;
  const dep=+document.getElementById('me-dep').value;
  const hpos=+document.getElementById('me-hpos').value;
  if(!dia||dia<=0){ toast('Enter a valid diameter','warn'); return; }
  // Ensure canvas is initialized
  if(!mctx){ initCanvas(); }
  const wH=wallHeightMm()||10;
  const wW=wallWidthMm()||20;
  const depVal = (dep===''||isNaN(dep)) ? 50 : dep;
  const hposVal = (hpos===''||isNaN(hpos)) ? 50 : hpos;
  const y=(depVal/100)*wH;
  const x=(hposVal/100)*wW;
  pushHistory();
  const pore={id:Date.now()+Math.random(), x, y, dia, type:S.poreType, zone:''};
  pore.zone=getPoreZone(pore);
  AP().push(pore);
  refreshWorkspaceUI();
  // Clear all fields
  document.getElementById('me-phi').value='';
  document.getElementById('me-dep').value='';
  document.getElementById('me-hpos').value='';
  document.getElementById('btn-undo').disabled=false;
}

function removePore(id){
  pushHistory();
  setAP(AP().filter(p=>p.id!==id));
  if(S.selectedId===id) S.selectedId=null;
  refreshWorkspaceUI();
}

function clearAllPores(){
  if(!AP().length) return;
  pushHistory();
  setAP([]); S.selectedId=null;
  refreshWorkspaceUI();
}

function _snapImgState(){
  // Snapshot the parts of imgState that can be undone
  return {
    src:     S.imgState.image ? S.imgState.image.src : null,
    scalePxPerMm: S.imgState.scalePxPerMm,
    scaleLine:    S.imgState.scaleLine ? {...S.imgState.scaleLine} : null,
    scaleRect:    S.imgState.scaleRect ? {...S.imgState.scaleRect} : null,
    autoDetected: S.imgState.autoDetected
  };
}

function _restoreImgState(snap, cb){
  if(!snap) { if(cb) cb(); return; }
  S.imgState.scalePxPerMm = snap.scalePxPerMm;
  S.imgState.scaleLine    = snap.scaleLine;
  S.imgState.scaleRect    = snap.scaleRect;
  S.imgState.autoDetected = !!snap.autoDetected;
  if(snap.src && (!S.imgState.image || S.imgState.image.src !== snap.src)){
    const img = new Image();
    img.onload = () => { S.imgState.image = img; S.imgState.cacheValid=false; if(cb) cb(); };
    img.src = snap.src;
  } else {
    if(!snap.src) S.imgState.image = null;
    if(cb) cb();
  }
  // Update scale pill
  const info = document.getElementById('img-scale-info');
  if(snap.scalePxPerMm && info){
    info.style.display='inline-flex';
    info.textContent=`Scale: ${(1/snap.scalePxPerMm).toFixed(4)} mm/px  ·  ${snap.scalePxPerMm.toFixed(2)} px/mm`;
  } else if(info){ info.style.display='none'; }
}

function pushHistory(){
  const _page = (typeof activeImagePage==='function') ? activeImagePage() : null;
  S.history.push({
    pores:     JSON.parse(JSON.stringify(S.pores)),
    imgPores:  JSON.parse(JSON.stringify(S.imgPores)),
    img:       _snapImgState(),
    exclZones: JSON.parse(JSON.stringify(_page?.exclusionZones || []))
  });
  // Trim history — keep 20 states max (image DataURLs are large)
  while(S.history.length>20) S.history.shift();
  S.redoHistory = [];
  document.getElementById('btn-undo').disabled=false;
  document.getElementById('btn-redo').disabled=true;
}

function undoPore(){
  if(!S.history.length) return;
  const _curPage = (typeof activeImagePage==='function') ? activeImagePage() : null;
  S.redoHistory.push({
    pores:     JSON.parse(JSON.stringify(S.pores)),
    imgPores:  JSON.parse(JSON.stringify(S.imgPores)),
    img:       _snapImgState(),
    exclZones: JSON.parse(JSON.stringify(_curPage?.exclusionZones || []))
  });
  const prev = S.history.pop();
  S.pores    = prev.pores    || [];
  S.imgPores = prev.imgPores || [];
  activeSpecTab().drawPores = S.pores;
  const _undoPage = activeImagePage();
  _undoPage.pores = S.imgPores;
  // Restore exclusion zones for this page
  _undoPage.exclusionZones = JSON.parse(JSON.stringify(prev.exclZones || []));
  recomputeZones();
  S.selectedId=null;
  if(typeof updateExclZoneBadge==='function') updateExclZoneBadge();
  if(typeof renderExclList==='function') renderExclList();
  _restoreImgState(prev.img, ()=>{ drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); });
  if(!S.history.length) document.getElementById('btn-undo').disabled=true;
  document.getElementById('btn-redo').disabled=false;
}

function redoPore(){
  if(!S.redoHistory.length) return;
  const _curPage2 = (typeof activeImagePage==='function') ? activeImagePage() : null;
  S.history.push({
    pores:     JSON.parse(JSON.stringify(S.pores)),
    imgPores:  JSON.parse(JSON.stringify(S.imgPores)),
    img:       _snapImgState(),
    exclZones: JSON.parse(JSON.stringify(_curPage2?.exclusionZones || []))
  });
  const next = S.redoHistory.pop();
  S.pores    = next.pores    || [];
  S.imgPores = next.imgPores || [];
  activeSpecTab().drawPores = S.pores;
  const _redoPage = activeImagePage();
  _redoPage.pores = S.imgPores;
  // Restore exclusion zones for this page
  _redoPage.exclusionZones = JSON.parse(JSON.stringify(next.exclZones || []));
  recomputeZones();
  S.selectedId=null;
  if(typeof updateExclZoneBadge==='function') updateExclZoneBadge();
  if(typeof renderExclList==='function') renderExclList();
  _restoreImgState(next.img, ()=>{ drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); });
  if(!S.redoHistory.length) document.getElementById('btn-redo').disabled=true;
  document.getElementById('btn-undo').disabled=false;
}

function loadSamplePores(){
  pushHistory();
  S.pores=[];
  activeSpecTab().drawPores=S.pores;
  if (!S.imgState.image) {
    S.cv.wallH = 300;
    S.cv.wallW = 600;
    S.cv.scale = 50;
    S.imgState.scalePxPerMm = 50;
  }
  const wH=wallHeightMm(), wW=wallWidthMm();
  const t3=wH/3;
  const samples=[
    // HR top zone
    {xRel:.12,y:t3*.2,dia:.4,type:'gas'},  {xRel:.28,y:t3*.35,dia:.8,type:'gas'},
    {xRel:.48,y:t3*.15,dia:.6,type:'gas'}, {xRel:.65,y:t3*.4,dia:1.1,type:'shrink'},
    {xRel:.82,y:t3*.25,dia:.3,type:'gas'},
    // HK central zone
    {xRel:.2,y:t3+t3*.3,dia:1.4,type:'shrink'}, {xRel:.4,y:t3+t3*.5,dia:.9,type:'gas'},
    {xRel:.58,y:t3+t3*.65,dia:1.7,type:'shrink'},{xRel:.72,y:t3+t3*.4,dia:.5,type:'gas'},
    {xRel:.88,y:t3+t3*.6,dia:.8,type:'shrink'},
    // HR bottom zone
    {xRel:.25,y:t3*2+t3*.4,dia:.5,type:'gas'},  {xRel:.6,y:t3*2+t3*.6,dia:.7,type:'gas'},
  ];
  samples.forEach((s,i)=>{
    S.pores.push({id:i, x:s.xRel*wW, y:s.y, dia:s.dia, type:s.type, zone:getPoreZone({y:s.y})});
  });
  if(S.imgMode){
    S.imgPores = JSON.parse(JSON.stringify(S.pores));
    const page = activeImagePage();
    if(page) page.pores = S.imgPores;
  }
  drawCanvas(); updateLiveMetrics(); updatePoreRegistry();
  document.getElementById('btn-undo').disabled=false;
}

// ═══════════════════════════════════════════════════
// PORE TYPE / TOOL
// ═══════════════════════════════════════════════════
function setPoreType(t){
  S.poreType=t;
  ['gas','shrink'].forEach(tt=>{
    const b=document.getElementById('type-'+tt);
    if(b) b.classList.toggle('on',tt===t);
  });
}
function setTool(t){
  S.tool=t; S.measurePt1=null;
  // Clear excl selection/edit state if leaving excl_select
  if(t!=='excl_select'){ S._exclSelected=null; S._exclEditPts=null; S._exclRotating=null; }
  ['place','select','measure','datum','pan'].forEach(tt=>{
    const b=document.getElementById('tool-'+tt);
    if(b) b.classList.toggle('on',tt===t);
  });
  const exclRect = document.getElementById('btn-excl-rect');
  if(exclRect) exclRect.classList.toggle('on', t==='exclude_rect');
  const exclCircle = document.getElementById('btn-excl-circle');
  if(exclCircle) exclCircle.classList.toggle('on', t==='exclude_circle');
  const exclSel = document.getElementById('btn-excl-select');
  if(exclSel) exclSel.classList.toggle('on', t==='excl_select');

  const hints={
    place:'Click to place pore · Scroll over pore: resize · Right-click: delete',
    select:'Click pore to select + drag to move · Scroll over pore: resize · Edit panel appears below registry',
    measure:'Click point 1, then point 2 to measure edge-to-edge distance',
    datum:'Click and drag to define datum area rectangle',
    exclude_rect:'Click and drag to define rectangular exclusion zone',
    exclude_circle:'Click and drag/extend to define circular exclusion zone',
    excl_select:'Click a zone to select · Drag to move · Drag corner handles to resize · Delete key to remove',
    pan:'Click and drag to pan the canvas'
  };
  document.getElementById('canvas-hint').textContent=hints[t] || '';
  document.getElementById('sb-tool').textContent=t.toUpperCase();
  const wrap=document.getElementById('canvas-wrap');
  const cursors={place:'crosshair',select:'grab',measure:'crosshair',datum:'cell',exclude_rect:'crosshair',exclude_circle:'crosshair',excl_select:'default',pan:'grab'};
  wrap.style.cursor=cursors[t] || 'default';
  // Hide edit panel when leaving select mode
  if(t!=='select'){ const ep=document.getElementById('pore-edit-panel'); if(ep) ep.style.display='none'; }
  // Refresh excl list to show/hide edit panel
  if(typeof renderExclList==='function') renderExclList();
}

// ═══════════════════════════════════════════════════
// TOOLTIP
// ═══════════════════════════════════════════════════
function showCanvasTip(pore, e){
  const tip=document.getElementById('ctip');
  if(!pore){ hideTip(); return; }
  const ignored=S.spec.u>0&&(pore.dia+0.005)<S.spec.u;
  const failing=!ignored&&pore.dia>S.spec.phi;
  const zone=pore.zone;
  const meta=pore._detectMeta;
  const typeLine=meta
    ? `Type: ${(pore.type||'gas').toUpperCase()} (${Math.round((meta.confidence||0)*100)}% conf)`
    : `Type: ${(pore.type||'gas').toUpperCase()}`;
  tip.style.display='block';
  tip.style.left=(e.offsetX+16)+'px';
  tip.style.top=(e.offsetY-10)+'px';
  document.getElementById('ctip-title').textContent='Ø '+pore.dia.toFixed(2)+' mm · '+pore.type;
  document.getElementById('ctip-title').style.color=failing?'var(--red)':zone==='hr'?'var(--amb)':zone==='hk'?'var(--pur)':'var(--g)';
  document.getElementById('ctip-rows').innerHTML=
    `<div style="color:var(--muted);margin-top:3px;line-height:1.7">`+
    `${typeLine}<br>Zone: ${zone.toUpperCase()}<br>Status: ${ignored?'IGNORED (< U)':failing?'FAIL > Φ':'PASS'}<br>`+
    `Pos: x:${pore.x.toFixed(2)} y:${pore.y.toFixed(2)} mm</div>`;
}
function hideTip(){ document.getElementById('ctip').style.display='none'; }

// ═══════════════════════════════════════════════════
// PORE REGISTRY
// ═══════════════════════════════════════════════════
function updatePoreRegistry(){
  const reg=document.getElementById('pore-registry');
  const eff=effectivePores();
  const evalPores=getPoresForEvaluation(AP());
  const hasDatum=S.datumRect && S.datumRect.w>0;
  const _exclN = AP().filter(p=>_poreInExclZone(p)).length;
  const _exclSuffix = _exclN > 0 ? ` · ${_exclN} excl` : '';
  const countTxt=hasDatum
    ? `${AP().length} total · ${evalPores.length} in datum · ${eff.length} effective${_exclSuffix}`
    : `${AP().length} pores (${eff.length} effective${_exclSuffix})`;
  document.getElementById('reg-count').textContent=countTxt;
  const poreCountEl=document.getElementById('tb-pores');
  if(poreCountEl) poreCountEl.textContent=AP().length;
  renderImageTabs();
  if(!AP().length){
    reg.innerHTML='<div style="font-size:10px;color:var(--dim);text-align:center;padding:16px">No pores · click canvas to place</div>';
    return;
  }
  reg.innerHTML=AP().map((p,i)=>{
    const ignored=S.spec.u>0&&(p.dia+0.005)<S.spec.u;
    const fail=!ignored&&p.dia>S.spec.phi;
    const zCol=p.zone==='hr'?'var(--amb)':p.zone==='hk'?'var(--pur)':'var(--g)';
    const tCol=p.type==='gas'?'#4db8f5':'#c88c5a';
    const sel=S.selectedId===p.id;
    // Check if pore is outside datum square
    const outDatum=hasDatum&&!_poreOverlapsDatum(p, S.datumRect);
    // Check crop status
    const _cs = _poreExclCropStatus(p);
    const exclMasked = (_cs.status === 'full');
    const isCropped = (_cs.status === 'partial');
    const rowOpacity = exclMasked ? 'opacity:.35' : '';
    const statusBadge = exclMasked
      ? (outDatum ? '<span style="font-size:9px;color:var(--dim);background:var(--c4);padding:1px 4px;border-radius:3px">OUT</span>' : '<span style="font-size:8px;font-weight:700;color:#ef4444;background:rgba(239,68,68,.12);padding:1px 5px;border-radius:3px;border:1px solid rgba(239,68,68,.3)">EXCL</span>')
      : isCropped ? `<span style="font-size:8px;font-weight:700;color:#f59e0b;background:rgba(245,158,11,.12);padding:1px 5px;border-radius:3px;border:1px solid rgba(245,158,11,.3)">CROP (${_cs.effectiveDia.toFixed(2)}mm)</span>`
      : ignored  ? '<span style="font-size:9px;color:var(--dim)">IGN</span>'
      : fail     ? '<span style="font-size:9px;color:var(--red)">FAIL</span>'
      :             '<span style="font-size:9px;color:var(--dim)">—</span>';
    return `<div class="pr-item${sel?' sel':''}" onclick="selectPore(${JSON.stringify(p.id)})" style="${rowOpacity}">
      <div class="pr-dot" style="background:${exclMasked?'#aaa':tCol};opacity:${exclMasked?.3:ignored?.3:1}"></div>
      <span style="font-variant-numeric:tabular-nums;font-size:10px;color:${exclMasked?'var(--dim)':fail?'var(--red)':ignored?'var(--dim)':'var(--tx)'}">
        #${i+1} Ø${p.dia.toFixed(2)}mm</span>
      <span style="font-size:9px;color:${exclMasked?'var(--dim)':zCol};font-weight:700">${p.zone.toUpperCase()}</span>
      ${statusBadge}
      <button class="pr-del" onclick="event.stopPropagation();removePore(${JSON.stringify(p.id)})">×</button>
    </div>`;
  }).join('');
}

function selectPore(id){
  S.selectedId=S.selectedId===id?null:id;
  // Switch to Select tool so user can drag/edit the pore
  if(S.selectedId && S.tool==='place') setTool('select');
  drawCanvas(); updatePoreRegistry(); showEditPanel();
  // Scroll edit panel into view
  if(S.selectedId){
    const ep=document.getElementById('pore-edit-panel');
    if(ep && ep.style.display!=='none') ep.scrollIntoView({behavior:'smooth',block:'nearest'});
  }
}

// ── PORE EDIT PANEL ──────────────────────────────
let preEditState = null;
function showEditPanel(){
  const ep=document.getElementById('pore-edit-panel');
  if(!ep) return;
  const p=AP().find(p=>p.id===S.selectedId);
  if(!p){ ep.style.display='none'; return; }
  ep.style.display='block';
  document.getElementById('ep-phi').value=p.dia.toFixed(2);
  document.getElementById('ep-x').value=p.x.toFixed(2);
  document.getElementById('ep-y').value=p.y.toFixed(2);
  // Also populate type if field exists
  const epType=document.getElementById('ep-type');
  if(epType) epType.value=p.type||'gas';
  preEditState = JSON.stringify(AP());
  // Scroll into view after render
  requestAnimationFrame(()=>ep.scrollIntoView({behavior:'smooth',block:'nearest'}));
}

function applyEditPanelLive(){
  const p=AP().find(p=>p.id===S.selectedId);
  if(!p) return;
  const newDia=+document.getElementById('ep-phi').value;
  const newX=+document.getElementById('ep-x').value;
  const newY=+document.getElementById('ep-y').value;
  if(newDia>0) p.dia=+newDia.toFixed(2);
  const wH=wallHeightMm(), wW=wallWidthMm();
  p.x=Math.max(0,Math.min(wW,newX));
  p.y=Math.max(0,Math.min(wH,newY));
  p.zone=getPoreZone(p);
  refreshWorkspaceUI();
}

function pushHistoryLive(){
  if(preEditState){
    // Restore snapshot of the active pore array from before edit started
    const snap = JSON.parse(preEditState);
    const entry = {
      pores:    S.imgMode ? JSON.parse(JSON.stringify(S.pores)) : snap,
      imgPores: S.imgMode ? snap : JSON.parse(JSON.stringify(S.imgPores)),
      img:      null
    };
    S.history.push(entry);
    while(S.history.length>20) S.history.shift();
    S.redoHistory=[];
    document.getElementById('btn-undo').disabled=false;
    document.getElementById('btn-redo').disabled=true;
    preEditState = JSON.stringify(AP());
  }
}

// ═══════════════════════════════════════════════════
// METRICS — correct calculations
// ═══════════════════════════════════════════════════
function effectivePores(){
  let _ap=AP();
  const _pg = (typeof activeImagePage==='function') ? activeImagePage() : null;
  const dr = (_pg && _pg.datumRect && _pg.datumRect.w > 0) ? _pg.datumRect : (S.datumRect && S.datumRect.w > 0 ? S.datumRect : null);
  // Normalise cropped pores: use effective dia for area calcs, keep original for U filter
  const normalised = _ap.map(p=>{
    const cs = _poreExclCropStatus(p, _pg);
    if(cs.status==='full') return null; // fully excluded
    const rawDia = p._rawDia || p.dia;
    if(cs.status==='partial') return Object.assign({}, p, {dia: cs.effectiveDia, _rawDia: rawDia, _isCropped:true});
    return Object.assign({}, p, {_rawDia: rawDia});
  }).filter(Boolean);
  // Filter by ORIGINAL measured diameter (before cropping), not by the clipped effective dia
  return S.spec.u>0 ? normalised.filter(p=>((p._rawDia||p.dia)+0.005)>=S.spec.u) : normalised;
}


// ── Effective datum: image area in image-mode, spec datum in draw-mode ───────

// ── Image-mode aware wall dimensions ─────────────────────────────────────────
function getEffectiveWallH(){
  if(S.imgMode && S.imgState.image && S.imgState.scalePxPerMm && S.imgState.fitScale){
    const natPxMm=S.imgState.scalePxPerMm/(S.imgState.fitScale||1);
    return S.imgState.image.naturalHeight/natPxMm;
  }
  return wallHeightMm()||S.spec.t||6;
}
function getEffectiveWallW(){
  if(S.imgMode && S.imgState.image && S.imgState.scalePxPerMm && S.imgState.fitScale){
    const natPxMm=S.imgState.scalePxPerMm/(S.imgState.fitScale||1);
    return S.imgState.image.naturalWidth/natPxMm;
  }
  return wallWidthMm()||20;
}
function getEffectiveDatum(){
  const _page = (typeof activeImagePage==='function') ? activeImagePage() : null;
  let base = S.spec.datum || 100;
  // Priority 1: user drew a datum square
  const dr = (_page && _page.datumRect && _page.datumRect.w > 0) ? _page.datumRect : (S.datumRect && S.datumRect.w > 0 ? S.datumRect : null);
  if(dr){
    base = dr.w * dr.h;
  } else if(S.imgMode && S.imgState.image && S.imgState.scalePxPerMm && S.imgState.fitScale){
    // Priority 2: image mode with calibrated scale → full image area
    const natPxMm = S.imgState.scalePxPerMm / (S.imgState.fitScale || 1);
    const wMm = S.imgState.image.naturalWidth / natPxMm;
    const hMm = S.imgState.image.naturalHeight / natPxMm;
    base = wMm * hMm;
  }
  // Subtract exclusion zone area that falls within the datum bounds
  // Guard: only compute when wall dimensions are valid to prevent NaN
  const wW = getEffectiveWallW() || 0;
  const wH = getEffectiveWallH() || 0;
  const exclArea = (wW > 0 && wH > 0)
    ? _exclusionAreaForDatum(_page, S.datumRect, wW, wH)
    : 0;
  const result = base - (isNaN(exclArea) ? 0 : exclArea);
  return +Math.max(result, 0.01).toFixed(2);
}

// ── Live exclusion-zone mask helpers ─────────────────────────────────────────

// Circle–Rectangle intersection area (analytical)
function _circleRectIntersectArea(cx, cy, r, rx, ry, rw, rh){
  // Optimization: completely inside
  if(cx - r >= rx && cx + r <= rx + rw && cy - r >= ry && cy + r <= ry + rh) {
    return Math.PI * r * r;
  }
  // Clamp circle centre to rectangle, find closest point distance
  const closestX = Math.max(rx, Math.min(cx, rx+rw));
  const closestY = Math.max(ry, Math.min(cy, ry+rh));
  const dist = Math.hypot(cx-closestX, cy-closestY);
  if(dist >= r) return 0;          // no intersection
  // Numerical integration (fast, accurate enough for UI)
  const steps = 60;
  let count = 0;
  const r2 = r*r;
  for(let i=0; i<steps; i++){
    const angle = (i/steps)*Math.PI*2;
    const cosVal = Math.cos(angle);
    const sinVal = Math.sin(angle);
    for(let ri=1; ri<=steps; ri++){
      const pr = (ri/steps)*r;
      const px = cx + cosVal*pr;
      const py = cy + sinVal*pr;
      if(px>=rx && px<=rx+rw && py>=ry && py<=ry+rh) count++;
    }
  }
  return (count/(steps*steps)) * Math.PI*r2;
}

// Circle–Circle intersection area (analytical)
function _circleCircleIntersectArea(cx1, cy1, r1, cx2, cy2, r2){
  const d = Math.hypot(cx1-cx2, cy1-cy2);
  if(d >= r1+r2) return 0;
  if(d <= Math.abs(r1-r2)) return Math.PI*Math.min(r1,r2)*Math.min(r1,r2);
  const arg1 = (d*d+r1*r1-r2*r2)/(2*d*r1);
  const arg2 = (d*d+r2*r2-r1*r1)/(2*d*r2);
  const a1 = r1*r1*Math.acos(Math.max(-1, Math.min(1, arg1)));
  const a2 = r2*r2*Math.acos(Math.max(-1, Math.min(1, arg2)));
  const a3 = 0.5*Math.sqrt(Math.max(0, (-d+r1+r2)*(d+r1-r2)*(d-r1+r2)*(d+r1+r2)));
  return a1 + a2 - a3;
}

// ── POLYGON GEOMETRY UTILITIES ────────────────────────────────────────────────

/** Shoelace formula — area of polygon (mm²) */
function polyArea(pts){
  if(!pts||pts.length<3) return 0;
  let a=0;
  for(let i=0;i<pts.length;i++){
    const j=(i+1)%pts.length;
    a+=pts[i].x*pts[j].y - pts[j].x*pts[i].y;
  }
  return Math.abs(a)/2;
}

/** Ray-casting point-in-polygon test */
function pointInPoly(x, y, pts){
  if(!pts||pts.length<3) return false;
  let inside=false, j=pts.length-1;
  for(let i=0;i<pts.length;i++){
    const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
    if(((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
    j=i;
  }
  return inside;
}

/** Bounding box {minX,minY,maxX,maxY} */
function polyBBox(pts){
  if(!pts||!pts.length) return {minX:0,minY:0,maxX:0,maxY:0};
  let minX=pts[0].x,minY=pts[0].y,maxX=pts[0].x,maxY=pts[0].y;
  for(const p of pts){
    if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x;
    if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y;
  }
  return {minX,minY,maxX,maxY};
}

/** Centroid of polygon */
function polyCentroid(pts){
  if(!pts||!pts.length) return {x:0,y:0};
  let cx=0,cy=0;
  for(const p of pts){cx+=p.x;cy+=p.y;}
  return {x:cx/pts.length, y:cy/pts.length};
}

/** Squared distance from point (px,py) to segment (ax,ay)→(bx,by) */
function _ptSegDistSq(px,py,ax,ay,bx,by){
  const dx=bx-ax, dy=by-ay;
  if(dx===0&&dy===0) return (px-ax)**2+(py-ay)**2;
  const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)));
  return (px-ax-t*dx)**2+(py-ay-t*dy)**2;
}

/** Circle-polygon intersection area with fast paths.
 *  - Entirely inside polygon  → returns π·r² exactly
 *  - Entirely outside polygon → returns 0 exactly
 *  - Straddles boundary       → polar Monte Carlo (72×72 samples) */
function _circlePolyIntersectArea(cx, cy, r, pts, steps=72){
  if(!pts||pts.length<3||r<=0) return 0;
  const poreArea = Math.PI*r*r;
  const n = pts.length;
  const centreIn = pointInPoly(cx,cy,pts);

  // Min distance from centre to any edge
  let minDsq = Infinity;
  for(let i=0;i<n;i++){
    const j=(i+1)%n;
    const dsq=_ptSegDistSq(cx,cy, pts[i].x,pts[i].y, pts[j].x,pts[j].y);
    if(dsq<minDsq) minDsq=dsq;
  }
  const minDist=Math.sqrt(minDsq);

  if(minDist>=r){
    // Pore doesn't straddle any edge — fast path
    return centreIn ? poreArea : 0;
  }

  // Straddles boundary → Monte Carlo
  let count=0, total=steps*steps;
  for(let i=0;i<steps;i++){
    const angle=(i/steps)*Math.PI*2, ca=Math.cos(angle), sa=Math.sin(angle);
    for(let ri=1;ri<=steps;ri++){
      const pr=(ri/steps)*r;
      if(pointInPoly(cx+ca*pr, cy+sa*pr, pts)) count++;
    }
  }
  return (count/total)*poreArea;
}

/** Sutherland-Hodgman: clip polygon pts to rect (rx,ry,rw,rh).
 *  Returns clipped polygon vertex array. */
function _clipPolyToRect(pts, rx, ry, rw, rh){
  const inside=(p,edge)=>{
    if(edge==='l') return p.x>=rx;
    if(edge==='r') return p.x<=rx+rw;
    if(edge==='t') return p.y>=ry;
    return p.y<=ry+rh;
  };
  const intersect=(p1,p2,edge)=>{
    const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y;
    if(edge==='l'){ const t=(rx-x1)/(x2-x1||1e-12); return {x:rx,      y:y1+t*(y2-y1)}; }
    if(edge==='r'){ const t=(rx+rw-x1)/(x2-x1||1e-12); return {x:rx+rw, y:y1+t*(y2-y1)}; }
    if(edge==='t'){ const t=(ry-y1)/(y2-y1||1e-12); return {x:x1+t*(x2-x1),y:ry};        }
    const t=(ry+rh-y1)/(y2-y1||1e-12); return {x:x1+t*(x2-x1),y:ry+rh};
  };
  let out=[...pts];
  for(const edge of ['l','r','t','b']){
    if(!out.length) return [];
    const inp=out; out=[];
    for(let i=0;i<inp.length;i++){
      const curr=inp[i], prev=inp[i-1<0?inp.length-1:i-1];
      const ci=inside(curr,edge), pi=inside(prev,edge);
      if(ci){ if(!pi) out.push(intersect(prev,curr,edge)); out.push(curr); }
      else if(pi) out.push(intersect(prev,curr,edge));
    }
  }
  return out;
}


/** Convert rect exclusion zone → polygon (4 corners) */
function rectToPolygon(z){
  return { type:'polygon', points:[
    {x:z.x,      y:z.y},
    {x:z.x+z.w,  y:z.y},
    {x:z.x+z.w,  y:z.y+z.h},
    {x:z.x,      y:z.y+z.h}
  ], rotation:z.rotation||0 };
}

/** Convert circle exclusion zone → polygon (n-sided approximation) */
function circleToPolygon(z, n=48){
  const pts=[];
  for(let i=0;i<n;i++){
    const a=(i/n)*Math.PI*2;
    pts.push({x:z.cx+Math.cos(a)*z.r, y:z.cy+Math.sin(a)*z.r});
  }
  return { type:'polygon', points:pts, rotation:0 };
}

/** Rotate polygon points around centroid by angleDeg */
function rotatePolyPoints(pts, angleDeg, cx, cy){
  const rad = angleDeg*Math.PI/180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return pts.map(p=>{
    const dx=p.x-cx, dy=p.y-cy;
    return {x: cx+dx*cos-dy*sin, y: cy+dx*sin+dy*cos};
  });
}

/** Get exclusion zone area (mm²) */
function exclZoneArea(z){
  if(z.type==='rect') return z.w*z.h;
  if(z.type==='circle') return Math.PI*z.r*z.r;
  if(z.type==='polygon') return polyArea(z.points||[]);
  return 0;
}

/** Point-in-zone test (mm coords) for any zone type */
function exclZoneContains(z, x, y){
  if(z.type==='rect') return x>=z.x && x<=(z.x+z.w) && y>=z.y && y<=(z.y+z.h);
  if(z.type==='circle'){ const dx=x-z.cx,dy=y-z.cy; return dx*dx+dy*dy<=z.r*z.r; }
  if(z.type==='polygon') return pointInPoly(x, y, z.points||[]);
  return false;
}

/** Build a canvas 2D path for any zone type */
function _buildZonePath(ctx, z, sc){
  ctx.beginPath();
  if(z.type==='circle'){
    const cp=mmToCanvas(z.cx,z.cy), zr=z.r*sc;
    ctx.arc(cp.x,cp.y,zr,0,Math.PI*2);
  } else if(z.type==='polygon'){
    const pts=z.points||[];
    if(pts.length<2) return;
    const p0=mmToCanvas(pts[0].x,pts[0].y);
    ctx.moveTo(p0.x,p0.y);
    for(let i=1;i<pts.length;i++){ const pi=mmToCanvas(pts[i].x,pts[i].y); ctx.lineTo(pi.x,pi.y); }
    ctx.closePath();
  } else {
    const p=mmToCanvas(z.x,z.y), w=z.w*sc, h=z.h*sc;
    ctx.rect(p.x,p.y,w,h);
  }
}

// ── POLYGON EDIT MODE STATE ────────────────────────────────────────────────────
// S._exclEditPts = null | { zi: number }  — vertex editing mode index
// S._exclRotating = null | { zi, cx, cy, startAngleDeg, origPts, origProps }

// ── CONTEXT MENU ─────────────────────────────────────────────────────────────

function _buildContextMenuEl(){
  let el = document.getElementById('excl-ctx-menu');
  if(el) return el;
  el = document.createElement('div');
  el.id = 'excl-ctx-menu';
  el.style.cssText = [
    'position:fixed','z-index:9999','min-width:180px','padding:4px 0',
    'background:#1e2026','border:1px solid rgba(255,255,255,.12)',
    'border-radius:8px','box-shadow:0 8px 24px rgba(0,0,0,.55)',
    'font:12px "Space Grotesk",system-ui','color:#dde','display:none',
    'user-select:none'
  ].join(';');
  document.body.appendChild(el);
  // Close on outside click
  document.addEventListener('mousedown', e=>{
    if(el.style.display!=='none' && !el.contains(e.target)) _hideCtxMenu();
  });
  return el;
}

function _hideCtxMenu(){
  const el=document.getElementById('excl-ctx-menu');
  if(el) el.style.display='none';
}

function _ctxItem(label, icon, cb, danger=false){
  const div=document.createElement('div');
  div.style.cssText='padding:7px 14px;cursor:pointer;display:flex;gap:8px;align-items:center;'
    +(danger?'color:#f87171;':'color:#dde;');
  div.innerHTML=`<span style="font-size:13px;width:16px;text-align:center">${icon}</span><span>${label}</span>`;
  div.addEventListener('mouseenter',()=>div.style.background='rgba(255,255,255,.07)');
  div.addEventListener('mouseleave',()=>div.style.background='');
  div.addEventListener('mousedown', e=>{ e.stopPropagation(); _hideCtxMenu(); cb(); });
  return div;
}

function _ctxSep(){
  const d=document.createElement('div');
  d.style.cssText='height:1px;margin:3px 0;background:rgba(255,255,255,.08)';
  return d;
}

/** Show context menu for an exclusion zone */
function showExclContextMenu(e, zi, ptIdx){
  e.preventDefault();
  const page = activeImagePage();
  if(!page||!page.exclusionZones) return;
  const z = page.exclusionZones[zi];
  if(!z) return;

  const el = _buildContextMenuEl();
  el.innerHTML = '';

  // Header
  const hdr=document.createElement('div');
  hdr.style.cssText='padding:5px 14px 4px;font-size:10px;font-weight:700;color:#888;letter-spacing:.06em;text-transform:uppercase';
  hdr.textContent = z.type==='polygon'?`Polygon Zone #${zi+1}`:z.type==='circle'?`Circle Zone #${zi+1}`:`Rect Zone #${zi+1}`;
  el.appendChild(hdr);
  el.appendChild(_ctxSep());

  // Edit Points (polygon only, or convert first)
  if(z.type==='polygon'){
    el.appendChild(_ctxItem('Edit Points', '✏️', ()=>{
      S._exclEditPts = { zi };
      S._exclSelected = zi;
      if(S.tool!=='excl_select') setTool('excl_select');
      drawCanvas();
      toast('Drag vertices • Click mid-edge + to add • Right-click vertex to delete');
    }));
    el.appendChild(_ctxItem('Done Editing', '✅', ()=>{
      S._exclEditPts = null; drawCanvas();
    }));
    el.appendChild(_ctxSep());
  }

  // Convert to Polygon
  if(z.type==='rect' || z.type==='circle'){
    el.appendChild(_ctxItem('Edit Points (Convert)', '✏️', ()=>{
      pushHistory();
      const poly = z.type==='rect' ? rectToPolygon(z) : circleToPolygon(z);
      page.exclusionZones[zi] = poly;
      S._exclEditPts = { zi };
      S._exclSelected = zi;
      if(S.tool!=='excl_select') setTool('excl_select');
      drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); renderExclList();
      toast('Converted to polygon — drag vertices to edit shape');
    }));
    el.appendChild(_ctxSep());
  }

  // Delete vertex (polygon only, when vertex right-clicked)
  if(z.type==='polygon' && ptIdx!=null && ptIdx>=0 && z.points.length>3){
    el.appendChild(_ctxItem(`Delete Vertex #${ptIdx+1}`, '🗑️', ()=>{
      pushHistory();
      z.points.splice(ptIdx,1);
      drawCanvas(); updateLiveMetrics(); updatePoreRegistry();
    }, true));
    el.appendChild(_ctxSep());
  }

  // Rotate
  el.appendChild(_ctxItem('Rotate…', '🔄', ()=>{
    S._exclRotating = _startRotateZone(page, zi);
    S._exclSelected = zi;
    if(S.tool!=='excl_select') setTool('excl_select');
    drawCanvas();
    toast('Drag the rotation handle (circle above zone) • Click elsewhere to finish');
  }));

  // Duplicate
  el.appendChild(_ctxItem('Duplicate Zone', '📋', ()=>{
    pushHistory();
    const dup = JSON.parse(JSON.stringify(z));
    if(dup.type==='polygon') dup.points=dup.points.map(p=>({x:p.x+2,y:p.y+2}));
    else if(dup.type==='rect'){ dup.x+=2; dup.y+=2; }
    else if(dup.type==='circle'){ dup.cx+=2; dup.cy+=2; }
    page.exclusionZones.push(dup);
    S._exclSelected = page.exclusionZones.length-1;
    drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); renderExclList();
    toast('Zone duplicated');
  }));

  el.appendChild(_ctxSep());

  // Delete zone
  el.appendChild(_ctxItem('Delete Zone', '🗑️', ()=>{
    pushHistory();
    page.exclusionZones.splice(zi,1);
    if(S._exclEditPts&&S._exclEditPts.zi===zi) S._exclEditPts=null;
    if(S._exclSelected===zi) S._exclSelected=null;
    updateExclZoneBadge(); renderExclList();
    drawCanvas(); updateLiveMetrics(); updatePoreRegistry();
    toast(`Zone #${zi+1} deleted`);
  }, true));

  // Position
  el.style.display='block';
  let lx=e.clientX+4, ly=e.clientY+4;
  if(lx+200>window.innerWidth) lx=e.clientX-204;
  if(ly+el.scrollHeight>window.innerHeight) ly=e.clientY-el.scrollHeight-4;
  el.style.left=lx+'px'; el.style.top=ly+'px';
}

/** Prepare rotation state for a zone */
function _startRotateZone(page, zi){
  const z = page.exclusionZones[zi];
  let cx, cy, origPts=null, origProps=null;
  if(z.type==='polygon'){
    const c=polyCentroid(z.points);
    cx=c.x; cy=c.y; origPts=JSON.parse(JSON.stringify(z.points));
  } else if(z.type==='circle'){
    cx=z.cx; cy=z.cy; origProps={cx:z.cx,cy:z.cy,r:z.r};
  } else {
    cx=z.x+z.w/2; cy=z.y+z.h/2; origProps={x:z.x,y:z.y,w:z.w,h:z.h};
  }
  return { zi, cx, cy, startAngleDeg:0, origPts, origProps, active:true };
}


// Returns crop status for a pore relative to all active exclusion zones:
// { status:'none'|'partial'|'full', effectiveDia, effectiveArea, fraction }
// 'partial' = pore boundary crosses a zone edge → crop & count with reduced area
// Check if pore circle/contour touches or overlaps datum box
function _poreOverlapsDatum(p, dr){
  if(!dr || dr.w <= 0) return true;
  let minX = p.x - p.dia/2, maxX = p.x + p.dia/2, minY = p.y - p.dia/2, maxY = p.y + p.dia/2;
  if(p._contour && p._contour.length >= 3){
    minX = Math.min(...p._contour.map(([dx]) => p.x + dx));
    maxX = Math.max(...p._contour.map(([dx]) => p.x + dx));
    minY = Math.min(...p._contour.map(([,dy]) => p.y + dy));
    maxY = Math.max(...p._contour.map(([,dy]) => p.y + dy));
  }
  return !(maxX < dr.x || minX > dr.x + dr.w || maxY < dr.y || minY > dr.y + dr.h);
}

// 'full'    = pore is entirely inside an exclusion zone or completely outside datum → exclude completely
// 'partial' = pore boundary crosses a zone/datum edge → crop & count with reduced area
// 'none'    = pore is untouched by any zone/datum
function _poreExclCropStatus(p, page){
  const _page = page || ((typeof activeImagePage==='function') ? activeImagePage() : null);
  const zones = (_page && _page.exclusionZones) || [];
  const dr = (_page && _page.datumRect && _page.datumRect.w > 0) ? _page.datumRect : (S.datumRect && S.datumRect.w > 0 ? S.datumRect : null);
  if(!zones.length && !dr) return {status:'none', effectiveDia:p.dia, effectiveArea:Math.PI*(p.dia/2)**2, fraction:1, centreInside:false};

  const r = p.dia/2;
  const poreArea = Math.PI*r*r;

  // ── Build contour polygon in mm if available (highest accuracy) ──────────
  let polyPts = null;
  let bbMinX = p.x - r, bbMaxX = p.x + r, bbMinY = p.y - r, bbMaxY = p.y + r;
  let trueArea = poreArea; // area of the shape we'll sample

  if(p._contour && p._contour.length >= 4){
    polyPts = p._contour.map(([dx, dy]) => ({x: p.x + dx, y: p.y + dy}));
    bbMinX = Math.min(...polyPts.map(pt => pt.x));
    bbMaxX = Math.max(...polyPts.map(pt => pt.x));
    bbMinY = Math.min(...polyPts.map(pt => pt.y));
    bbMaxY = Math.max(...polyPts.map(pt => pt.y));
    // Estimate contour area via shoelace (more accurate than assuming circle)
    let area = 0;
    for(let i = 0, n = polyPts.length; i < n; i++){
      const j = (i + 1) % n;
      area += polyPts[i].x * polyPts[j].y;
      area -= polyPts[j].x * polyPts[i].y;
    }
    trueArea = Math.abs(area) / 2;
    if(trueArea < 0.0001) trueArea = poreArea; // fallback if degenerate
  }

  // ── Grid sampling over bounding box ─────────────────────────────────────
  // Use 30×30 grid for better precision on large pores
  const steps = 30;
  const stepX = (bbMaxX - bbMinX) / steps;
  const stepY = (bbMaxY - bbMinY) / steps;
  let insideCount = 0;
  let totalGridCells = 0;
  let centreInside = false;

  for(let i = 0; i < steps; i++){
    const px = bbMinX + (i + 0.5) * stepX;
    for(let j = 0; j < steps; j++){
      const py = bbMinY + (j + 0.5) * stepY;
      // Only count cells that are inside the actual pore shape
      const inPore = polyPts
        ? pointInPoly(px, py, polyPts)
        : ((px - p.x)**2 + (py - p.y)**2 <= r*r);
      if(!inPore) continue;

      totalGridCells++;
      let insideExcl = false;
      // Check datum boundary — outside datum = excluded region
      if(dr && !(px >= dr.x && px <= (dr.x + dr.w) && py >= dr.y && py <= (dr.y + dr.h))){
        insideExcl = true;
      } else {
        // Check exclusion zones — inside zone = excluded region
        for(let z = 0; z < zones.length; z++){
          const zone = zones[z];
          if(zone.type === 'rect'){
            if(px >= zone.x && px <= (zone.x+zone.w) && py >= zone.y && py <= (zone.y+zone.h)){ insideExcl=true; break; }
          } else if(zone.type === 'circle'){
            if((px-zone.cx)**2 + (py-zone.cy)**2 <= zone.r**2){ insideExcl=true; break; }
          } else if(zone.type === 'polygon'){
            if(pointInPoly(px, py, zone.points||[])){ insideExcl=true; break; }
          }
        }
      }
      if(insideExcl) insideCount++;
    }
  }

  // Check if pore centre itself is inside any exclusion zone (for centreInside flag)
  if(zones.length){
    for(const z of zones){
      if(z.type==='rect'){
        if(p.x>=z.x&&p.x<=(z.x+z.w)&&p.y>=z.y&&p.y<=(z.y+z.h)){ centreInside=true; break; }
      } else if(z.type==='circle'){
        if((p.x-z.cx)**2+(p.y-z.cy)**2 <= z.r**2){ centreInside=true; break; }
      } else if(z.type==='polygon'){
        if(pointInPoly(p.x, p.y, z.points||[])){ centreInside=true; break; }
      }
    }
  }

  const exclFractionGrid = totalGridCells > 0 ? insideCount / totalGridCells : 0;
  if(exclFractionGrid <= 0) return {status:'none', effectiveDia:p.dia, effectiveArea:trueArea, fraction:1, centreInside};

  // Effective area = fraction of the actual pore shape that lies inside the datum
  const effectiveArea = Math.max(0, trueArea * (1 - exclFractionGrid));
  const fraction = effectiveArea / trueArea;

  // Fully excluded: almost nothing remains (<2%) OR pore centre inside an exclusion zone
  if(fraction < 0.02 || (centreInside && zones.length > 0)) return {status:'full', effectiveDia:0, effectiveArea:0, fraction:0, centreInside};
  // Completely excluded by datum (>98% outside)
  if(exclFractionGrid >= 0.98) return {status:'full', effectiveDia:0, effectiveArea:0, fraction:0, centreInside};

  // effectiveDia derived from the actual inside area (equivalent-circle formula, consistent with detection)
  const effectiveDia = 2*Math.sqrt(effectiveArea/Math.PI);
  return {status:'partial', effectiveDia, effectiveArea, fraction, centreInside};
}



// Legacy helper — keeps backward compat: true only when pore is fully inside a zone
function _poreInExclZone(p, page){
  const status = _poreExclCropStatus(p, page);
  return status.status === 'full';
}

// Partial-overlap check: centre not inside, but pore boundary crosses zone
function _poreIsPartialExcl(p, page){
  return _poreExclCropStatus(p, page).status === 'partial';
}

// ── Excl zone hit-testing helpers ──
// Returns index of topmost zone containing canvas point, or -1
function exclZoneAtCanvas(cx, cy, zones){
  const mm = canvasToMm(cx, cy);
  for(let i=zones.length-1; i>=0; i--){
    const z = zones[i];
    if(exclZoneContains(z, mm.x, mm.y)) return i;
  }
  return -1;
}

// Returns {zi, handle, cursor, ptIdx?, midIdx?} for a handle near canvas point, or null
function exclZoneHandleAtCanvas(cx, cy, zones){
  const _sc = (S.imgMode && S.imgState.scalePxPerMm) ? S.imgState.scalePxPerMm : S.cv.scale;
  const HR = 8; // handle hit radius px

  for(let i=zones.length-1; i>=0; i--){
    const z = zones[i];
    const isSelected = (S._exclSelected === i);
    const inEditPts  = isSelected && S._exclEditPts && S._exclEditPts.zi === i;

    // ── Rotation handle check (applies when rotating) ──────────────────────
    if(S._exclRotating && S._exclRotating.zi===i && S._exclRotating.active){
      const _rState = S._exclRotating;
      const _rCx = mmToCanvas(_rState.cx, _rState.cy);
      let _topY = _rCx.y - 40;
      if(z.type==='polygon'&&z.points){ const _bb2=polyBBox(z.points); _topY=mmToCanvas(_bb2.minX,_bb2.minY).y-40; }
      else if(z.type==='circle'){ _topY=mmToCanvas(z.cx,z.cy-z.r).y-40; }
      else { _topY=mmToCanvas(z.x,z.y).y-40; }
      if(Math.hypot(cx-_rCx.x, cy-_topY)<=12)
        return {zi:i, handle:'rotate', cursor:'grab'};
    }

    // ── Polygon vertex/midpoint handles (edit mode) ────────────────────────
    if(z.type==='polygon' && inEditPts){
      const pts = z.points||[];
      // Vertex handles
      for(let vi=0; vi<pts.length; vi++){
        const vc=mmToCanvas(pts[vi].x,pts[vi].y);
        if(Math.hypot(cx-vc.x,cy-vc.y)<=HR)
          return {zi:i, handle:'poly_vtx', ptIdx:vi, cursor:'move'};
      }
      // Midpoint handles (insert new vertex)
      for(let vi=0; vi<pts.length; vi++){
        const vj=(vi+1)%pts.length;
        const mx=(pts[vi].x+pts[vj].x)/2, my=(pts[vi].y+pts[vj].y)/2;
        const mc=mmToCanvas(mx,my);
        if(Math.hypot(cx-mc.x,cy-mc.y)<=8)
          return {zi:i, handle:'poly_mid', midIdx:vi, midX:mx, midY:my, cursor:'cell'};
      }
    }

    // ── Polygon bounding-box handles (selected, non-edit mode) ────────────
    if(z.type==='polygon' && isSelected && !inEditPts){
      const pts=z.points||[];
      if(pts.length>=2){
        const _bb=polyBBox(pts);
        const _bbl=mmToCanvas(_bb.minX,_bb.minY), _bbr=mmToCanvas(_bb.maxX,_bb.maxY);
        const _bw=_bbr.x-_bbl.x, _bh=_bbr.y-_bbl.y;
        const bboxHandles=[
          {name:'nw',px:_bbl.x,         py:_bbl.y,         cur:'nwse-resize', scaleX:-1,scaleY:-1},
          {name:'ne',px:_bbl.x+_bw,     py:_bbl.y,         cur:'nesw-resize', scaleX:1, scaleY:-1},
          {name:'sw',px:_bbl.x,         py:_bbl.y+_bh,     cur:'nesw-resize', scaleX:-1,scaleY:1},
          {name:'se',px:_bbl.x+_bw,     py:_bbl.y+_bh,     cur:'nwse-resize', scaleX:1, scaleY:1},
          {name:'n', px:_bbl.x+_bw/2,  py:_bbl.y,          cur:'ns-resize',   scaleX:0, scaleY:-1},
          {name:'s', px:_bbl.x+_bw/2,  py:_bbl.y+_bh,      cur:'ns-resize',   scaleX:0, scaleY:1},
          {name:'e', px:_bbl.x+_bw,    py:_bbl.y+_bh/2,    cur:'ew-resize',   scaleX:1, scaleY:0},
          {name:'w', px:_bbl.x,         py:_bbl.y+_bh/2,   cur:'ew-resize',   scaleX:-1,scaleY:0},
        ];
        for(const h of bboxHandles){
          if(Math.hypot(cx-h.px,cy-h.py)<=HR)
            return {zi:i, handle:'poly_bbox_'+h.name, cursor:h.cur, _bbl, _bbr,
              origW:_bb.maxX-_bb.minX, origH:_bb.maxY-_bb.minY,
              origMinX:_bb.minX, origMinY:_bb.minY};
        }
      }
    }

    // ── Circle handles ────────────────────────────────────────────────────
    if(z.type==='circle'){
      const cp=mmToCanvas(z.cx,z.cy), r=z.r*_sc;
      if(Math.hypot(cx-cp.x,cy-cp.y)<=HR)
        return {zi:i,handle:'center',cursor:'move'};
      const cardinals=[
        {name:'r',px:cp.x+r,py:cp.y,cur:'ew-resize'},
        {name:'l',px:cp.x-r,py:cp.y,cur:'ew-resize'},
        {name:'t',px:cp.x,py:cp.y-r,cur:'ns-resize'},
        {name:'b',px:cp.x,py:cp.y+r,cur:'ns-resize'}
      ];
      for(const c of cardinals){
        if(Math.hypot(cx-c.px,cy-c.py)<=HR)
          return {zi:i,handle:'radius_'+c.name,cursor:c.cur,_startMx:cx,_startMy:cy};
      }
    }

    // ── Rect handles ──────────────────────────────────────────────────────
    if(z.type==='rect'){
      const p=mmToCanvas(z.x,z.y), w=z.w*_sc, h=z.h*_sc;
      const handles=[
        {name:'nw',px:p.x,     py:p.y,     cur:'nwse-resize'},
        {name:'ne',px:p.x+w,   py:p.y,     cur:'nesw-resize'},
        {name:'sw',px:p.x,     py:p.y+h,   cur:'nesw-resize'},
        {name:'se',px:p.x+w,   py:p.y+h,   cur:'nwse-resize'},
        {name:'n', px:p.x+w/2, py:p.y,     cur:'ns-resize'},
        {name:'s', px:p.x+w/2, py:p.y+h,   cur:'ns-resize'},
        {name:'e', px:p.x+w,   py:p.y+h/2, cur:'ew-resize'},
        {name:'w', px:p.x,     py:p.y+h/2, cur:'ew-resize'}
      ];
      for(const h of handles){
        if(Math.hypot(cx-h.px,cy-h.py)<=HR)
          return {zi:i,handle:h.name,cursor:h.cur,_startMx:cx,_startMy:cy};
      }
    }
  }
  return null;
}

// Helper: draw a square selection handle on canvas
function _drawExclHandle(ctx, x, y, color){
  ctx.fillStyle='#fff'; ctx.strokeStyle=color; ctx.lineWidth=1.5;
  ctx.fillRect(x-4,y-4,8,8);
  ctx.strokeRect(x-4,y-4,8,8);
}

// ── Datum rectangle resize handles ───────────────────────────────────────────
// Returns {handle, cursor} if canvas point (cx,cy) is near a handle, else null.
function datumHandleAtCanvas(cx, cy){
  const dr = S.datumRect;
  if(!dr || dr.w <= 0) return null;
  const _sc = (S.imgMode && S.imgState.scalePxPerMm) ? S.imgState.scalePxPerMm : S.cv.scale;
  const HR = 8; // handle hit radius px
  const p  = mmToCanvas(dr.x, dr.y);
  const pw = dr.w * _sc, ph = dr.h * _sc;
  const handles = [
    {name:'nw', px:p.x,      py:p.y,       cur:'nwse-resize'},
    {name:'ne', px:p.x+pw,   py:p.y,       cur:'nesw-resize'},
    {name:'sw', px:p.x,      py:p.y+ph,    cur:'nesw-resize'},
    {name:'se', px:p.x+pw,   py:p.y+ph,    cur:'nwse-resize'},
    {name:'n',  px:p.x+pw/2, py:p.y,       cur:'ns-resize'},
    {name:'s',  px:p.x+pw/2, py:p.y+ph,    cur:'ns-resize'},
    {name:'e',  px:p.x+pw,   py:p.y+ph/2,  cur:'ew-resize'},
    {name:'w',  px:p.x,      py:p.y+ph/2,  cur:'ew-resize'},
  ];
  for(const h of handles){
    if(Math.hypot(cx - h.px, cy - h.py) <= HR) return h;
  }
  return null;
}

// Apply datum resize from handle name + delta-mm from original snapshot (enforcing square constraint)
function _applyDatumResize(handle, dxmm, dymm, origDatum){
  let {x, y, w, h} = origDatum;
  let cw = w, ch = h;
  if(handle.includes('e')) cw = w + dxmm;
  else if(handle.includes('w')) cw = w - dxmm;
  if(handle.includes('s')) ch = h + dymm;
  else if(handle.includes('n')) ch = h - dymm;

  let side;
  if(handle === 'e' || handle === 'w') side = Math.max(0.5, cw);
  else if(handle === 'n' || handle === 's') side = Math.max(0.5, ch);
  else side = Math.max(0.5, Math.max(cw, ch));

  if(handle === 'se'){
    w = side; h = side; x = origDatum.x; y = origDatum.y;
  } else if(handle === 'sw'){
    w = side; h = side; x = origDatum.x + origDatum.w - side; y = origDatum.y;
  } else if(handle === 'ne'){
    w = side; h = side; x = origDatum.x; y = origDatum.y + origDatum.h - side;
  } else if(handle === 'nw'){
    w = side; h = side; x = origDatum.x + origDatum.w - side; y = origDatum.y + origDatum.h - side;
  } else if(handle === 'e'){
    w = side; h = side; x = origDatum.x; y = origDatum.y + origDatum.h/2 - side/2;
  } else if(handle === 'w'){
    w = side; h = side; x = origDatum.x + origDatum.w - side; y = origDatum.y + origDatum.h/2 - side/2;
  } else if(handle === 's'){
    w = side; h = side; x = origDatum.x + origDatum.w/2 - side/2; y = origDatum.y;
  } else if(handle === 'n'){
    w = side; h = side; x = origDatum.x + origDatum.w/2 - side/2; y = origDatum.y + origDatum.h - side;
  }
  S.datumRect = { x, y, w, h };
}

// Apply resize to an excl zone given handle name and delta-mm from original state
function _applyExclResize(tz, handle, dxmm, dymm, origZone){
  if(tz.type==='circle'){
    // All radius handles just change radius
    const newR = Math.max(0.05, origZone.r + Math.sqrt(dxmm*dxmm+dymm*dymm) * Math.sign(dxmm+dymm));
    if(handle==='radius_r') tz.r = Math.max(0.05, origZone.r+dxmm);
    else if(handle==='radius_l') tz.r = Math.max(0.05, origZone.r-dxmm);
    else if(handle==='radius_t') tz.r = Math.max(0.05, origZone.r-dymm);
    else if(handle==='radius_b') tz.r = Math.max(0.05, origZone.r+dymm);
    else if(handle==='center'){ tz.cx=origZone.cx+dxmm; tz.cy=origZone.cy+dymm; }
    return;
  }
  // Rect handles — manipulate x/y/w/h from the original zone snapshot
  let {x,y,w,h} = origZone;
  if(handle==='nw'){ x+=dxmm; y+=dymm; w-=dxmm; h-=dymm; }
  else if(handle==='ne'){ w+=dxmm; y+=dymm; h-=dymm; }
  else if(handle==='sw'){ x+=dxmm; w-=dxmm; h+=dymm; }
  else if(handle==='se'){ w+=dxmm; h+=dymm; }
  else if(handle==='n'){ y+=dymm; h-=dymm; }
  else if(handle==='s'){ h+=dymm; }
  else if(handle==='e'){ w+=dxmm; }
  else if(handle==='w'){ x+=dxmm; w-=dxmm; }
  // Enforce minimum size
  if(w<0.05){ if(handle.includes('w')){ x=origZone.x+origZone.w-0.05; } w=0.05; }
  if(h<0.05){ if(handle.includes('n')){ y=origZone.y+origZone.h-0.05; } h=0.05; }
  tz.x=x; tz.y=y; tz.w=w; tz.h=h;
}

// ── Exclusion zone filter for any page (used in evaluation across all tabs) ──
// Fully-excluded pores (centre inside zone, ≥95% area overlap) are removed.
// Partially-overlapping pores are kept with _effectiveDia / _cropFraction tags.
// Pass `page` = the image page object that owns the pores.
function _filterExclZones(pores, page){
  const _page = page || ((typeof activeImagePage==='function') ? activeImagePage() : null);
  const zones = (_page && _page.exclusionZones) || [];
  const dr = (_page && _page.datumRect && _page.datumRect.w > 0) ? _page.datumRect : (S.datumRect && S.datumRect.w > 0 ? S.datumRect : null);
  if(!zones.length && !dr) return pores;
  return pores.map(p => {
    const cs = _poreExclCropStatus(p, _page);
    if(cs.status === 'full') return null;
    if(cs.status === 'partial'){
      return Object.assign({}, p, {
        _effectiveDia: cs.effectiveDia,
        _effectiveArea: cs.effectiveArea,
        _cropFraction: cs.fraction,
        _isCropped: true,
        _rawDia: p._rawDia || p.dia
      });
    }
    return Object.assign({}, p, {
      _effectiveDia: p.dia,
      _effectiveArea: cs.effectiveArea,
      _cropFraction: 1,
      _isCropped: false,
      _rawDia: p._rawDia || p.dia
    });
  }).filter(Boolean);
}

function _rectIntersectionArea(a, b){
  if(!a || !b) return 0;
  const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
  const w=Math.max(0, Math.min(ax2,bx2)-Math.max(a.x,b.x));
  const h=Math.max(0, Math.min(ay2,by2)-Math.max(a.y,b.y));
  return w*h;
}

function _exclusionAreaForDatum(page, datumRect, wallW, wallH){
  const zones=(page && page.exclusionZones) || [];
  if(!zones.length) return 0;
  let bounds = datumRect;
  if(!bounds || bounds.w <= 0){
    if(wallW > 0 && wallH > 0) bounds = { x: 0, y: 0, w: wallW, h: wallH };
    else return 0;
  }
  
  // Use a 100x100 grid for accurate overlap union area
  const steps = 100;
  const stepX = bounds.w / steps;
  const stepY = bounds.h / steps;
  const cellArea = stepX * stepY;
  let count = 0;
  for(let i=0; i<steps; i++){
    const px = bounds.x + (i + 0.5) * stepX;
    for(let j=0; j<steps; j++){
      const py = bounds.y + (j + 0.5) * stepY;
      let inside = false;
      for(let z=0; z<zones.length; z++){
        const zone = zones[z];
        if(zone.type==='rect'){
          if(px>=zone.x && px<=(zone.x+zone.w) && py>=zone.y && py<=(zone.y+zone.h)){ inside=true; break; }
        } else if(zone.type==='circle'){
          if((px-zone.cx)**2 + (py-zone.cy)**2 <= zone.r**2){ inside=true; break; }
        } else if(zone.type==='polygon'){
          if(pointInPoly(px, py, zone.points)){ inside=true; break; }
        }
      }
      if(inside) count++;
    }
  }
  return count * cellArea;
}

function _evaluationDatumArea(page, metrics, datumRect){
  const base=Math.max(metrics?.datum || 0, 0.01);
  const exclArea = _exclusionAreaForDatum(page, datumRect, metrics?.wallW, metrics?.wallH);
  return +Math.max(base - exclArea, 0.01).toFixed(2);
}

// Returns only pores within datum square (or all pores if no datum drawn),
// AND filters out fully-excluded pores. Partially-overlapping pores are kept
// with their effective (cropped) diameter embedded as p._effectiveDia.
// Pass explicit `page` to ensure the correct page's zones/datumRect are used.
function getPoresForEvaluation(pores, page){
  if(!pores) pores=AP();
  const _page = page || ((typeof activeImagePage==='function') ? activeImagePage() : null);
  // Annotate each pore with crop status, then filter fully-excluded
  pores = pores.map(p=>{
    const cs = _poreExclCropStatus(p, _page);
    if(cs.status==='full') return null; // exclude completely
    if(cs.status==='partial'){
      // Use a shallow clone with effective diameter and area for metric calculations
      return Object.assign({}, p, {
        _effectiveDia: cs.effectiveDia,
        _effectiveArea: cs.effectiveArea,   // actual contour-based area inside datum
        _cropFraction: cs.fraction,
        _isCropped: true,
        _rawDia: p._rawDia || p.dia
      });
    }
    return Object.assign({}, p, {
      _effectiveDia: p.dia,
      _effectiveArea: cs.effectiveArea,     // trueArea from shoelace (contour-based)
      _cropFraction: 1,
      _isCropped: false,
      _rawDia: p._rawDia || p.dia
    });
  }).filter(Boolean);
  // Use page-specific datumRect when available (ensures per-page filtering for multi-page workspaces).
  // Fall back to S.datumRect (global) for the currently active page.
  const _dr = (_page && _page.datumRect && _page.datumRect.w > 0)
    ? _page.datumRect
    : (S.datumRect && S.datumRect.w > 0 ? S.datumRect : null);
  return pores;
}

// Remove datum square
function clearDatum(){
  S.datumRect=null;
  const btn=document.getElementById('btn-clear-datum');
  if(btn) btn.style.display='none';
  const sbDatum=document.getElementById('sb-datum');
  if(sbDatum) sbDatum.textContent=S.imgMode?getEffectiveDatum().toFixed(1)+' mm² (img)':(S.spec.datum||100)+' mm²';
  refreshWorkspaceUI();
  toast('Datum square removed');
}

function getImagePageMetrics(page, spec){
  const imgState=page?.imgState || {};
  // Check if a datum square was drawn for this page
  const dr = page && page.datumRect && page.datumRect.w>0 ? page.datumRect : null;
  if(imgState.image && imgState.scalePxPerMm && imgState.fitScale){
    const natPxMm=imgState.scalePxPerMm/(imgState.fitScale||1);
    const wallW=imgState.image.naturalWidth/natPxMm;
    const wallH=imgState.image.naturalHeight/natPxMm;
    const datum = dr ? +(dr.w*dr.h).toFixed(2) : +(wallW*wallH).toFixed(2);
    const offset = page ? (page.imgOffsetMm || 0) : 0;
  return {wallW, wallH, datum, calibrated:true, datumRect:dr, offset};
  }
  const datum = dr ? +(dr.w*dr.h).toFixed(2) : (spec.datum||100);
  const offset = page ? (page.imgOffsetMm || 0) : 0;
  return {wallW:20, wallH:spec.t||6, datum, calibrated:false, datumRect:dr, offset};
}
function calcPorosity(){
  // True mm² calculation
  const eff=effectivePores();
  const totalArea=eff.reduce((s,p)=>s+Math.PI*(p.dia/2)*(p.dia/2),0);
  const datum=getEffectiveDatum();
  return totalArea/datum*100;
}

function calcMaxPhi(){
  const eff=effectivePores();
  return eff.reduce((m,p)=>Math.max(m,p.dia),0);
}

function calcMinGap(){
  // Returns {gap,p1,p2,reqGap} in mm — edge to edge
  const eff=effectivePores();
  if(eff.length<2) return null;
  let best=null;
  for(let i=0;i<eff.length;i++) for(let j=i+1;j<eff.length;j++){
    const pi=eff[i],pj=eff[j];
    const dist=Math.hypot(pi.x-pj.x,pi.y-pj.y);
    const edgeGap=dist-pi.dia/2-pj.dia/2;
    const smaller=Math.min(pi.dia,pj.dia);
    const req=(S.spec.a||2)*smaller;
    if(!best||edgeGap<best.gap){
      best={gap:edgeGap,p1:pi,p2:pj,reqGap:req,smaller,isPacking:edgeGap<smaller};
    }
  }
  return best;
}

function analyseZone(zone){
  const eff=effectivePores().filter(p=>p.zone===zone);
  if(!eff.length) return {packing:false,cluster:0,pores:eff};
  let packing=false,maxCluster=0;
  for(let i=0;i<eff.length;i++) for(let j=i+1;j<eff.length;j++){
    const pi=eff[i],pj=eff[j];
    const dist=Math.hypot(pi.x-pj.x,pi.y-pj.y);
    const edgeGap=dist-pi.dia/2-pj.dia/2;
    const smaller=Math.min(pi.dia,pj.dia);
    if(edgeGap<(S.spec.a||2)*smaller){
      packing=true;
      const clusterD=dist+pi.dia/2+pj.dia/2; // rough bounding
      maxCluster=Math.max(maxCluster,clusterD);
    }
  }
  return {packing,cluster:maxCluster,pores:eff};
}

let metricDebounce = null;
function updateLiveMetrics(){
  // Fast local count update
  const _apAll = AP();
  const _page4 = (typeof activeImagePage==='function') ? activeImagePage() : null;
  const _exclFull = _apAll.filter(p=>_poreExclCropStatus(p,_page4).status==='full').length;
  const _exclPartial = _apAll.filter(p=>_poreExclCropStatus(p,_page4).status==='partial').length;
  const _nonExcl = _apAll.filter(p=>_poreExclCropStatus(p,_page4).status!=='full');
  const effLen = S.spec.u > 0 ? _nonExcl.filter(p=>(p.dia+0.005)>=S.spec.u).length : _nonExcl.length;
  let cntLabel = String(effLen);
  if(_exclFull>0) cntLabel += ` (+${_exclFull} excl`+(_exclPartial>0?`, ${_exclPartial} ✂`:'')+`)`;
  else if(_exclPartial>0) cntLabel += ` (${_exclPartial} ✂ cropped)`;
  document.getElementById('m-cnt').textContent = cntLabel;
  document.getElementById('mb-cnt').style.width=Math.min(100,effLen*8)+'%';
  
  if(metricDebounce) clearTimeout(metricDebounce);
  try {
    // FILTER pores to datum square if drawn, then apply exclusion zones
    const evalPores = getPoresForEvaluation(AP());
    // Compute net datum ONCE here and pass explicitly to avoid double-subtracting
    // exclusion area (getEffectiveDatum already subtracts it; if we also passed null
    // to runEvaluationLocal it would call getEffectiveDatum a second time inside).
    const _liveEvalDatum = getEffectiveDatum();
    const data = runEvaluationLocal(evalPores, S.spec, getEffectiveWallH(), _liveEvalDatum, activeImagePage().imgOffsetMm || 0);

    const pct=data.pct;
    const maxPhi=data.max_phi;
    const gapData=data.gap_data;
    const lim=S.spec;

    // Pct
    const pctRatio=pct/(lim.pct||5);
    const pctCol=pctRatio>1?'var(--red)':pctRatio>.85?'var(--amb)':'var(--g)';
    document.getElementById('m-pct').textContent=pct.toFixed(1)+'%';
    document.getElementById('m-pct').style.color=pctCol;
    document.getElementById('mb-pct').style.width=Math.min(100,pctRatio*100)+'%';
    document.getElementById('mb-pct').style.background=pctCol;
    document.getElementById('ml-pct').style.left=Math.min(98,100/1)+'%';// at 100% of limit
    const tbPct=document.getElementById('tb-pct');
    if(tbPct){
      tbPct.textContent=pct.toFixed(1)+'%';
      tbPct.style.color=pctCol;
    }

    // Phi
    const phiRatio=maxPhi/(lim.phi||1.5);
    const phiCol=phiRatio>1?'var(--red)':phiRatio>.85?'var(--amb)':'var(--blu)';
    document.getElementById('m-phi').textContent=maxPhi.toFixed(2)+' mm';
    document.getElementById('m-phi').style.color=phiCol;
    document.getElementById('mb-phi').style.width=Math.min(100,phiRatio*100)+'%';
    document.getElementById('mb-phi').style.background=phiCol;

    // Gap
    if(gapData){
      const gapCol=gapData.gap<gapData.req?'var(--red)':gapData.gap<gapData.req*1.2?'var(--amb)':'var(--pur)';
      document.getElementById('m-gap').textContent=gapData.gap.toFixed(3)+' mm';
      document.getElementById('m-gap').style.color=gapCol;
      const gapRatio=gapData.gap/Math.max(gapData.req,.001);
      document.getElementById('mb-gap').style.width=Math.min(100,gapRatio*100)+'%';
      document.getElementById('mb-gap').style.background=gapCol;
      document.getElementById('ms-gap').textContent='min '+gapData.req.toFixed(2)+' mm';
    } else {
      document.getElementById('m-gap').textContent='—';
      document.getElementById('m-gap').style.color='var(--dim)';
      document.getElementById('mb-gap').style.width='100%';
      document.getElementById('mb-gap').style.background='var(--pur)';
      document.getElementById('ms-gap').textContent='A × Φ_smaller';
    }

    // Live verdict
    const allOK=data.all_pass;
    const el=document.getElementById('m-verdict');
    const bl=document.getElementById('mb-verdict');
    if(!S.spec.specSaved||data.eff_pores===0){
      el.textContent='—'; el.style.color='var(--dim)';
      bl.style.width='0%'; bl.style.background='var(--dim)';
      document.getElementById('ms-verdict').textContent='No spec / no pores';
    } else if(allOK){
      el.textContent='PASS'; el.style.color='var(--g)';
      bl.style.width='100%'; bl.style.background='var(--g)';
      document.getElementById('ms-verdict').textContent='All parameters within limit';
      document.getElementById('tb-badge').textContent='PASS';
      document.getElementById('tb-badge').className='t-badge tb-pass';
      document.getElementById('tb-dot').className='t-dot td-pass';
    } else {
      el.textContent='FAIL'; el.style.color='var(--red)';
      bl.style.width='100%'; bl.style.background='var(--red)';
      document.getElementById('ms-verdict').textContent='Parameter(s) exceeded';
      document.getElementById('tb-badge').textContent='FAIL';
      document.getElementById('tb-badge').className='t-badge tb-fail';
      document.getElementById('tb-dot').className='t-dot td-fail';
    }

    _silentReEvalActivePage();
    updatePoreRegistry();
    updateHeaderButtons();
  } catch(e){ /* calculation error — skip */ }
}

function updateHeaderButtons() {
  const btnUpload = document.getElementById('btn-upload-top');
  const btnScale = document.getElementById('btn-scale-tool-top');
  const btnDetect = document.getElementById('btn-autodetect-top');
  const btnEval = document.getElementById('btn-eval');
  
  if (S.imgMode) {
    const hasImg = !!(S.imgState && S.imgState.image);
    const hasScale = !!(hasImg && S.imgState.scalePxPerMm);
    const hasDetected = !!(hasImg && (S.imgState.autoDetected || (AP() && AP().length > 0) || (S.datumRect && S.datumRect.w > 0)));
    
    if(btnUpload) btnUpload.style.display = '';
    if(btnScale) btnScale.disabled = !hasImg;
    if(btnDetect) btnDetect.disabled = !hasScale;
    if(btnEval) btnEval.disabled = !hasDetected;
  } else {
    if(btnUpload) btnUpload.style.display = 'none';
    if(btnScale) btnScale.disabled = true;
    if(btnDetect) btnDetect.disabled = true;
    
    // In Spec mode, allow evaluation if images have been detected or have pores/datum
    let allReady = true;
    let hasAnyImage = false;
    for (let si = 0; si < Workspace.specs.length; si++) {
      const tab = Workspace.specs[si];
      for (let ii = 0; ii < tab.images.length; ii++) {
        const page = tab.images[ii];
        if (page.imgState && page.imgState.image) {
          hasAnyImage = true;
          const pageReady = page.imgState.autoDetected || (page.pores && page.pores.length > 0) || (page.datumRect && page.datumRect.w > 0);
          if (!pageReady) {
            allReady = false;
            break;
          }
        }
      }
      if(!allReady) break;
    }
    if(btnEval) btnEval.disabled = !(hasAnyImage && allReady);
  }
}

// ── Silent single-page re-evaluation ─────────────────────────────────────────
// Re-computes page.verdict + S.verdict for the active image page WITHOUT
// mutating page.pores zones and WITHOUT showing any toast. Calls renderVerdict()
// live if the Verdict tab is currently visible so results are always in sync.
function _silentReEvalActivePage(){
  try {
    const page = activeImagePage();
    if(!page) return;
    const tab  = activeSpecTab();
    const spec = (tab && tab.spec) || S.spec;
    const metrics = getImagePageMetrics(page, spec);
    const exclZonesCount = (page.exclusionZones || []).length;

    // ── NET pores (excl-zone-filtered + datum-filtered) ──
    let pores = [...(page.pores || [])];
    pores = _filterExclZones(pores, page);
    const pageDatum = (page.datumRect && page.datumRect.w > 0) ? page.datumRect : null;
    if(pageDatum) pores = pores.filter(p=>_poreOverlapsDatum(p, pageDatum));
    const evalDatum = _evaluationDatumArea(page, metrics, pageDatum);
    const data = runEvaluationLocal(pores, spec, metrics.wallH, evalDatum, metrics.offset || 0);

    // ── RAW pores (no excl-zone filter — informational) ──
    let poresRaw = [...(page.pores || [])];
    if(pageDatum) poresRaw = poresRaw.filter(p=>_poreOverlapsDatum(p, pageDatum));
    const rawDatumBase = pageDatum ? +(pageDatum.w*pageDatum.h).toFixed(2) : (metrics.datum || (spec.datum||100));
    const rawData = runEvaluationLocal(poresRaw, spec, metrics.wallH, rawDatumBase, metrics.offset || 0);

    const _rawPoreCount = (page.pores || []).length;
    const _exclCount = _rawPoreCount - _filterExclZones([...(page.pores||[])], page).length;
    const _totalBefore = pageDatum ? poresRaw.length : _rawPoreCount;
    const _maskedN = pageDatum ? Math.max(0, poresRaw.length - pores.length) : _exclCount;

    // Build new verdict — does NOT touch page.pores zones
    page.verdict = {
      allPass: data.all_pass, checks: data.checks, pct: data.pct,
      maxPhi: data.max_phi, gapD: data.gap_data,
      hTriggered: data.h_triggered, nTriggered: data.n_triggered,
      hrZ: data.hr_zone, hkZ: data.hk_zone,
      eff: Array(data.eff_pores).fill({}),
      exclZoneCount: exclZonesCount,
      exclMaskedPores: _maskedN,
      totalPoresBeforeExcl: _totalBefore,
      rawPct: rawData.pct,
      rawPoreCount: poresRaw.length,
      rawDatum: rawDatumBase,
      netPct: data.pct,
      netPoreCount: pores.length,
      netDatum: evalDatum,
      hasExclZone: exclZonesCount > 0,
      hasDatum: !!pageDatum,
      datumArea: evalDatum,
      poresInDatum: pores.length
    };
    S.verdict = page.verdict;
    S.evaluated = true;
    page.evaluated = true;

    // Re-render verdict live if the Verdict page is already open
    const vpg = document.getElementById('pg-verdict');
    if(vpg && vpg.style.display !== 'none' && vpg.style.opacity !== '0') {
      renderVerdict();
    }

    // Sync global badge
    HPDC_STATE.set('lastVerdict', data.all_pass ? 'ACCEPT' : 'REJECT', 'Tool 01');
    updateHomeVerdictBadge(); setPlatformBadge('porosity');
  } catch(e){ /* silent — skip */ }
}


// ═══════════════════════════════════════════════════════════════════════════
// STANDALONE CALCULATION ENGINE (ports core/calculations.py — no server needed)
// ═══════════════════════════════════════════════════════════════════════════
function _effectivePores(pores, spec){
  const u = spec.u || 0;
  // Normalise: for cropped pores, substitute effectiveDia and effectiveArea so downstream
  // area calcs reflect only the inside-datum portion. Filter by ORIGINAL diameter for U.
  const normalised = pores.map(p => {
    const rawDia = p._rawDia || p.dia;
    if(p._isCropped && p._effectiveDia != null){
      return Object.assign({}, p, {
        dia: p._effectiveDia,
        _rawDia: rawDia,
        _effectiveArea: p._effectiveArea ?? Math.PI*(p._effectiveDia/2)**2
      });
    }
    return Object.assign({}, p, {
      _rawDia: rawDia,
      _effectiveArea: p._effectiveArea ?? Math.PI*(rawDia/2)**2
    });
  });
  // Apply U threshold against the original (uncropped) diameter
  return u > 0 ? normalised.filter(p => ((p._rawDia||p.dia) + 0.005) >= u) : normalised;
}

function _getZone(y, wallH, poreOffset, specT){
  // poreOffset: mm from Surface A to top of cropped image (0 = full section)
  // specT: full wall thickness from spec — used as total height when offset > 0
  const offset = poreOffset || 0;
  const totalH = (offset > 0 && specT > 0) ? specT : wallH;
  const absY = y + offset;  // absolute position from Surface A
  if(totalH <= 0) return 'hr';
  const t3 = totalH / 3.0;
  if(absY < 0 || absY > totalH) return 'outside';
  if(absY < t3) return 'hr';           // Surface A zone
  if(absY <= t3 * 2) return 'hk';     // middle zone
  return 'hr';                          // Surface B zone (matches original mapping)
}

function _calcPorosity(pores, spec, datum){
  // datum MUST be passed explicitly — never falls back to getEffectiveDatum() to
  // avoid double-subtracting exclusion area on an already-filtered pore list.
  const eff = _effectivePores(pores, spec);
  // Use pre-computed _effectiveArea when available (more accurate for irregular contours);
  // fall back to circle area from diameter for manually-placed pores.
  const total = eff.reduce((s, p) => {
    const area = (p._effectiveArea != null) ? p._effectiveArea : Math.PI*(p.dia/2)**2;
    return s + area;
  }, 0);
  return total / Math.max(datum || 0.01, 0.01) * 100;
}

function _calcMaxPhi(pores, spec){
  const eff = _effectivePores(pores, spec);
  return eff.length ? Math.max(...eff.map(p => p.dia)) : 0;
}

function _calcMinGap(pores, spec){
  const eff = _effectivePores(pores, spec);
  if(eff.length < 2) return null;
  let best = null;
  for(let i = 0; i < eff.length; i++){
    for(let j = i + 1; j < eff.length; j++){
      const pi = eff[i], pj = eff[j];
      const dist = Math.hypot(pi.x - pj.x, pi.y - pj.y);
      const edgeGap = dist - pi.dia / 2 - pj.dia / 2;
      const smaller = Math.min(pi.dia, pj.dia);
      const req = (spec.a || 3) * smaller;
      const clusterD = pi.dia / 2 + pj.dia / 2 + dist;
      const isN = edgeGap < smaller;
      if(best === null || edgeGap < best.gap){
        best = { gap: edgeGap, req, smaller, cluster_d: clusterD, is_N: isN, pair: [pi.id, pj.id] };
      }
    }
  }
  return best;
}

function _analyseZone(pores, spec, zone){
  const eff = _effectivePores(pores, spec).filter(p => p.zone === zone);
  const n = eff.length;
  if(n === 0) return { h: false, n: false, cluster: 0, pores: 0, min_gap: null };
  let hTrig = false, nTrig = false, maxCluster = 0, minGapVal = null;
  for(let i = 0; i < n; i++){
    for(let j = i + 1; j < n; j++){
      const pi = eff[i], pj = eff[j];
      const dist = Math.hypot(pi.x - pj.x, pi.y - pj.y);
      const edgeGap = dist - pi.dia / 2 - pj.dia / 2;
      const smaller = Math.min(pi.dia, pj.dia);
      if(edgeGap < (spec.a || 3) * smaller) hTrig = true;
      if(edgeGap < smaller){
        nTrig = true;
        maxCluster = Math.max(maxCluster, pi.dia / 2 + pj.dia / 2 + dist);
      }
      if(minGapVal === null || edgeGap < minGapVal) minGapVal = edgeGap;
    }
  }
  return { h: hTrig, n: nTrig, cluster: maxCluster, pores: n, min_gap: minGapVal };
}

async function _callApiEvaluate(pores, spec, wallH, exclusionZones, datumRect, poreOffset) {
  try {
    const formattedSpec = {
      pno: spec.pno || 'PART-001',
      zone: spec.zone || 'Zone A',
      rev: spec.rev || '—',
      insp: spec.insp || '—',
      pct: isNaN(parseFloat(spec.pct)) ? 5.0 : parseFloat(spec.pct),
      phi: isNaN(parseFloat(spec.phi)) ? 1.5 : parseFloat(spec.phi),
      a: isNaN(parseFloat(spec.a)) ? 2.0 : parseFloat(spec.a),
      u: isNaN(parseFloat(spec.u)) ? 0.2 : parseFloat(spec.u),
      t: isNaN(parseFloat(spec.t)) ? 6.0 : parseFloat(spec.t),
      datum: isNaN(parseFloat(spec.datum)) ? 100.0 : parseFloat(spec.datum),
      h: parseInt(spec.h) || 0,
      n: parseInt(spec.n) || 0,
      hr: parseInt(spec.hr) || 0,
      nr: parseInt(spec.nr) || 0,
      hk: parseInt(spec.hk) || 1,
      nk: parseInt(spec.nk) || 1,
      method: spec.method || 'visual_machined',
      zone_disabled: !!spec.zone_disabled,
      phi_gas: (spec.phi_gas !== undefined && spec.phi_gas !== null && spec.phi_gas !== '' && !isNaN(parseFloat(spec.phi_gas))) ? parseFloat(spec.phi_gas) : null,
      pct_gas: (spec.pct_gas !== undefined && spec.pct_gas !== null && spec.pct_gas !== '' && !isNaN(parseFloat(spec.pct_gas))) ? parseFloat(spec.pct_gas) : null,
      phi_shrink: (spec.phi_shrink !== undefined && spec.phi_shrink !== null && spec.phi_shrink !== '' && !isNaN(parseFloat(spec.phi_shrink))) ? parseFloat(spec.phi_shrink) : null,
      pct_shrink: (spec.pct_shrink !== undefined && spec.pct_shrink !== null && spec.pct_shrink !== '' && !isNaN(parseFloat(spec.pct_shrink))) ? parseFloat(spec.pct_shrink) : null
    };

    const formattedPores = (pores || []).map(p => ({
      id: parseInt(p.id),
      x: parseFloat(p.x),
      y: parseFloat(p.y),
      dia: parseFloat((p._effectiveDia !== undefined && p._effectiveDia !== null) ? p._effectiveDia : p.dia),
      type: p.type || 'gas',
      zone: p.zone || 'hr'
    }));

    const formattedZones = (exclusionZones || []).flatMap(z => {
      if (z.type === 'rect') {
        return [{
          type: 'rect',
          x: parseFloat(z.x),
          y: parseFloat(z.y),
          w: parseFloat(z.w),
          h: parseFloat(z.h)
        }];
      } else if (z.type === 'circle') {
        return [{
          type: 'circle',
          cx: parseFloat(z.cx),
          cy: parseFloat(z.cy),
          r: parseFloat(z.r)
        }];
      } else if (z.type === 'polygon' && z.points && z.points.length >= 3) {
        return [{
          type: 'polygon',
          points: z.points.map(p => ({ x: parseFloat(p.x), y: parseFloat(p.y) }))
        }];
      }
      return []; // skip malformed zones
    });

    // KEY FIX: when datumRect is null/empty but image is calibrated, synthesize a
    // full-image datum_rect so the backend uses actual image area, not spec.datum.
    // This keeps the API result consistent with the frontend local evaluation.
    const _calibMetrics = (typeof getImagePageMetrics==='function') ? getImagePageMetrics(activeImagePage(), S.spec) : null;
    const _syntheticDatum = (!datumRect || !datumRect.w) && _calibMetrics && _calibMetrics.calibrated && _calibMetrics.wallW > 0 && _calibMetrics.wallH > 0
      ? { x: 0, y: 0, w: +_calibMetrics.wallW.toFixed(4), h: +_calibMetrics.wallH.toFixed(4) }
      : datumRect;
    const formattedDatum = (_syntheticDatum && _syntheticDatum.w > 0) ? {
      x: parseFloat(_syntheticDatum.x),
      y: parseFloat(_syntheticDatum.y),
      w: parseFloat(_syntheticDatum.w),
      h: parseFloat(_syntheticDatum.h)
    } : null;

    const res = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spec: formattedSpec,
        pores: formattedPores,
        wall_h_mm: parseFloat(wallH),
        exclusion_zones: formattedZones,
        datum_rect: formattedDatum,
        pore_offset_mm: parseFloat(poreOffset) || 0.0
      })
    });
    if (!res.ok) {
      throw new Error(`Server returned status ${res.status}`);
    }
    const data = await res.json();
    return data;
  } catch (err) {
    console.warn("API evaluate failed, falling back to local evaluation:", err);
    const datumVal = datumRect ? (typeof datumRect === 'number' ? datumRect : +(datumRect.w * datumRect.h).toFixed(2)) : null;
    return runEvaluationLocal(pores, spec, wallH, datumVal, poreOffset);
  }
}

function runEvaluationLocal(pores, spec, wallH, datumOverride, poreOffset){
  // Re-assign zones — offset applied for cropped images
  const _off = poreOffset || 0;
  pores.forEach(p => p.zone = _getZone(p.y, wallH, _off, spec.t || wallH));

  // datumOverride is the NET datum area (already has exclusion zones subtracted by caller).
  // When null/undefined, fall back to spec.datum — NOT getEffectiveDatum() — to avoid
  // double-subtracting exclusion zone area on an already-filtered pore list.
  const datum  = (datumOverride != null && datumOverride > 0) ? datumOverride : (spec.datum || 100);
  const pct    = _calcPorosity(pores, spec, datum);
  const maxPhi = _calcMaxPhi(pores, spec);
  const gapD   = _calcMinGap(pores, spec);
  const eff    = _effectivePores(pores, spec);

  const hTrig = gapD !== null && gapD.gap < gapD.req;
  const nTrig = gapD !== null && gapD.is_N;

  const hrZ = _analyseZone(pores, spec, 'hr');
  const hkZ = _analyseZone(pores, spec, 'hk');

  const nrTrig = hrZ.n && hrZ.cluster > (spec.phi || 1.5);
  const nkTrig = hkZ.n && hkZ.cluster > (spec.phi || 1.5);

  const gapMeas = () => gapD === null ? 'N/A' :
    gapD.gap > 0 ? `${gapD.gap.toFixed(3)} mm` : `OVERLAP (${Math.abs(gapD.gap).toFixed(3)}mm)`;
  const gapLimit = () => gapD === null ? 'A×Φ_smaller' : `≥${gapD.req.toFixed(2)} mm`;

  const checks = [
    { n:'Porosity %',            par:'%',   pass: pct <= (spec.pct||5),
      meas:`${pct.toFixed(2)}%`,       limit:`≤${spec.pct||5}%`,
      detail:`Σπr²=${eff.reduce((s,p)=>s+Math.PI*(p.dia/2)**2,0).toFixed(2)}mm² / Datum ${datum.toFixed(1)}mm² = ${pct.toFixed(3)}%` },
    { n:'Max pore Φ (combined)', par:'Φ',   pass: maxPhi <= (spec.phi||1.5),
      meas:`${maxPhi.toFixed(3)} mm`,  limit:`≤${spec.phi||1.5} mm`,
      detail:`Largest effective pore ${maxPhi.toFixed(3)} mm` },
    { n:'Spacing A (global)',     par:'A',   pass: !hTrig,
      meas: gapMeas(), limit: gapLimit(),
      detail: hTrig ? `Closest pair gap ${gapD.gap.toFixed(3)} mm < A×Φs ${gapD.req.toFixed(2)} mm`
                    : 'All pores adequately spaced' },
    { n:'H — Looseness (full)',   par:'H',   pass: !hTrig || (spec.h||1) === 1,
      meas: hTrig ? 'TRIGGERED' : 'None', limit:`H${spec.h||1}`,
      detail: hTrig ? 'Pore group spacing below A×Φ_smaller' : 'No looseness group' },
    { n:'N — Packing cluster',    par:'N',   pass: !nTrig || (spec.n||1) === 1,
      meas: nTrig && gapD ? `Cluster span ${gapD.cluster_d.toFixed(2)} mm` : 'None',
      limit:`N${spec.n||1}`,
      detail: nTrig ? 'Edge gap < Φ_smaller — packing cluster formed' : 'No packing cluster' },
    { n:'HR / NR (outer ⅓)',      par:'HR',  pass: (spec.hr||1) === 2 || !hrZ.h || ((spec.hr||1)===1 && (!nrTrig||(spec.nr||1)===1)),
      meas: hrZ.h ? `H-group (${hrZ.pores} pores, gap ${(hrZ.min_gap||0).toFixed(2)}mm)` : 'Clean',
      limit: (spec.hr||1) === 2 ? 'N/A' : `HR${spec.hr||1} / NR${spec.nr||1}`,
      detail: (spec.hr||1) === 2 ? 'Not specified' : hrZ.h ? `Outer ⅓: looseness, cluster ${hrZ.cluster.toFixed(2)} mm` : 'Outer ⅓ clean' },
    { n:'HK / NK (central ⅓)',    par:'HK',  pass: (spec.hk||1) === 2 || !hkZ.h || ((spec.hk||1)===1 && (!nkTrig||(spec.nk||1)===1)),
      meas: hkZ.h ? `H-group (${hkZ.pores} pores, gap ${(hkZ.min_gap||0).toFixed(2)}mm)` : 'Clean',
      limit: (spec.hk||1) === 2 ? 'N/A' : `HK${spec.hk||1} / NK${spec.nk||1}`,
      detail: (spec.hk||1) === 2 ? 'Not specified' : hkZ.h ? `Central ⅓: looseness, cluster ${hkZ.cluster.toFixed(2)} mm` : 'Central ⅓ clean' },
    // ── Type-specific checks — only added when pores of that type exist ──
    ...(() => {
      const gasP  = _effectivePores(pores.filter(p => (p.type||'gas') === 'gas'),  spec);
      const shrP  = _effectivePores(pores.filter(p =>  p.type === 'shrink'),        spec);
      const phiG  = spec.phi_gas    != null ? spec.phi_gas    : (spec.phi || 1.5);
      const phiS  = spec.phi_shrink != null ? spec.phi_shrink : (spec.phi || 1.5);
      const pctG  = spec.pct_gas    != null ? spec.pct_gas    : (spec.pct || 5);
      const pctS  = spec.pct_shrink != null ? spec.pct_shrink : (spec.pct || 5);
      const maxPhiG = gasP.length ? Math.max(...gasP.map(p => p.dia)) : 0;
      const maxPhiS = shrP.length ? Math.max(...shrP.map(p => p.dia)) : 0;
      const areaG = gasP.reduce((s, p) => s + Math.PI * (p.dia/2)**2, 0);
      const areaS = shrP.reduce((s, p) => s + Math.PI * (p.dia/2)**2, 0);
      const pctGval = areaG / Math.max(datum, 0.01) * 100;
      const pctSval = areaS / Math.max(datum, 0.01) * 100;
      const rows = [];
      if(gasP.length > 0){
        rows.push({ n:`Gas Φ max (${gasP.length}p)`,    par:'Φ_G', pass: maxPhiG <= phiG,
          meas:`${maxPhiG.toFixed(3)} mm`, limit:`≤${phiG} mm`,
          detail:`${gasP.length} gas pore(s) — largest Φ ${maxPhiG.toFixed(3)} mm` });
        rows.push({ n:`Gas porosity %`,                 par:'%_G', pass: pctGval <= pctG,
          meas:`${pctGval.toFixed(2)}%`, limit:`≤${pctG}%`,
          detail:`Gas area ${areaG.toFixed(2)} mm² / ${datum.toFixed(1)} mm² datum` });
      }
      if(shrP.length > 0){
        rows.push({ n:`Shrink Φ max (${shrP.length}p)`, par:'Φ_S', pass: maxPhiS <= phiS,
          meas:`${maxPhiS.toFixed(3)} mm`, limit:`≤${phiS} mm`,
          detail:`${shrP.length} shrink pore(s) — largest Φ ${maxPhiS.toFixed(3)} mm` });
        rows.push({ n:`Shrink porosity %`,              par:'%_S', pass: pctSval <= pctS,
          meas:`${pctSval.toFixed(2)}%`, limit:`≤${pctS}%`,
          detail:`Shrink area ${areaS.toFixed(2)} mm² / ${datum.toFixed(1)} mm² datum` });
      }
      return rows;
    })(),
  ];

  return {
    all_pass: checks.every(c => c.pass),
    checks, pct, max_phi: maxPhi, gap_data: gapD,
    h_triggered: hTrig, n_triggered: nTrig,
    hr_zone: hrZ, hk_zone: hkZ,
    eff_pores: eff.length,
    updated_pores: pores.map(p => ({ ...p }))
  };
}
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════
// EVALUATION (STANDALONE — no server needed)
// ═══════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// EVALUATE ALL SPECS + EXPORT
// ══════════════════════════════════════════════════════════
async function evaluateAllSpecs(silent){
  // Sync active pores into page before iterating (S.imgPores and page.pores share same ref but be explicit)
  const _activePage2 = activeImagePage();
  if(_activePage2) _activePage2.pores = S.imgPores;
  persistActiveResults();
  let totalSpecs = 0, passedSpecs = 0;
  const summary = [];

  for (let si = 0; si < Workspace.specs.length; si++) {
    const tab = Workspace.specs[si];
    const spec = tab.spec;
    let tabAllPass = true;
    let tabTotalImages = 0, tabPassedImages = 0;

    for (let ii = 0; ii < tab.images.length; ii++) {
      const page = tab.images[ii];
      if (page.imgState && page.imgState.image && !page.imgState.autoDetected && (!page.pores || page.pores.length === 0) && (!page.datumRect || page.datumRect.w <= 0)) {
        throw new Error(`Image ${ii+1} in Spec ${si+1} has no detected pores or datum.`);
      }
      // ── NET (excl. zone filtered) evaluation ──
      let pores = JSON.parse(JSON.stringify(page.pores || []));
      const exclZonesCount = (page.exclusionZones || []).length;
      if(exclZonesCount >= 0) pores = _filterExclZones(pores, page);
      const pageDatum = (page.datumRect && page.datumRect.w > 0) ? page.datumRect : null;
      if(pageDatum) pores = pores.filter(p=>_poreOverlapsDatum(p, pageDatum));
      const metrics = getImagePageMetrics(page, spec);
      
      const data = await _callApiEvaluate(
        pores,
        spec,
        metrics.wallH,
        page.exclusionZones || [],
        pageDatum,
        metrics.offset || 0
      );

      // ── RAW (all pores, NO exclusion zone filter) ──
      let poresRaw = JSON.parse(JSON.stringify(page.pores || []));
      if(pageDatum) poresRaw = poresRaw.filter(p=>_poreOverlapsDatum(p, pageDatum));
      const rawDatumBase = pageDatum ? +(pageDatum.w*pageDatum.h).toFixed(2) : (metrics.datum || (spec.datum||100));
      const rawData = await _callApiEvaluate(
        poresRaw,
        spec,
        metrics.wallH,
        [],
        pageDatum,
        metrics.offset || 0
      );

      const _rawPoreCount = (page.pores || []).length;
      const _exclCount2 = _rawPoreCount - _filterExclZones([...(page.pores||[])], page).length;
      const _totalBefore = pageDatum ? poresRaw.length : _rawPoreCount;
      const _maskedN = pageDatum ? Math.max(0, poresRaw.length - pores.length) : _exclCount2;

      page.verdict = {
        allPass: data.all_pass, checks: data.checks, pct: data.pct,
        maxPhi: data.max_phi, gapD: data.gap_data,
        hTriggered: data.h_triggered, nTriggered: data.n_triggered,
        hrZ: data.hr_zone, hkZ: data.hk_zone,
        eff: Array(data.eff_pores).fill({}),
        exclZoneCount: exclZonesCount,
        exclMaskedPores: _maskedN,
        totalPoresBeforeExcl: _totalBefore,
        // Dual porosity fields
        rawPct: rawData.pct,
        rawPoreCount: poresRaw.length,
        rawDatum: rawDatumBase,
        netPct: data.pct,
        netPoreCount: pores.length,
        netDatum: data.net_datum || (pageDatum ? +(pageDatum.w*pageDatum.h).toFixed(2) : metrics.datum || (spec.datum||100)),
        hasExclZone: exclZonesCount > 0,
        hasDatum: !!pageDatum,
        datumArea: data.net_datum || (pageDatum ? +(pageDatum.w*pageDatum.h).toFixed(2) : metrics.datum || (spec.datum||100)),
        poresInDatum: pores.length
      };
      page.evaluated = true;
      const updatedMap = new Map();
      if (data.updated_pores) {
        data.updated_pores.forEach(up => { if(up.id) updatedMap.set(up.id, up.zone); });
      }
      page.pores.forEach((p) => {
        if(updatedMap.has(p.id)) p.zone = updatedMap.get(p.id);
      });
      tabTotalImages++;
      if(data.all_pass) tabPassedImages++; else tabAllPass = false;
    }

    tab.verdict = { allPass: tabAllPass, tabPassedImages, tabTotalImages };
    totalSpecs++;
    if(tabAllPass) passedSpecs++;
    summary.push({
      name: tab.name || `Spec ${si+1}`,
      pno: spec.pno || '-',
      zone: spec.zone || '-',
      allPass: tabAllPass,
      passedImages: tabPassedImages,
      totalImages: tabTotalImages
    });
  }

  const allPass = passedSpecs === totalSpecs;
  // Render summary panel
  const grid = document.getElementById('v-all-specs-grid');
  const badge = document.getElementById('v-all-verdict-badge');
  const panel = document.getElementById('v-all-specs-summary');
  if(grid){
    grid.innerHTML = summary.map((s, i) => `
      <div style="display:grid;grid-template-columns:auto 1fr auto auto auto;gap:8px 12px;
        align-items:center;padding:7px 10px;border-radius:6px;
        background:${s.allPass?'rgba(0,232,162,.05)':'rgba(255,61,61,.05)'};
        border:1px solid ${s.allPass?'rgba(0,232,162,.15)':'rgba(255,61,61,.15)'}">
        <span style="font-size:9px;font-weight:700;color:var(--dim);min-width:18px">${i+1}</span>
        <div>
          <div style="font-size:10px;font-weight:700;color:var(--tx)">${escapeHtml(s.name)}</div>
          <div style="font-size:8px;color:var(--dim)">Part: ${escapeHtml(s.pno)} &middot; Zone: ${escapeHtml(s.zone)}</div>
        </div>
        <span style="font-size:9px;color:var(--dim)">${s.passedImages}/${s.totalImages} img</span>
        <span style="font-size:10px;font-weight:800;color:${s.allPass?'var(--g)':'var(--red)'}">${s.allPass?'PASS':'FAIL'}</span>
        <span style="font-size:14px">${s.allPass?'✅':'❌'}</span>
      </div>`).join('');
  }
  if(badge){
    badge.textContent = allPass ? `ALL ${totalSpecs} PASS` : `${totalSpecs-passedSpecs}/${totalSpecs} FAIL`;
    badge.style.background = allPass ? 'var(--ga)' : 'var(--ra)';
    badge.style.color = allPass ? 'var(--g)' : 'var(--red)';
  }
  if(panel) panel.style.display = 'block';

  // Update global badge based on active spec
  HPDC_STATE.set('lastVerdict', allPass ? 'ACCEPT' : 'REJECT', 'Tool 01');
  updateHomeVerdictBadge(); setPlatformBadge('porosity');
  if (!silent) {
    toast(`Evaluated ${totalSpecs} spec(s): ${passedSpecs} PASS, ${totalSpecs-passedSpecs} FAIL`, allPass?'ok':'warn');
  }
  return { allPass, summary };
}

async function evaluateAllAndExport(){
  const btn = document.getElementById('btn-eval-all');
  if(btn){ btn.disabled = true; btn.textContent = '⏳ Evaluating…'; }
  try {
    await evaluateAllSpecs();
    nav('verdict');
    await downloadPDF();
  } catch(e) {
    toast('Evaluation error: ' + e.message, 'err');
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='⚡ Eval All'; }
  }
}

// ═══════════════════════════════════════════════════════════════════
// EVAL SELECTOR MODAL — open / close / render / run
// ═══════════════════════════════════════════════════════════════════
function openEvalSelector(){
  persistActiveResults();
  renderEvalSelectorUI();
  const modal = document.getElementById('eval-selector-modal');
  if(modal){ modal.style.display='flex'; }
}
function closeEvalSelector(){
  const modal = document.getElementById('eval-selector-modal');
  if(modal){ modal.style.display='none'; }
}
function renderEvalSelectorUI(){
  const list = document.getElementById('eval-selector-list');
  if(!list) return;
  list.innerHTML = Workspace.specs.map((tab, si) => {
    const imgRows = tab.images.map((page, ii) => {
      const ev = page.evaluated;
      const pass = ev && page.verdict ? page.verdict.allPass : null;
      return '<label style="display:flex;align-items:center;gap:8px;padding:5px 8px 5px 28px;cursor:pointer;border-radius:5px"'
        +' >'
        +'<input type="checkbox" class="eval-img-cb" data-si="'+si+'" data-ii="'+ii+'"'
        +' onchange="_evalSelUpdateCount()" checked style="width:13px;height:13px;cursor:pointer;flex-shrink:0">'
        +'<div style="flex:1;min-width:0">'
        +'<div style="font-size:10px;color:var(--tx);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+escapeHtml(page.name)+'</div>'
        +'<div style="font-size:8px;color:var(--dim)">'+page.pores.length+' pores</div>'
        +'</div>'
        +(ev ? '<span style="font-size:8px;font-weight:700;color:'+(pass?'var(--g)':'var(--red)')+'">'+( pass?'PASS':'FAIL')+'</span>'
              : '<span style="font-size:8px;color:var(--dim)">-</span>')
        +'</label>';
    }).join('');
    const tv = tab.verdict;
    return '<div style="margin-bottom:8px;border:1px solid var(--bd);border-radius:8px;overflow:hidden">'
      +'<label style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--c3);cursor:pointer;border-bottom:1px solid var(--bd)">'
      +'<input type="checkbox" class="eval-spec-cb" data-si="'+si+'" onchange="_evalSelSpecToggle(this,'+si+')" checked style="width:14px;height:14px;cursor:pointer;flex-shrink:0">'
      +'<div style="flex:1">'
      +'<div style="font-size:11px;font-weight:700;color:var(--tx)">'+escapeHtml(tab.name)+'</div>'
      +'<div style="font-size:8px;color:var(--dim)">Part: '+escapeHtml(tab.spec.pno||'-')+' · Zone: '+escapeHtml(tab.spec.zone||'-')+' · '+tab.images.length+' image(s)</div>'
      +'</div>'
      +(tv&&tv.allPass!=null ? '<span style="font-size:9px;font-weight:700;color:'+(tv.allPass?'var(--g)':'var(--red)')+'">'+( tv.allPass?'PASS':'FAIL')+'</span>' : '')
      +'</label>'
      +'<div style="background:var(--c2)">'+imgRows+'</div>'
      +'</div>';
  }).join('');
  _evalSelUpdateCount();
  const all = document.getElementById('eval-sel-all');
  if(all) all.checked = true;
}
function _evalSelSpecToggle(cb, si){
  document.querySelectorAll('.eval-img-cb[data-si="'+si+'"]').forEach(el => el.checked = cb.checked);
  _evalSelUpdateCount();
}
function _evalSelToggleAll(checked){
  document.querySelectorAll('.eval-img-cb, .eval-spec-cb').forEach(el => el.checked = checked);
  _evalSelUpdateCount();
}
function _evalSelUpdateCount(){
  const total = document.querySelectorAll('.eval-img-cb').length;
  const selected = document.querySelectorAll('.eval-img-cb:checked').length;
  const el = document.getElementById('eval-sel-count');
  if(el) el.textContent = selected+' / '+total+' images selected';
  const master = document.getElementById('eval-sel-all');
  if(master){
    if(selected === total){ master.checked=true; master.indeterminate=false; }
    else if(selected === 0){ master.checked=false; master.indeterminate=false; }
    else{ master.indeterminate=true; }
  }
}
async function runSelectedEval(mode){
  closeEvalSelector();
  const selectedImages = {};
  document.querySelectorAll('.eval-img-cb:checked').forEach(cb => {
    const si = +cb.dataset.si, ii = +cb.dataset.ii;
    if(!selectedImages[si]) selectedImages[si] = [];
    selectedImages[si].push(ii);
  });
  if(!Object.keys(selectedImages).length){ toast('No images selected','warn'); return; }
  persistActiveResults();
  let totalSpecs=0, passedSpecs=0;
  const evalledSpecIndices = [];
  const siKeys = Object.keys(selectedImages);
  for (let idx = 0; idx < siKeys.length; idx++) {
    const siStr = siKeys[idx];
    const si = +siStr, imgIndices = selectedImages[si];
    const tab = Workspace.specs[si]; if(!tab) continue;
    let tabAllPass=true, tabPassedImages=0;
    for (let j = 0; j < imgIndices.length; j++) {
      const ii = imgIndices[j];
      const page = tab.images[ii]; if(!page) continue;
      
      // ── NET (excl. zone filtered) evaluation ──
      let pores = JSON.parse(JSON.stringify(page.pores||[]));
      const exclZonesCount = (page.exclusionZones || []).length;
      if(exclZonesCount >= 0) pores = _filterExclZones(pores, page);
      const pageDatum = (page.datumRect && page.datumRect.w > 0) ? page.datumRect : null;
      if(pageDatum) pores = pores.filter(p=>_poreOverlapsDatum(p, pageDatum));
      const metrics = getImagePageMetrics(page, tab.spec);
      
      const data = await _callApiEvaluate(
        pores,
        tab.spec,
        metrics.wallH,
        page.exclusionZones || [],
        pageDatum,
        metrics.offset || 0
      );

      // ── RAW (all pores, NO exclusion zone filter) ──
      let poresRaw = JSON.parse(JSON.stringify(page.pores || []));
      if(pageDatum) poresRaw = poresRaw.filter(p=>_poreOverlapsDatum(p, pageDatum));
      const rawDatumBase = pageDatum ? +(pageDatum.w*pageDatum.h).toFixed(2) : (metrics.datum || (tab.spec.datum||100));
      const rawData = await _callApiEvaluate(
        poresRaw,
        tab.spec,
        metrics.wallH,
        [],
        pageDatum,
        metrics.offset || 0
      );

      const _rawPoreCount = (page.pores || []).length;
      const _exclCount2 = _rawPoreCount - _filterExclZones([...(page.pores||[])], page).length;
      const _totalBefore = pageDatum ? poresRaw.length : _rawPoreCount;
      const _maskedN = pageDatum ? Math.max(0, poresRaw.length - pores.length) : _exclCount2;

      page.verdict = {
        allPass: data.all_pass, checks: data.checks, pct: data.pct,
        maxPhi: data.max_phi, gapD: data.gap_data,
        hTriggered: data.h_triggered, nTriggered: data.n_triggered,
        hrZ: data.hr_zone, hkZ: data.hk_zone,
        eff: Array(data.eff_pores).fill({}),
        exclZoneCount: exclZonesCount,
        exclMaskedPores: _maskedN,
        totalPoresBeforeExcl: _totalBefore,
        rawPct: rawData.pct,
        rawPoreCount: poresRaw.length,
        rawDatum: rawDatumBase,
        netPct: data.pct,
        netPoreCount: pores.length,
        netDatum: data.net_datum || (pageDatum ? +(pageDatum.w*pageDatum.h).toFixed(2) : metrics.datum || (tab.spec.datum||100)),
        hasExclZone: exclZonesCount > 0,
        hasDatum: !!pageDatum,
        datumArea: data.net_datum || (pageDatum ? +(pageDatum.w*pageDatum.h).toFixed(2) : metrics.datum || (tab.spec.datum||100)),
        poresInDatum: pores.length
      };
      page.evaluated = true;

      const updatedMap = new Map();
      if (data.updated_pores) {
        data.updated_pores.forEach(up => { if(up.id) updatedMap.set(up.id, up.zone); });
      }
      page.pores.forEach((p,i)=>{ 
        if(updatedMap.has(p.id)) p.zone=updatedMap.get(p.id);
        else p.zone = 'hr'; // fallback
      });
      if(data.all_pass) tabPassedImages++; else tabAllPass=false;
    }
    tab.verdict = { allPass:tabAllPass, tabPassedImages, tabTotalImages:imgIndices.length };
    totalSpecs++; if(tabAllPass) passedSpecs++;
    evalledSpecIndices.push({ si, imgIndices });
  }
  const allPass = passedSpecs === totalSpecs;
  HPDC_STATE.set('lastVerdict', allPass?'ACCEPT':'REJECT','Tool 01');
  updateHomeVerdictBadge(); setPlatformBadge('porosity');
  window._evalledSpecIndices = evalledSpecIndices;
  nav('verdict');
  renderVerdictTabs(evalledSpecIndices);
  if(evalledSpecIndices.length>0){
    const first=evalledSpecIndices[0];
    showVerdictForTab(first.si, first.imgIndices[0]);
  }
  toast(totalSpecs+' spec(s): '+passedSpecs+' PASS, '+(totalSpecs-passedSpecs)+' FAIL', allPass?'ok':'warn');
  if(mode==='export') await downloadPDF();
}
// ═══════════════════════════════════════════════════════════════════
// VERDICT PAGE MULTI-TAB
// ═══════════════════════════════════════════════════════════════════
function renderVerdictTabs(evalledSpecIndices){
  const specInner=document.getElementById('v-spec-tabs-inner');
  const specStrip=document.getElementById('v-spec-tabs');
  if(!specInner||!specStrip) return;
  specInner.innerHTML = evalledSpecIndices.map((entry,idx)=>{
    const tab=Workspace.specs[entry.si];
    const pass=tab.verdict?tab.verdict.allPass:null;
    const badge=pass===true?' ✓':pass===false?' ✗':'';
    const bc=pass===true?'var(--g)':'var(--red)';
    return '<button id="v-spec-tab-'+entry.si+'" onclick="switchVerdictSpec('+idx+','+entry.si+')"'
      +' style="padding:5px 12px 7px;border:none;cursor:pointer;border-radius:6px 6px 0 0;'
      +'font-size:10px;font-weight:700;white-space:nowrap;'
      +'background:'+(idx===0?'var(--c0)':'var(--c3)')+';'
      +'color:'+(idx===0?'var(--tx)':'var(--dim)')+';'
      +'border-bottom:'+(idx===0?'2px solid var(--primary)':'2px solid transparent')+'">'+escapeHtml(tab.name)
      +(pass!==null?'<span style="color:'+bc+'">'+badge+'</span>':'')+'</button>';
  }).join('');
  specStrip.style.display='block';
  if(evalledSpecIndices.length>0) _buildImageTabs(evalledSpecIndices[0]);
}
function _buildImageTabs(entry){
  const imgInner=document.getElementById('v-image-tabs-inner');
  const imgStrip=document.getElementById('v-image-tabs');
  if(!imgInner||!imgStrip) return;
  const tab=Workspace.specs[entry.si];
  imgInner.innerHTML = entry.imgIndices.map((ii,idx)=>{
    const page=tab.images[ii];
    const pass=page&&page.verdict?page.verdict.allPass:null;
    const badge=pass===true?' ✓':pass===false?' ✗':'';
    const bc=pass===true?'var(--g)':'var(--red)';
    return '<button id="v-img-tab-'+entry.si+'-'+ii+'" onclick="switchVerdictImage('+entry.si+','+ii+','+idx+')"'
      +' style="padding:4px 10px 6px;border:none;cursor:pointer;border-radius:5px 5px 0 0;'
      +'font-size:9px;font-weight:600;white-space:nowrap;'
      +'background:'+(idx===0?'var(--c0)':'var(--c2)')+';'
      +'color:'+(idx===0?'var(--tx)':'var(--dim)')+';'
      +'border-bottom:'+(idx===0?'2px solid var(--primary)':'2px solid transparent')+'">'+escapeHtml((page&&page.name)||'Image '+(ii+1))
      +(pass!==null?'<span style="color:'+bc+'">'+badge+'</span>':'')+'</button>';
  }).join('');
  imgStrip.style.display='block';
}
function switchVerdictSpec(idx,si){
  const all=window._evalledSpecIndices||[];
  all.forEach(e=>{
    const el=document.getElementById('v-spec-tab-'+e.si);
    if(el){el.style.background='var(--c3)';el.style.color='var(--dim)';el.style.borderBottom='2px solid transparent';}
  });
  const ae=document.getElementById('v-spec-tab-'+si);
  if(ae){ae.style.background='var(--c0)';ae.style.color='var(--tx)';ae.style.borderBottom='2px solid var(--primary)';}
  const entry=all.find(e=>e.si===si);
  if(entry){_buildImageTabs(entry);if(entry.imgIndices.length>0) showVerdictForTab(si,entry.imgIndices[0]);}
}
function switchVerdictImage(si,ii,idx){
  const entry=(window._evalledSpecIndices||[]).find(e=>e.si===si);
  if(!entry) return;
  entry.imgIndices.forEach(i=>{
    const el=document.getElementById('v-img-tab-'+si+'-'+i);
    if(el){el.style.background='var(--c2)';el.style.color='var(--dim)';el.style.borderBottom='2px solid transparent';}
  });
  const ae=document.getElementById('v-img-tab-'+si+'-'+ii);
  if(ae){ae.style.background='var(--c0)';ae.style.color='var(--tx)';ae.style.borderBottom='2px solid var(--primary)';}
  showVerdictForTab(si,ii);
}
function showVerdictForTab(si,ii){
  const tab=Workspace.specs[si]; if(!tab) return;
  const page=tab.images[ii]; if(!page||!page.verdict) return;
  // Permanently update S.spec + S.verdict so navigating back shows correct data
  S.spec=tab.spec;
  S.verdict=page.verdict;
  S.evaluated=true;
  renderVerdict();
}

async function submitEvaluation(){
  if(S.imgMode && S.imgState && S.imgState.image && !S.imgState.autoDetected && (!AP() || AP().length === 0) && (!S.datumRect || S.datumRect.w <= 0)) {
    toast('Please run Auto Detect or place pores/datum before evaluating.', 'warn');
    return;
  }
  const btn = document.getElementById('btn-eval');
  if(btn){ btn.disabled=true; btn.textContent='Evaluating…'; }
  try {
    // Evaluate ALL spec tabs and their image pages
    await evaluateAllSpecs();
    // Build the full list for multi-tab rendering
    const allEntries = Workspace.specs.map((tab, si) => ({
      si, imgIndices: tab.images.map((_, ii) => ii)
    }));
    window._evalledSpecIndices = allEntries;
    nav('verdict');
    renderVerdictTabs(allEntries);
    if(allEntries.length > 0 && allEntries[0].imgIndices.length > 0){
      showVerdictForTab(allEntries[0].si, allEntries[0].imgIndices[0]);
    }
  } catch(e){
    toast('Evaluation error — ' + e.message,'err');
  } finally {
    if(btn){ btn.disabled=false; btn.textContent='Evaluate →'; }
  }
}

function runEvaluation(){
  const hasDatum = S.datumRect && S.datumRect.w > 0;
  const page = activeImagePage();
  const metrics = getImagePageMetrics(page, S.spec);
  const exclZonesCount = (page.exclusionZones || []).length;

  // NET (excl. zone filtered) — used for pass/fail verdict
  const evalPores = getPoresForEvaluation(AP(), page);
  const evalDatum = _evaluationDatumArea(page, metrics, S.datumRect);
  const data = runEvaluationLocal(evalPores, S.spec, metrics.wallH, evalDatum, metrics.offset || 0);

  // RAW (all pores, no exclusion zone filter) — informational
  const rawPoresAll = hasDatum && S.datumRect
    ? AP().filter(p => _poreOverlapsDatum(p, S.datumRect))
    : [...AP()];
  const rawDatumBase = hasDatum && S.datumRect
    ? +(S.datumRect.w * S.datumRect.h).toFixed(2)
    : (metrics.datum || (S.spec.datum || 100));
  const rawData = runEvaluationLocal([...rawPoresAll], S.spec, metrics.wallH, rawDatumBase, metrics.offset || 0);

  // FULL IMAGE RESULT: always all pores, full image area (only meaningful when datum exists)
  let dataFull = null;
  let _fullPores = [];
  let fullDatumAfterExcl = 0;
  if(hasDatum){
    // Full image datum = actual image area (bypass S.datumRect by temporarily nulling it)
    const savedDatum = S.datumRect;
    S.datumRect = null; // temporarily remove so getEffectiveDatum returns full image area
    const fullDatum = getEffectiveDatum();
    S.datumRect = savedDatum; // restore
    // Filter exclusion zones from full-image pore list too (explicit page reference)
    _fullPores = _filterExclZones([...AP()], page);
    fullDatumAfterExcl = _evaluationDatumArea(page, {...metrics, datum: fullDatum, datumRect: null}, null);
    dataFull = runEvaluationLocal(_fullPores, S.spec, metrics.wallH, fullDatumAfterExcl, metrics.offset || 0);
  }

  // Sync zone changes back
  if(data.updated_pores){
    const updatedMap = new Map();
    data.updated_pores.forEach(up => { if(up.id) updatedMap.set(up.id, up.zone); });
    AP().forEach(p => {
      if(updatedMap.has(p.id)) p.zone = updatedMap.get(p.id);
    });
  }

  const allPass = data.all_pass;
  const _totalPores = hasDatum ? rawPoresAll.length : AP().length;
  const _exclMaskedN = hasDatum ? Math.max(0, rawPoresAll.length - evalPores.length) : AP().filter(p=>_poreInExclZone(p)).length;
  S.verdict = {
    allPass,
    hasDatum,
    datumArea: evalDatum,
    exclZoneCount: exclZonesCount,
    exclMaskedPores: _exclMaskedN,
    totalPoresBeforeExcl: _totalPores,
    // Net (excl. zone filtered) result — drives pass/fail
    checks: data.checks, pct: data.pct, maxPhi: data.max_phi,
    gapD: data.gap_data, hTriggered: data.h_triggered, nTriggered: data.n_triggered,
    hrZ: data.hr_zone, hkZ: data.hk_zone, eff: Array(data.eff_pores).fill({}),
    poresInDatum: evalPores.length,
    // Dual porosity fields
    rawPct: rawData.pct,            // Complete porosity — all pores, no excl zone
    rawPoreCount: rawPoresAll.length,
    rawDatum: rawDatumBase,
    netPct: data.pct,               // Net porosity — after excl zone masking
    netPoreCount: evalPores.length,
    netDatum: evalDatum,
    hasExclZone: exclZonesCount > 0,
    // Full image result (only when datum drawn)
    full: dataFull ? {
      allPass: dataFull.all_pass, checks: dataFull.checks, pct: dataFull.pct,
      maxPhi: dataFull.max_phi, gapD: dataFull.gap_data,
      eff: Array(dataFull.eff_pores).fill({}), poreCount: _fullPores.length,
      datumArea: fullDatumAfterExcl
    } : null
  };
  S.evaluated = true;
  persistActiveResults();
  renderImageTabs();
  HPDC_STATE.set('lastVerdict', allPass ? 'ACCEPT' : 'REJECT', 'Tool 01');
  updateHomeVerdictBadge();
  setPlatformBadge('porosity');

  // Update badges
  document.getElementById('bve').textContent=allPass?'PASS':'FAIL';
  document.getElementById('bve').className='nb-badge '+(allPass?'nbb-pass':'nbb-fail');
  document.getElementById('bme').textContent='DONE';
  document.getElementById('bme').className='nb-badge nbb-set';
  document.getElementById('h-ve-st').innerHTML=`<span style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;background:${allPass?'var(--ga)':'var(--ra)'};color:${allPass?'var(--g)':'var(--red)'}">${allPass?'ACCEPT':'REJECT'}</span>`;
  document.getElementById('h-me-st').innerHTML='<span style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;background:var(--ga);color:var(--tx)">COMPLETE</span>';
}

function escapeHtml(v){
  return String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderReportImage(page, spec, metrics){
  const img=page.imgState.image;
  if(!img) return '';
  const maxW=760;
  const scale=Math.min(1,maxW/img.naturalWidth);
  const w=Math.max(1,Math.round(img.naturalWidth*scale));
  const h=Math.max(1,Math.round(img.naturalHeight*scale));
  const c=document.createElement('canvas');
  c.width=w; c.height=h;
  const ctx=c.getContext('2d');
  ctx.fillStyle='#f4f5f7'; ctx.fillRect(0,0,w,h);
  ctx.drawImage(img,0,0,w,h);
  const natPxMm=page.imgState.scalePxPerMm && page.imgState.fitScale ? page.imgState.scalePxPerMm/page.imgState.fitScale : null;
  const sx=natPxMm ? natPxMm*scale : w/(metrics.wallW||20);
  const sy=natPxMm ? natPxMm*scale : h/(metrics.wallH||spec.t||6);
  const pageDatum = (page.datumRect && page.datumRect.w > 0) ? page.datumRect : null;

  // 1. Draw Datum Rectangle
  if(pageDatum){
    const dx = pageDatum.x*sx, dy = pageDatum.y*sy, dw = pageDatum.w*sx, dh = pageDatum.h*sy;
    ctx.fillStyle='rgba(255,173,0,.06)'; ctx.fillRect(dx,dy,dw,dh);
    ctx.setLineDash([5,3]); ctx.strokeStyle='rgba(255,173,0,.75)'; ctx.lineWidth=1.5;
    ctx.strokeRect(dx,dy,dw,dh); ctx.setLineDash([]);
    // Corner ticks
    const tk=6;
    ctx.strokeStyle='rgba(255,173,0,.9)'; ctx.lineWidth=1.5;
    [[dx,dy],[dx+dw,dy],[dx,dy+dh],[dx+dw,dy+dh]].forEach(([cx2,cy2])=>{
      ctx.beginPath(); ctx.moveTo(cx2,cy2+Math.sign(cy2-dy-dh/2)*tk); ctx.lineTo(cx2,cy2); ctx.lineTo(cx2+Math.sign(cx2-dx-dw/2)*tk,cy2); ctx.stroke();
    });
    ctx.fillStyle='rgba(255,173,0,.95)'; ctx.font='bold 9px Arial'; ctx.textAlign='left'; ctx.textBaseline='bottom';
    ctx.fillText('DATUM □', dx+4, dy-3);
  }

  // 2. Draw Exclusion Zones
  const ez = page.exclusionZones || [];
  if(ez.length){
    ctx.save();
    ez.forEach((z, zi)=>{
      const zx = z.x*sx, zy = z.y*sy, zw = z.w*sx, zh = z.h*sy;
      ctx.fillStyle='rgba(239,68,68,.06)'; ctx.fillRect(zx,zy,zw,zh);
      ctx.setLineDash([4,2]); ctx.strokeStyle='rgba(239,68,68,.6)'; ctx.lineWidth=1.2;
      ctx.strokeRect(zx,zy,zw,zh); ctx.setLineDash([]);
      // Diagonal stripes
      ctx.strokeStyle='rgba(239,68,68,.12)'; ctx.lineWidth=0.5;
      for(let d=-Math.max(zw,zh); d<Math.max(zw,zh)*2; d+=8){
        ctx.beginPath(); ctx.moveTo(zx+d,zy); ctx.lineTo(zx+d-zh,zy+zh); ctx.stroke();
      }
      ctx.fillStyle='rgba(239,68,68,.85)'; ctx.font='bold 8px Arial';
      ctx.textAlign='left'; ctx.textBaseline='top';
      ctx.fillText('EXCL #'+(zi+1), zx+3, zy+2);
    });
    ctx.restore();
  }

  // 3. Draw Pores
  page.pores.forEach(p=>{
    const x=p.x*sx, y=p.y*sy, r=Math.max(3,(p.dia/2)*((sx+sy)/2));
    const ignored=spec.u>0&&(p.dia+0.005)<spec.u;
    const fail=!ignored&&p.dia>spec.phi;
    const _cs2 = _poreExclCropStatus(p, page);
    const isExcluded = _cs2.status === 'full';
    const isPartial = _cs2.status === 'partial';

    ctx.save();
    if(isExcluded){
      // Fully inside zone: faint ghost
      ctx.globalAlpha = 0.22;
      ctx.fillStyle='rgba(100,100,100,0.10)';
      ctx.strokeStyle='#bbb'; ctx.lineWidth=1.2; ctx.setLineDash([2,3]);
      if(p._contour && p._contour.length>=4){
        ctx.beginPath();
        p._contour.forEach(([dx,dy],i)=>{
          const px=x+dx*sx, py=y+dy*sy;
          if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
        });
        ctx.closePath(); ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle='#bbb'; ctx.font=`bold ${Math.max(8,Math.min(12,r*.6))}px Arial`;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('✕', x, y);
    } else if(isPartial){
      // Partially in zone: clip to outside zones, show cropped pore
      const ez2 = page.exclusionZones || [];
      // Ghost full outline
      ctx.globalAlpha = 0.15;
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2);
      ctx.strokeStyle='rgba(239,68,68,0.5)'; ctx.lineWidth=1; ctx.setLineDash([2,2]); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Clip to outside zones
      ctx.save();
      ctx.beginPath();
      const rW=page.imgState?.image?.naturalWidth||800, rH=page.imgState?.image?.naturalHeight||600;
      const _pdr = (page.datumRect && page.datumRect.w > 0) ? page.datumRect : null;
      if(_pdr){
        ctx.rect(_pdr.x*sx, _pdr.y*sy, _pdr.w*sx, _pdr.h*sy);
      } else {
        ctx.rect(0,0,rW,rH);
      }
      ez2.forEach(z=>{
        if(z.type==='circle'){
          const zcx=z.cx*sx, zcy=z.cy*sy, zrp=z.r*((sx+sy)/2);
          ctx.moveTo(zcx+zrp,zcy); ctx.arc(zcx,zcy,zrp,0,Math.PI*2);
        } else {
          ctx.rect(z.x*sx, z.y*sy, z.w*sx, z.h*sy);
        }
      });
      ctx.clip('evenodd');
      // Draw pore normally
      const col2=ignored?'#777':fail?'#d92d20':p.zone==='hk'?'#6f42c1':'#0b7285';
      if(p._contour && p._contour.length>=4){
        ctx.beginPath();
        p._contour.forEach(([dx,dy],i)=>{
          const px=x+dx*sx, py=y+dy*sy;
          if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
        });
        ctx.closePath();
        ctx.fillStyle=fail?'rgba(217,45,32,.24)':'rgba(11,114,133,.18)';
        ctx.strokeStyle=col2; ctx.lineWidth=2; ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2);
        ctx.fillStyle=fail?'rgba(217,45,32,.24)':'rgba(11,114,133,.18)';
        ctx.strokeStyle=col2; ctx.lineWidth=2; ctx.fill(); ctx.stroke();
      }
      ctx.restore();
      // Scissor badge
      ctx.font=`bold ${Math.max(8,Math.min(11,r*.65))}px Arial`;
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle='rgba(239,68,68,0.85)';
      ctx.fillText('✂', x+(r*0.55), y-(r*0.55));
    } else {
      // Normal pore drawing
      const col=ignored?'#777':fail?'#d92d20':p.zone==='hk'?'#6f42c1':'#0b7285';
      if(p._contour && p._contour.length>=4){
        ctx.beginPath();
        p._contour.forEach(([dx,dy],i)=>{
          const px=x+dx*sx, py=y+dy*sy;
          if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
        });
        ctx.closePath();
        ctx.fillStyle=fail?'rgba(217,45,32,.24)':'rgba(11,114,133,.18)';
        ctx.strokeStyle=col; ctx.lineWidth=2; ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2);
        ctx.fillStyle=fail?'rgba(217,45,32,.24)':'rgba(11,114,133,.18)';
        ctx.strokeStyle=col; ctx.lineWidth=2; ctx.fill(); ctx.stroke();
      }
    }
    ctx.restore();
  });
  return c.toDataURL('image/jpeg',0.86);
}

function renderReportZoneMap(page, spec, metrics){
  const pores=page.pores||[];
  const pageDatum = (page.datumRect && page.datumRect.w > 0) ? page.datumRect : null;
  const W=520,H=260,wx=35,wy=18,ww=430,wh=210,t3=wh/3;
  let out=`<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">`;
  out+=`<rect width="${W}" height="${H}" fill="#fff"/>`;
  out+=`<rect x="${wx}" y="${wy}" width="${ww}" height="${t3}" fill="rgba(245,159,0,.12)"/>`;
  out+=`<rect x="${wx}" y="${wy+t3}" width="${ww}" height="${t3}" fill="rgba(121,80,242,.10)"/>`;
  out+=`<rect x="${wx}" y="${wy+t3*2}" width="${ww}" height="${t3}" fill="rgba(245,159,0,.12)"/>`;
  out+=`<rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" fill="none" stroke="#999"/>`;
  out+=`<line x1="${wx}" y1="${wy+t3}" x2="${wx+ww}" y2="${wy+t3}" stroke="#ccc" stroke-dasharray="5 3"/>`;
  out+=`<line x1="${wx}" y1="${wy+t3*2}" x2="${wx+ww}" y2="${wy+t3*2}" stroke="#ccc" stroke-dasharray="5 3"/>`;
  out+=`<text x="${wx+5}" y="${wy+12}" fill="#a16207" font-size="10" font-weight="700">HR</text>`;
  out+=`<text x="${wx+5}" y="${wy+t3+12}" fill="#6f42c1" font-size="10" font-weight="700">HK</text>`;
  out+=`<text x="${wx+5}" y="${wy+t3*2+12}" fill="#a16207" font-size="10" font-weight="700">HR</text>`;
  pores.forEach(p=>{
    const x=wx+(p.x/Math.max(metrics.wallW,.01))*ww;
    const y=wy+(p.y/Math.max(metrics.wallH,.01))*wh;
    const r=Math.max(3,Math.min(18,(p.dia/Math.max(metrics.wallH,.01))*wh/2));
    const ignored=spec.u>0&&(p.dia+0.005)<spec.u;
    const fail=!ignored&&p.dia>spec.phi;
    const _cs3 = _poreExclCropStatus(p, page);
    const isExcluded = _cs3.status === 'full';
    const isPartial2 = _cs3.status === 'partial';
    const isOutsideDatum = pageDatum && !_poreOverlapsDatum(p, pageDatum);

    if(isExcluded){
      out+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="rgba(100,100,100,0.04)" stroke="#ccc" stroke-width="1" stroke-dasharray="2 3" opacity="0.4"/>`;
      out+=`<text x="${x.toFixed(1)}" y="${(y+0.5).toFixed(1)}" fill="#ccc" font-size="${Math.max(6, Math.min(10, r*1.2)).toFixed(0)}" text-anchor="middle" dominant-baseline="central" opacity="0.5">✕</text>`;
    } else if(isPartial2){
      const col3=ignored?'#777':fail?'#d92d20':p.zone==='hk'?'#6f42c1':'#0b7285';
      // Ghost full circle
      out+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="rgba(239,68,68,0.3)" stroke-width="1" stroke-dasharray="2 2" opacity="0.5"/>`;
      // Active arc (draw partial using clip)
      const effR = (_cs3.effectiveDia/2 / Math.max(metrics.wallH,.01))*wh;
      out+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${fail?'rgba(217,45,32,.25)':'rgba(11,114,133,.18)'}" stroke="${col3}" stroke-width="1.3" opacity="0.85"/>`;
      out+=`<text x="${(x+r*0.5).toFixed(1)}" y="${(y-r*0.5).toFixed(1)}" fill="rgba(239,68,68,0.8)" font-size="7" text-anchor="middle">✂</text>`;
    } else if(isOutsideDatum){
      out+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="rgba(180,100,0,0.04)" stroke="#bbb" stroke-width="1" stroke-dasharray="2 2" opacity="0.4"/>`;
      out+=`<text x="${x.toFixed(1)}" y="${(y+0.5).toFixed(1)}" fill="#999" font-size="${Math.max(6, Math.min(10, r*1.2)).toFixed(0)}" text-anchor="middle" dominant-baseline="central" opacity="0.5">✕</text>`;
    } else {
      const col=ignored?'#777':fail?'#d92d20':p.zone==='hk'?'#6f42c1':'#0b7285';
      out+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${fail?'rgba(217,45,32,.25)':'rgba(11,114,133,.18)'}" stroke="${col}" stroke-width="1.3"/>`;
    }
  });
  out+='</svg>';
  return out;
}

function buildImageReportSection(tab, page, spec, specIndex, imageIndex){
  const metrics = getImagePageMetrics(page, spec);
  const exclZonesCount = (page.exclusionZones || []).length;

  // ── NET (excl. zone filtered) evaluation ──
  let pores = JSON.parse(JSON.stringify(page.pores || []));
  if(exclZonesCount >= 0) pores = _filterExclZones(pores, page);
  const pageDatum = (page.datumRect && page.datumRect.w > 0) ? page.datumRect : null;
  if(pageDatum) pores = pores.filter(p=>_poreOverlapsDatum(p, pageDatum));
  const evalDatum = _evaluationDatumArea(page, metrics, pageDatum);
  const data = runEvaluationLocal(pores, spec, metrics.wallH, evalDatum, metrics.offset || 0);

  // ── RAW (all pores, NO exclusion zone filter) ──
  let poresRaw = JSON.parse(JSON.stringify(page.pores || []));
  if(pageDatum) poresRaw = poresRaw.filter(p=>_poreOverlapsDatum(p, pageDatum));
  const rawDatumBase = pageDatum ? +(pageDatum.w*pageDatum.h).toFixed(2) : (metrics.datum || (spec.datum||100));
  const rawData = runEvaluationLocal(poresRaw, spec, metrics.wallH, rawDatumBase, metrics.offset || 0);

  const _rawPoreCount = (page.pores || []).length;
  const _exclCount2 = _rawPoreCount - _filterExclZones([...(page.pores||[])], page).length;
  const _totalBefore = pageDatum ? poresRaw.length : _rawPoreCount;
  const _maskedN = pageDatum ? Math.max(0, poresRaw.length - pores.length) : _exclCount2;

  // Sync dual-porosity verdict state back to the page
  page.verdict = {
    allPass: data.all_pass, checks: data.checks, pct: data.pct,
    maxPhi: data.max_phi, gapD: data.gap_data,
    hTriggered: data.h_triggered, nTriggered: data.n_triggered,
    hrZ: data.hr_zone, hkZ: data.hk_zone,
    eff: Array(data.eff_pores).fill({}),
    exclZoneCount: exclZonesCount,
    exclMaskedPores: _maskedN,
    totalPoresBeforeExcl: _totalBefore,
    rawPct: rawData.pct,
    rawPoreCount: poresRaw.length,
    rawDatum: rawDatumBase,
    netPct: data.pct,
    netPoreCount: pores.length,
    netDatum: evalDatum,
    hasExclZone: exclZonesCount > 0,
    hasDatum: !!pageDatum,
    datumArea: evalDatum,
    poresInDatum: pores.length
  };
  page.evaluated = true;

  const updatedMap = new Map();
  data.updated_pores.forEach(up => { if(up.id) updatedMap.set(up.id, up.zone); });
  page.pores.forEach((p,i)=>{ 
    if(updatedMap.has(p.id)) p.zone=updatedMap.get(p.id);
    else p.zone = 'hr'; // fallback
  });

  const rows=data.checks.map(c=>`<tr>
    <td>${escapeHtml(c.n)}</td><td>${escapeHtml(c.meas)}</td><td>${escapeHtml(c.limit)}</td>
    <td class="${c.pass?'pass':'fail'}">${c.pass?'PASS':'FAIL'}</td><td class="detail">${escapeHtml(c.detail)}</td>
  </tr>`).join('');

  // Pore Rows with Status
  const poreRows = page.pores.length ? page.pores.map((p,i)=>{
    const _csR = _poreExclCropStatus(p, page);
    const isExcluded = _csR.status === 'full';
    const isPartialR = _csR.status === 'partial';
    const isOutsideDatum = pageDatum && (p.x < pageDatum.x || p.x > pageDatum.x + pageDatum.w || p.y < pageDatum.y || p.y > pageDatum.y + pageDatum.h);
    let statusStr = '<span class="pass">Active</span>';
    let rowStyle = '';
    if(isExcluded){
      statusStr = '<span class="fail" style="color:#d92d20">✕ Excl. (Zone)</span>';
      rowStyle = ' style="background:#fafafa;text-decoration:line-through;color:#bbb"';
    } else if(isPartialR){
      const pct = ((_csR.fraction||0)*100).toFixed(0);
      statusStr = `<span style="color:#f76707">✂ Cropped (${pct}% active, Ø${_csR.effectiveDia.toFixed(2)})</span>`;
      rowStyle = ' style="background:#fff9f0"';
    } else if(isOutsideDatum){
      statusStr = '<span class="fail" style="color:#f76707">Outside Datum</span>';
      rowStyle = ' style="background:#f9f9f9;text-decoration:line-through;color:#999"';
    }
    const displayDia = isPartialR ? `${Number(p.dia||0).toFixed(3)} <span style="font-size:8px;color:#f76707">(→${_csR.effectiveDia.toFixed(3)})</span>` : Number(p.dia||0).toFixed(3);
    return `<tr${rowStyle}>
      <td>${i+1}</td><td>${displayDia}</td><td>${Number(p.x||0).toFixed(2)}</td>
      <td>${Number(p.y||0).toFixed(2)}</td><td>${escapeHtml((p.zone||'-').toUpperCase())}</td><td>${escapeHtml(p.type||'gas')}</td>
      <td>${statusStr}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="detail">No pores recorded for this image.</td></tr>';

  // ── Datum & Exclusion Analysis section (PDF) ─────────────────────────────
  const _datumType    = pageDatum ? 'Drawn □ (measured square)' : (metrics.calibrated ? 'Full image (calibrated)' : 'Spec default');
  const _datumArea2   = evalDatum.toFixed(2);
  const _rawDatumArea = rawDatumBase.toFixed(2);
  const _hasExclOrDatum = exclZonesCount > 0 || !!pageDatum;

  let datumExclSection = '';
  if(_hasExclOrDatum){
    const _limPct2    = spec.pct || 5;
    const _rawOk2     = rawData.pct <= _limPct2;
    const _netOk2     = data.pct   <= _limPct2;
    const _delta2     = (rawData.pct - data.pct).toFixed(2);
    const _deltaSign2 = (rawData.pct - data.pct) > 0 ? '▼' : (rawData.pct - data.pct) < 0 ? '▲' : '≈';
    const _poresInDatum = pageDatum
      ? page.pores.filter(p => _poreOverlapsDatum(p, pageDatum)).length
      : page.pores.length;
    datumExclSection = `
    <h4 style="border-left:3px solid #b45309;padding-left:8px;color:#b45309;margin-top:16px">□ Datum &amp; Exclusion Analysis</h4>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0 14px">
      <!-- Datum Panel -->
      <div style="border:1.5px solid #f59f00;border-radius:7px;padding:12px 14px;background:#fffbf0">
        <div style="font-weight:800;font-size:10px;color:#b45309;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">□ Datum Zone</div>
        <table style="width:100%;font-size:10px;border-collapse:collapse">
          <tr><td style="color:#666;padding:3px 0;width:45%">Type</td><td style="font-weight:600;color:#111">${_datumType}</td></tr>
          <tr><td style="color:#666;padding:3px 0">Datum Area</td><td style="font-weight:600;color:#111">${_datumArea2} mm²</td></tr>
          ${pageDatum ? `<tr><td style="color:#666;padding:3px 0">Datum dimensions</td><td style="font-weight:600;color:#111">${pageDatum.w.toFixed(2)} × ${pageDatum.h.toFixed(2)} mm</td></tr>` : ''}
          <tr><td style="color:#666;padding:3px 0">Pores in datum</td><td style="font-weight:600;color:#111">${_poresInDatum}</td></tr>
          <tr><td style="color:#666;padding:3px 0">Porosity (datum)</td>
            <td style="font-weight:800;font-size:13px;color:${_netOk2?'#087f5b':'#c92a2a'}">${data.pct.toFixed(2)}%
              <span style="font-size:9px;font-weight:600;padding:1px 5px;border-radius:8px;background:${_netOk2?'#d3f9d8':'#ffe3e3'};color:${_netOk2?'#2f9e44':'#c92a2a'}">${_netOk2?'PASS':'FAIL'} ≤${_limPct2}%</span>
            </td>
          </tr>
        </table>
      </div>
      <!-- Exclusion Panel -->
      <div style="border:1.5px solid ${exclZonesCount>0?'#fa5252':'#dee2e6'};border-radius:7px;padding:12px 14px;background:${exclZonesCount>0?'#fff5f5':'#f8f9fa'}">
        <div style="font-weight:800;font-size:10px;color:${exclZonesCount>0?'#c92a2a':'#868e96'};text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">🚫 Exclusion Zones</div>
        ${exclZonesCount > 0 ? `
        <table style="width:100%;font-size:10px;border-collapse:collapse">
          <tr><td style="color:#666;padding:3px 0;width:45%">Zones defined</td><td style="font-weight:600;color:#c92a2a">${exclZonesCount} zone${exclZonesCount!==1?'s':''}</td></tr>
          <tr><td style="color:#666;padding:3px 0">Pores masked</td><td style="font-weight:600;color:#c92a2a">${_exclCount2} of ${_rawPoreCount}</td></tr>
          <tr><td style="color:#666;padding:3px 0">Before (Raw %)</td>
            <td style="font-weight:800;font-size:12px;color:${_rawOk2?'#087f5b':'#c92a2a'}">${rawData.pct.toFixed(2)}%
              <span style="font-size:9px;padding:1px 5px;border-radius:8px;background:${_rawOk2?'#d3f9d8':'#ffe3e3'};color:${_rawOk2?'#2f9e44':'#c92a2a'}">${_rawOk2?'PASS':'FAIL'}</span>
            </td>
          </tr>
          <tr><td style="color:#666;padding:3px 0">After (Net %)</td>
            <td style="font-weight:800;font-size:12px;color:${_netOk2?'#087f5b':'#c92a2a'}">${data.pct.toFixed(2)}%
              <span style="font-size:9px;padding:1px 5px;border-radius:8px;background:${_netOk2?'#d3f9d8':'#ffe3e3'};color:${_netOk2?'#2f9e44':'#c92a2a'}">${_netOk2?'PASS':'FAIL'}</span>
            </td>
          </tr>
          <tr><td style="color:#666;padding:3px 0">Δ Impact</td><td style="font-weight:700;color:${(rawData.pct-data.pct)>0?'#087f5b':'#c92a2a'}">${_deltaSign2} ${Math.abs(rawData.pct - data.pct).toFixed(2)}% ${(rawData.pct-data.pct)>=0?'reduction':'increase'}</td></tr>
        </table>` : `<div style="font-size:10px;color:#868e96;padding:16px 0;text-align:center">No exclusion zones defined for this image</div>`}
      </div>
    </div>`;
  }

  const imgUrl=renderReportImage(page,spec,metrics);
  return `<section class="image-section">
    <h3>${specIndex}.${imageIndex} ${escapeHtml(page.name)}</h3>
    <div class="mini-meta">
      <span><b>Verdict:</b> <strong class="${data.all_pass?'pass':'fail'}">${data.all_pass?'ACCEPT':'REJECT'}</strong></span>
      <span><b>Pores:</b> ${page.pores.length}</span>
      <span><b>Effective:</b> ${data.eff_pores}</span>
      <span><b>Datum:</b> ${evalDatum.toFixed(1)} mm² ${metrics.calibrated?'(image)':'(spec)'}</span>
      <span><b>Wall H:</b> ${metrics.wallH.toFixed(2)} mm</span>
    </div>
    ${imgUrl?`<div class="media-row"><div><img src="${imgUrl}" class="report-img"><div class="caption">Annotated pore overlay</div></div><div>${renderReportZoneMap(page,spec,metrics)}<div class="caption">Cross-section zone map</div></div></div>`:''}
    <h4>Compliance Checks</h4>
    <table><thead><tr><th>Parameter</th><th>Measured</th><th>Limit</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
    ${datumExclSection}
    <h4>Pore Data</h4>
    <table><thead><tr><th>#</th><th>Φ (mm)</th><th>X (mm)</th><th>Y (mm)<th>Zone</th><th>Type</th><th>Status</th></tr></thead><tbody>${poreRows}</tbody></table>
  </section>`;
}

async function downloadPDF() {
  persistActiveResults();
  
  const btn = document.getElementById('btn-pdf');
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating PDF…';
  }
  
  try {
    const payloadSpecs = Workspace.specs.map(tab => {
      return {
        name: tab.name || 'Specification',
        spec: {
          pno: tab.spec.pno || 'PART-001',
          zone: tab.spec.zone || 'Zone A',
          rev: tab.spec.rev || '—',
          insp: tab.spec.insp || '—',
          pct: isNaN(parseFloat(tab.spec.pct)) ? 5.0 : parseFloat(tab.spec.pct),
          phi: isNaN(parseFloat(tab.spec.phi)) ? 1.5 : parseFloat(tab.spec.phi),
          a: isNaN(parseFloat(tab.spec.a)) ? 2.0 : parseFloat(tab.spec.a),
          u: isNaN(parseFloat(tab.spec.u)) ? 0.2 : parseFloat(tab.spec.u),
          t: isNaN(parseFloat(tab.spec.t)) ? 6.0 : parseFloat(tab.spec.t),
          datum: isNaN(parseFloat(tab.spec.datum)) ? 100.0 : parseFloat(tab.spec.datum),
          h: parseInt(tab.spec.h) || 0,
          n: parseInt(tab.spec.n) || 0,
          hr: parseInt(tab.spec.hr) || 0,
          nr: parseInt(tab.spec.nr) || 0,
          hk: parseInt(tab.spec.hk) || 1,
          nk: parseInt(tab.spec.nk) || 1,
          method: tab.spec.method || 'visual_machined',
          zone_disabled: !!tab.spec.zone_disabled,
          phi_gas: (tab.spec.phi_gas !== undefined && tab.spec.phi_gas !== null && tab.spec.phi_gas !== '' && !isNaN(parseFloat(tab.spec.phi_gas))) ? parseFloat(tab.spec.phi_gas) : null,
          pct_gas: (tab.spec.pct_gas !== undefined && tab.spec.pct_gas !== null && tab.spec.pct_gas !== '' && !isNaN(parseFloat(tab.spec.pct_gas))) ? parseFloat(tab.spec.pct_gas) : null,
          phi_shrink: (tab.spec.phi_shrink !== undefined && tab.spec.phi_shrink !== null && tab.spec.phi_shrink !== '' && !isNaN(parseFloat(tab.spec.phi_shrink))) ? parseFloat(tab.spec.phi_shrink) : null,
          pct_shrink: (tab.spec.pct_shrink !== undefined && tab.spec.pct_shrink !== null && tab.spec.pct_shrink !== '' && !isNaN(parseFloat(tab.spec.pct_shrink))) ? parseFloat(tab.spec.pct_shrink) : null
        },
        images: tab.images.map(img => {
          const metrics = getImagePageMetrics(img, tab.spec);
          return {
            name: img.name || 'Image',
            pores: (img.pores || []).map(p => ({
              id: parseInt(p.id),
              x: parseFloat(p.x),
              y: parseFloat(p.y),
              dia: parseFloat(p.dia),
              type: p.type || 'gas',
              zone: p.zone || 'hr'
            })),
            wall_h_mm: parseFloat(metrics.wallH),
            exclusion_zones: (img.exclusionZones || []).flatMap(z => {
              if (z.type === 'rect') {
                return [{ type: 'rect', x: parseFloat(z.x), y: parseFloat(z.y), w: parseFloat(z.w), h: parseFloat(z.h) }];
              } else if (z.type === 'circle') {
                return [{ type: 'circle', cx: parseFloat(z.cx), cy: parseFloat(z.cy), r: parseFloat(z.r) }];
              } else if (z.type === 'polygon' && z.points && z.points.length >= 3) {
                return [{ type: 'polygon', points: z.points.map(p => ({ x: parseFloat(p.x), y: parseFloat(p.y) })) }];
              }
              return [];
            }),
            // KEY FIX: when no explicit datum rect is drawn but the image IS calibrated,
            // synthesize a full-image datum_rect so the backend uses the actual calibrated
            // image area instead of falling back to spec.datum (e.g. 100 mm² by default).
            // Without this, the PDF report datum would be wrong (too large), making
            // porosity % appear much lower than the live frontend metrics.
            datum_rect: (img.datumRect && img.datumRect.w > 0) ? {
              x: parseFloat(img.datumRect.x),
              y: parseFloat(img.datumRect.y),
              w: parseFloat(img.datumRect.w),
              h: parseFloat(img.datumRect.h)
            } : (metrics.calibrated && metrics.wallW > 0 && metrics.wallH > 0) ? {
              // Synthesized full-image datum from calibrated scale
              x: 0, y: 0,
              w: parseFloat(metrics.wallW.toFixed(4)),
              h: parseFloat(metrics.wallH.toFixed(4))
            } : null,
            pore_offset_mm: parseFloat(metrics.offset) || 0.0
          };
        })
      };
    });

    const res = await fetch('/api/export-workspace-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specs: payloadSpecs })
    });

    if (!res.ok) {
      throw new Error(`Export API error: ${res.status}`);
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `PVI_Workspace_Report_${new Date().toISOString().slice(0,10)}.pdf`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    toast('PDF generated and downloaded successfully.', 'ok');
  } catch (err) {
    console.error('ReportLab export failed. Falling back to browser print view.', err);
    toast('PDF generator failed. Falling back to print view.', 'warn');
    runHtmlPrintFallback();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText || 'Download PDF Report (A4)';
    }
  }
}

function runHtmlPrintFallback() {
  const dateStr = new Date().toLocaleString();
  let imageTotal=0;
  const specSections=Workspace.specs.map((tab,si)=>{
    const spec=tab.spec;
    const imageSections=tab.images.map((page,ii)=>{
      imageTotal++;
      return buildImageReportSection(tab,page,spec,si+1,ii+1);
    }).join('');
    return `<section class="spec-section">
      <h2>Specification ${si+1}: ${escapeHtml(spec.pno||tab.name)}</h2>
      <div class="meta">
        <div><b>Part No:</b> ${escapeHtml(spec.pno||'-')}</div>
        <div><b>Zone:</b> ${escapeHtml(spec.zone||'-')}</div>
        <div><b>Revision:</b> ${escapeHtml(spec.rev||'-')}</div>
        <div><b>Inspector:</b> ${escapeHtml(spec.insp||'-')}</div>
        <div><b>Limits:</b> % ≤${spec.pct||5}, Φ ≤${spec.phi||1.5} mm, A ${spec.a||2}, U ${spec.u||0} mm${spec.phi_gas!=null?' | Gas Φ ≤'+spec.phi_gas+'mm':''}${spec.pct_gas!=null?' Gas %≤'+spec.pct_gas:''}${spec.phi_shrink!=null?' | Shrink Φ ≤'+spec.phi_shrink+'mm':''}${spec.pct_shrink!=null?' Shrink %≤'+spec.pct_shrink:''}</div>
        <div><b>H/N Zones:</b> H${spec.h||0}/N${spec.n||0}, HR${spec.hr||0}/NR${spec.nr||0}, HK${spec.hk||1}/NK${spec.nk||1}</div>
        <div><b>Method:</b> ${ {'visual_machined':'Visual (Machined)','visual_cast':'Visual (As-Cast)','xray':'X-Ray / DR','ct':'CT Scan 3D'}[spec.method] || spec.method || '—' }</div>
      </div>
      ${imageSections}
    </section>`;
  }).join('');
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>PVI Report — 100 Image Workspace</title>
  <style>
    body{font-family:Arial,sans-serif;margin:28px;color:#111;font-size:12px;line-height:1.35}
    h1{margin:0 0 6px;font-size:24px} h2{font-size:17px;margin:24px 0 8px;border-bottom:2px solid #222;padding-bottom:5px}
    h3{font-size:14px;margin:18px 0 6px;color:#222} h4{font-size:12px;margin:12px 0 5px;color:#444}
    table{width:100%;border-collapse:collapse;margin-bottom:8px;page-break-inside:auto}
    th{background:#f0f0f0;padding:6px;text-align:left;font-size:11px;border:1px solid #ddd}
    td{padding:5px 6px;border:1px solid #e6e6e6;vertical-align:top}
    .meta,.mini-meta{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0;color:#555}
    .meta b,.mini-meta b{color:#111}.pass{color:#087f5b;font-weight:700}.fail{color:#c92a2a;font-weight:700}.detail{font-size:10px;color:#666}
    .image-section{page-break-inside:avoid;margin:14px 0 22px}.spec-section{break-after:auto}
    .media-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start;margin:8px 0}
    .report-img{width:100%;border:1px solid #ccc;border-radius:4px}.caption{font-size:10px;color:#777;margin-top:3px}
    @media print{button{display:none}.spec-section{page-break-before:always}.spec-section:first-of-type{page-break-before:auto}}
  </style></head><body>
  <h1>PVI — Porosity Validation Inspection Report</h1>
  <div class="meta">
    <div><b>Date:</b> ${escapeHtml(dateStr)}</div>
    <div><b>Specification tabs:</b> ${Workspace.specs.length}/10</div>
    <div><b>Image pages:</b> ${imageTotal}/100</div>
  </div>
  ${specSections}
  <p style="margin-top:24px;font-size:10px;color:#888">Generated by PVI 3.0 — grouped by specification tab, up to 10 images per specification and 100 total images.</p>
  <script>window.onload=()=>window.print()<\/script>
  </body></html>`);
  win.document.close();
  refreshWorkspaceUI();
}

function _renderChecksHTML(checks){
  return checks.map(c=>`
    <div class="chk-row">
      <div class="chk-ico ${c.pass?'ci-p':'ci-f'}">${c.pass?'✓':'✗'}</div>
      <div>
        <div class="chk-name">${c.n}</div>
        <div class="chk-detail">${c.detail}</div>
      </div>
      <div>
        <div class="chk-meas" style="color:${c.pass?'var(--g)':'var(--red)'}">${c.meas}</div>
        <div class="chk-limit">${c.limit}</div>
      </div>
    </div>`).join('');
}

function _renderChipsHTML(checks){
  return checks.map(c=>
    `<span class="v-chip" style="background:${c.pass?'var(--ga)':'var(--ra)'};color:${c.pass?'var(--g)':'var(--red)'};border:1px solid ${c.pass?'rgba(0,232,162,.25)':'rgba(255,61,61,.25)'}">${c.par}: ${c.pass?'✓':'✗'}</span>`
  ).join('');
}

function renderVerdict(){
  if(!S.evaluated||!S.verdict){ drawGauge(0,S.spec.pct||5); return; }
  const v=S.verdict;
  const lim=S.spec;

  // PRIMARY verdict (datum-filtered or full)
  document.getElementById('v-big').textContent=v.allPass?'ACCEPT':'REJECT';
  document.getElementById('v-big').style.color=v.allPass?'var(--g)':'var(--red)';

  const failCount=v.checks.filter(c=>!c.pass).length;
  const subTxt = v.hasDatum
    ? (v.allPass?'Datum zone meets all requirements':failCount+' parameter(s) outside spec in datum zone')
    : (v.allPass?'Part meets all VW50093 porosity requirements':failCount+' parameter(s) outside specification');
  document.getElementById('v-sub').textContent=subTxt;

  // Chips & count — show DATUM zone chips
  document.getElementById('v-chips').innerHTML=_renderChipsHTML(v.checks);
  const passed=v.checks.filter(c=>c.pass).length;
  document.getElementById('v-pass-count').textContent=passed+'/'+v.checks.length+' passed'+(v.hasDatum?' (datum zone)':'');

  // CHECKS — dual panel when datum exists
  if(v.hasDatum && v.full){
    document.getElementById('v-checks').innerHTML=`
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--amb);margin-bottom:8px;padding:5px 10px;background:rgba(255,173,0,.08);border-radius:6px;border-left:3px solid var(--amb)">
            □ DATUM ZONE — ${v.poresInDatum} pores · ${v.datumArea.toFixed(1)} mm²
            <span style="float:right;font-weight:800;color:${v.allPass?'var(--g)':'var(--red)'}">${v.allPass?'PASS':'FAIL'}</span>
          </div>
          ${_renderChecksHTML(v.checks)}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--blu);margin-bottom:8px;padding:5px 10px;background:rgba(0,150,255,.06);border-radius:6px;border-left:3px solid var(--blu)">
            ⬜ FULL IMAGE — ${v.full.poreCount} pores · ${(v.full.datumArea||0).toFixed(1)} mm²
            <span style="float:right;font-weight:800;color:${v.full.allPass?'var(--g)':'var(--red)'}">${v.full.allPass?'PASS':'FAIL'}</span>
          </div>
          ${_renderChecksHTML(v.full.checks)}
        </div>
      </div>`;
  } else {
    document.getElementById('v-checks').innerHTML=_renderChecksHTML(v.checks);
  }

  // Gauge always shows DATUM (primary) porosity
  drawGauge(v.pct, lim.pct||5);
  drawVerdictZone();

  // ── Hide old porosity-compare card (replaced by dedicated section below) ──
  const _compCard = document.getElementById('v-porosity-compare');
  if(_compCard){ _compCard.style.display='none'; _compCard.innerHTML=''; }

  // ── Render dedicated Datum & Exclusion Analysis section ───────────────────
  _renderDatumExclSection(v, lim);

  // Summary
  const _exclZN = v.exclZoneCount || 0;
  const _exclMN = v.exclMaskedPores || 0;
  const _totalRaw = v.totalPoresBeforeExcl !== undefined ? v.totalPoresBeforeExcl : AP().length;
  const _mLabel={'visual_machined':'Visual (Machined)','visual_cast':'Visual (As-Cast)','xray':'X-Ray / DR','ct':'CT Scan 3D'};
  const summRows=[
    ['Part No.',lim.pno||'—'],['Zone / Feature',lim.zone||'—'],['Drawing Rev.',lim.rev||'—'],
    ['Inspector',lim.insp||'—'],
    ['Method',_mLabel[lim.method]||lim.method||'—'],
    ['Limits — % / Φ / A / U', `≤${lim.pct||5}% / ≤${lim.phi||1.5}mm / A${lim.a||2} / U${lim.u||0}mm`],
    ...(lim.phi_gas!=null||lim.pct_gas!=null?[['Gas limits', `${lim.phi_gas!=null?'Φ≤'+lim.phi_gas+'mm':'—'} / ${lim.pct_gas!=null?'%≤'+lim.pct_gas+'%':'—'}`]]:[] ),
    ...(lim.phi_shrink!=null||lim.pct_shrink!=null?[['Shrink limits', `${lim.phi_shrink!=null?'Φ≤'+lim.phi_shrink+'mm':'—'} / ${lim.pct_shrink!=null?'%≤'+lim.pct_shrink+'%':'—'}`]]:[] ),
    ['H / N zones', `H${lim.h||0} / N${lim.n||0}`],
    ['HR / NR (outer ⅓)', (lim.hr||0)===2?'N/A':`HR${lim.hr||0} / NR${lim.nr||0}`],
    ['HK / NK (central ⅓)', (lim.hk||0)===2?'N/A':`HK${lim.hk||1} / NK${lim.nk||1}`],
    ['Wall thickness t', (S.imgMode?getEffectiveWallH().toFixed(1):lim.t)+' mm'],
    ['Total pores detected', _totalRaw],
    ['Effective pores',v.eff.length],
    ['Date',new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})],
  ];
  document.getElementById('v-summary').innerHTML=summRows.map(([l,val])=>
    `<div class="chk-row" style="grid-template-columns:130px 1fr;padding:6px 0">
      <div style="font-size:11px;color:var(--muted)">${l}</div>
      <div style="font-size:11px;font-weight:600;color:var(--tx);font-variant-numeric:tabular-nums">${val}</div>
    </div>`).join('');

  const MCAP={
    visual_machined:'<strong>Visual / Machined section:</strong> Polished metallographic section cut at Rz=0. Direct measurement of %, Φ, U, A, H, N. HR/HK zone assignment requires precise sectioning at exact zone boundaries. Destructive method.',
    visual_cast:'<strong>Visual / As-Cast surface:</strong> Direct visual inspection of the as-cast surface without machining. No Rz requirement. Best for general surface evaluation. HR/HK depth zones cannot be determined. Non-destructive.',
    xray:'<strong>X-Ray / Digital Radiography:</strong> Internal porosity visible but wall-zone depth (HR/HK/NR/NK) cannot be determined from 2D projection. Reported % is projected area estimate. If zone conditions are specified on the drawing, supplement with section cut or CT scan.',
    ct:'<strong>CT Scan 3D:</strong> All parameters fully determinable. HR/HK/NR/NK zones auto-assigned from 3D pore position. Pore volume, sphericity, and spatial coordinates available. Non-destructive — part survives for further testing. Gold standard for PPAP and new design qualification.'
  };
  const _methodLabel={'visual_machined':'Visual (Machined)','visual_cast':'Visual (As-Cast)','xray':'X-Ray / DR','ct':'CT Scan 3D'};
  document.getElementById('v-method-title').textContent='Method Capability — '+(_methodLabel[lim.method]||lim.method||'—');
  document.getElementById('v-method-note').innerHTML=`<p style="font-size:12px;color:var(--muted);line-height:1.65">${MCAP[lim.method]||'No method recorded.'}</p>`;
}

// ═══════════════════════════════════════════════════
// DATUM & EXCLUSION ZONE — DEDICATED SECTION RENDERER
// ═══════════════════════════════════════════════════
function _renderDatumExclSection(v, lim){
  const sec  = document.getElementById('v-datum-excl-section');
  const body = document.getElementById('v-datum-excl-body');
  const badge= document.getElementById('v-datum-excl-badge');
  if(!sec || !body) return;

  const hasDatum = v.hasDatum;
  const hasExcl  = (v.exclZoneCount||0) > 0 || v.hasExclZone;

  // Hide section entirely when nothing is active
  if(!hasDatum && !hasExcl){
    sec.style.display='none';
    return;
  }
  sec.style.display='block';

  // ── Badge pills ──────────────────────────────────────────────────────────
  const badgeParts=[];
  if(hasDatum) badgeParts.push(`<span style="font-size:9px;padding:2px 8px;border-radius:12px;background:rgba(255,173,0,.15);color:var(--amb);font-weight:700;border:1px solid rgba(255,173,0,.3)">□ Datum active</span>`);
  if(hasExcl)  badgeParts.push(`<span style="font-size:9px;padding:2px 8px;border-radius:12px;background:rgba(239,68,68,.12);color:#ef4444;font-weight:700;border:1px solid rgba(239,68,68,.25)">🚫 ${v.exclZoneCount||0} Excl. Zone${(v.exclZoneCount||0)!==1?'s':''}</span>`);
  badge.innerHTML = badgeParts.join('');

  // ── Shared values ────────────────────────────────────────────────────────
  const limPct   = lim.pct || 5;
  const rawPct   = typeof v.rawPct  ==='number' ? v.rawPct  : v.pct;
  const netPct   = typeof v.netPct  ==='number' ? v.netPct  : v.pct;
  const rawN     = typeof v.rawPoreCount==='number' ? v.rawPoreCount : (v.totalPoresBeforeExcl||0);
  const netN     = typeof v.netPoreCount==='number' ? v.netPoreCount : rawN-(v.exclMaskedPores||0);
  const rawD     = typeof v.rawDatum==='number'  ? v.rawDatum.toFixed(2) : (v.datumArea||0).toFixed(2);
  const netD     = typeof v.netDatum==='number'  ? v.netDatum.toFixed(2) : (v.datumArea||0).toFixed(2);
  const exclZN   = v.exclZoneCount||0;
  const exclMN   = v.exclMaskedPores||0;
  const datumArea= v.datumArea||0;
  const datumType= hasDatum ? 'Drawn □ (measured)' : 'Full image (calibrated)';

  // Helper: status chip
  const chip = (ok, lim) => `<span style="display:inline-block;font-size:9px;padding:2px 8px;border-radius:10px;background:${ok?'rgba(0,232,162,.12)':'rgba(255,61,61,.12)'};color:${ok?'var(--g)':'var(--red)'};font-weight:700">${ok?'✓ ≤':'✗ >'} ${lim}%</span>`;

  // ── Left panel: DATUM ────────────────────────────────────────────────────
  const datumPanel = `
    <div style="background:rgba(255,173,0,.05);border:1px solid rgba(255,173,0,.2);border-radius:10px;padding:16px">
      <div style="font-size:10px;font-weight:800;color:var(--amb);letter-spacing:.07em;text-transform:uppercase;margin-bottom:12px;display:flex;align-items:center;gap:6px">
        <span style="font-size:14px">□</span> Datum Zone
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div>
          <div style="font-size:9px;color:var(--dim);margin-bottom:2px">Type</div>
          <div style="font-size:11px;font-weight:600;color:var(--tx)">${datumType}</div>
        </div>
        <div>
          <div style="font-size:9px;color:var(--dim);margin-bottom:2px">Area</div>
          <div style="font-size:11px;font-weight:600;color:var(--tx)">${datumArea.toFixed(2)} mm²</div>
        </div>
        <div>
          <div style="font-size:9px;color:var(--dim);margin-bottom:2px">Pores in Datum</div>
          <div style="font-size:11px;font-weight:600;color:var(--tx)">${hasDatum ? (v.poresInDatum !== undefined ? v.poresInDatum : v.netPoreCount || 0) : netN}</div>
        </div>
        <div>
          <div style="font-size:9px;color:var(--dim);margin-bottom:2px">Full Image</div>
          <div style="font-size:11px;font-weight:600;color:var(--tx)">${hasDatum&&v.full ? v.full.poreCount+' pores' : '—'}</div>
        </div>
      </div>
      <!-- Porosity in datum -->
      <div style="border-top:1px solid rgba(255,173,0,.15);padding-top:10px">
        <div style="font-size:9px;color:var(--dim);margin-bottom:4px">Porosity (Datum zone)</div>
        <div style="font-size:28px;font-weight:800;color:${v.pct<=limPct?'var(--g)':'var(--red)'};font-variant-numeric:tabular-nums;line-height:1">${v.pct.toFixed(2)}<span style="font-size:14px">%</span></div>
        <div style="margin-top:5px">${chip(v.pct<=limPct, limPct)}</div>
      </div>
      ${hasDatum&&v.full ? `
      <div style="border-top:1px solid rgba(255,173,0,.15);padding-top:10px;margin-top:10px">
        <div style="font-size:9px;color:var(--dim);margin-bottom:4px">Porosity (Full image)</div>
        <div style="font-size:22px;font-weight:800;color:${v.full.pct<=limPct?'var(--g)':'var(--red)'};font-variant-numeric:tabular-nums;line-height:1">${v.full.pct.toFixed(2)}<span style="font-size:12px">%</span></div>
        <div style="margin-top:5px">${chip(v.full.pct<=limPct, limPct)}</div>
      </div>` : ''}
    </div>`;

  // ── Right panel: EXCLUSION ZONES ─────────────────────────────────────────
  let exclPanel = '';
  if(hasExcl){
    const rawOk = rawPct <= limPct;
    const netOk = netPct <= limPct;
    const delta  = (rawPct - netPct).toFixed(2);
    const deltaSign = (rawPct - netPct) > 0 ? '▼' : (rawPct - netPct) < 0 ? '▲' : '≈';
    const deltaColor = (rawPct - netPct) > 0 ? 'var(--g)' : 'var(--red)';
    exclPanel = `
    <div style="background:rgba(239,68,68,.04);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:16px">
      <div style="font-size:10px;font-weight:800;color:#ef4444;letter-spacing:.07em;text-transform:uppercase;margin-bottom:12px;display:flex;align-items:center;gap:6px">
        <span style="font-size:14px">🚫</span> Exclusion Zones
        <span style="margin-left:auto;font-size:9px;background:rgba(239,68,68,.12);color:#ef4444;padding:2px 8px;border-radius:10px;font-weight:700">${exclZN} zone${exclZN!==1?'s':''}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div>
          <div style="font-size:9px;color:var(--dim);margin-bottom:2px">Pores Masked</div>
          <div style="font-size:20px;font-weight:800;color:#ef4444;line-height:1">${exclMN}</div>
        </div>
        <div>
          <div style="font-size:9px;color:var(--dim);margin-bottom:2px">Pores Evaluated</div>
          <div style="font-size:20px;font-weight:800;color:var(--tx);line-height:1">${netN}</div>
        </div>
        <div>
          <div style="font-size:9px;color:var(--dim);margin-bottom:2px">Total (Before Excl.)</div>
          <div style="font-size:11px;font-weight:600;color:var(--tx)">${rawN} pores · ${rawD} mm²</div>
        </div>
        <div>
          <div style="font-size:9px;color:var(--dim);margin-bottom:2px">After Excl.</div>
          <div style="font-size:11px;font-weight:600;color:var(--tx)">${netN} pores · ${netD} mm²</div>
        </div>
      </div>
      <!-- Before / After porosity -->
      <div style="border-top:1px solid rgba(239,68,68,.15);padding-top:10px;display:grid;grid-template-columns:1fr auto 1fr;gap:6px;align-items:center">
        <div style="text-align:center">
          <div style="font-size:8.5px;color:var(--dim);text-transform:uppercase;font-weight:700;margin-bottom:4px">Before (Raw)</div>
          <div style="font-size:22px;font-weight:800;color:${rawOk?'var(--g)':'var(--red)'};font-variant-numeric:tabular-nums;line-height:1">${rawPct.toFixed(2)}<span style="font-size:12px">%</span></div>
          <div style="margin-top:4px">${chip(rawOk, limPct)}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:18px;color:${deltaColor};font-weight:700">${deltaSign}</div>
          <div style="font-size:9px;color:${deltaColor};font-weight:700">${delta}%</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:8.5px;color:var(--dim);text-transform:uppercase;font-weight:700;margin-bottom:4px">After (Net)</div>
          <div style="font-size:22px;font-weight:800;color:${netOk?'var(--g)':'var(--red)'};font-variant-numeric:tabular-nums;line-height:1">${netPct.toFixed(2)}<span style="font-size:12px">%</span></div>
          <div style="margin-top:4px">${chip(netOk, limPct)}</div>
        </div>
      </div>
    </div>`;
  } else {
    exclPanel = `
    <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:120px">
      <div style="font-size:22px;opacity:.3">🚫</div>
      <div style="font-size:11px;color:var(--dim);font-weight:500;text-align:center">No exclusion zones defined<br><span style="font-size:10px;opacity:.7">Use the 🚫 Excl. Rect / Circle tools in the toolbar</span></div>
    </div>`;
  }

  body.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${datumPanel}${exclPanel}</div>`;
}

// ═══════════════════════════════════════════════════
// GAUGE CANVAS
// ═══════════════════════════════════════════════════
function drawGauge(value,limit){
  const gc=document.getElementById('gauge-canvas');
  const g=gc.getContext('2d');
  const W=240,H=140; gc.width=W*2; gc.height=H*2;
  g.scale(2,2);
  g.clearRect(0,0,W,H);
  g.fillStyle='rgba(6,20,16,.0)'; g.fillRect(0,0,W,H);
  const cx=W/2, cy=H*.88, r=H*.72;
  const SA=Math.PI, EA=2*Math.PI;
  // Background track
  g.beginPath(); g.arc(cx,cy,r,SA,EA);
  g.strokeStyle='rgba(0,0,0,.05)'; g.lineWidth=20; g.lineCap='round'; g.stroke();
  // Danger zone (80%–100% of limit)
  const warnA=SA+(EA-SA)*(Math.min(1,limit*0.8/Math.max(limit*1.5,20)));
  const limA=SA+(EA-SA)*(Math.min(1,limit/Math.max(limit*1.5,20)));
  g.beginPath(); g.arc(cx,cy,r,warnA,limA);
  g.strokeStyle='rgba(255,173,0,.12)'; g.lineWidth=20; g.stroke();
  // Over-limit zone
  g.beginPath(); g.arc(cx,cy,r,limA,EA);
  g.strokeStyle='rgba(255,61,61,.1)'; g.lineWidth=20; g.stroke();
  // Value arc
  const pct=Math.min(1,value/Math.max(limit*1.5,20));
  const valA=SA+(EA-SA)*pct;
  const over=value>limit;
  const gr=g.createLinearGradient(cx-r,cy,cx+r,cy);
  if(over){ gr.addColorStop(0,'#ffad00'); gr.addColorStop(1,'#ff3d3d'); }
  else if(value>limit*.8){ gr.addColorStop(0,'#00e8a2'); gr.addColorStop(1,'#ffad00'); }
  else{ gr.addColorStop(0,'#00e8a2'); gr.addColorStop(.8,'#00c88a'); gr.addColorStop(1,'#00e8a2'); }
  g.beginPath(); g.arc(cx,cy,r,SA,valA);
  g.strokeStyle=gr; g.lineWidth=20; g.lineCap='round'; g.stroke();
  // Limit tick
  g.save(); g.strokeStyle='rgba(0,0,0,.2)'; g.lineWidth=3;
  g.beginPath();
  g.moveTo(cx+(r-12)*Math.cos(limA),cy+(r-12)*Math.sin(limA));
  g.lineTo(cx+(r+12)*Math.cos(limA),cy+(r+12)*Math.sin(limA)); g.stroke();
  g.restore();
  // Needle
  g.save(); g.translate(cx,cy); g.rotate(SA+(EA-SA)*pct);
  g.beginPath(); g.moveTo(-4,0); g.lineTo(r-22,0);
  g.strokeStyle=over?'rgba(255,61,61,.9)':'rgba(0,232,162,.9)';
  g.lineWidth=2; g.lineCap='round'; g.stroke();
  g.restore();
  g.beginPath(); g.arc(cx,cy,6,0,Math.PI*2);
  g.fillStyle=over?'var(--red)':'var(--g)'; g.fill();
  // Text
  g.font='bold 28px Space Grotesk'; g.textAlign='center'; g.textBaseline='middle';
  g.fillStyle=over?'#ff3d3d':'#00e8a2';
  g.fillText(value.toFixed(1)+'%',cx,cy-18);
  g.font='11px Space Grotesk'; g.fillStyle='rgba(84,112,96,.9)';
  g.fillText('LIMIT '+limit+'%',cx,cy-4);
  g.font='bold 13px Space Grotesk';
  g.fillStyle=over?'#ff3d3d':'#00e8a2';
  g.fillText(over?'EXCEEDS':'WITHIN LIMIT',cx,cy+10);
}

// ═══════════════════════════════════════════════════
// VERDICT ZONE SVG
// ═══════════════════════════════════════════════════
function drawVerdictZone(){
  const svg=document.getElementById('v-zone-svg');
  if(!svg) return;
  const W=460,H=320,wx=50,wy=18,ww=350,wh=268,t3=wh/3;
  const wHmm=getEffectiveWallH();   // image height or spec wall thickness
  const wWmm=getEffectiveWallW();   // image width or spec wall width
  let out=`<rect width="${W}" height="${H}" fill="#ffffff" rx="8"/>`;

  // ── Image background (image mode only) ──────────────────────────────────
  if(S.imgMode && S.imgState.image){
    try{
      const oc=document.createElement('canvas'); oc.width=ww; oc.height=wh;
      const cx2=oc.getContext('2d');
      cx2.drawImage(S.imgState.image,0,0,ww,wh);
      const dataUrl=oc.toDataURL('image/jpeg',0.82);
      out+=`<image href="${dataUrl}" x="${wx}" y="${wy}" width="${ww}" height="${wh}" opacity="0.85"/>`;
    }catch(e){}
  }

  // ── Zone fills (semi-transparent overlays) ───────────────────────────────
  const zAlpha=S.imgMode?0.06:0.08;
  out+=`<rect x="${wx}" y="${wy}" width="${ww}" height="${t3}" fill="rgba(255,173,0,${zAlpha})"/>`;
  out+=`<rect x="${wx}" y="${wy+t3}" width="${ww}" height="${t3}" fill="rgba(155,107,255,${zAlpha*.8})"/>`;
  out+=`<rect x="${wx}" y="${wy+t3*2}" width="${ww}" height="${t3}" fill="rgba(255,173,0,${zAlpha})"/>`;
  out+=`<rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="1.5"/>`;
  out+=`<line x1="${wx}" y1="${wy+t3}" x2="${wx+ww}" y2="${wy+t3}" stroke="rgba(255,255,255,.6)" stroke-width="1" stroke-dasharray="5 3"/>`;
  out+=`<line x1="${wx}" y1="${wy+t3*2}" x2="${wx+ww}" y2="${wy+t3*2}" stroke="rgba(255,255,255,.6)" stroke-width="1" stroke-dasharray="5 3"/>`;
  out+=`<text x="${wx+6}" y="${wy+11}" fill="rgba(255,173,0,.7)" font-family="Space Grotesk" font-size="8" font-weight="600">HR ZONE</text>`;
  out+=`<text x="${wx+6}" y="${wy+t3+11}" fill="rgba(155,107,255,.7)" font-family="Space Grotesk" font-size="8" font-weight="600">HK ZONE</text>`;
  out+=`<text x="${wx+6}" y="${wy+t3*2+11}" fill="rgba(255,173,0,.7)" font-family="Space Grotesk" font-size="8" font-weight="600">HR ZONE</text>`;
  out+=`<text x="${wx+2}" y="${wy-5}" fill="rgba(0,0,0,.5)" font-family="Space Grotesk" font-size="9">SURFACE A</text>`;
  out+=`<text x="${wx+2}" y="${wy+wh+12}" fill="rgba(0,0,0,.4)" font-family="Space Grotesk" font-size="9">SURFACE B</text>`;
  [[wy,wy+t3,'t/3','rgba(255,173,0,.5)'],[wy+t3,wy+t3*2,'t/3','rgba(155,107,255,.5)'],[wy+t3*2,wy+wh,'t/3','rgba(255,173,0,.5)']].forEach(([y1,y2,lbl,col])=>{
    const bx=wx+ww+8;
    out+=`<line x1="${bx}" y1="${y1}" x2="${bx}" y2="${y2}" stroke="${col}" stroke-width="1"/>`;
    out+=`<text x="${bx+5}" y="${(y1+y2)/2+3}" fill="${col}" font-family="Space Grotesk" font-size="9">${lbl}</text>`;
  });

  // ── Pores: real contour shapes when available, else circles ─────────────
  function poreContourSVG(p, svgCx, svgCy, svgR, col, fillC, fail){
    let s='';
    if(p._contour && p._contour.length>=4){
      // Scale mm-offsets to SVG coords
      const scX=ww/wWmm, scY=wh/wHmm;
      const pts=p._contour.map(([dx,dy])=>
        `${(svgCx+dx*scX).toFixed(1)},${(svgCy+dy*scY).toFixed(1)}`
      ).join(' ');
      if(fail) s+=`<polygon points="${pts}" fill="none" stroke="rgba(255,61,61,.3)" stroke-width="2" stroke-dasharray="3 2"/>`;
      s+=`<polygon points="${pts}" fill="${fillC}" stroke="${col}" stroke-width="1.2"/>`;
    } else {
      if(fail) s+=`<circle cx="${svgCx}" cy="${svgCy}" r="${svgR+4}" fill="none" stroke="rgba(255,61,61,.3)" stroke-width="1.5" stroke-dasharray="3 2"/>`;
      s+=`<circle cx="${svgCx}" cy="${svgCy}" r="${svgR}" fill="${fillC}" stroke="${col}" stroke-width="1.2"/>`;
    }
    if(svgR>7) s+=`<text x="${svgCx}" y="${svgCy+3}" text-anchor="middle" fill="${col}" font-family="Space Grotesk" font-size="7.5">${p.dia.toFixed(2)}</text>`;
    return s;
  }

  if(AP().length>0){
    AP().forEach(p=>{
      const svgX=wx+(p.x/wWmm)*ww;
      const svgY=wy+(p.y/wHmm)*wh;
      const svgR=Math.max(3,Math.min(22,(p.dia/wHmm)*wh*.5));
      const excl = typeof _poreInExclZone==='function' && _poreInExclZone(p);
      const ign=S.spec.u>0&&(p.dia+0.005)<S.spec.u;
      const fail=!ign&&!excl&&p.dia>S.spec.phi;
      const col=excl?'rgba(180,180,180,.6)':ign?'rgba(120,120,120,.7)':fail?'#ff3d3d':p.zone==='hr'?'#ffad00':p.zone==='hk'?'#9b6bff':'#00e8a2';
      const fillC=excl?'rgba(180,180,180,.1)':ign?'rgba(120,120,120,.15)':fail?'rgba(255,61,61,.25)':
                  p.zone==='hr'?'rgba(255,173,0,.2)':p.zone==='hk'?'rgba(155,107,255,.2)':'rgba(0,232,162,.15)';
      out+=poreContourSVG(p,svgX,svgY,svgR,col,fillC,fail);
      if(excl) {
        out+=`<line x1="${svgX-4}" y1="${svgY-4}" x2="${svgX+4}" y2="${svgY+4}" stroke="rgba(180,180,180,.8)" stroke-width="1.5"/>`;
        out+=`<line x1="${svgX+4}" y1="${svgY-4}" x2="${svgX-4}" y2="${svgY+4}" stroke="rgba(180,180,180,.8)" stroke-width="1.5"/>`;
      }
    });
  }
  svg.innerHTML=out;

  // Update full image pore count label
  const fullLbl=document.getElementById('v-full-pore-count');
  if(fullLbl) fullLbl.textContent=AP().length+' pores total';

  // ── Datum-cropped canvas view ───────────────────────────────────────────────
  const datumCard=document.getElementById('v-datum-card');
  const datumCanvas=document.getElementById('v-datum-canvas');
  const dr=S.datumRect;
  if(!dr || dr.w<=0 || !S.imgState.image || !S.imgState.scalePxPerMm || !datumCanvas){
    if(datumCard) datumCard.style.display='none';
    return;
  }
  datumCard.style.display='';
  const img=S.imgState.image;
  const sc=S.imgState.scalePxPerMm; // canvas px per mm (calibrated)
  const fitSc=S.imgState.fitScale||1;
  const natPxMm=sc/fitSc; // natural image px per mm
  // Datum in natural image pixels
  const sx=dr.x*natPxMm, sy=dr.y*natPxMm;
  const sw=dr.w*natPxMm, sh=dr.h*natPxMm;
  const cW=400, cH=Math.round(cW*(sh/sw));
  datumCanvas.width=cW; datumCanvas.height=cH;
  const dc=datumCanvas.getContext('2d');
  dc.fillStyle='#111'; dc.fillRect(0,0,cW,cH);
  // Draw cropped image region
  try{ dc.drawImage(img, sx,sy,sw,sh, 0,0,cW,cH); } catch(e){}
  // Draw datum pores as overlays (clip to canvas so cropped pores don't spill over)
  const datumPores=getPoresForEvaluation(AP());
  dc.save();
  dc.beginPath(); dc.rect(0,0,cW,cH); dc.clip();
  dc.font='bold 10px sans-serif'; dc.textAlign='center';
  datumPores.forEach(p=>{
    const px=((p.x-dr.x)/dr.w)*cW;
    const py=((p.y-dr.y)/dr.h)*cH;
    const pr=Math.max(4,((p.dia/2)/dr.w)*cW);
    const ign=S.spec.u>0&&(p.dia+0.005)<S.spec.u;
    const fail=!ign&&p.dia>S.spec.phi;
    const col=ign?'rgba(140,140,140,.7)':fail?'#ff3d3d':p.zone==='hr'?'#ffad00':p.zone==='hk'?'#9b6bff':'#00e8a2';
    // Contour or circle
    if(p._contour&&p._contour.length>=4){
      dc.beginPath();
      const scX=cW/dr.w, scY=cH/dr.h;
      p._contour.forEach(([dx,dy],i)=>{
        const cx2=px+dx*scX, cy2=py+dy*scY;
        i===0?dc.moveTo(cx2,cy2):dc.lineTo(cx2,cy2);
      });
      dc.closePath();
      dc.strokeStyle=col; dc.lineWidth=1.5;
      dc.fillStyle=col.replace(')',',0.2)').replace('rgba','rgba').replace('rgb(','rgba(').replace(/#([0-9a-f]{6})/i,(_,h)=>{const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16);return `rgba(${r},${g},${b},0.2)`;});
      dc.fill(); dc.stroke();
    } else {
      dc.beginPath(); dc.arc(px,py,pr,0,Math.PI*2);
      dc.fillStyle=col.replace('#','').length===6?`rgba(${parseInt(col.slice(1,3),16)},${parseInt(col.slice(3,5),16)},${parseInt(col.slice(5,7),16)},0.25)`:col;
      dc.fill(); dc.strokeStyle=col; dc.lineWidth=1.5; dc.stroke();
    }
    if(pr>8){ dc.fillStyle='#fff'; dc.fillText(p.dia.toFixed(1),px,py+3.5); }
    if(p._isCropped){
      dc.font='11px Arial'; dc.fillStyle='#f59e0b';
      dc.fillText('✂',px+(pr*0.7),py-(pr*0.7));
      dc.font='bold 10px sans-serif';
    }
  });
  dc.restore();
  // Datum border overlay
  dc.strokeStyle='rgba(255,173,0,.9)'; dc.lineWidth=3; dc.setLineDash([8,5]);
  dc.strokeRect(2,2,cW-4,cH-4); dc.setLineDash([]);
  // Pore count label
  const dtLbl=document.getElementById('v-datum-pore-count');
  if(dtLbl) dtLbl.textContent=datumPores.length+' pores in datum · '+dr.w.toFixed(1)+'×'+dr.h.toFixed(1)+'mm';
}

// ═══════════════════════════════════════════════════
// QUICK REFERENCE PAGE
// ═══════════════════════════════════════════════════
function buildRef(){
  const host=document.getElementById('ref-scroll');
  if(host.innerHTML.trim()) return;
  const params=[
    ['%','Porosity %','Total pore area inside datum ÷ datum area × 100. Min 1%. ≤4: round to integer. ≥5: steps of 5. If spec <5%: 3×4mm sub-area must also satisfy <4%.','—'],
    ['Φ','Max single pore Φ','Max permissible diameter of any individual pore (max Feret). Steps of 0.5mm. Pores <0.5mm not considered. A packing cluster overall size ≤ Φ is treated as one pore.','mm'],
    ['U','Ignore threshold','Machined surfaces only — pores with Φ < U excluded from evaluation. Steps of 0.1mm, min 0.2mm. Not applicable to as-cast surfaces.','mm'],
    ['A','Spacing coefficient','Min edge-to-edge gap = A × Φ_smaller. If gap < this: pore group formed → H condition triggered. Edge-to-edge, NOT centre-to-centre.','×Φs'],
    ['H / HR / HK','Looseness','Packing / Auflockerung. H: full surface. HR: outer ⅓ (both surface sides). HK: central ⅓ (hot-node). H0/HR0/HK0 = NOT permitted. H1/HR1/HK1 = permitted.','0/1'],
    ['N / NR / NK','Coarse pore group','Packing cluster whose overall bounding size > Φ limit. Same zone variants as H. N0 = NOT permitted. N1 = permitted.','0/1'],
    ['Rz','Surface prep','Rz=0: mirror polish (default), confirmed at ×100 — no scratches. Rz>0: as-machined surface acceptable. Must be verified before evaluation.','µm'],
    ['Z','Pore count','Maximum number of individual pores on machined surface. Each pore AND each packing cluster counted as one unit.','count'],
  ];
  const methods=[
    ['Visual (Machined)','Full','Full','Full','Full','Full','Full','Full','Full','YES'],
    ['Visual (As-Cast)','Full','Full','No','Full','Partial','Partial','Partial','Partial','YES'],
    ['X-Ray / DR','2D est.','2D only','No','2D only','No','No','No','No','No'],
    ['CT Scan 3D','3D Full','3D Full','Voxel','3D Full','3D Full','3D Full','3D Full','3D Full','No'],
  ];
  host.innerHTML=`
  <table class="ref-table" style="margin-bottom:24px">
    <thead><tr><th>Sym</th><th>Name</th><th>Definition</th><th>Unit</th></tr></thead>
    <tbody>${params.map(([s,n,d,u],i)=>`
      <tr>
        <td><span class="ref-sym" style="color:var(--tx)">${s}</span></td>
        <td style="font-weight:600;color:var(--tx);font-size:12px">${n}</td>
        <td style="color:var(--muted);line-height:1.5">${d}</td>
        <td style="font-family:monospace;color:var(--dim)">${u}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <div style="font-size:13px;font-weight:700;color:var(--tx);margin-bottom:12px">Detectability Matrix</div>
  <table class="ref-table">
    <thead><tr><th>Method</th><th>%</th><th>Φ</th><th>U</th><th>A</th><th>H</th><th>HR/HK</th><th>N</th><th>NR/NK</th><th>Destructive</th></tr></thead>
    <tbody>${methods.map(r=>`<tr>${r.map((v,i)=>{
      const col=v.includes('Full')?'var(--g)':v==='No'||v==='YES'&&i===10?'var(--red)':v.includes('est')||v.includes('Partial')||v.includes('2D')||v.includes('Voxel')?'var(--amb)':'var(--tx)';
      return `<td style="color:${col};font-weight:${i<2?700:500}">${v}</td>`;
    }).join('')}</tr>`).join('')}
    </tbody>
  </table>`;
}

// ═══════════════════════════════════════════════════
// RESET
// ═══════════════════════════════════════════════════
function resetAll(){
  Workspace.specs = [makeSpecTab(1, { pno:'', zone:'', rev:'', insp:'', pct:5, phi:1.5, a:2, u:0.2, t:6, datum:100,
          h:0, n:0, hr:0, nr:0, hk:1, nk:1, method:'visual_machined', specSaved:false })];
  Workspace.activeSpec = 0;
  bindActiveWorkspace();
  S.pores=[]; S.imgPores=[]; S.history=[]; S.redoHistory=[]; S.selectedId=null; S.evaluated=false; S.verdict=null;
  activeSpecTab().drawPores=S.pores;
  activeImagePage().pores=S.imgPores;
  activeImagePage().history=S.history;
  activeImagePage().redoHistory=S.redoHistory;
  S.datumRect=null; S.measurePt1=null; S.spec.specSaved=false;
  HPDC_STATE.set('lastVerdict', null, 'Tool 01');
  ['bsp','bme','bve'].forEach(id=>{ document.getElementById(id).textContent={bsp:'SETUP',bme:'READY',bve:'PENDING'}[id]; document.getElementById(id).className='nb-badge nbb-idle'; });
  document.getElementById('tb-part').textContent='—';
  document.getElementById('tb-pct').textContent='—';
  document.getElementById('tb-pct').style.color='var(--tx)';
  document.getElementById('tb-badge').textContent='AWAITING SPEC'; document.getElementById('tb-badge').className='t-badge tb-idle';
  document.getElementById('tb-dot').className='t-dot td-idle';
  document.getElementById('sb-spec-body').innerHTML='<div style="font-size:10px;color:var(--dim)">No spec loaded</div>';
  document.getElementById('h-sp-st').innerHTML='<span style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;background:var(--aa);color:var(--amb)">NOT CONFIGURED</span>';
  document.getElementById('h-me-st').innerHTML='<span style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;background:var(--c3);color:var(--dim)">AWAITING SPEC</span>';
  document.getElementById('h-ve-st').innerHTML='<span style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:10px;background:var(--c3);color:var(--dim)">PENDING</span>';
  renderSpecTabs();
  renderImageTabs();
  loadSpecIntoForm();
  updateImageControlsUI();
  updateHomeVerdictBadge();
  if(mctx) drawCanvas();
  nav('meas');
}

// ═══════════════════════════════════════════════════
// RESIZE HANDLER
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// IMAGE MODE — DEEP UPGRADE
// ═══════════════════════════════════════════════════
function switchCanvasMode(mode){
  persistActiveResults();
  S.imgMode = true;
  bindActiveWorkspace();
  S.selectedId = null; // clear cross-mode selection
  const tb=document.getElementById('img-toolbar');
  if(tb) tb.classList.add('show');
  if(S.tool==='datum') setTool('select');
  updateSpecSummaryUI();
  updateImageControlsUI();
  updateImgHint();
  updatePoreRegistry(); // show the correct mode's pore list
  showEditPanel();      // hide edit panel if no selection
  refreshImgOffsetUI(); // show image offset panel
  drawCanvas();
}

function updateImgHint(){
  const h=document.getElementById('canvas-hint');
  if(!S.imgMode){ h.textContent='Click to place pore · Scroll over pore: resize · Right-click: delete'; return; }
  const it=S.imgState.imgTool;
  if(it==='scale_mm')  h.textContent='Click and DRAG to draw a reference line, then release to enter its length in mm';
  else if(it==='scale_line') h.textContent='Click and DRAG over a feature of KNOWN length (e.g. a visible scale bar), then enter its real length in mm';
  else if(it==='crop') h.textContent='Click and DRAG to select crop area — then click ✅ Apply';
  else if(!S.imgState.image) h.textContent='Upload a casting photo → Set Scale → place pores';
  else if(!S.imgState.scalePxPerMm) h.textContent='Set Scale first (Line mm or Area mm²) before placing pores';
  else h.textContent='Click on pores to place markers · Scroll over pore: resize · Right-click: delete';
}

function imgToolActivate(tool){
  // deactivate all
  ['btn-crop','btn-scale-tool-top'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.classList.remove('img-tool-on');
  });
  S.imgState.imgTool = (S.imgState.imgTool===tool) ? null : tool; // toggle
  if(S.imgState.imgTool){
    const idMap={crop:'btn-crop',scale_line:'btn-scale-tool-top'};
    const el=document.getElementById(idMap[tool]); if(el) el.classList.add('img-tool-on');
    const wrap = document.getElementById('canvas-wrap');
    if(wrap) wrap.style.cursor = 'crosshair';
  } else {
    const wrap = document.getElementById('canvas-wrap');
    if(wrap) {
      const cursors={place:'crosshair',select:'grab',measure:'crosshair',datum:'cell',exclude_rect:'crosshair',exclude_circle:'crosshair',excl_select:'default',pan:'grab'};
      wrap.style.cursor = cursors[S.tool] || 'default';
    }
  }
  S.imgState.scaleDrawing=false; S.imgState.cropDrawing=false;
  S.imgState.scaleLine=null; S.imgState.scaleRect=null; S.imgState.cropRect=null;
  document.getElementById('btn-applycrop').style.display='none';
  document.getElementById('btn-cancelcrop').style.display='none';
  refreshWorkspaceUI();
}

function loadImageFile(evt){
  try {
  const file=evt.target.files[0]; if(!file) return;
  console.log(`[PVI] Loading image: ${file.name} (${(file.size/1024).toFixed(0)}KB)`);
  if(!file.type.startsWith('image/')){
    toast('Only image files are supported (PNG, JPG, TIFF)','error');
    console.error('[PVI] Invalid file type:', file.type);
    return;
  }
  const reader=new FileReader();
  reader.onerror = (e) => { console.error('[PVI] FileReader error:', e); toast('Failed to read file','error'); };
  reader.onload=e=>{
    const img=new Image();
    img.onerror = () => { console.error('[PVI] Image decode failed for:', file.name); toast('Image could not be decoded','error'); };
    img.onload=()=>{
      console.log(`[PVI] Image loaded: ${img.naturalWidth}×${img.naturalHeight}px`);
      pushHistory();

      // Force navigation to the measurement tab so the canvas is visible.
      // This also fires requestAnimationFrame(initCanvas) to properly size and draw.
      if(typeof nav === 'function') nav('meas');
      if(typeof switchCanvasMode === 'function') switchCanvasMode('img');
      else S.imgMode = true;

      // Reset ALL image state cleanly before setting new image
      S.imgState = Object.assign(S.imgState, {
        image: img,
        cacheValid: false,
        scalePxPerMm: null, scaleLine: null, scaleRect: null,
        cropRect: null, imgTool: null,
        offscreen: null, fitScale: null,
        imgX: null, imgY: null, imgW: null, imgH: null
      });
      document.getElementById('img-scale-info').style.display='none';
      activeImagePage().name = file.name.replace(/\.[^.]+$/,'').slice(0,24) || activeImagePage().name;
      const infoEl = document.getElementById('img-overlay-info');
      if(infoEl) infoEl.textContent = `${file.name}  ·  ${img.naturalWidth}×${img.naturalHeight}px`;
      renderImageTabs();
      updateImgHint();
      
      const triggerDraw = () => {
        if(!mctx || S.cv.W < 1){ initCanvas(); }
        refreshWorkspaceUI();
      };
      
      if (typeof img.decode === 'function') {
        img.decode().then(triggerDraw).catch(triggerDraw);
      } else {
        setTimeout(triggerDraw, 50);
      }
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
  evt.target.value='';
  } catch(err) {
    console.error('[PVI] loadImageFile error:', err);
    toast('Error loading image: ' + err.message, 'error');
  }
}

// ── Scale calibration via drag ────────────────────────────────────────────
// ── Scale calibration — LINE method (industry standard, like ImageJ) ─────────
function showScaleInput(){
  const sl=S.imgState.scaleLine;
  if(!sl) return;
  const pxLen=Math.hypot(sl.x2-sl.x1, sl.y2-sl.y1);
  if(pxLen<5){ S.imgState.scaleLine=null; drawCanvas(); return; }
  const overlay=document.getElementById('scale-input-overlay');
  const wrap=document.getElementById('canvas-wrap');
  const wr=wrap.getBoundingClientRect();
  const mx=Math.min((sl.x1+sl.x2)/2, wr.width-340);
  const my=Math.min(Math.max((sl.y1+sl.y2)/2+20, 20), wr.height-200);
  overlay.style.left=Math.max(8,mx)+'px';
  overlay.style.top=my+'px';
  overlay.style.display='block';
  // Line angle info
  const dx=sl.x2-sl.x1, dy=sl.y2-sl.y1;
  const angleDeg=Math.abs(Math.atan2(dy,dx)*180/Math.PI);
  const isHoriz=angleDeg<15||angleDeg>165;
  const lineTip=isHoriz?'(horizontal line ✓)':angleDeg>75&&angleDeg<105?'(vertical line ✓)':`(diagonal ${angleDeg.toFixed(0)}°)`;
  document.getElementById('scale-px-info').textContent=
    `Line: ${pxLen.toFixed(1)} px ${lineTip} — enter the REAL length of this line in mm`;
  overlay.dataset.pxLen=pxLen;
  const inp=document.getElementById('scale-mm-input');
  inp.value=''; inp.focus();
  // Hide preview until typing
  const prev=document.getElementById('scale-dim-preview');
  if(prev) prev.style.display='none';
}

// Live dimension preview while typing mm value
function _scalePreview(val){
  const mm=parseFloat(val);
  const overlay=document.getElementById('scale-input-overlay');
  const pxLen=parseFloat(overlay.dataset.pxLen);
  const prev=document.getElementById('scale-dim-preview');
  const wh=document.getElementById('scale-preview-wh');
  if(!prev||!wh) return;
  if(!mm||mm<=0||!pxLen){ prev.style.display='none'; return; }
  const pxPerMm=pxLen/mm;
  // Canvas dimensions
  const canvas=document.getElementById('main-canvas');
  if(!canvas){ prev.style.display='none'; return; }
  const imgW=S.imgState.image?S.imgState.image.naturalWidth:canvas.width;
  const imgH=S.imgState.image?S.imgState.image.naturalHeight:canvas.height;
  const fitSc=S.imgState.fitScale||1;
  const natPxPerMm=pxPerMm/fitSc;
  const widthMm=(imgW/natPxPerMm).toFixed(1);
  const heightMm=(imgH/natPxPerMm).toFixed(1);
  // Sanity: flag if >500mm (likely wrong)
  const sane=parseFloat(widthMm)<500&&parseFloat(heightMm)<500&&parseFloat(widthMm)>0.5;
  wh.textContent=`${widthMm} × ${heightMm} mm`;
  wh.style.color=sane?'var(--g)':'var(--red)';
  if(!sane) wh.textContent+=` ⚠ Seems too ${parseFloat(widthMm)>500?'large':'small'} — check your mm value`;
  prev.style.display='block';
}

function confirmScale(){
  const overlay=document.getElementById('scale-input-overlay');
  const mm=parseFloat(document.getElementById('scale-mm-input').value);
  const pxLen=parseFloat(overlay.dataset.pxLen);
  if(!mm||mm<=0||!pxLen){ cancelScale(); return; }
  overlay.style.display='none';
  pushHistory();
  S.imgState.scalePxPerMm = pxLen / mm;  // px per mm — Euclidean (works for any line direction)
  S.imgState.scaleLine = null;
  S.imgState.imgTool=null;
  S.imgState.cacheValid=false;
  const btn=document.getElementById('btn-scale-tool-top');
  if(btn) btn.classList.remove('img-tool-on');
  showScaleInfo();
  _updateScaleDisplay();
  refreshWorkspaceUI();
  // Show sanity toast with image dimensions
  const canvas=document.getElementById('main-canvas');
  if(canvas&&S.imgState.image){
    const fitSc=S.imgState.fitScale||1;
    const natPxPerMm=S.imgState.scalePxPerMm/fitSc;
    const wMm=(S.imgState.image.naturalWidth/natPxPerMm).toFixed(1);
    const hMm=(S.imgState.image.naturalHeight/natPxPerMm).toFixed(1);
    const sane=parseFloat(wMm)<500&&parseFloat(hMm)<500&&parseFloat(wMm)>0.5;
    toast(
      sane
        ? `Scale set ✓ — Image = ${wMm} × ${hMm} mm (${S.imgState.scalePxPerMm.toFixed(1)} px/mm)`
        : `⚠ Scale may be wrong — Image = ${wMm} × ${hMm} mm. Try a different mm value.`,
      sane?'info':'warn'
    );
  }
}

function cancelScale(){
  document.getElementById('scale-input-overlay').style.display='none';
  S.imgState.scaleLine=null;
  S.imgState.imgTool=null;
  const btn=document.getElementById('btn-scale-tool-top');
  if(btn) btn.classList.remove('img-tool-on');
  _updateScaleDisplay();
  refreshWorkspaceUI();
}

function showScaleInfo(){
  const ppm=S.imgState.scalePxPerMm;
  const info=document.getElementById('img-scale-info');
  info.style.display='inline-flex';
  info.textContent=`Scale: ${(1/ppm).toFixed(4)} mm/px  ·  ${ppm.toFixed(2)} px/mm`;
}

// ── Crop cancel ───────────────────────────────────────────────────────────
function cancelCrop(){
  S.imgState.cropRect=null; S.imgState.cropDrawing=false;
  document.getElementById('btn-applycrop').style.display='none';
  document.getElementById('btn-cancelcrop').style.display='none';
  // Keep crop tool active so user can redraw a new selection
  refreshWorkspaceUI();
  toast('Crop selection cleared — draw a new area or click ✂️ Crop again to exit', 'info');
}

// ── Crop ──────────────────────────────────────────────────────────────────
function applyCrop(){
  const r=S.imgState.cropRect; if(!r) return;
  pushHistory();
  const img=S.imgState.image;
  const fit=S.imgState.fitScale;
  const ix=S.imgState.imgX, iy=S.imgState.imgY;
  const sx=(r.x-ix)/fit, sy=(r.y-iy)/fit;
  const sw=Math.abs(r.w)/fit, sh=Math.abs(r.h)/fit;
  if(sw<10||sh<10){ toast('Crop area too small — draw a larger region','warn'); return; }
  const oc=document.createElement('canvas');
  oc.width=sw; oc.height=sh;
  oc.getContext('2d').drawImage(img,sx,sy,sw,sh,0,0,sw,sh);
  const ni=new Image(); ni.src=oc.toDataURL();
  ni.onload=()=>{
    S.imgState.image=ni;
    S.imgState.cropRect=null; S.imgState.imgTool=null;
    S.imgState.scalePxPerMm=null; S.imgState.scaleLine=null; S.imgState.scaleRect=null;
    document.getElementById('btn-applycrop').style.display='none';
    document.getElementById('btn-cancelcrop').style.display='none';
    document.getElementById('btn-crop').classList.remove('img-tool-on');
    document.getElementById('img-scale-info').style.display='none';
    S.imgState.imgOffsetX=0; S.imgState.imgOffsetY=0;
    document.getElementById('img-overlay-info').textContent=
      `Cropped: ${Math.round(sw)}×${Math.round(sh)}px · Set Scale to recalibrate`;
    refreshWorkspaceUI();
  };
}

// ── Rotate / Flip ─────────────────────────────────────────────────────────
function rotateImage(deg){
  if(!S.imgState.image) return;
  const img=S.imgState.image;
  const oc=document.createElement('canvas');
  const abs90=(Math.abs(deg)===90);
  oc.width  = abs90?img.naturalHeight:img.naturalWidth;
  oc.height = abs90?img.naturalWidth:img.naturalHeight;
  const ctx=oc.getContext('2d');
  ctx.translate(oc.width/2, oc.height/2);
  ctx.rotate(deg*Math.PI/180);
  ctx.drawImage(img,-img.naturalWidth/2,-img.naturalHeight/2);
  const ni=new Image(); ni.src=oc.toDataURL();
  ni.onload=()=>{ pushHistory(); S.imgState.image=ni; refreshWorkspaceUI(); };
}

function flipImage(axis){
  if(!S.imgState.image) return;
  const img=S.imgState.image;
  const oc=document.createElement('canvas');
  oc.width=img.naturalWidth; oc.height=img.naturalHeight;
  const ctx=oc.getContext('2d');
  if(axis==='h'){ ctx.scale(-1,1); ctx.drawImage(img,-img.naturalWidth,0); }
  else { ctx.scale(1,-1); ctx.drawImage(img,0,-img.naturalHeight); }
  const ni=new Image(); ni.src=oc.toDataURL();
  ni.onload=()=>{ pushHistory(); S.imgState.image=ni; S.imgState.cacheValid=false; refreshWorkspaceUI(); };
}

// ── Export annotated PNG ───────────────────────────────────────────────────
function downloadAnnotatedImage(){
  if(!S.imgState.image){ toast('No image loaded — use Upload to add a photo','warn'); return; }
  // Render to offscreen canvas matching main canvas
  const mc=document.getElementById('main-canvas');
  const oc=document.createElement('canvas');
  oc.width=mc.width; oc.height=mc.height;
  const oc2=oc.getContext('2d');
  // Draw background
  oc2.fillStyle='#f5f6f8'; oc2.fillRect(0,0,oc.width,oc.height);
  // Copy main canvas content
  oc2.drawImage(mc,0,0);
  // Download
  const a=document.createElement('a');
  a.download=`PVI_Annotated_${S.spec.pno||'Image'}_${Date.now()}.png`;
  a.href=oc.toDataURL('image/png');
  a.click();
}

// ── Mouse handling for image tools ────────────────────────────────────────
function handleImageToolMousedown(p){
  if(!S.imgState.imgTool) return false;
  const it=S.imgState.imgTool;
  if(it==='scale_line'){
    S.imgState.scaleDrawing=true;
    S.imgState.scaleLine={x1:p.x,y1:p.y,x2:p.x,y2:p.y};
    S.imgState.scaleRect=null;
    return true;
  }
  if(it==='crop'){
    S.imgState.cropDrawing=true;
    S.imgState.cropRect={x:p.x,y:p.y,w:0,h:0};
    document.getElementById('btn-applycrop').style.display='none';
    return true;
  }
  return false;
}

function handleImageToolMousemove(p){
  if(!S.imgState.imgTool) return false;
  const it=S.imgState.imgTool;
  if(it==='scale_line' && S.imgState.scaleDrawing && S.imgState.scaleLine){
    let ex = p.x, ey = p.y;
    // Shift-constrain: snap to horizontal or vertical (like Acrobat / Illustrator)
    if(window._scaleShift) {
      const dx = ex - S.imgState.scaleLine.x1;
      const dy = ey - S.imgState.scaleLine.y1;
      if(Math.abs(dx) >= Math.abs(dy)) ey = S.imgState.scaleLine.y1; // horizontal
      else                             ex = S.imgState.scaleLine.x1; // vertical
    }
    S.imgState.scaleLine.x2 = ex;
    S.imgState.scaleLine.y2 = ey;
    drawCanvas(); return true;
  }
  if(it==='crop' && S.imgState.cropDrawing && S.imgState.cropRect){
    const r=S.imgState.cropRect;
    r.w=p.x-r.x; r.h=p.y-r.y;
    drawCanvas(); return true;
  }
  return false;
}

function handleImageToolMouseup(p){
  if(!S.imgState.imgTool) return false;
  const it=S.imgState.imgTool;
  if(it==='scale_line' && S.imgState.scaleDrawing){
    S.imgState.scaleDrawing=false;
    showScaleInput(); return true;
  }
  if(it==='crop' && S.imgState.cropDrawing){
    S.imgState.cropDrawing=false;
    if(Math.abs(S.imgState.cropRect.w)>10 && Math.abs(S.imgState.cropRect.h)>10){
      document.getElementById('btn-applycrop').style.display='inline-flex';
      document.getElementById('btn-cancelcrop').style.display='inline-flex';
    } else {
      // Too small — auto-cancel
      S.imgState.cropRect=null;
      document.getElementById('btn-applycrop').style.display='none';
      document.getElementById('btn-cancelcrop').style.display='none';
    }
    drawCanvas(); return true;
  }
  return false;
}

// handleImageModeClick kept for non-tool pore-placement guard
function handleImageModeClick(canvasX, canvasY){
  if(S.imgState.imgTool) return true; // image tool active — consumed
  // Select tool always works in image mode (to pick and drag pores)
  if(S.tool==='select') return false;
  // Place tool needs scale set first
  if(S.tool==='place' && !S.imgState.scalePxPerMm && S.imgState.image){
    updateImgHint(); return true;
  }
  return false;
}

let _resizeTimer = null;
window.addEventListener('resize',()=>{
  if(document.getElementById('pg-meas').classList.contains('on')){
    clearTimeout(_resizeTimer);
    // Only resize canvas — do NOT reset evtsBound or rebind events
    // Rebinding events with anonymous closures would stack duplicate listeners
    _resizeTimer = setTimeout(()=>{ resizeCanvas(); }, 150);
  }
});

// ── Horizontal scroll on img-toolbar with mouse wheel ─────────────────────
(function(){
  function attachToolbarScroll(){
    const itb=document.getElementById('img-toolbar');
    if(!itb) return;
    itb.addEventListener('wheel',e=>{
      // If primary scroll axis is vertical, redirect to horizontal toolbar scroll
      if(Math.abs(e.deltaY)>=Math.abs(e.deltaX)){
        e.preventDefault();
        itb.scrollLeft += e.deltaY * 1.5;
      }
    },{passive:false});
    // Also support touch drag on toolbar
    let _tx=0;
    itb.addEventListener('touchstart',e=>{ _tx=e.touches[0].clientX; },{passive:true});
    itb.addEventListener('touchmove',e=>{
      const dx=_tx-e.touches[0].clientX;
      itb.scrollLeft+=dx; _tx=e.touches[0].clientX;
    },{passive:true});
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',attachToolbarScroll);
  else attachToolbarScroll();
})();



// Active pore array — returns draw or image pore list depending on mode
function AP(){ return S.imgMode ? S.imgPores : S.pores; }
function setAP(arr){
  if(S.imgMode){
    S.imgPores=arr;
    activeImagePage().pores=arr;
  } else {
    S.pores=arr;
    activeSpecTab().drawPores=arr;
  }
}
// ── Toast utility (replaces alert) ─────────────────────────────────────────
function toast(msg, type=''){
  const c=document.getElementById('toast-container');
  const t=document.createElement('div');
  t.className='toast'+(type?' '+type:'');
  t.textContent=msg;
  c.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .3s';
    setTimeout(()=>c.removeChild(t),300); }, 3000);
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════
drawGauge(0,5);
renderSpecTabs();
renderImageTabs();
updateSpecSummaryUI();
updateImageControlsUI();
switchCanvasMode('image');
updateHomeVerdictBadge();
function loadPlatformScript(url){
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => (s.getAttribute('src') || '').includes(url))) { resolve(); return; }
    const s=document.createElement('script');
    s.src=url;
    s.async=false;
    s.onload=resolve;
    s.onerror=reject;
    document.head.appendChild(s);
  });
}

async function bootstrapPlatformTools(){
  nav('meas', { platformRoute:'Tool 01 / Measurement' });

  try {
    await loadPlatformScript('/static/tools/porosity.js?v=20260427h');
  } catch (e) {
    console.error('Tool script load failed', e);
  }
}

bootstrapPlatformTools();


// ═══════════════════════════════════════════════════════════════════════════
// AUTO-DETECT PORES v4 — Gaussian blur + improved adaptive threshold +
// morphological open + edge rejection + hole flagging + exclusion zones
// ═══════════════════════════════════════════════════════════════════════════

// ── 5×5 Gaussian blur (σ≈1.0) — better noise suppression than box blur ──────
function _gaussianBlur5(gray,w,h){
  // 5×5 Gaussian kernel (σ≈1.0, sum=273)
  const k=[1,4,7,4,1, 4,16,26,16,4, 7,26,41,26,7, 4,16,26,16,4, 1,4,7,4,1];
  const kSum=273;
  const out=new Uint8Array(gray.length);
  for(let y=2;y<h-2;y++) for(let x=2;x<w-2;x++){
    let s=0, ki=0;
    for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++){
      s+=gray[(y+dy)*w+(x+dx)]*k[ki++];
    }
    out[y*w+x]=(s/kSum)|0;
  }
  // Copy border pixels from original
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(y<2||y>=h-2||x<2||x>=w-2) out[y*w+x]=gray[y*w+x];
  }
  return out;
}

// Legacy alias for compatibility
function _boxBlur3(gray,w,h){ return _gaussianBlur5(gray,w,h); }

// ── Global Otsu ──────────────────────────────────────────────────────────────
function _otsu(gray,total){
  const hist=new Int32Array(256);
  for(let i=0;i<total;i++) hist[gray[i]]++;
  let sum=0; for(let t=0;t<256;t++) sum+=t*hist[t];
  let sumB=0,wB=0,wF=0,maxVar=0,thr=128;
  for(let t=0;t<256;t++){
    wB+=hist[t]; if(!wB) continue;
    wF=total-wB; if(!wF) break;
    sumB+=t*hist[t];
    const mB=sumB/wB, mF=(sum-sumB)/wF;
    const v=wB*wF*(mB-mF)**2;
    if(v>maxVar){maxVar=v;thr=t;}
  }
  return thr;
}

// ── Adaptive threshold v2 — smaller blocks, gradient compensation, dark-bg ──
function _adaptiveThreshold(gray,w,h,blockSize,globalThr,sens){
  // Auto-detect dark background (e.g. X-ray): if global mean < 100, invert logic
  let globalMean=0;
  for(let i=0;i<w*h;i++) globalMean+=gray[i];
  globalMean/=(w*h);
  const darkBg=globalMean<100;

  const bin=new Uint8Array(w*h);
  for(let by=0;by<h;by+=blockSize) for(let bx=0;bx<w;bx+=blockSize){
    const bw=Math.min(blockSize,w-bx), bh2=Math.min(blockSize,h-by);
    const localGray=[];
    let sum=0, sumSq=0;
    for(let y=by;y<by+bh2;y++) for(let x=bx;x<bx+bw;x++) localGray.push(gray[y*w+x]);
    for(let i=0;i<localGray.length;i++){
      const v=localGray[i]; sum+=v; sumSq+=v*v;
    }
    const localThr=_otsu(new Uint8Array(localGray),localGray.length);
    const mean=sum/localGray.length;
    const variance=Math.max(0, sumSq/localGray.length - mean*mean);
    const localStd=Math.sqrt(variance);

    // Illumination gradient compensation: weight local vs global based on contrast
    const contrastWeight=Math.min(1, Math.max(0.15, localStd/30));
    const uniformBlock=localStd < 6;
    const baseThr=Math.round(uniformBlock
      ? (globalThr*0.80 + localThr*0.20)
      : (localThr*0.75 + globalThr*0.25));

    // Wider sensitivity range: 0–100 maps to ±25 threshold units (was ±21)
    const sensOffset=(sens-50) * 0.50 * contrastWeight;
    const thr=Math.max(10,Math.min(240,Math.round(baseThr + sensOffset)));
    for(let y=by;y<by+bh2;y++) for(let x=bx;x<bx+bw;x++){
      if(darkBg){
        bin[y*w+x]=gray[y*w+x]>thr?1:0;  // invert for dark background
      } else {
        bin[y*w+x]=gray[y*w+x]<thr?1:0;   // normal: dark pores on light bg
      }
    }
  }
  return bin;
}

// ── Morphological dilation (radius r) ────────────────────────────────────────
function _dilate(bin,w,h,r){
  const out=new Uint8Array(w*h);
  const r2=r*r;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(bin[y*w+x]){ out[y*w+x]=1; continue; }
    outer: for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++){
      if(dx*dx+dy*dy>r2) continue;
      const ny=y+dy, nx=x+dx;
      if(ny>=0&&ny<h&&nx>=0&&nx<w&&bin[ny*w+nx]){out[y*w+x]=1;break outer;}
    }
  }
  return out;
}

// ── Morphological erosion (radius r) ─────────────────────────────────────────
function _erode(bin,w,h,r){
  const out=new Uint8Array(w*h);
  const r2=r*r;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(!bin[y*w+x]) continue;
    let ok=true;
    outer: for(let dy=-r;dy<=r;dy++) for(let dx=-r;dx<=r;dx++){
      if(dx*dx+dy*dy>r2) continue;
      const ny=y+dy, nx=x+dx;
      if(ny<0||ny>=h||nx<0||nx>=w||!bin[ny*w+nx]){ok=false;break outer;}
    }
    if(ok) out[y*w+x]=1;
  }
  return out;
}

// ── Morphological opening (erode→dilate) — removes small noise bridges ───────
function _open(bin,w,h,r){
  if(r<=0) return bin;
  return _dilate(_erode(bin,w,h,r),w,h,r);
}

// ── 4-connectivity connected components (union-find) ─────────────────────────
function _labelCC(bin,w,h){
  const lbl=new Int32Array(w*h);
  const par=[0]; let next=1;
  function find(x){while(par[x]!==x)x=par[x]=par[par[x]];return x;}
  function union(a,b){par[find(a)]=find(b);}
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const i=y*w+x; if(!bin[i]) continue;
    const up=y>0?lbl[(y-1)*w+x]:0, le=x>0?lbl[y*w+x-1]:0;
    if(!up&&!le){par.push(next);lbl[i]=next++;}
    else if(up&&!le) lbl[i]=up;
    else if(!up&&le) lbl[i]=le;
    else{lbl[i]=up; if(up!==le) union(up,le);}
  }
  for(let i=0;i<lbl.length;i++) if(lbl[i]) lbl[i]=find(lbl[i]);
  return lbl;
}

function _polyPerimeter(contour){
  if(!contour || contour.length < 2) return 0;
  let perim = 0;
  for(let i=0;i<contour.length;i++){
    const a=contour[i];
    const b=contour[(i+1)%contour.length];
    perim += Math.hypot(b[0]-a[0], b[1]-a[1]);
  }
  return perim;
}

// ── Blob extraction with PCA + row-scan outline ──────────────────────────────
function _blobs(lbl,w,h,maxContourPts=32){
  const b={};
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const l=lbl[y*w+x]; if(!l) continue;
    if(!b[l]) b[l]={n:0,sx:0,sy:0,sxx:0,syy:0,sxy:0,
                    minX:x,maxX:x,minY:y,maxY:y,
                    rowL:{},rowR:{}};
    const o=b[l]; o.n++; o.sx+=x; o.sy+=y;
    o.sxx+=x*x; o.syy+=y*y; o.sxy+=x*y;
    if(x<o.minX)o.minX=x; if(x>o.maxX)o.maxX=x;
    if(y<o.minY)o.minY=y; if(y>o.maxY)o.maxY=y;
    if(o.rowL[y]===undefined||x<o.rowL[y]) o.rowL[y]=x;
    if(o.rowR[y]===undefined||x>o.rowR[y]) o.rowR[y]=x;
  }
  return Object.values(b).map(o=>{
    const n=o.n, cx=o.sx/n, cy=o.sy/n;
    const Sxx=o.sxx/n-cx*cx, Syy=o.syy/n-cy*cy, Sxy=o.sxy/n-cx*cy;
    const tmp=Math.sqrt(((Sxx-Syy)/2)**2+Sxy**2);
    const lam1=(Sxx+Syy)/2+tmp, lam2=(Sxx+Syy)/2-tmp;
    const ra=2*Math.sqrt(Math.max(0,lam1)), rb=2*Math.sqrt(Math.max(0,lam2));
    const angle=Math.atan2(2*Sxy,Sxx-Syy)/2;
    const bboxW=o.maxX-o.minX+1, bboxH=o.maxY-o.minY+1;
    const shortSide=Math.max(1,Math.min(bboxW,bboxH));
    const ys=Object.keys(o.rowL).map(Number).sort((a,b2)=>a-b2);
    const step=Math.max(1,Math.floor(ys.length/Math.max(8,maxContourPts)));
    const sampY=ys.filter((_,i)=>i%step===0);
    const leftEdge =sampY.map(y=>[o.rowL[y],y]);
    const rightEdge=sampY.slice().reverse().map(y=>[o.rowR[y],y]);
    const contour=[...leftEdge,...rightEdge];
    const perimeter=Math.max(_polyPerimeter(contour), 1);
    const bboxArea=Math.max(1, bboxW*bboxH);
    const fillRatio=n/bboxArea;
    const elongation=Math.max(ra,rb)/Math.max(1,Math.min(ra,rb));
    const circularity=(4*Math.PI*n)/(perimeter*perimeter);
    const idealPerim=2*Math.PI*Math.sqrt(Math.max(n/Math.PI, 1));
    const roughness=perimeter/Math.max(idealPerim, 1);
    // Edge-touching flag (within 2px of image border)
    const edgeTouching = o.minX<=2 || o.minY<=2 || o.maxX>=w-3 || o.maxY>=h-3;
    return { cx,cy,area:n,
      dia:2*Math.sqrt(n/Math.PI),
      ra,rb,angle,bboxW,bboxH,contour,
      aspect:Math.max(bboxW,bboxH)/shortSide,
      perimeter, fillRatio, elongation, circularity, roughness,
      edgeTouching };
  });
}

function _classifyDetectedPore(blob){
  let gasScore = 0;
  let shrinkScore = 0;

  if(blob.circularity >= 0.78) gasScore += 2.2;
  else if(blob.circularity <= 0.62) shrinkScore += 2.4;
  else { gasScore += 0.8; shrinkScore += 0.8; }

  if(blob.elongation <= 1.45) gasScore += 1.8;
  else if(blob.elongation >= 2.1) shrinkScore += 2.1;
  else { gasScore += 0.6; shrinkScore += 0.9; }

  if(blob.fillRatio >= 0.63) gasScore += 1.3;
  else if(blob.fillRatio <= 0.5) shrinkScore += 1.4;
  else { gasScore += 0.5; shrinkScore += 0.7; }

  if(blob.roughness <= 1.18) gasScore += 1.0;
  else if(blob.roughness >= 1.32) shrinkScore += 1.2;
  else { gasScore += 0.4; shrinkScore += 0.5; }

  if(blob.aspect >= 2.4) shrinkScore += 1.6;
  if(blob.area >= 3000 && blob.circularity < 0.72) shrinkScore += 0.8;

  const type = shrinkScore > gasScore ? 'shrink' : 'gas';
  const confidence = Math.abs(shrinkScore - gasScore) / Math.max(shrinkScore + gasScore, 1);
  return { type, confidence, gasScore, shrinkScore };
}

// ── Hole detection heuristic ─────────────────────────────────────────────────
// Structural holes (drilled/machined) are near-perfect circles with large area
function _isPossibleHole(blob, specPhi, dsNatPxMm){
  const diaMm = blob.dia / dsNatPxMm;
  return blob.circularity > 0.90
      && blob.fillRatio > 0.80
      && blob.elongation < 1.3
      && blob.area > 400
      && diaMm > (specPhi || 1.5) * 2.5;
}

// ── Exclusion zone check ─────────────────────────────────────────────────────
function _isInExclusionZone(xMm, yMm, zones){
  if(!zones || !zones.length) return false;
  return zones.some(z => {
    if(z.type === 'rect'){
      return xMm >= z.x && xMm <= z.x + z.w && yMm >= z.y && yMm <= z.y + z.h;
    }
    if(z.type === 'circle'){
      const dx = xMm - z.cx, dy = yMm - z.cy;
      return (dx*dx + dy*dy) <= z.r*z.r;
    }
    return false;
  });
}

// ── Main auto-detect entry point ─────────────────────────────────────────────
// ── Auto-detect: preset configurations ───────────────────────────────────────
function setDetectPreset(name){
  const presets={
    // threshold, minDia, aspect, blur, close, curve, edgeReject, maxAreaPct
    fine:     {thr:60, minD:0.05, asp:5,  blur:1, close:1, curve:24, edge:true,  maxA:10},
    balanced: {thr:50, minD:0.10, asp:6,  blur:1, close:2, curve:32, edge:true,  maxA:15},
    coarse:   {thr:40, minD:0.50, asp:4,  blur:2, close:3, curve:20, edge:false, maxA:25},
  };
  const p=presets[name]; if(!p) return;
  const set=(id,val,dispId,fmt)=>{ const el=document.getElementById(id); if(el){el.value=val; const d=document.getElementById(dispId); if(d)d.textContent=fmt?fmt(val):val;} };
  set('detect-threshold',p.thr,'detect-sens-val',v=>v+(v==50?' (Auto)':v>50?' +'+(v-50):' '+(v-50)));
  set('detect-min-dia',p.minD,'detect-min-dia-val',v=>parseFloat(v).toFixed(2)+'mm');
  set('detect-aspect',p.asp,'detect-aspect-val');
  set('detect-blur',p.blur,'detect-blur-val');
  set('detect-close',p.close,'detect-close-val');
  set('detect-curve',p.curve,'detect-curve-val');
  // Edge reject toggle
  document.querySelectorAll('#detect-edge-reject').forEach(el=>el.checked=p.edge);
  // Max area %
  set('detect-max-area',p.maxA,'detect-max-area-val',v=>v+'%');
  toast('Preset: '+name.charAt(0).toUpperCase()+name.slice(1)+' (Threshold '+p.thr+', Min Φ '+p.minD+'mm, Max Area '+p.maxA+'%)');
}

function toggleDetectAdvanced(){
  const panel=document.getElementById('detect-advanced');
  const btn=document.getElementById('btn-adv-toggle');
  if(!panel) return;
  const show=panel.style.display==='none'||panel.style.display==='';
  panel.style.display=show?'block':'none';
  if(btn) btn.style.background=show?'var(--c4)':'';
}

function _resetAdvancedDefaults(){
  const defs={aspect:6,blur:1,close:2,curve:32};
  ['aspect','blur','close','curve'].forEach(k=>{
    const sl=document.getElementById('detect-'+k);
    const vl=document.getElementById('detect-'+k+'-val');
    const pip=document.getElementById('adv-'+k+'-pip');
    if(sl){ sl.value=defs[k]; }
    if(vl){ vl.textContent=defs[k]; }
    if(pip){
      if(k==='aspect') pip.style.left=((defs[k]-2)/10*100)+'%';
      else if(k==='blur') pip.style.left=(defs[k]/3*100)+'%';
      else if(k==='close') pip.style.left=(defs[k]/5*100)+'%';
      else if(k==='curve') pip.style.left=((defs[k]-12)/68*100)+'%';
    }
  });
  // Reset edge reject and max area
  document.querySelectorAll('#detect-edge-reject').forEach(el=>el.checked=false);
  const maSl=document.getElementById('detect-max-area');
  const maVl=document.getElementById('detect-max-area-val');
  if(maSl) maSl.value=15;
  if(maVl) maVl.textContent='15%';
  const maPip=document.getElementById('adv-max-area-pip');
  if(maPip) maPip.style.left=((15-1)/29*100)+'%';
  toast('Advanced parameters reset to defaults','info');
}

function applyImageFilters(){
  const b = +document.getElementById('img-brightness').value;
  const c = +document.getElementById('img-contrast').value;
  S.imgState.brightness = b;
  S.imgState.contrast = c;
  S.imgState.cacheValid = false; // Force re-render of offscreen cache
  drawCanvas();
}

function resetImageFilters(){
  const bri = document.getElementById('img-brightness');
  const con = document.getElementById('img-contrast');
  if(bri) bri.value = 100;
  if(con) con.value = 100;
  applyImageFilters();
}

function autoDetectPores(){
  if(!S.imgState.image){toast('Upload an image first','warn');return;}
  if(!S.imgState.scalePxPerMm){toast('Set Scale first — draw a reference line','warn');return;}

  const btn=document.getElementById('btn-autodetect-top');
  btn.textContent='⏳ Detecting…'; btn.disabled=true;

  setTimeout(()=>{
    try{
      const img=S.imgState.image;
      const dispPxPerMm=S.imgState.scalePxPerMm;
      const fitSc=S.imgState.fitScale||1;
      const natPxPerMm=dispPxPerMm/fitSc;

      const sliderMinDia=+(document.getElementById('detect-min-dia')?.value||0.1);
      const minDiaMm=Math.max(0.05, sliderMinDia);
      const maxDiaMm=Math.max(20, (S.spec.phi||1.5)*20);

      // Downsample for performance
      const maxSide=1600;
      const dsScale=Math.min(1,maxSide/Math.max(img.naturalWidth,img.naturalHeight));
      const W=Math.round(img.naturalWidth*dsScale);
      const H=Math.round(img.naturalHeight*dsScale);
      const dsNatPxMm=natPxPerMm*dsScale;

      const oc=document.createElement('canvas'); oc.width=W; oc.height=H;
      const ctx=oc.getContext('2d');
      ctx.drawImage(img,0,0,W,H);
      const px=ctx.getImageData(0,0,W,H).data;

      // Grayscale + brightness/contrast
      const bri=(S.imgState.brightness||100)/100;
      const con=(S.imgState.contrast||100)/100;
      let gray=new Uint8Array(W*H);
      for(let i=0;i<W*H;i++){
        let v=(0.299*px[i*4]+0.587*px[i*4+1]+0.114*px[i*4+2])*bri;
        v=((v/255-0.5)*con+0.5)*255;
        gray[i]=Math.max(0,Math.min(255,v))|0;
      }

      // Gaussian blur (noise reduction)
      const blurPasses=+(document.getElementById('detect-blur')?.value||1);
      for(let b=0;b<blurPasses;b++) gray=_gaussianBlur5(gray,W,H);

      // Sensitivity and Otsu
      const sens=+document.getElementById('detect-threshold').value;
      const globalOtsu=_otsu(gray,W*H);

      // Adaptive threshold — smaller blocks for finer local adaptation
      const blockSize=Math.max(20,Math.round(Math.min(W,H)/16));
      const bin=_adaptiveThreshold(gray,W,H,blockSize,globalOtsu,sens);

      // Morphological closing (fills micro-holes in pores)
      const dilR=+(document.getElementById('detect-close')?.value||2);
      let processed=dilR>0 ? _erode(_dilate(bin,W,H,dilR),W,H,dilR) : bin;

      // Morphological opening (removes small noise bridges) — radius=1 always
      processed=_open(processed,W,H,1);

      // ── Physical Exclusion Masking during Tracing ──
      // Wipe out pores that fall inside exclusion zones so they are never traced.
      {
        const maskZones = activeImagePage()?.exclusionZones || [];
        if (maskZones.length > 0) {
          for (let i = 0; i < maskZones.length; i++) {
            const z = maskZones[i];
          let minXmm = 0, maxXmm = 0, minYmm = 0, maxYmm = 0;
          if (z.type === 'rect') {
            minXmm = z.x; maxXmm = z.x + z.w; minYmm = z.y; maxYmm = z.y + z.h;
          } else if (z.type === 'circle') {
            minXmm = z.cx - z.r; maxXmm = z.cx + z.r; minYmm = z.cy - z.r; maxYmm = z.cy + z.r;
          } else if (z.type === 'polygon' && z.points && z.points.length > 0) {
            minXmm = z.points[0].x; maxXmm = z.points[0].x;
            minYmm = z.points[0].y; maxYmm = z.points[0].y;
            for (const pt of z.points) {
              if(pt.x < minXmm) minXmm = pt.x; if(pt.x > maxXmm) maxXmm = pt.x;
              if(pt.y < minYmm) minYmm = pt.y; if(pt.y > maxYmm) maxYmm = pt.y;
            }
          } else {
            continue;
          }
          
          const startX = Math.max(0, Math.floor(minXmm * dsNatPxMm));
          const endX = Math.min(W - 1, Math.ceil(maxXmm * dsNatPxMm));
          const startY = Math.max(0, Math.floor(minYmm * dsNatPxMm));
          const endY = Math.min(H - 1, Math.ceil(maxYmm * dsNatPxMm));

          for (let y = startY; y <= endY; y++) {
            const yMm = y / dsNatPxMm;
            let offset = y * W + startX;
            for (let x = startX; x <= endX; x++) {
              if (processed[offset] > 0) { // Only check if pixel is currently a pore
                const xMm = x / dsNatPxMm;
                let inside = false;
                if (z.type === 'rect') {
                  inside = true; // BB check already passed
                } else if (z.type === 'circle') {
                  if ((xMm - z.cx) ** 2 + (yMm - z.cy) ** 2 <= z.r ** 2) inside = true;
                } else if (z.type === 'polygon') {
                  if (pointInPoly(xMm, yMm, z.points)) inside = true;
                }
                if (inside) processed[offset] = 0;
              }
              offset++;
            }
          }
        }
      }
      }

      // Connected components
      const labels=_labelCC(processed,W,H);
      const curvePts=+(document.getElementById('detect-curve')?.value||32);
      const blobs=_blobs(labels,W,H,curvePts);

      // Size filters
      const minPxDs=minDiaMm*dsNatPxMm;
      const maxPxDs=maxDiaMm*dsNatPxMm;
      const maxAreaPct=+(document.getElementById('detect-max-area')?.value||15);
      const maxBlobAreaPx=W*H*(maxAreaPct/100);

      // Edge reject setting
      const edgeReject=document.getElementById('detect-edge-reject')?.checked !== false;

      // Filter: size, aspect, area, edge
      const imgWMm=W/dsNatPxMm, imgHMm=H/dsNatPxMm;
      const maxAspect=+(document.getElementById('detect-aspect')?.value||8);
      let valid=blobs.filter(b=>{
        if(b.dia<minPxDs||b.dia>maxPxDs) return false;
        if(b.area>maxBlobAreaPx) return false;
        if(b.aspect>=maxAspect) return false;
        if(edgeReject && b.edgeTouching) return false;
        const xMm=b.cx/dsNatPxMm, yMm=b.cy/dsNatPxMm;
        if(xMm<0||xMm>imgWMm||yMm<0||yMm>imgHMm) return false;
        return true;
      });
      if(!valid.length){
        valid=blobs.filter(b=>{
          if(b.dia<minPxDs*0.5||b.dia>maxPxDs*1.5) return false;
          if(b.area>maxBlobAreaPx*3) return false;
          if(b.aspect>=maxAspect*2) return false;
          const xMm=b.cx/dsNatPxMm, yMm=b.cy/dsNatPxMm;
          if(xMm<0||xMm>imgWMm||yMm<0||yMm>imgHMm) return false;
          return true;
        });
      }

      // Exclusion zones are an evaluation mask, not a destructive detection filter.
      const exclZones = activeImagePage().exclusionZones || [];
      const exclCount = valid.filter(b=>{
        const xMm=b.cx/dsNatPxMm, yMm=b.cy/dsNatPxMm;
        return _isInExclusionZone(xMm, yMm, exclZones);
      }).length;

      // Hole auto-flagging: perfectly circular large blobs
      let holeCount = 0;
      const finalBlobs = valid.filter(b=>{
        if(_isPossibleHole(b, S.spec.phi, dsNatPxMm)){
          holeCount++;
          return false; // exclude detected holes
        }
        return true;
      });

      if(!finalBlobs.length){
        let hint = 'try raising sensitivity';
        if(exclCount) hint += ` (${exclCount} inside exclusion zones, kept for review)`;
        if(holeCount) hint += ` (${holeCount} holes excluded)`;
        toast(`No pores detected — ${hint} (Otsu=${globalOtsu})`, 'warn');
        S.imgState.autoDetected = true;
        updateHeaderButtons();
        btn.textContent='🔍 Auto-Detect'; btn.disabled=false; return;
      }

      pushHistory();
      // ── Clear previously auto-detected pores before re-run ──────────────
      // Keep manually-added pores (no _detectMeta) and discard any pore that
      // came from a previous auto-detection so we get a clean fresh result.
      setAP(AP().filter(p => !p._detectMeta));

      let added=0, gasCount=0, shrinkCount=0;
      finalBlobs.forEach(b=>{
        const xMm=+(b.cx/dsNatPxMm).toFixed(3);
        const yMm=+(b.cy/dsNatPxMm).toFixed(3);
        const diaMm=+(b.dia/dsNatPxMm).toFixed(3);
        const cls=_classifyDetectedPore(b);
        const rxMm=Math.max(diaMm/2, b.ra/dsNatPxMm/2);
        const ryMm=Math.max(diaMm/4, b.rb/dsNatPxMm/2);
        const contourMm = (b.contour||[]).map(([bx,by])=>
          [+((bx-b.cx)/dsNatPxMm).toFixed(4), +((by-b.cy)/dsNatPxMm).toFixed(4)]
        );
        const pore={
          id:Date.now()+Math.random(),
          x:xMm, y:yMm, dia:diaMm, type:cls.type, zone:'',
          _rx:rxMm, _ry:ryMm, _angle:b.angle,
          _contour: contourMm.length>=4 ? contourMm : null,
          _detectMeta: {
            confidence: +cls.confidence.toFixed(3),
            circularity: +b.circularity.toFixed(3),
            elongation: +b.elongation.toFixed(3),
            fillRatio: +b.fillRatio.toFixed(3),
            roughness: +b.roughness.toFixed(3)
          }
        };
        pore.zone=getPoreZone(pore);
        AP().push(pore);
        if(cls.type === 'gas') gasCount++;
        else shrinkCount++;
        added++;
      });

      // Filter pores outside the datum square if one is drawn
      if(S.datumRect && S.datumRect.w > 0){
        const dr=S.datumRect;
        const before=AP().length;
        setAP(AP().filter(p=> _poreOverlapsDatum(p, dr)));
        const removed=before-AP().length;
        if(removed>0) toast(`ℹ️ ${removed} pore${removed>1?'s':''} outside datum square excluded`);
      }
      S.imgState.autoDetected = true;
      drawCanvas(); updateLiveMetrics(); updatePoreRegistry();
      let msg = `✅ ${added} pore${added>1?'s':''} detected · ${gasCount} gas · ${shrinkCount} shrink · Otsu=${globalOtsu}`;
      if(exclCount) msg += ` · ${exclCount} in excl. zones`;
      if(holeCount) msg += ` · ${holeCount} holes excluded`;
      toast(msg);
    }catch(e){
      toast('Detection error: '+e.message,'err');
      console.error(e);
    }
    btn.textContent='🔍 Auto-Detect'; btn.disabled=false;
  },20);
}



// ═══════════════════════════════════════════════════════════════════════════
// EXCLUSION ZONES — helper functions
// ═══════════════════════════════════════════════════════════════════════════
function clearExclusionZones(){
  const page = activeImagePage();
  if(!page) return;
  const count = (page.exclusionZones || []).length;
  page.exclusionZones = [];
  S._exclDraw = null;
  updateExclZoneBadge();
  renderExclList();
  drawCanvas(); updateLiveMetrics(); updatePoreRegistry();
  if(count) toast('\u{1f6ab} ' + count + ' exclusion zone' + (count>1?'s':'') + ' removed — pores restored to metrics');
}

function updateExclZoneBadge(){
  const page = activeImagePage();
  const count = (page ? page.exclusionZones || [] : []).length;
  document.querySelectorAll('#excl-zone-count').forEach(el => {
    el.textContent = count;
    el.classList.toggle('show', count > 0);
  });
}

function renderExclList(){
  const page = activeImagePage();
  const zones = page ? page.exclusionZones || [] : [];
  const selIdx = S._exclSelected;
  const isEditMode = S.tool === 'excl_select';

  document.querySelectorAll('#excl-zone-list').forEach(list => {
    if(!zones.length){
      list.innerHTML = '<div style="font-size:9px;color:var(--dim);font-style:italic">No exclusion zones — use 🚫 Excl. Zone tool to draw</div>';
      return;
    }
    list.innerHTML = zones.map((z, i) => {
      let icon='▭', desc='';
      if(z.type==='circle'){
        icon='⭕';
        desc = `r=${(z.r||0).toFixed(2)}mm @ (${(z.cx||0).toFixed(1)},${(z.cy||0).toFixed(1)})`;
      } else if(z.type==='polygon'){
        icon='✦';
        const _a = polyArea(z.points||[]);
        desc = `${(z.points||[]).length} pts · ${_a.toFixed(2)}mm²`;
      } else {
        desc = `${(z.w||0).toFixed(2)}×${(z.h||0).toFixed(2)}mm`;
      }
      const isSel = isEditMode && selIdx === i;
      const _inEP = isSel && S._exclEditPts && S._exclEditPts.zi===i;
      return `<div class="excl-list-item${isSel?' excl-selected':''}" onclick="_exclListClick(${i})" title="${isEditMode?'Click to select · Right-click for options':'Switch to Edit Zones tool to select'}">`+
        `<span>${icon} Zone #${i+1}</span>`+
        `<span style="color:var(--dim);font-size:8px">${desc}</span>`+
        (isSel?`<span style="cursor:pointer;margin-left:4px;font-size:9px;color:#60a5fa" onclick="event.stopPropagation();_exclQuickCtx(event,${i})" title="Options">⋯</span>`:'') +
        `<span class="excl-del" onclick="event.stopPropagation();removeExclZone(${i})" title="Remove">✕</span>`+
        `</div>`;
    }).join('');
  });

  // Render inline edit panel for selected zone
  const editPanel = document.getElementById('excl-edit-panel');
  if(editPanel){
    if(isEditMode && selIdx != null && zones[selIdx]){
      const z = zones[selIdx];
      const _inEP2 = S._exclEditPts && S._exclEditPts.zi===selIdx;
      editPanel.style.display = 'block';
      if(z.type==='circle'){
        editPanel.innerHTML = `
          <div style="font-size:8px;font-weight:700;color:#ef4444;margin-bottom:5px">✏️ Edit Zone #${selIdx+1} — Circle</div>
          <div class="excl-edit-row">
            <label>cx</label><input type="number" step="0.1" value="${z.cx.toFixed(2)}" onchange="_exclApplyEdit(${selIdx},'cx',+this.value)" title="Center X (mm)">
            <label>cy</label><input type="number" step="0.1" value="${z.cy.toFixed(2)}" onchange="_exclApplyEdit(${selIdx},'cy',+this.value)" title="Center Y (mm)">
          </div>
          <div class="excl-edit-row">
            <label>r</label><input type="number" step="0.1" min="0.05" value="${z.r.toFixed(2)}" onchange="_exclApplyEdit(${selIdx},'r',+this.value)" title="Radius (mm)">
          </div>
          <div class="excl-edit-hint">Area: ${(Math.PI*z.r*z.r).toFixed(2)} mm² · Del removes · Right-click for more options</div>
          <div style="margin-top:5px;display:flex;gap:4px">
            <button onclick="_exclConvertToPoly(${selIdx})" style="font-size:8px;padding:2px 6px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.4);border-radius:4px;color:#f87171;cursor:pointer">✏ Edit Points</button>
            <button onclick="_exclQuickRotate(${selIdx})" style="font-size:8px;padding:2px 6px;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);border-radius:4px;color:#fbbf24;cursor:pointer">↻ Rotate</button>
          </div>`;
      } else if(z.type==='polygon'){
        const _ptCount=(z.points||[]).length;
        const _area=polyArea(z.points||[]).toFixed(2);
        const _epBtnLabel = _inEP2 ? '✅ Done Editing' : '✏ Edit Points';
        const _epBtnOnclick = _inEP2 ? '_exclExitEditPts()' : '_exclEnterEditPts('+selIdx+')';
        const _epBtnBg = _inEP2 ? 'rgba(239,68,68,.3)' : 'rgba(239,68,68,.12)';
        editPanel.innerHTML = `
          <div style="font-size:8px;font-weight:700;color:#ef4444;margin-bottom:5px">✏️ Edit Zone #${selIdx+1} — Polygon (${_ptCount} vertices)</div>
          <div class="excl-edit-hint">Area: ${_area} mm² · ${_ptCount} vertices · Del removes zone</div>
          <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">
            <button onclick="${_epBtnOnclick}" style="font-size:8px;padding:2px 7px;background:${_epBtnBg};border:1px solid rgba(239,68,68,.5);border-radius:4px;color:#ef4444;cursor:pointer">${_epBtnLabel}</button>
            <button onclick="_exclQuickRotate(${selIdx})" style="font-size:8px;padding:2px 6px;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);border-radius:4px;color:#fbbf24;cursor:pointer">↻ Rotate</button>
            <button onclick="_exclDupZone(${selIdx})" style="font-size:8px;padding:2px 6px;background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.35);border-radius:4px;color:#60a5fa;cursor:pointer">📋 Dup</button>
          </div>`;
      } else {
        editPanel.innerHTML = `
          <div style="font-size:8px;font-weight:700;color:#ef4444;margin-bottom:5px">✏️ Edit Zone #${selIdx+1} — Rect</div>
          <div class="excl-edit-row">
            <label>x</label><input type="number" step="0.1" value="${z.x.toFixed(2)}" onchange="_exclApplyEdit(${selIdx},'x',+this.value)" title="Left edge X (mm)">
            <label>y</label><input type="number" step="0.1" value="${z.y.toFixed(2)}" onchange="_exclApplyEdit(${selIdx},'y',+this.value)" title="Top edge Y (mm)">
          </div>
          <div class="excl-edit-row">
            <label>w</label><input type="number" step="0.1" min="0.05" value="${z.w.toFixed(2)}" onchange="_exclApplyEdit(${selIdx},'w',+this.value)" title="Width (mm)">
            <label>h</label><input type="number" step="0.1" min="0.05" value="${z.h.toFixed(2)}" onchange="_exclApplyEdit(${selIdx},'h',+this.value)" title="Height (mm)">
          </div>
          <div class="excl-edit-hint">Area: ${(z.w*z.h).toFixed(2)} mm² · Del removes · Right-click for more options</div>
          <div style="margin-top:5px;display:flex;gap:4px">
            <button onclick="_exclConvertToPoly(${selIdx})" style="font-size:8px;padding:2px 6px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.4);border-radius:4px;color:#f87171;cursor:pointer">✏ Edit Points</button>
            <button onclick="_exclQuickRotate(${selIdx})" style="font-size:8px;padding:2px 6px;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);border-radius:4px;color:#fbbf24;cursor:pointer">↻ Rotate</button>
          </div>`;
      }
    } else {
      editPanel.style.display = 'none';
    }
  }
}

// Quick action helpers called from edit panel buttons
function _exclConvertToPoly(zi){
  const page=activeImagePage(); if(!page||!page.exclusionZones) return;
  pushHistory();
  const z=page.exclusionZones[zi];
  page.exclusionZones[zi] = z.type==='rect'?rectToPolygon(z):circleToPolygon(z,24);
  S._exclEditPts={zi}; S._exclSelected=zi;
  if(S.tool!=='excl_select') setTool('excl_select');
  drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); renderExclList();
  toast('Converted to polygon — drag vertices to reshape');
}
function _exclEnterEditPts(zi){
  S._exclEditPts={zi}; S._exclSelected=zi;
  if(S.tool!=='excl_select') setTool('excl_select');
  drawCanvas(); renderExclList();
  toast('Drag vertices • Click + midpoints to add • Right-click vertex to delete');
}
function _exclExitEditPts(){ S._exclEditPts=null; drawCanvas(); renderExclList(); }
function _exclQuickRotate(zi){
  const page=activeImagePage(); if(!page||!page.exclusionZones) return;
  S._exclRotating=_startRotateZone(page,zi); S._exclSelected=zi;
  if(S.tool!=='excl_select') setTool('excl_select');
  drawCanvas(); renderExclList();
  toast('Drag the gold ↻ handle above the zone to rotate');
}
function _exclDupZone(zi){
  const page=activeImagePage(); if(!page||!page.exclusionZones) return;
  pushHistory();
  const dup=JSON.parse(JSON.stringify(page.exclusionZones[zi]));
  if(dup.type==='polygon') dup.points=dup.points.map(p=>({x:p.x+2,y:p.y+2}));
  else if(dup.type==='rect'){dup.x+=2;dup.y+=2;}
  else if(dup.type==='circle'){dup.cx+=2;dup.cy+=2;}
  page.exclusionZones.push(dup);
  S._exclSelected=page.exclusionZones.length-1;
  drawCanvas(); updateLiveMetrics(); updatePoreRegistry(); renderExclList();
  toast('Zone duplicated');
}
function _exclQuickCtx(e,zi){ showExclContextMenu(e,zi,null); }


function _exclListClick(i){
  if(S.tool !== 'excl_select') setTool('excl_select');
  S._exclSelected = i;
  drawCanvas(); renderExclList();
}

function _exclApplyEdit(zi, key, val){
  const page = activeImagePage();
  if(!page || !page.exclusionZones || !page.exclusionZones[zi]) return;
  pushHistory();
  page.exclusionZones[zi][key] = Math.max(key==='w'||key==='r'||key==='h' ? 0.05 : -9999, val);
  refreshWorkspaceUI();
}

function removeExclZone(index){
  const page = activeImagePage();
  if(!page || !page.exclusionZones) return;
  page.exclusionZones.splice(index, 1);
  updateExclZoneBadge();
  renderExclList();
  refreshWorkspaceUI();
  toast('\u{1f6ab} Exclusion zone removed');
}