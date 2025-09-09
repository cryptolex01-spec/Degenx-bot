#!/usr/bin/env bash
echo "Installing dependencies (one time)..."
npm install
echo "Starting bot..."
xdg-open "http://localhost:7000" 2>/dev/null || open "http://localhost:7000" 2>/dev/null || true
node sniper-worker.js
