@echo off
title Jeopardy! Activity Launcher

echo Starting Discord Bot Server...
start cmd /k "cd discord-bot && node server.js"

echo Starting Discord Bot App...
start cmd /k "cd discord-bot && node bot-server.js"

echo Starting Frontend Vite Server...
start cmd /k "npm run dev"

echo Starting Cloudflare Tunnel...
start cmd /k "cloudflared tunnel --url http://localhost:5173"

echo All services launched!
pause