// server.js — SYFM Poker | Last edited: 2026-03-25 (server-side ID + secret token security)
'use strict';
const http   = require('http');
const { WebSocketServer } = require('ws');
const fs     = require('fs');
const path   = require('path');
const ftp    = require('basic-ftp');
const crypto = require('crypto');

const PORT  = process.env.PORT || 10000;
const SUITS = ['\u2660','\u2665','\u2666','\u2663'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RVAL  = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
const NP    = 9;
const SB    = 10, BB = 20;          // cash-game fixed blinds (pence)
const START_CHIPS = 1000;
const ACTION_TIMEOUT = 15000;
const ROOM_EMPTY_TTL_MS = 60_000;

// ─── Bot configuration ────────────────────────────────────────────────
const BOT_NAMES = ['RoboRaise','FoldBot','DeepStack','BluffBot','AutoAce','PokerAI','AllInBot','CallBot','SkyNet'];

function mkBot(id, name, seat, room, chips) {
  const styles = ['aggressive', 'passive', 'balanced'];
  return {
    ws: null, id, name, chips, seat, cards: [], bet: 0, folded: false,
    disconnected: false, autoFold: false, pendingCashOut: false,
    _disconnectTimer: null, _buyBackTimer: null, _onBuyBackResolved: null,
    buyInCount: 1, buyInTotal: chips, ip: 'bot',
    secret: generateSecret(), isBot: true,
    sittingOut: false, spectator: false, voluntaryAutoFold: false,
    pendingBuyBack: false, totalBet: 0,
    botStyle: styles[Math.floor(Math.random() * styles.length)]
  };
}

function evalPreflopStrength(cards) {
  const [c1, c2] = cards;
  const r1 = RVAL[c1.r], r2 = RVAL[c2.r];
  const suited = c1.s === c2.s;
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  if (r1 === r2) return 0.28 + (hi - 2) / 12 * 0.72;
  const hiScore = (hi - 2) / 12;
  const loScore = (lo - 2) / 12;
  let score = hiScore * 0.52 + loScore * 0.28;
  if (suited) score += 0.06;
  const gap = hi - lo - 1;
  if (gap === 0) score += 0.08;
  else if (gap === 1) score += 0.04;
  return Math.min(0.87, score);
}

function handTier(score) {
  if (score >= 9e8) return 1.00;
  if (score >= 8e8) return 0.95;
  if (score >= 7e8) return 0.88;
  if (score >= 6e8) return 0.80;
  if (score >= 5e8) return 0.72;
  if (score >= 4e8) return 0.63;
  if (score >= 3e8) return 0.54;
  if (score >= 2e8) return 0.42;
  if (score >= 1e8) return 0.30;
  return 0.14;
}

function decideBotAction(room, seat) {
  const G = room.G;
  const p = room.seats[seat];
  if (!p || !G) return { action: 'fold' };
  const callAmt = Math.min(G.currentBet - p.bet, p.chips);
  const potOdds = (G.pot + callAmt) > 0 ? callAmt / (G.pot + callAmt) : 0;
  let strength;
  if (G.phase === 'preflop') {
    strength = evalPreflopStrength(p.cards);
  } else {
    const allCards = [...p.cards, ...G.community];
    strength = handTier(evalBest(allCards));
  }
  const aggrMod = p.botStyle === 'aggressive' ? 0.12 : p.botStyle === 'passive' ? -0.10 : 0;
  const noise = (Math.random() - 0.5) * 0.18;
  const adj = Math.max(0, Math.min(1, strength + aggrMod + noise));
  const raiseIncrement = G.firstRaiseAction ? G.curBB : G.lastRaiseIncrement;
  const minRaise = Math.min(callAmt + raiseIncrement, p.chips);
  if (callAmt === 0) {
    if (adj > 0.60 && Math.random() > 0.35) {
      const betFraction = 0.4 + Math.random() * 0.5;
      const rawBet = Math.round(G.pot * betFraction / G.curBB) * G.curBB;
      const betAmt = Math.max(minRaise, Math.min(rawBet, p.chips));
      if (betAmt > 0 && betAmt <= p.chips) return { action: 'raise', amount: betAmt };
    }
    return { action: 'check' };
  } else {
    const foldThresh = p.botStyle === 'aggressive' ? 0.22 : p.botStyle === 'passive' ? 0.30 : 0.26;
    const raiseThresh = p.botStyle === 'aggressive' ? 0.58 : p.botStyle === 'passive' ? 0.72 : 0.65;
    if (adj < foldThresh || (adj < 0.42 && potOdds > 0.38)) {
      return { action: 'fold' };
    } else if (adj > raiseThresh && Math.random() > 0.38) {
      const sizeMult = 2.2 + Math.random() * 1.6;
      const rawRaise = Math.round(callAmt * sizeMult / G.curBB) * G.curBB;
      const raiseAmt = Math.max(minRaise, Math.min(rawRaise, p.chips));
      return { action: 'raise', amount: raiseAmt };
    } else {
      return { action: 'call' };
    }
  }
}

function scheduleBotAction(room, seat) {
  const thinkMs = 900 + Math.random() * 1400;
  startActionTimer(room, seat);
  setTimeout(() => {
    if (!room.G || room.G.toAct[0] !== seat) return;
    const bot = room.seats[seat];
    if (!bot || !bot.isBot) return;
    clearActionTimer(room);
    const { action, amount } = decideBotAction(room, seat);
    handleAction(room, seat, action, amount);
  }, thinkMs);
}

// ── Tournament blind structure (pence). ───────────────────────────────────────
const TOURNAMENT_BLINDS = [
  { sb: 10,   bb: 20   },  // Level 1
  { sb: 20,   bb: 40   },  // Level 2
  { sb: 30,   bb: 60   },  // Level 3
  { sb: 50,   bb: 100  },  // Level 4
  { sb: 75,   bb: 150  },  // Level 5
  { sb: 100,  bb: 200  },  // Level 6
  { sb: 150,  bb: 300  },  // Level 7
  { sb: 200,  bb: 400  },  // Level 8
  { sb: 300,  bb: 600  },  // Level 9
  { sb: 500,  bb: 1000 },  // Level 10
  { sb: 750,  bb: 1500 },  // Level 11
  { sb: 1000, bb: 2000 },  // Level 12
];

// ─── Logging ──────────────────────────────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

const SERVER_LOG = path.join(LOGS_DIR, `server_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.txt`);
function svrLog(line) {
  const ts = new Date().toISOString().slice(11,23);
  const entry = `[${ts}] ${line}\n`;
  try { fs.appendFileSync(SERVER_LOG, entry); } catch {}
  console.log(`[SVR] ${line}`);
}

function handLogPath(roomId, handNum) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(LOGS_DIR, `room${roomId}_hand${String(handNum).padStart(4,'0')}_${ts}.txt`);
}

