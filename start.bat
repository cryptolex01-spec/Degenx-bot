@echo off
echo Installing dependencies (one time)...
npm install
echo Starting the bot...
start "" "http://localhost:7000"
node sniper-worker.js
pause
