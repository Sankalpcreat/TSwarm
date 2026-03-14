const fs = require('fs');
let content = fs.readFileSync('src/components/TerminalWindow.tsx', 'utf8');
content = content.replace("const setup = async () => {", "let isMounted = true;\n    const setup = async () => {");
content = content.replace("await initTerminalEvents();", "await initTerminalEvents();\n      if (!isMounted) return;");
content = content.replace("if (ro && containerRef.current) ro.unobserve(containerRef.current);", "isMounted = false;\n      if (ro && containerRef.current) ro.unobserve(containerRef.current);");
fs.writeFileSync('src/components/TerminalWindow.tsx', content);