function writeLog(room, line) {
  if (!room.G || !room.G.logPath) return;
  const ts = new Date().toTimeString().slice(0, 8);
  try { fs.appendFileSync(room.G.logPath, `[${ts}] ${line}\n`); } catch {}
}

function writeRoomLog(room, line) {
  const ts = new Date().toTimeString().slice(0, 8);
  if (room.G && room.G.logPath) {
    try { fs.appendFileSync(room.G.logPath, `[${ts}] ${line}\n`); } catch {}
  }
  svrLog(`[ROOM ${room.id}] ${line}`);
}

function logEvent(room, text) { broadcastAll(room, { type: 'logEvent', text }); }
function logBoth(room, text)  { writeLog(room, text); logEvent(room, text); }

function fmtCard(c) { return `${c.r}${c.s}`; }
function fmtCards(cards) { return cards.map(fmtCard).join(' '); }
function fmtPounds(pence) { return `£${(pence / 100).toFixed(2)}`; }

function writeSep(room, char) {
  char = char || '─';
  writeLog(room, char.repeat(64));
}

function writeChipSnapshot(room, label) {
  if (!room.G) return;
  writeLog(room, `  ${label || 'CHIP COUNTS'}:`);
  room.seats.forEach(s => {
    if (!s) return;
    const tags = [];
    if (s.folded)      tags.push('FOLDED');
    if (s.spectator)   tags.push('SPECTATOR');
    if (s.sittingOut)  tags.push('SITTING OUT');
    if (s.chips === 0) tags.push('ALL-IN');
    const tagStr = tags.length ? ` [${tags.join('+')}]` : '';
    writeLog(room, `    Seat ${String(s.seat+1).padStart(2)} | ${s.name.padEnd(18)} | ${fmtPounds(s.chips).padStart(8)}${tagStr}`);
  });
}

async function ftpUpload(localPath) {
  const host = process.env.FTP_HOST, user = process.env.FTP_USER, pass = process.env.FTP_PASS;
  const dir  = process.env.FTP_DIR || '/poker-logs';
  if (!host || !user || !pass) { svrLog('FTP: env vars not set - upload skipped'); return; }
  const client = new ftp.Client();
  client.ftp.verbose = false;
  const fname = path.basename(localPath);
  try {
    await client.access({ host, user, password: pass, secure: false });
    try { await client.ensureDir(dir); } catch {}
    await client.uploadFrom(localPath, `${dir}/${fname}`);
    svrLog(`FTP: uploaded ${fname}`);
  } catch (err) {
    svrLog(`FTP: upload FAILED for ${fname} - ${err.message}`);
  } finally { client.close(); }
}

function cleanIp(raw) {
  if (!raw) return 'unknown';
  return raw.replace(/^::ffff:/, '');
}

// ─── Generate a cryptographically secure player ID and session secret ─────────
function generatePlayerId() {
  return 'p_' + crypto.randomBytes(8).toString('hex');
}
function generateSecret() {
  return crypto.randomBytes(16).toString('hex');
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading game'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }
  if (req.url === '/logs') {
    let files = [];
    try { files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.txt')).sort().reverse(); } catch {}
    const links = files.map(f => `<li><a href="/logs/download/${encodeURIComponent(f)}">${f}</a></li>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>Logs</title><style>body{font-family:monospace;background:#111;color:#aef;padding:20px}a{color:#ffd700}li{margin:4px 0}</style></head><body><h2>SYFM Poker - Hand Logs (${files.length} files)</h2><ul>${links}</ul><p><a href="/">Back to game</a></p></body></html>`);
    return;
  }
  const dl = req.url.match(/^\/logs\/download\/(.+)$/);
  if (dl) {
    const name = decodeURIComponent(dl[1]).replace(/[/\\]/g, '');
    const fp = path.join(LOGS_DIR, name);
    if (!fp.startsWith(LOGS_DIR) || !name.endsWith('.txt')) { res.writeHead(403); res.end(); return; }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${name}"` });
      res.end(data);
    });
    return;
  }
  if (req.url && req.url.startsWith('/keepalive')) {
    const params = new URL(req.url, 'http://x').searchParams;
    const roomP = params.get('room') || '?', handP = params.get('hand') || '?';
    const ts = new Date().toISOString();
    svrLog(`KEEPALIVE | Room: ${roomP} | Hand: ${handP}`);
    const r = rooms.get(roomP);
    if (r && r.G) writeLog(r, `KEEPALIVE at hand #${handP}`);
    res.writeHead(200, {'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});
    res.end('alive:'+ts);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const rooms = new Map();

function destroyRoom(room) {
  svrLog(`ROOM ${room.id} DESTROY`);
  clearActionTimer(room);
  stopBlindTimer(room);
  if (room._emptyTimer) { clearTimeout(room._emptyTimer); room._emptyTimer = null; }
  room.seats.forEach(s => {
    if (s) {
      if (s._disconnectTimer) { clearTimeout(s._disconnectTimer); s._disconnectTimer = null; }
      if (s._buyBackTimer)    { clearTimeout(s._buyBackTimer);    s._buyBackTimer    = null; }
      try { if (s.ws?.readyState === 1) s.ws.close(); } catch {}
    }
  });
  room.pendingJoins.forEach(p => { try { if (p.ws?.readyState === 1) p.ws.close(); } catch {} });
  rooms.delete(room.id);
}

function scheduleRoomCleanup(room) {
  if (room._emptyTimer) { clearTimeout(room._emptyTimer); room._emptyTimer = null; }
  const hasConnected = room.seats.some(s => s && !s.disconnected && s.ws?.readyState === 1)
    || room.pendingJoins.some(p => p.ws?.readyState === 1);
  if (!hasConnected) {
    room._emptyTimer = setTimeout(() => {
      const stillEmpty = !room.seats.some(s => s && !s.disconnected && s.ws?.readyState === 1)
        && !room.pendingJoins.some(p => p.ws?.readyState === 1);
      if (stillEmpty) destroyRoom(room);
    }, ROOM_EMPTY_TTL_MS);
  }
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId, seats: Array(NP).fill(null), hostId: null,
      gameActive: false, pendingJoins: [], G: null, dealerSeat: -1,
      actionTimer: null, handNum: 0,
      paused: false, actionTimerSeat: -1, actionTimerRemaining: ACTION_TIMEOUT,
      actionTimerStarted: 0,
      buyIn: START_CHIPS,
      _emptyTimer: null,
      gameHistory: [],
      // ── Tournament fields ──
      gameType: 'cash',
      tournamentChips: 8000,
      blindLevelDuration: 10,
      blindLevel: 0,
      blindLevelTimer: null,
      blindLevelStartedAt: null,
      blindLevelRemaining: null,
      blindLevelPausedAt: null,
      tournamentPlacement: [],
      botOnlyHandCount: 0,
    });
  }
  const room = rooms.get(roomId);
  if (room._emptyTimer) { clearTimeout(room._emptyTimer); room._emptyTimer = null; }
  return room;
}

