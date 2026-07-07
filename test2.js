const fs = require('fs');
let code = fs.readFileSync('pvi_web/static/app.js', 'utf8');

// Just parse the file to ensure there are no syntax errors
try {
  new Function(code);
  console.log("No syntax errors");
} catch(e) {
  console.error("Syntax error:", e);
}
