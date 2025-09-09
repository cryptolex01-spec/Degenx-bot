// sniper-worker.js - Final optimized strict-mode scanner (dev-sold only) + polite rate-limiting + volume-spike detection
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const Bottleneck = require('bottleneck');
const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '5000', 10);
const MAX_TOKENS_PER_CYCLE = parseInt(process.env.MAX_TOKENS_PER_CYCLE || '18', 10);
const MIN_HOLDERS = parseInt(process.env.MIN_HOLDERS || '20', 10);
const TOP10_LIMIT_PCT = parseFloat(process.env.TOP10_LIMIT_PCT || '20');
const AI_KEYWORDS = (process.env.AI_KEYWORDS || 'AI,GPT,LLM,GenAI,Neural,Model,Agent').split(',');
const PORT = parseInt(process.env.PORT || '7000', 10);
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '8000', 10);

const connection = new Connection(RPC_URL, 'confirmed');
const bot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN) : null;

const limiter = new Bottleneck({ minTime: 380, maxConcurrent: 1 });

const app = express();
app.use(cors());
app.use(bodyParser.json());

const STATS_FILE = path.join(__dirname, 'worker-stats.json');
let stats = { scanned:0, alerts:[], wins:0, losses:0, scannerOn:false, lastError:null, lastRun:null };
try { if (fs.existsSync(STATS_FILE)) stats = JSON.parse(fs.readFileSync(STATS_FILE)); } catch(e){}

function saveStats(){ try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); } catch(e){} }

const cache = new Map();
function getCached(key){ const e = cache.get(key); if(!e) return null; if(Date.now()-e.t > CACHE_TTL){ cache.delete(key); return null;} return e.v; }
function setCached(key, val){ cache.set(key, { v: val, t: Date.now() }); }

async function limitedGet(url, opts={}, retries=3){
  const wrapped = limiter.wrap(async (u, o) => { return (await axios.get(u, o)).data; });
  try { return await wrapped(url, opts); } catch (err) {
    if (retries <= 0) throw err;
    const delay = Math.min(10000, (4 - retries) * 1000 + 500);
    await new Promise(r => setTimeout(r, delay));
    return limitedGet(url, opts, retries-1);
  }
}

async function sendTelegram(html){
  stats.alerts.unshift(new Date().toISOString() + ' | ' + html.replace(/<[^>]*>/g,''));
  if(stats.alerts.length>400) stats.alerts.pop();
  saveStats();
  if(!bot || !TELEGRAM_CHAT_ID){ console.warn('Telegram not configured'); return; }
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, html, { parse_mode:'HTML' }); }
  catch(e){ console.error('TG send error', e.message||e); stats.lastError = 'TG:'+ (e.message||String(e)); saveStats(); }
}

async function getTopHolders(mint){
  try {
    const cached = getCached('top_'+mint);
    if(cached) return cached;
    const res = await connection.getTokenLargestAccounts(new PublicKey(mint));
    const val = res.value || [];
    setCached('top_'+mint, val);
    return val;
  } catch(e){ return []; }
}
async function getMintInfo(mint){
  try {
    const cached = getCached('mint_'+mint);
    if(cached) return cached;
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const parsed = info && info.value && info.value.data && info.value.data.parsed ? info.value.data.parsed.info : null;
    setCached('mint_'+mint, parsed);
    return parsed;
  } catch(e){ return null; }
}

async function checkDevSold(mint, topHolder){
  try {
    if(!topHolder) return { ok:true, sold:false, reason:'no_top' };
    const cached = getCached('devsold_'+mint+'_'+topHolder);
    if(cached) return cached;
    const sigs = await connection.getSignaturesForAddress(new PublicKey(topHolder), { limit: 120 });
    let sold = false, moves = 0;
    for(const s of sigs){
      const tx = await connection.getParsedTransaction(s.signature, 'confirmed').catch(()=>null);
      if(!tx || !tx.meta) continue;
      const pre = tx.meta.preTokenBalances || [];
      const post = tx.meta.postTokenBalances || [];
      const found = pre.concat(post).some(b => b && b.mint && b.mint === mint);
      if(found) moves++;
    }
    if(moves>0) sold = true;
    const res = { ok:true, sold, moves };
    setCached('devsold_'+mint+'_'+topHolder, res);
    return res;
  } catch(e){ return { ok:false, error: e.message||String(e) }; }
}

function containsAIKeyword(text){ if(!text) return false; const lower = text.toLowerCase(); return AI_KEYWORDS.some(k => lower.includes(k.toLowerCase())); }