// ── Tournament blind timer ────────────────────────────────────────────────────
function stopBlindTimer(room) {
  if (room.blindLevelTimer) { clearTimeout(room.blindLevelTimer); room.blindLevelTimer = null; }
}

function startBlindTimer(room, overrideMs) {
  stopBlindTimer(room);
  if (room.gameType !== 'tournament') return;
  const durationMs = overrideMs != null ? overrideMs : (room.blindLevelDuration || 10) * 60 * 1000;
  room.blindLevelStartedAt = Date.now();
  room.blindLevelRemaining = durationMs;
  room.blindLevelPausedAt  = null;
  svrLog(`ROOM ${room.id} blind timer: ${(durationMs/1000).toFixed(0)}s until level ${room.blindLevel + 2}`);
  room.blindLevelTimer = setTimeout(() => {
    room.blindLevelTimer = null;
    if (room.blindLevel < TOURNAMENT_BLINDS.length - 1) {
      room.blindLevel++;
      const b = TOURNAMENT_BLINDS[room.blindLevel];
      logBoth(room, `BLIND LEVEL UP -> Level ${room.blindLevel + 1} | SB/BB ${b.sb}/${b.bb}`);
      broadcastAll(room, {
        type: 'blindLevelUp', level: room.blindLevel, sb: b.sb, bb: b.bb,
        nextLevelMs: (room.blindLevelDuration || 10) * 60 * 1000
      });
    }
    startBlindTimer(room);
  }, durationMs);
}

function pauseBlindTimer(room) {
  if (room.gameType !== 'tournament' || !room.blindLevelTimer) return;
  const elapsed = Date.now() - (room.blindLevelStartedAt || Date.now());
  room.blindLevelRemaining = Math.max(0, (room.blindLevelRemaining || 0) - elapsed);
  room.blindLevelPausedAt  = Date.now();
  stopBlindTimer(room);
}

