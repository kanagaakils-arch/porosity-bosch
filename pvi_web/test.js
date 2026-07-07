const fs = require('fs');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const dom = new JSDOM(fs.readFileSync('/Users/kanagasenthilraja/Documents/Porosity Bosch/pvi_web/static/index.html', 'utf8'));
global.window = dom.window;
global.document = dom.window.document;
global.Image = dom.window.Image;
global.HTMLCanvasElement = dom.window.HTMLCanvasElement;

// Mock enough of app.js to run the logic
let appCode = fs.readFileSync('/Users/kanagasenthilraja/Documents/Porosity Bosch/pvi_web/static/app.js', 'utf8');

// Replace any browser-specific missing APIs if they cause issues
appCode = appCode.replace(/new ResizeObserver/g, 'function(){return {observe:()=>{}};}');
appCode = appCode.replace(/requestAnimationFrame/g, 'setTimeout');

try {
  eval(appCode);
  console.log("App loaded successfully");
  
  // Simulate image upload
  S.imgMode = true;
  S.imgState = {
    image: new Image(),
    cacheValid: false,
    scalePxPerMm: null, scaleLine: null, scaleRect: null,
    cropRect: null, imgTool: null,
    offscreen: null, fitScale: null,
    imgX: null, imgY: null, imgW: null, imgH: null
  };
  S.imgState.image.naturalWidth = 1000;
  S.imgState.image.naturalHeight = 1000;
  
  // Mock canvas ctx
  global.mctx = {
    clearRect: () => {},
    fillRect: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    beginPath: () => {},
    fill: () => {},
    stroke: () => {},
    rect: () => {},
    setLineDash: () => {},
    arc: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    putImageData: () => {}
  };
  
  // Trigger refresh
  refreshWorkspaceUI();
  console.log("Refresh succeeded");
} catch(e) {
  console.error("Error:", e);
}