async function detectVolumeSpike(mint){
  try {
    const key = 'vol_'+mint;
    const cached = getCached(key);
    if(cached) return cached;
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${mint}`;
    try {
      const j = await limitedGet(url).catch(()=>null);
      if(j && j.pair && j.pair.liquidity && j.pair.priceUsd){
        const vol = j.pair?.volumeUsd24h || 0;
        const spike = vol > 5000 && vol > 2;
        setCached(key, spike);
        return spike;
      }
    } catch(e){}
    setCached(key, false);
    return false;
  } catch(e){ return false; }
}

const SPL_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const seen = new Set();

async function discoverCandidates(limit=MAX_TOKENS_PER_CYCLE){
  try {
    const sigs = await connection.getSignaturesForAddress(SPL_PROGRAM, { limit: 80 });
    const candidates = [];
    for(const s of sigs){
      if(!s.signature) continue;
      const tx = await connection.getParsedTransaction(s.signature, 'confirmed').catch(()=>null);
      if(!tx || !tx.transaction) continue;
      const msg = tx.transaction.message;
      for(const inst of msg.instructions || []){
        const parsed = inst.parsed || null;
        if(parsed && parsed.type === 'initializeMint' && parsed.info && parsed.info.mint){
          const mint = parsed.info.mint;
          if(!seen.has(mint)) candidates.push(mint);
        }
        if(candidates.length >= limit) break;
      }
      if(candidates.length >= limit) break;
    }
    return candidates.slice(0, limit);
  } catch(e){ console.error('discoverCandidates err', e.message||e); return []; }
}

async function processCandidate(mint){
  try {
    console.log('Process candidate', mint);
    const top = await getTopHolders(mint);
    const topSumUi = (top && top.slice(0,10).reduce((a,b)=>a + (b.uiAmount || 0), 0)) || 0;
    const mintInfo = await getMintInfo(mint);
    const supply = mintInfo && mintInfo.supply ? parseFloat(mintInfo.supply) : null;
    const nameSymbol = (mintInfo && ((mintInfo.name||'') + ' ' + (mintInfo.symbol||''))) || '';
    const top10Pct = (supply && topSumUi) ? (topSumUi / supply) * 100 : null;
    const holdersCount = Math.max((top && top.length) || 0, 0);
    const devAddr = top && top[0] && top[0].address ? top[0].address : null;
    const devCheck = await checkDevSold(mint, devAddr);
    const devSold = devCheck && devCheck.ok && devCheck.sold;
    if(!devSold){
      stats.alerts.unshift(new Date().toISOString() + ' | SKIP_NOT_SOLD ' + mint);
      if(stats.alerts.length>400) stats.alerts.pop();
      saveStats();
      return;
    }
    if(top10Pct !== null && top10Pct > TOP10_LIMIT_PCT){
      stats.alerts.unshift(new Date().toISOString() + ' | SKIP_TOP10 ' + mint + ' pct='+top10Pct.toFixed(2));
      if(stats.alerts.length>400) stats.alerts.pop();
      saveStats();
      return;
    }
    if(holdersCount < MIN_HOLDERS){
      stats.alerts.unshift(new Date().toISOString() + ' | SKIP_HOLDERS ' + mint + ' count=' + holdersCount);
    
      if(stats.alerts.length>400) stats.alerts.pop();
      saveStats();
      return;
    }
    const volSpike = await detectVolumeSpike(mint);
    let risk = 10;
    if(top10Pct !== null && top10Pct > (TOP10_LIMIT_PCT * 0.75)) risk += 25;
    if(holdersCount < (MIN_HOLDERS * 1.2)) risk += 20;
    const aiTag = containsAIKeyword(nameSymbol) ? 'AI_WARM' : 'AI_NONE';
    if(aiTag === 'AI_WARM') risk += 12;
    if(volSpike) risk = Math.max(1, risk - 8);
    risk = Math.max(1, Math.min(99, risk));
    const buyLink = `https://Raydium-or-Jupiter-swap?mint=${mint}`;
    const html = `<b>🔥 SAFE TOKEN (dev sold)</b>\nName: ${nameSymbol || 'n/a'}\nMint: <code>${mint}</code>\nTop10%: ${top10Pct!==null?top10Pct.toFixed(3)+'%':'n/a'}\nHolders: ${holdersCount}\nRisk: ${risk}%\nNarrative: ${aiTag}\nVol spike: ${volSpike ? 'YES' : 'NO'}\n\nBuy: ${buyLink}\nCopy: ${mint}`;
    await sendTelegram(html);
    console.log('Alert sent for', mint);
    await new Promise(r=>setTimeout(r, 220));
  } catch(e){
    console.error('processCandidate error', e.message||e);
    stats.lastError = e.message || String(e);
    saveStats();
  }
}

async function mainLoop(){
  console.log('Starting main loop', { CHECK_INTERVAL_MS, MAX_TOKENS_PER_CYCLE });
  stats.scannerOn = true; saveStats();
  while(true){
    try {
      stats.lastRun = Date.now(); saveStats();
      const candidates = await discoverCandidates(MAX_TOKENS_PER_CYCLE);
      for(const mint of candidates){
        if(seen.has(mint)) continue;
        seen.add(mint);
        stats.scanned++; saveStats();
        await processCandidate(mint);
      }
    } catch(e){
      console.error('mainLoop err', e.message||e);
      stats.lastError = e.message || String(e);
      saveStats();
    }
    await new Promise(r=>setTimeout(r, CHECK_INTERVAL_MS));
  }
}

app.get('/health', (req,res) => res.json({ ok:true, time:Date.now(), scanned: stats.scanned, lastError: stats.lastError }));
app.get('/api/stats', (req,res) => res.json(stats));
app.post('/api/mark', (req,res) => {
  const r = req.body && req.body.result;
  if(r === 'win') stats.wins++; else if(r === 'lose') stats.losses++;
  saveStats(); res.json({ ok:true, stats });
});
app.post('/test-alert', async (req,res) => {
  await sendTelegram(`<b>TEST ALERT</b>\nTime: ${new Date().toISOString()}`);
  res.json({ ok:true });
});

app.listen(PORT, () => console.log(`Worker listening on http://0.0.0.0:${PORT}`));
(async ()=>{
  if(bot && TELEGRAM_CHAT_ID){
    try { await sendTelegram('<b>Sniper worker started — final optimized strict mode</b>'); } catch(e){ console.warn('startup TG failed', e.message||e); }
  } else console.warn('Telegram not configured — set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in .env');
  await mainLoop();
})();