function resumeBlindTimer(room) {
  if (room.gameType !== 'tournament') return;
  const remaining = room.blindLevelRemaining != null
    ? room.blindLevelRemaining
    : (room.blindLevelDuration || 10) * 60 * 1000;
  startBlindTimer(room, remaining);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcastAll(room, msg) {
  const str = JSON.stringify(msg);
  room.seats.forEach(s => { if (s?.ws?.readyState === 1) s.ws.send(str); });
}

function lobbySnapshot(room) {
  return {
    type: 'lobby', roomId: room.id, hostId: room.hostId, gameActive: room.gameActive,
    buyIn: room.buyIn,
    gameType: room.gameType || 'cash',
    tournamentChips: room.tournamentChips || 8000,
    blindLevelDuration: room.blindLevelDuration || 10,
    seats: room.seats.map(s => s ? { id: s.id, name: s.name, chips: s.chips, seat: s.seat, isBot: s.isBot || false } : null),
    pending: room.pendingJoins.map(p => ({ id: p.id, name: p.name }))
  };
}

function currentBlinds(room) {
  if (room.gameType === 'tournament') {
    return TOURNAMENT_BLINDS[Math.min(room.blindLevel || 0, TOURNAMENT_BLINDS.length - 1)];
  }
  return { sb: SB, bb: BB };
}

function getBlindLevelRemainingMs(room) {
  if (room.gameType !== 'tournament') return null;
  if (room.blindLevelPausedAt) return room.blindLevelRemaining || 0;
  if (room.blindLevelStartedAt && room.blindLevelRemaining != null) {
    return Math.max(0, room.blindLevelRemaining - (Date.now() - room.blindLevelStartedAt));
  }
  return (room.blindLevelDuration || 10) * 60 * 1000;
}

function tableSnapshot(room, forId) {
  const G = room.G;
  const blinds = currentBlinds(room);
  const tournamentInfo = {
    gameType: room.gameType || 'cash',
    blindLevel: room.blindLevel || 0,
    currentSB: blinds.sb,
    currentBB: blinds.bb,
    blindLevelDuration: room.blindLevelDuration || 10,
    blindLevelRemainingMs: getBlindLevelRemainingMs(room),
    tournamentPlacement: room.tournamentPlacement || [],
  };
  if (!G) return {
    type: 'state', phase: 'idle', ...tournamentInfo,
    players: room.seats.map(s => {
      if (!s) return null;
      return { seat: s.seat, name: s.name, chips: s.chips, bet: 0,
               folded: false, disconnected: s.disconnected || false,
               pendingCashOut: s.pendingCashOut || false,
               voluntaryAutoFold: s.voluntaryAutoFold || false,
               spectator: s.spectator || false,
               pendingBuyBack: s.pendingBuyBack || false,
               isBot: s.isBot || false,
               cards: [], active: !s.sittingOut };
    })
  };
  return {
    type: 'state', phase: G.phase, pot: G.pot, currentBet: G.currentBet,
    community: G.community, dealerSeat: room.dealerSeat,
    sbSeat: G.sbSeat, bbSeat: G.bbSeat, toActSeat: G.toAct[0] ?? null,
    ...tournamentInfo,
    players: room.seats.map(s => {
      if (!s) return null;
      const isOwner = s.id === forId;
      const atShowdown = G.phase === 'showdown' && !s.folded;
      const showCards = isOwner || atShowdown;
      return {
        seat: s.seat, name: s.name, chips: s.chips, bet: s.bet,
        folded: s.folded, disconnected: s.disconnected || false,
        pendingCashOut: s.pendingCashOut || false,
        voluntaryAutoFold: s.voluntaryAutoFold || false,
        spectator: s.spectator || false,
        pendingBuyBack: s.pendingBuyBack || false,
        isBot: s.isBot || false,
        cards: showCards ? s.cards : s.cards.map(() => 'back'),
        active: !s.sittingOut
      };
    })
  };
}

function startActionTimer(room, seat, remainingMs) {
  clearActionTimer(room);
  if (room.paused) {
    room.actionTimerSeat = seat;
    room.actionTimerRemaining = remainingMs != null ? remainingMs : ACTION_TIMEOUT;
    return;
  }
  const duration = remainingMs != null ? remainingMs : ACTION_TIMEOUT;
  room.actionTimerSeat = seat;
  room.actionTimerRemaining = duration;
  room.actionTimerStarted = Date.now();
  writeLog(room, `ACTION TIMER: seat ${seat+1} has ${(duration/1000).toFixed(1)}s`);
  room.actionTimer = setTimeout(() => {
    const p = room.seats[seat];
    if (!p || p.folded || !room.G || room.G.toAct[0] !== seat) return;
    writeLog(room, `ACTION TIMER EXPIRED: seat ${seat+1} (${p.name}) auto-folding`);
    doFold(room, seat, 'timeout');
  }, duration);
}

function clearActionTimer(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  if (room.actionTimerStarted) {
    const elapsed = Date.now() - room.actionTimerStarted;
    room.actionTimerRemaining = Math.max(2000, (room.actionTimerRemaining || ACTION_TIMEOUT) - elapsed);
    room.actionTimerStarted = 0;
  }
}

function pauseGame(room, byName) {
  if (room.paused) return;
  room.paused = true;
  room._pausedAt = Date.now();
  clearActionTimer(room);
  pauseBlindTimer(room);
  broadcastAll(room, { type: 'gamePaused', byName });
  writeLog(room, `GAME PAUSED by ${byName}`);
  svrLog(`ROOM ${room.id} PAUSED by ${byName}`);
}

function resumeGame(room, byName) {
  if (!room.paused) return;
  room.botOnlyHandCount = 0;  // reset when a human resumes
  room.botOnlyHandCount = 0;  // fresh start when a human resumes
  const pausedForMs = room._pausedAt ? Date.now() - room._pausedAt : 0;
  room.paused = false; room._pausedAt = null;
  broadcastAll(room, { type: 'gameResumed', byName });
  writeLog(room, `GAME RESUMED by ${byName} | paused for ${(pausedForMs/1000).toFixed(1)}s`);
  svrLog(`ROOM ${room.id} RESUMED by ${byName}`);
  resumeBlindTimer(room);
  if (room.G && room.actionTimerSeat >= 0 && room.G.toAct[0] === room.actionTimerSeat) {
    startActionTimer(room, room.actionTimerSeat, room.actionTimerRemaining || ACTION_TIMEOUT);
  }
}

// ─── Connections ──────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = forwardedFor
    ? cleanIp(forwardedFor.split(',')[0].trim())
    : cleanIp(ws._socket?.remoteAddress);
  let myId = null, myRoomId = null;
  svrLog(`WS OPEN (total: ${wss.clients.size}) | IP: ${clientIp}`);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        const rawRoom = String(msg.room || '1').replace(/\D/g, '') || '1';
        myRoomId = rawRoom.slice(0, 6);
        const name = (msg.name || 'Player').slice(0, 18).trim() || 'Player';
        const room = getOrCreateRoom(myRoomId);

        // ── RECONNECT: client supplies their existing id + secret ──────────
        if (msg.id && msg.secret) {
          myId = msg.id;

          // Check pending joins first (waiting for host approval)
          const pendingIdx = room.pendingJoins.findIndex(p => p.id === myId);
          if (pendingIdx !== -1) {
            const pj = room.pendingJoins[pendingIdx];
            if (pj.secret !== msg.secret) {
              svrLog(`SECRET MISMATCH (pending): id=${myId} | IP: ${clientIp}`);
              send(ws, { type: 'rejected', reason: 'Invalid session' });
              return;
            }
            pj.ws = ws; pj.ip = clientIp;
            send(ws, { type: 'waiting', id: myId });
            return;
          }

          // Check seated players
          const existing = room.seats.find(s => s?.id === myId);
          if (existing) {
            // ── Secret validation ──────────────────────────────────────────
            if (existing.secret !== msg.secret) {
              svrLog(`SECRET MISMATCH (seated): id=${myId} name="${existing.name}" | IP: ${clientIp}`);
              send(ws, { type: 'rejected', reason: 'Invalid session' });
              return;
            }

            const wasDisconnectedMs = existing.disconnected ? Date.now() - (existing._disconnectedAt||0) : 0;
            if (existing._disconnectTimer) { clearTimeout(existing._disconnectTimer); existing._disconnectTimer = null; }
            const needsHostApproval = existing.autoFold && (existing._missedHands || 0) >= 1;
            if (needsHostApproval) {
              if (!room.pendingJoins.find(p => p.id === myId)) {
                room.pendingJoins.push({ ws, id: myId, name: existing.name, secret: existing.secret, isRejoin: true, ip: clientIp });
              } else {
                const pj = room.pendingJoins.find(p => p.id === myId);
                if (pj) { pj.ws = ws; pj.ip = clientIp; }
              }
              send(ws, { type: 'waiting', id: myId, reason: `You missed ${existing._missedHands} hand(s). Waiting for host to re-admit you.` });
              const host = room.seats.find(s => s?.id === room.hostId);
              if (host?.ws?.readyState === 1) send(host.ws, { type: 'joinRequest', id: myId, name: existing.name });
              broadcastAll(room, lobbySnapshot(room));
              writeRoomLog(room, `REJOIN REQUEST (pending host approval): ${existing.name} | Seat ${existing.seat+1} | IP: ${clientIp} | Missed hands: ${existing._missedHands}`);
            } else {
              existing.ws = ws; existing.disconnected = false; existing.autoFold = false;
              existing._disconnectedAt = null; existing._missedHands = 0;
              existing.ip = clientIp;
              room.botOnlyHandCount = 0;  // human reconnected — reset bot-only counter
              send(ws, { type: 'joined', id: myId, seat: existing.seat, isHost: myId === room.hostId });
              send(ws, lobbySnapshot(room));
              if (room.G) send(ws, tableSnapshot(room, myId));
              const goneFor = (wasDisconnectedMs/1000).toFixed(1);
              writeRoomLog(room, `RECONNECT: ${name} | Seat ${existing.seat+1} | IP: ${clientIp} | Was disconnected for ${goneFor}s`);
              logEvent(room, `\uD83D\uDD04 ${existing.name} reconnected`);
            }
            return;
          }

          // ID+secret provided but not found — treat as a fresh join
          svrLog(`RECONNECT FAILED (not found): id=${myId} | IP: ${clientIp} — treating as new join`);
        }

        // ── FRESH JOIN: server generates id + secret ───────────────────────
        myId = generatePlayerId();
        const secret = generateSecret();
        svrLog(`JOIN - room ${myRoomId} | id=${myId} | name="${name}" | IP=${clientIp}`);

        const hasSeatedPlayers = room.seats.some(s => s !== null);
        if (!hasSeatedPlayers && room.pendingJoins.length === 0) {
          const hostBuyIn = (msg.buyIn && msg.buyIn > 0) ? Math.round(msg.buyIn) : START_CHIPS;
          room.seats[0] = mkPlayer(ws, myId, name, 0, room, hostBuyIn, clientIp, secret);
          room.hostId = myId;
          svrLog(`NEW ROOM - ${name} created room ${myRoomId} as host | IP: ${clientIp}`);
          writeRoomLog(room, `ROOM CREATED by ${name} | ID: ${myId} | IP: ${clientIp} | Buy-in: ${fmtPounds(hostBuyIn)}`);
          // Send id AND secret so client can store both for reconnection
          send(ws, { type: 'joined', id: myId, secret, seat: 0, isHost: true });
          broadcastAll(room, lobbySnapshot(room));
          return;
        }

        const pendingBuyIn = (msg.buyIn && msg.buyIn > 0) ? Math.round(msg.buyIn) : null;
        room.pendingJoins.push({ ws, id: myId, name, secret, buyIn: pendingBuyIn, ip: clientIp });
        // Send id + secret immediately so client can store them while waiting
        send(ws, { type: 'waiting', id: myId, secret });
        svrLog(`JOIN REQUEST (pending): ${name} | IP: ${clientIp} | room: ${myRoomId}`);
        const host = room.seats.find(s => s?.id === room.hostId);
        if (host?.ws?.readyState === 1) send(host.ws, { type: 'joinRequest', id: myId, name });
        break;
      }

      case 'approve': {
        const room = rooms.get(myRoomId);
        if (!room || myId !== room.hostId) return;
        const idx = room.pendingJoins.findIndex(p => p.id === msg.id);
        if (idx === -1) return;
        const p = room.pendingJoins.splice(idx, 1)[0];
        if (msg.accept) {
          const existSeat = room.seats.find(s => s?.id === p.id);
          if (existSeat) {
            if (existSeat._disconnectTimer) { clearTimeout(existSeat._disconnectTimer); existSeat._disconnectTimer = null; }
            existSeat.ws = p.ws; existSeat.disconnected = false; existSeat.autoFold = false;
            existSeat._missedHands = 0; existSeat._disconnectedAt = null; existSeat.ip = p.ip || existSeat.ip;
            send(p.ws, { type: 'joined', id: p.id, seat: existSeat.seat, isHost: p.id === room.hostId });
            send(p.ws, lobbySnapshot(room));
            if (room.G) send(p.ws, tableSnapshot(room, p.id));
            writeRoomLog(room, `RE-ADMITTED: ${existSeat.name} | Seat ${existSeat.seat+1} | IP: ${existSeat.ip || 'unknown'}`);
            logEvent(room, `\u2705 ${existSeat.name} re-admitted to the table`);
          } else {
            const seat = room.seats.findIndex(s => s === null);
            if (seat === -1) { send(p.ws, { type: 'rejected', reason: 'Table is full' }); broadcastAll(room, lobbySnapshot(room)); return; }
            const startChips = room.gameType === 'tournament' ? room.tournamentChips : (p.buyIn || room.buyIn);
            room.seats[seat] = mkPlayer(p.ws, p.id, p.name, seat, room, startChips, p.ip, p.secret);
            send(p.ws, { type: 'joined', id: p.id, seat, isHost: false });
            writeRoomLog(room, `PLAYER JOINED: ${p.name} | Seat ${seat+1} | IP: ${p.ip || 'unknown'} | Chips: ${fmtPounds(startChips)}`);
            logEvent(room, `\u2705 ${p.name} joined the table (Seat ${seat+1})`);
            if (room.gameActive) {
              if (room.gameType === 'tournament') {
                room.seats[seat].spectator = true; room.seats[seat].sittingOut = true;
                send(p.ws, { type: 'sittingOut', reason: 'Tournament in progress - you are spectating.' });
              } else {
                room.seats[seat].sittingOut = true;
                send(p.ws, { type: 'sittingOut', reason: 'Hand in progress - you will join next hand.' });
              }
              send(p.ws, tableSnapshot(room, p.id));
            }
          }
        } else {
          svrLog(`JOIN REJECTED: ${p.name} | IP: ${p.ip || 'unknown'} | room: ${room.id}`);
          send(p.ws, { type: 'rejected', reason: 'Host declined your request' });
        }
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'addBot': {
        const room = rooms.get(myRoomId);
        if (!room || room.hostId !== myId || room.gameActive) return;
        const seat = room.seats.findIndex(s => s === null);
        if (seat === -1) { send(ws, { type: 'error', msg: 'Table is full' }); return; }
        const botId = generatePlayerId();
        const usedNames = room.seats.filter(Boolean).map(s => s.name);
        const avail = BOT_NAMES.filter(n => !usedNames.includes(n));
        const botName = avail.length ? avail[Math.floor(Math.random() * avail.length)] : 'Bot' + (seat + 1);
        const startChips = room.gameType === 'tournament' ? room.tournamentChips : room.buyIn;
        room.seats[seat] = mkBot(botId, botName, seat, room, startChips);
        writeRoomLog(room, `BOT ADDED: ${botName} | Seat ${seat + 1}`);
        logEvent(room, `🤖 ${botName} (bot) joined the table`);
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'removeBot': {
        const room = rooms.get(myRoomId);
        if (!room || room.hostId !== myId || room.gameActive) return;
        const botSeats = room.seats.map((s, i) => (s?.isBot ? i : null)).filter(i => i !== null);
        if (!botSeats.length) return;
        const removeSeat = msg.seat != null && room.seats[msg.seat]?.isBot
          ? msg.seat
          : botSeats[botSeats.length - 1];
        const bot = room.seats[removeSeat];
        logEvent(room, `🤖 ${bot.name} (bot) removed`);
        writeRoomLog(room, `BOT REMOVED: ${bot.name} | Seat ${removeSeat + 1}`);
        room.seats[removeSeat] = null;
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'startGame': {
        const room = rooms.get(myRoomId);
        if (!room || myId !== room.hostId) return;
        const playable = room.seats.filter(s => s && !s.autoFold);
        if (playable.length < 2) { send(ws, { type: 'error', msg: 'Need at least 2 players' }); return; }
        svrLog(`GAME START - room ${myRoomId} | ${playable.length} players | type=${room.gameType}`);
        room.gameActive = true;
        if (room.gameType === 'tournament') {
          room.blindLevel = 0;
          room.tournamentPlacement = [];
          room.seats.forEach(s => {
            if (s) { s.chips = room.tournamentChips; s.buyInTotal = room.tournamentChips; s.buyInCount = 1; }
          });
          startBlindTimer(room);
        }
        broadcastAll(room, { type: 'gameStarting', gameType: room.gameType });
        broadcastAll(room, lobbySnapshot(room));
        startNewHand(room);
        break;
      }

      case 'setGameType': {
        const room = rooms.get(myRoomId);
        if (!room || room.hostId !== myId || room.gameActive) return;
        if (msg.gameType === 'cash' || msg.gameType === 'tournament') room.gameType = msg.gameType;
        if (msg.tournamentChips > 0) room.tournamentChips = Math.max(100, Math.round(msg.tournamentChips));
        if (msg.blindLevelDuration > 0) room.blindLevelDuration = Math.max(1, Math.min(120, Math.round(msg.blindLevelDuration)));
        svrLog(`ROOM ${room.id} type=${room.gameType} chips=${room.tournamentChips} blindDur=${room.blindLevelDuration}min`);
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'pause': {
        const room = rooms.get(myRoomId);
        if (!room || !room.gameActive) return;
        const p = room.seats.find(s => s?.id === myId);
        if (p) pauseGame(room, p.name);
        break;
      }

      case 'resume': {
        const room = rooms.get(myRoomId);
        if (!room || !room.gameActive) return;
        const p = room.seats.find(s => s?.id === myId);
        if (p) resumeGame(room, p.name);
        break;
      }

      case 'buyBack': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const p = room.seats.find(s => s?.id === myId);
        if (!p || !p.pendingBuyBack) return;
        if (p._buyBackTimer) { clearTimeout(p._buyBackTimer); p._buyBackTimer = null; }
        const resolve = p._onBuyBackResolved; p._onBuyBackResolved = null;
        if (msg.accept) {
          const buyInChips = (msg.buyIn && msg.buyIn > 0) ? Math.round(msg.buyIn) : room.buyIn;
          p.chips = buyInChips; p.pendingBuyBack = false; p.spectator = false;
          p.buyInCount = (p.buyInCount || 1) + 1; p.buyInTotal = (p.buyInTotal || room.buyIn) + buyInChips;
          p.sittingOut = true;
          writeLog(room, `BUY-BACK: ${p.name} | Seat ${p.seat+1} | Bought back in for ${fmtPounds(buyInChips)} | Total invested: ${fmtPounds(p.buyInTotal)} (${p.buyInCount} buy-ins)`);
          logEvent(room, `\u2705 ${p.name} bought back in`);
          send(p.ws, { type: 'buyBackAccepted', chips: buyInChips });
        } else {
          p.pendingBuyBack = false; p.sittingOut = true; p.spectator = true;
          recordPlayerExit(room, p, 'bust');
          writeLog(room, `BUY-BACK DECLINED: ${p.name} | Seat ${p.seat+1} | IP: ${p.ip || 'unknown'} | Finished with ${fmtPounds(0)}`);
          logEvent(room, `\ud83d\udc40 ${p.name} declined buy-back - now spectating`);
          send(p.ws, { type: 'spectating' });
        }
        broadcastState(room);
        if (resolve) resolve();
        break;
      }

      case 'voluntaryAutoFold': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const p = room.seats.find(s => s?.id === myId);
        if (!p) return;
        p.voluntaryAutoFold = msg.enabled === true;
        const afStatus = p.voluntaryAutoFold ? 'ENABLED' : 'DISABLED';
        writeLog(room, `AUTO-FOLD ${afStatus}: ${p.name} | Seat ${p.seat+1}`);
        logEvent(room, `\uD83D\uDD01 AUTO-FOLD ${afStatus}: ${p.name}`);
        if (p.voluntaryAutoFold && room.G && room.G.toAct[0] === p.seat) {
          clearActionTimer(room); doFold(room, p.seat, 'auto-fold');
        }
        send(ws, { type: 'voluntaryAutoFoldAck', enabled: p.voluntaryAutoFold });
        break;
      }

      case 'action': {
        const room = rooms.get(myRoomId);
        if (!room?.G || !room.gameActive) return;
        const actSeat = room.seats.findIndex(s => s?.id === myId);
        if (actSeat === -1 || room.G.toAct[0] !== actSeat) return;
        clearActionTimer(room);
        handleAction(room, actSeat, msg.action, msg.amount);
        break;
      }

      case 'exitGame': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const s = room.seats.find(s => s?.id === myId);
        if (!s) return;
        if (s._buyBackTimer) { clearTimeout(s._buyBackTimer); s._buyBackTimer = null; }
        const resolve = s._onBuyBackResolved; s._onBuyBackResolved = null;
        s.pendingBuyBack = false;
        recordPlayerExit(room, s, 'bust');
        svrLog(`EXIT GAME - ${s.name} room ${room.id} | IP: ${s.ip || 'unknown'} | Chips at exit: ${fmtPounds(s.chips)}`);
        writeRoomLog(room, `PLAYER LEFT (exit): ${s.name} | Seat ${s.seat+1} | IP: ${s.ip || 'unknown'} | Chips: ${fmtPounds(s.chips)} | Invested: ${fmtPounds(s.buyInTotal||0)} (${s.buyInCount||1} buy-in(s)) | Net: ${fmtPounds(s.chips-(s.buyInTotal||0))}`);
        logEvent(room, `\uD83D\uDEAA ${s.name} has left the game`);
        broadcastAll(room, { type: 'playerLeft', id: s.id, name: s.name, seat: s.seat, chips: 0, reason: 'exit' });
        room.seats[s.seat] = null;
        if (room.hostId === s.id) {
          const newHost = room.seats.find(Boolean);
          if (newHost) { room.hostId = newHost.id; send(newHost.ws, { type: 'logEvent', text: '\uD83D\uDC51 You are now the host.' }); }
        }
        broadcastAll(room, lobbySnapshot(room)); broadcastState(room); scheduleRoomCleanup(room);
        if (resolve) resolve();
        break;
      }

      case 'cashOut': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        if (room.gameType === 'tournament') { send(ws, { type: 'error', msg: 'Cash out is not available in tournament mode.' }); return; }
        const s = room.seats.find(s => s?.id === myId);
        if (!s) return;
        const inActiveHand = room.G && !s.folded && !s.sittingOut && room.G.phase !== 'idle' && s.cards && s.cards.length > 0;
        if (inActiveHand) {
          s.pendingCashOut = true; send(ws, { type: 'cashOutPending' });
          logEvent(room, `\uD83D\uDCB0 ${s.name} will cash out after this hand`);
          writeLog(room, `CASH OUT REQUESTED: ${s.name} | Seat ${s.seat+1} | Chips: ${fmtPounds(s.chips)} | Will take effect end of hand`);
          if (room.G.toAct[0] === s.seat) { clearActionTimer(room); doFold(room, s.seat, 'cash out'); }
          else if (!s.folded) {
            s.folded = true;
            const idx = room.G.toAct.indexOf(s.seat); if (idx !== -1) room.G.toAct.splice(idx, 1);
            broadcastAll(room, { type: 'playerAction', seat: s.seat, action: 'fold', amount: 0, name: s.name + ' (cashing out)' });
            broadcastState(room); checkRoundEnd(room);
          }
          broadcastState(room);
        } else { executeCashOut(room, s); }
        break;
      }

      case 'chat': {
        const room = rooms.get(myRoomId); if (!room) return;
        const s = room.seats.find(s => s?.id === myId); if (!s) return;
        writeLog(room, `CHAT [${s.name}]: ${(msg.text||'').slice(0,120)}`);
        broadcastAll(room, { type: 'chat', name: s.name, text: (msg.text || '').slice(0, 120) });
        break;
      }

      case 'setBuyIn': {
        const room = rooms.get(myRoomId); if (!room || room.hostId !== myId) return;
        const newBuyIn = Math.max(20, Math.round(Number(msg.buyIn)));
        room.buyIn = newBuyIn;
        writeRoomLog(room, `BUY-IN CHANGED: ${fmtPounds(newBuyIn)} (set by host)`);
        logEvent(room, `\uD83D\uDCB0 Buy-in set to \u00a3${(newBuyIn/100).toFixed(2)} by host`);
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'setStack': {
        const room = rooms.get(myRoomId); if (!room || room.hostId !== myId) return;
        const target = room.seats.find(s => s?.id === msg.playerId); if (!target) return;
        const newChips = Math.max(0, Math.round(Number(msg.chips)));
        const oldChips = target.chips;
        target.chips = newChips;
        writeRoomLog(room, `STACK ADJUSTED (by host): ${target.name} | Seat ${target.seat+1} | ${fmtPounds(oldChips)} -> ${fmtPounds(newChips)}`);
        logEvent(room, `\uD83D\uDD27 ${target.name}'s stack set to \u00a3${(newChips/100).toFixed(2)} by host`);
        broadcastState(room); broadcastAll(room, lobbySnapshot(room));
        break;
      }
    }
  });

  ws.on('close', () => {
    svrLog(`WS CLOSE - id=${myId||'(pre-join)'} room=${myRoomId||'none'} | IP: ${clientIp}`);
    if (!myId || !myRoomId) return;
    const room = rooms.get(myRoomId); if (!room) return;

    const pi = room.pendingJoins.findIndex(p => p.id === myId && p.ws === ws);
    if (pi !== -1) {
      const pj = room.pendingJoins[pi]; room.pendingJoins.splice(pi, 1);
      svrLog(`PENDING JOIN CANCELLED: ${pj.name} | IP: ${clientIp}`);
      broadcastAll(room, lobbySnapshot(room)); scheduleRoomCleanup(room); return;
    }

    const s = room.seats.find(s => s?.id === myId);
    if (!s || s.ws !== ws) return;
    s.disconnected = true; s.ws = null; s._disconnectedAt = Date.now();
    s._missedHands = s._missedHands || 0;
    writeRoomLog(room, `DISCONNECTED: ${s.name} | Seat ${s.seat+1} | IP: ${clientIp} | Chips at disconnect: ${fmtPounds(s.chips)}`);
    logEvent(room, `\u26A0 ${s.name} disconnected`);
    s.autoFold = true; broadcastState(room);
    if (room.G && room.G.toAct[0] === s.seat) { clearActionTimer(room); doFold(room, s.seat, 'disconnected'); }
    else if (room.G && !s.folded) {
      s.folded = true;
      const idx = room.G.toAct.indexOf(s.seat); if (idx !== -1) room.G.toAct.splice(idx, 1);
      broadcastAll(room, { type: 'playerAction', seat: s.seat, action: 'fold', amount: 0, name: s.name + ' (disconnected)' });
      broadcastState(room); checkRoundEnd(room);
    }
    scheduleRoomCleanup(room);
  });

  ws.on('error', err => { svrLog(`WS ERROR - id=${myId||'(pre-join)'} | IP: ${clientIp}: ${err.message}`); });
});

