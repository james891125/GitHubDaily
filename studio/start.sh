#!/usr/bin/env sh
# AI 工作坊一鍵啟動（macOS / Linux）
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "請先安裝 Node.js 20 以上：https://nodejs.org/"; exit 1; }
[ -d node_modules ] || npm install || exit 1
( sleep 2; (command -v open >/dev/null && open http://127.0.0.1:8790) || (command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:8790) ) >/dev/null 2>&1 &
npm start
