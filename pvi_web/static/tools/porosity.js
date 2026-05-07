window.initPorosityTool = function initPorosityTool() {
  if (window.__hpdcPorosityBridge) return;
  window.__hpdcPorosityBridge = true;

  const syncFromPorosity = () => {
    if (!window.HPDC_STATE || !window.S || !window.activeSpecTab) return;
    const spec = window.S.spec || {};
    if (spec.specSaved) {
      window.HPDC_STATE.set("partNo", spec.pno || null, "Tool 01");
      window.HPDC_STATE.set("zone", spec.zone || null, "Tool 01");
      window.HPDC_STATE.set("specPhi", spec.phi || null, "Tool 01");
      window.HPDC_STATE.set("specPct", spec.pct || null, "Tool 01");
      window.HPDC_STATE.set("wallThickness", spec.t || null, "Tool 01");
    }
  };

  const patch = (name, after) => {
    const original = window[name];
    if (typeof original !== "function") return;
    window[name] = function patchedPorosityFn(...args) {
      const result = original.apply(this, args);
      try { after(result, args); } catch (err) { console.error(err); }
      return result;
    };
  };

  patch("saveSpec", () => syncFromPorosity());
  patch("submitEvaluation", () => {
    if (!window.HPDC_STATE || !window.S || !window.S.verdict) return;
    window.HPDC_STATE.set("lastVerdict", window.S.verdict.allPass ? "ACCEPT" : "REJECT", "Tool 01");
  });
  syncFromPorosity();
};