function executeCashOut(room, s) {
  const chips = s.chips, seatIdx = s.seat;
  recordPlayerExit(room, s, 'cashout');
  const net = chips - (s.buyInTotal || 0);
  svrLog(`CASH OUT - ${s.name} room ${room.id} | IP: ${s.ip || 'unknown'} | Chips: ${fmtPounds(chips)}`);
  writeRoomLog(room, `PLAYER CASHED OUT: ${s.name} | Seat ${seatIdx+1} | IP: ${s.ip || 'unknown'} | Cash out: ${fmtPounds(chips)} | Total invested: ${fmtPounds(s.buyInTotal||0)} (${s.buyInCount||1} buy-in(s)) | Net P&L: ${fmtPounds(net)}`);
  logEvent(room, `\uD83D\uDCB0 ${s.name} cashed out with \u00a3${(chips/100).toFixed(2)}`);
  broadcastAll(room, { type: 'playerLeft', id: s.id, name: s.name, seat: seatIdx, chips: s.chips, reason: 'cashout' });
  room.seats[seatIdx] = null;
  if (room.hostId === s.id) {
    const newHost = room.seats.find(Boolean);
    if (newHost) { room.hostId = newHost.id; send(newHost.ws, { type: 'logEvent', text: '\uD83D\uDC51 You are now the host.' }); }
  }
  broadcastAll(room, lobbySnapshot(room)); broadcastState(room); scheduleRoomCleanup(room);
}

