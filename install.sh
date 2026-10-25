#!/bin/sh
set -eu

cd "$(dirname "$0")"
node -e "if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Node.js 24+ is required'); process.exit(1); }"
npm ci
npm run build

printf '%s\n' 'Installation complete. Run npm start to open the workbench at http://127.0.0.1:8642.'
