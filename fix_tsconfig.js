const fs = require('fs');
let content = fs.readFileSync('vite.config.ts', 'utf8');
content = content.replace("minify: false,", "minify: false, target: 'esnext',");
fs.writeFileSync('vite.config.ts', content);