// secret param added — stored on the player object
function mkPlayer(ws, id, name, seat, room, chips, ip, secret) {
  const startChips = chips != null ? chips : (room ? room.buyIn : START_CHIPS);
  return {
    ws, id, name, chips: startChips, seat, cards: [], bet: 0, folded: false,
    disconnected: false, autoFold: false, pendingCashOut: false,
    _disconnectTimer: null, buyInCount: 1, buyInTotal: startChips,
    ip: ip || 'unknown',
    secret: secret || generateSecret()   // always has a secret
  };
}

function buyInTag(s) { return `[Buy-ins: ${s.buyInCount} | Total in: \u00a3${(s.buyInTotal/100).toFixed(2)}]`; }

function ensurePlayerHistory(room, s) {
  if (!room.gameHistory) room.gameHistory = [];
  const existing = room.gameHistory.find(h => h.id === s.id);
  if (!existing) { room.gameHistory.push({ id: s.id, name: s.name, buyInTotal: s.buyInTotal || room.buyIn, chips: s.chips, status: 'active', ip: s.ip || 'unknown' }); }
  else { existing.name = s.name; existing.buyInTotal = s.buyInTotal || existing.buyInTotal; if (existing.status !== 'cashout' && existing.status !== 'evicted') existing.status = 'active'; }
}

