# DegenX Scanner Bot - Package (no secrets)

This package contains the DegenX Scanner Bot backend and a professional dashboard UI.

Important: Do NOT commit your `.env` or secrets to GitHub. Use Render environment variables when deploying.

Files included:
- package.json
- sniper-worker.js
- web/index.html
- .env.example
- README.md

Quick local test (optional):
1. Install Node.js LTS (>=18).
2. Copy `.env.example` to `.env` and fill in YOUR values (locally only).
3. Run:
   npm install
   node sniper-worker.js
4. Open `web/index.html` in your browser (or visit http://localhost:7000 if running backend).

Deploying online:
- Upload this repo to GitHub (without your `.env`).
- Deploy backend to Render (set environment variables in Render UI).
- Deploy UI to Vercel and set BACKEND_URL to your Render URL.
- Use UptimeRobot to keep the Render service alive.
