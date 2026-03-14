const fs = require('fs');
if (fs.existsSync('package-lock.json')) fs.unlinkSync('package-lock.json');
if (fs.existsSync('node_modules')) fs.rmSync('node_modules', { recursive: true, force: true });