function recordPlayerExit(room, s, status) {
  if (!room.gameHistory) room.gameHistory = [];
  const idx = room.gameHistory.findIndex(h => h.id === s.id);
  const record = { id: s.id, name: s.name, buyInTotal: s.buyInTotal || room.buyIn, chips: s.chips, status, ip: s.ip || 'unknown' };
  if (idx >= 0) room.gameHistory[idx] = record; else room.gameHistory.push(record);
}

function writeGameSummary(room) {
  if (!room.G || !room.G.logPath) return;
  const registry = new Map();
  (room.gameHistory || []).forEach(h => registry.set(h.id, { ...h }));
  room.seats.forEach(s => {
    if (!s) return;
    const prev = registry.get(s.id) || {};
    registry.set(s.id, { id: s.id, name: s.name, buyInTotal: s.buyInTotal || prev.buyInTotal || room.buyIn, chips: s.chips, status: s.spectator ? 'spectating' : s.pendingBuyBack ? 'bust' : 'active', ip: s.ip || prev.ip || 'unknown' });
  });
  if (registry.size === 0) return;
  const ORD = { active: 0, spectating: 1, cashout: 2, bust: 3, evicted: 4 };
  const players = [...registry.values()].sort((a, b) => {
    const od = (ORD[a.status] ?? 5) - (ORD[b.status] ?? 5);
    if (od) return od;
    return ((b.chips ?? 0) - (b.buyInTotal || 0)) - ((a.chips ?? 0) - (a.buyInTotal || 0));
  });
  let totalIn = 0, totalOut = 0;
  players.forEach(p => { totalIn += p.buyInTotal || 0; totalOut += p.chips ?? 0; });
  const W = 78, pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
  const fmt = n => '\u00a3' + (n / 100).toFixed(2), net = n => (n >= 0 ? '+' : '-') + '\u00a3' + (Math.abs(n) / 100).toFixed(2);
  const SEP = '\u2560' + '\u2550'.repeat(W) + '\u2563\n';
  const dataRow = (name, bi, chips, n, status, ip) =>
    '\u2551  ' + pad(name, 18) + ' ' + pad(fmt(bi), 10) + ' ' + pad(fmt(chips), 10) + ' ' + pad(net(n), 10) + ' ' + pad(status, 10) + ' ' + pad(ip||'', 16) + '\u2551\n';
  let out = '\n\u2554' + '\u2550'.repeat(W) + '\u2557\n';
  out += '\u2551' + ('  GAME SUMMARY - After Hand #' + String(room.handNum).padStart(4, '0')).padEnd(W) + '\u2551\n' + SEP;
  out += '\u2551' + ('  ' + pad('Player', 18) + ' ' + pad('Bought In', 10) + ' ' + pad('Has / Out', 10) + ' ' + pad('Net P&L', 10) + ' ' + pad('Status', 10) + ' ' + pad('IP Address', 16)).padEnd(W) + '\u2551\n' + SEP;
  players.forEach(p => { const c = p.chips ?? 0; out += dataRow(p.name, p.buyInTotal || 0, c, c - (p.buyInTotal || 0), p.status || 'active', p.ip || 'unknown'); });
  const totalNet = totalOut - totalIn, balTag = Math.abs(totalNet) <= 1 ? 'BALANCED' : 'ERR ' + net(totalNet);
  out += SEP + dataRow('TOTALS', totalIn, totalOut, totalNet, balTag, '') + '\u255a' + '\u2550'.repeat(W) + '\u255d\n';
  try { fs.appendFileSync(room.G.logPath, out); } catch {}
}

function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function buildDeck() { const d = []; for (const s of SUITS) for (const r of RANKS) d.push({ s, r }); return shuffle(d); }

function activePlaying(room) {
  return room.seats.map((s, i) => {
    if (!s || s.sittingOut || s.autoFold || s.spectator || s.pendingBuyBack || s.chips <= 0) return null; return i;
  }).filter(i => i !== null);
}

function nextSeat(from, active) {
  const sorted = [...active].sort((a, b) => a - b);
  const nxt = sorted.find(i => i > from);
  return nxt !== undefined ? nxt : sorted[0];
}

function buildActOrder(room, startSeat, active) {
  const sorted = [...active].sort((a, b) => a - b);
  let startIdx = sorted.indexOf(startSeat); if (startIdx === -1) startIdx = 0;
  const ordered = [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  return ordered.filter(i => { const p = room.seats[i]; return p && !p.folded && !p.autoFold && !p.voluntaryAutoFold && p.chips > 0; });
}

function checkRoundEnd(room) {
  const alive = room.seats.filter(s => s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack && !s.autoFold && !s.voluntaryAutoFold);
  if (alive.length <= 1) { endRound(room); return true; }
  return false;
}

function startNewHand(room) {
  clearActionTimer(room);

    if (room.paused)
