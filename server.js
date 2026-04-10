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

  // ── Bot-only hand limit: auto-pause if no humans are active ────────────
  const BOT_ONLY_HAND_LIMIT = 5;
  const humanActive = room.seats.some(s =>
    s && !s.isBot && !s.disconnected && !s.spectator && !s.pendingBuyBack
  );
  if (humanActive) {
    room.botOnlyHandCount = 0;  // reset whenever a human is present
  } else {
    room.botOnlyHandCount = (room.botOnlyHandCount || 0) + 1;
    if (room.botOnlyHandCount >= BOT_ONLY_HAND_LIMIT) {
      room.botOnlyHandCount = 0;
      svrLog(`ROOM ${room.id} auto-paused: ${BOT_ONLY_HAND_LIMIT} bot-only hands played with no humans connected`);
      pauseGame(room, 'Server (no humans connected)');
      broadcastAll(room, {
        type: 'logEvent',
        text: `⏸ Game auto-paused after ${BOT_ONLY_HAND_LIMIT} bot-only hands — waiting for a player to resume`
      });
      return;  // don't deal another hand
    }
  }
  // ───────────────────────────────────────────────────────────────────

  if (room.paused) { room.paused = false; broadcastAll(room, { type: 'gameResumed' }); }
  room.actionTimerSeat = -1; room.actionTimerRemaining = ACTION_TIMEOUT; room.actionTimerStarted = 0;

  if (room.gameType === 'cash') {
    room.seats.forEach((s, i) => { if (s && s.pendingCashOut) executeCashOut(room, s); });
  }

  const ABSENT_HAND_LIMIT = 3;
  room.seats.forEach((s, idx) => {
    if (!s) return;
    if (s._disconnectTimer) { clearTimeout(s._disconnectTimer); s._disconnectTimer = null; }
    if (s.isBot) { s.sittingOut = false; return; }  // bots never go absent
    if (s.disconnected && s.autoFold) {
      s._missedHands = (s._missedHands || 0) + 1;
      logEvent(room, `\uD83D\uDCA4 ${s.name} absent - missed ${s._missedHands}/${ABSENT_HAND_LIMIT} hand${s._missedHands>1?'s':''}`);
      if (s._missedHands >= ABSENT_HAND_LIMIT) {
        svrLog(`EVICT - ${s.name} room ${room.id} | IP: ${s.ip || 'unknown'}`);
        writeRoomLog(room, `PLAYER EVICTED (${ABSENT_HAND_LIMIT} missed hands): ${s.name} | Seat ${s.seat+1} | IP: ${s.ip || 'unknown'} | Chips: ${fmtPounds(s.chips)}`);
        logEvent(room, `\u274C ${s.name} removed after ${ABSENT_HAND_LIMIT} missed hands`);
        recordPlayerExit(room, s, 'evicted');
        broadcastAll(room, { type: 'playerLeft', id: s.id, name: s.name, seat: s.seat, reason: 'absent-eviction' });
        if (room.hostId === s.id) {
          const newHost = room.seats.find(h => h && h.id !== s.id && h.ws?.readyState === 1);
          if (newHost) { room.hostId = newHost.id; send(newHost.ws, { type: 'logEvent', text: '\uD83D\uDC51 You are now the host.' }); }
          else { room.hostId = null; }
        }
        room.seats[idx] = null; broadcastAll(room, lobbySnapshot(room)); scheduleRoomCleanup(room);
      }
    } else { s._missedHands = 0; s.sittingOut = false; }
  });

  room.seats.forEach(s => { if (s) ensurePlayerHistory(room, s); });

  const active = activePlaying(room);
  if (active.length < 2) {
    broadcastAll(room, { type: 'waitingForPlayers' });
    room.gameActive = false; stopBlindTimer(room); broadcastAll(room, lobbySnapshot(room)); return;
  }

  const blinds = currentBlinds(room);
  const curSB = blinds.sb, curBB = blinds.bb;

  room.dealerSeat = room.dealerSeat < 0 ? active[0] : nextSeat(room.dealerSeat, active);
  room.handNum = (room.handNum || 0) + 1;

  const isHeadsUp = active.length === 2;
  const sbSeat = isHeadsUp ? room.dealerSeat : nextSeat(room.dealerSeat, active);
  const bbSeat = nextSeat(sbSeat, active);
  const preflopStart = nextSeat(bbSeat, active);
  const logPath = handLogPath(room.id, room.handNum);

  room.G = {
    deck: buildDeck(), phase: 'preflop', pot: 0, currentBet: curBB, lastRaiseIncrement: curBB,
    community: [], toAct: [], sbSeat, bbSeat, isHeadsUp, logPath, curSB, curBB,
    firstRaiseAction: true
  };
  room.seats.forEach(s => { if (s) { s.cards = []; s.bet = 0; s.folded = false; s.totalBet = 0; } });

  const dealStartSeat = isHeadsUp ? bbSeat : sbSeat;
  const dsIdx = active.indexOf(dealStartSeat);
  const dealOrder = dsIdx >= 0 ? [...active.slice(dsIdx), ...active.slice(0, dsIdx)] : active;

  const now = new Date();
  const blindTag = room.gameType === 'tournament'
    ? `Level ${room.blindLevel + 1} | SB/BB \u00a3${(curSB/100).toFixed(2)}/\u00a3${(curBB/100).toFixed(2)}`
    : `SB \u00a3${(curSB/100).toFixed(2)} / BB \u00a3${(curBB/100).toFixed(2)}`;

  const playerLines = active.map(i => {
    const s = room.seats[i];
    const tags = [];
    if (i === room.dealerSeat) tags.push('DEALER');
    if (i === sbSeat) tags.push('SB');
    if (i === bbSeat) tags.push('BB');
    if (s.voluntaryAutoFold) tags.push('AUTO-FOLD');
    return `  Seat ${String(i+1).padStart(2)} | ${s.name.padEnd(18)} | ${fmtPounds(s.chips).padStart(8)}${tags.length?' ['+tags.join('+')+']':''} | IP: ${s.ip || 'unknown'}`;
  }).join('\n');

  // ── Post blinds ────────────────────────────────────────────────────────────
  room.seats[sbSeat].chips -= curSB; room.seats[sbSeat].bet = curSB; room.seats[sbSeat].totalBet = curSB;
  room.seats[bbSeat].chips -= curBB; room.seats[bbSeat].bet = curBB; room.seats[bbSeat].totalBet = curBB;
  room.G.pot = curSB + curBB;
  room._chipsInPlayAtHandStart = room.seats.filter(Boolean).reduce((sum, s) => sum + s.chips, 0) + room.G.pot;

  const preDealBuffer = [];
  preDealBuffer.push(`BLINDS POSTED`);
  preDealBuffer.push(`  SB: ${room.seats[sbSeat].name} (Seat ${sbSeat+1}) posts ${fmtPounds(curSB)} | Stack after: ${fmtPounds(room.seats[sbSeat].chips)}`);
  preDealBuffer.push(`  BB: ${room.seats[bbSeat].name} (Seat ${bbSeat+1}) posts ${fmtPounds(curBB)} | Stack after: ${fmtPounds(room.seats[bbSeat].chips)}`);
  preDealBuffer.push(`  Pot: ${fmtPounds(room.G.pot)}`);
  preDealBuffer.push('');

  // ── Deal hole cards ────────────────────────────────────────────────────────
  for (let rd = 0; rd < 2; rd++) for (const si of dealOrder) room.seats[si].cards.push(room.G.deck.shift());

  // ── Build hole card lines ──────────────────────────────────────────────────
  const holeCardLines = [];
  holeCardLines.push('─'.repeat(70));
  holeCardLines.push('HOLE CARDS DEALT:');
  active.forEach(i => {
    const s = room.seats[i];
    if (s && s.cards && s.cards.length > 0) {
      const tags = [];
      if (i === room.dealerSeat) tags.push('BTN');
      if (i === sbSeat) tags.push('SB');
      if (i === bbSeat) tags.push('BB');
      const tagStr = tags.length ? ` [${tags.join('/')}]` : '';
      holeCardLines.push(`  Seat ${String(i+1).padStart(2)} | ${s.name.padEnd(18)} | ${fmtCards(s.cards)}${tagStr} | Stack: ${fmtPounds(s.chips)}`);
    }
  });
  holeCardLines.push('');

  // ── Create the log file ────────────────────────────────────────────────────
  const ts = new Date().toTimeString().slice(0, 8);
  const headerBlock =
    '\u2554' + '\u2550'.repeat(70) + '\u2557\n\u2551  SYFM POKER - HAND LOG' + ' '.repeat(47) + '\u2551\n\u2560' + '\u2550'.repeat(70) + '\u2563\n' +
    `\u2551  Room: ${room.id.padEnd(10)} Hand: #${String(room.handNum).padEnd(6)} ${now.toLocaleDateString('en-GB').padEnd(14)}\u2551\n` +
    `\u2551  Time: ${now.toLocaleTimeString('en-GB').padEnd(62)}\u2551\n\u2560` + '\u2550'.repeat(70) + '\u2563\n\u2551  PLAYERS\u2551\n\u2560' + '\u2550'.repeat(70) + '\u2563\n' +
    playerLines.split('\n').map(l => '\u2551' + l.padEnd(71) + '\u2551').join('\n') + '\n\u2560' + '\u2550'.repeat(70) + '\u2563\n' +
    `\u2551  ${isHeadsUp ? 'HEADS-UP' : active.length+'-handed'} | ${blindTag}`.padEnd(71) + '\u2551\n' +
    `\u2551  Dealer: Seat ${String(room.dealerSeat+1).padStart(2)} (${(room.seats[room.dealerSeat]?.name || '?').padEnd(18)})`.padEnd(71) + '\u2551\n' +
    `\u2551  SB:     Seat ${String(sbSeat+1).padStart(2)} (${(room.seats[sbSeat]?.name || '?').padEnd(18)})`.padEnd(71) + '\u2551\n' +
    `\u2551  BB:     Seat ${String(bbSeat+1).padStart(2)} (${(room.seats[bbSeat]?.name || '?').padEnd(18)})`.padEnd(71) + '\u2551\n' +
    '\u255a' + '\u2550'.repeat(70) + '\u255d\n\n';

  const initialContent = headerBlock
    + preDealBuffer.map(l => `[${ts}] ${l}\n`).join('')
    + holeCardLines.map(l => `[${ts}] ${l}\n`).join('');

  try {
    fs.writeFileSync(logPath, initialContent);
    svrLog(`LOG CREATED: ${path.basename(logPath)}`);
  } catch (err) {
    svrLog(`LOG CREATE FAILED: ${logPath} — ${err.message}`);
  }

  // ── Chip snapshot before action ────────────────────────────────────────────
  writeLog(room, 'STACKS BEFORE PREFLOP ACTION:');
  active.forEach(i => {
    const s = room.seats[i];
    writeLog(room, `  Seat ${String(i+1).padStart(2)} | ${s.name.padEnd(18)} | ${fmtPounds(s.chips).padStart(8)} | Bet in: ${fmtPounds(s.bet)}`);
  });
  writeLog(room, '');
  writeLog(room, '─'.repeat(70));
  writeLog(room, 'PREFLOP ACTION:');

  // ── Auto-fold any voluntary-auto-fold players ──────────────────────────────
  room.G.toAct = buildActOrder(room, preflopStart, active);
  active.forEach(i => {
    const s = room.seats[i];
    if (s && s.voluntaryAutoFold && !s.folded) {
      s.folded = true;
      writeLog(room, `  AUTO-FOLD: ${s.name} (Seat ${i+1})`);
      broadcastAll(room, { type: 'playerAction', seat: i, action: 'fold', amount: 0, name: s.name + ' (auto-fold)' });
    }
  });

  broadcastAll(room, {
    type: 'newHand', dealerSeat: room.dealerSeat, sbSeat, bbSeat,
    pot: room.G.pot, activeSeats: dealOrder, bb: curBB, sb: curSB,
    blindLevel: room.blindLevel, gameType: room.gameType,
  });

  room.seats.forEach(s => { if (s?.ws?.readyState === 1) send(s.ws, tableSnapshot(room, s.id)); });
  promptToAct(room);
}

function promptToAct(room) {
  const G = room.G; if (!G) return;
  while (G.toAct.length) {
    const si = G.toAct[0]; const p = room.seats[si];
    if (!p || p.folded || p.autoFold || p.voluntaryAutoFold || p.chips === 0) G.toAct.shift(); else break;
  }
  const activeInHand = room.seats.filter(s => s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack && !s.autoFold && !s.voluntaryAutoFold);
  if (activeInHand.length <= 1) {
    room.seats.filter(s => s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack && (s.autoFold || s.voluntaryAutoFold)).forEach(af => {
      if (!af.folded) { af.folded = true; const label = af.voluntaryAutoFold ? 'auto-fold' : 'auto (disconnected)'; broadcastAll(room, { type: 'playerAction', seat: af.seat, action: 'fold', amount: 0, name: af.name + ` (${label})` }); const idx = G.toAct.indexOf(af.seat); if (idx !== -1) G.toAct.splice(idx, 1); }
    });
    broadcastState(room); endRound(room); return;
  }
  const unfolded = room.seats.filter(s => s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack && !s.autoFold && !s.voluntaryAutoFold);
  const canAct = unfolded.filter(s => s.chips > 0);
  if (canAct.length === 0 || G.toAct.length === 0) { advPhase(room); return; }
  if (canAct.length === 1 && G.toAct.length > 0) {
    const solo = room.seats[G.toAct[0]];
    if (solo && Math.min(G.currentBet - solo.bet, solo.chips) === 0 && unfolded.filter(s => s.seat !== G.toAct[0] && s.chips === 0).length === unfolded.length - 1) { advPhase(room); return; }
  }
  const seat = G.toAct[0]; const p = room.seats[seat];
  if (!p) { G.toAct.shift(); setTimeout(() => promptToAct(room), 100); return; }
  if (p.disconnected || p.autoFold || p.voluntaryAutoFold) { clearActionTimer(room); doFold(room, seat, p.voluntaryAutoFold ? 'auto-fold' : 'auto (disconnected)'); return; }
  // ── Bot: server decides action internally
  if (p.isBot) { scheduleBotAction(room, seat); return; }
  const callAmt = Math.min(G.currentBet - p.bet, p.chips);
  const raiseIncrement = G.firstRaiseAction ? G.curBB : G.lastRaiseIncrement;
  const minRaise = Math.min(callAmt + raiseIncrement, p.chips);
  const firstBet = G.currentBet === 0;
  broadcastAll(room, { type: 'yourTurn', seat, callAmt, minRaise, pot: G.pot, currentBet: G.currentBet, firstBet });
  startActionTimer(room, seat);
}

function doFold(room, seat, reason) {
  const p = room.seats[seat]; if (!p) return;
  p.folded = true;
  const label = reason ? ` (${reason})` : '';
  broadcastAll(room, { type: 'playerAction', seat, action: 'fold', amount: 0, name: p.name + label });
  const G = room.G;
  const potStr = G ? ` | Pot: ${fmtPounds(G.pot)}` : '';
  const stackStr = ` | Stack: ${fmtPounds(p.chips)}`;
  writeLog(room, `  FOLD: ${p.name} (Seat ${seat+1})${label}${stackStr}${potStr}`);
  if (G) { const idx = G.toAct.indexOf(seat); if (idx !== -1) G.toAct.splice(idx, 1); }
  broadcastState(room);
  if (!checkRoundEnd(room)) setTimeout(() => promptToAct(room), 200);
}

function handleAction(room, seat, action, amount) {
  const p = room.seats[seat]; const G = room.G;
  if (!p || !G) return;
  if (action === 'fold') { doFold(room, seat, null); }
  else if (action === 'check' || action === 'call') {
    const ca = Math.min(G.currentBet - p.bet, p.chips);
    p.chips -= ca; p.bet += ca; p.totalBet = (p.totalBet||0) + ca; G.pot += ca;
    const act = ca === 0 ? 'check' : 'call';
    broadcastAll(room, { type: 'playerAction', seat, action: act, amount: ca, name: p.name, pot: G.pot });
    if (act === 'check') {
      writeLog(room, `  CHECK: ${p.name} (Seat ${seat+1}) | Stack: ${fmtPounds(p.chips)} | Pot: ${fmtPounds(G.pot)}`);
    } else {
      const allIn = p.chips === 0 ? ' [ALL-IN]' : '';
      writeLog(room, `  CALL:  ${p.name} (Seat ${seat+1}) | Amount: ${fmtPounds(ca)}${allIn} | Stack: ${fmtPounds(p.chips)} | Pot: ${fmtPounds(G.pot)}`);
    }
    broadcastState(room); G.toAct.shift(); setTimeout(() => promptToAct(room), 200);
  } else if (action === 'raise') {
    const callAmount = G.currentBet - p.bet;
    const raiseIncrement = G.firstRaiseAction ? G.curBB : G.lastRaiseIncrement;
    const minFromStack = Math.min(callAmount + raiseIncrement, p.chips);
    const raiseFromStack = Math.min(Math.max(amount || minFromStack, minFromStack), p.chips);
    const prevCurrentBet = G.currentBet;
    p.chips -= raiseFromStack; p.bet += raiseFromStack; p.totalBet = (p.totalBet||0) + raiseFromStack; G.pot += raiseFromStack;
    G.currentBet = Math.max(G.currentBet, p.bet);
    if (G.currentBet > prevCurrentBet) {
      G.lastRaiseIncrement = G.currentBet - prevCurrentBet;
      G.firstRaiseAction = false;
    }
    const allIn = p.chips === 0 ? ' [ALL-IN]' : '';
    broadcastAll(room, { type: 'playerAction', seat, action: 'raise', amount: raiseFromStack, name: p.name, pot: G.pot });
    writeLog(room, `  RAISE: ${p.name} (Seat ${seat+1}) | Amount: ${fmtPounds(raiseFromStack)} | Total bet: ${fmtPounds(p.bet)} | Stack: ${fmtPounds(p.chips)}${allIn} | Pot: ${fmtPounds(G.pot)}`);
    broadcastState(room);
    const active = activePlaying(room).sort((a, b) => a - b);
    const raiserIdx = active.indexOf(seat);
    const rotated = raiserIdx >= 0 ? [...active.slice(raiserIdx + 1), ...active.slice(0, raiserIdx + 1)] : active;
    G.toAct = rotated.filter(i => { if (i === seat) return false; const op = room.seats[i]; return op && !op.folded && !op.autoFold && !op.voluntaryAutoFold && op.chips > 0 && op.bet < G.currentBet; });
    setTimeout(() => promptToAct(room), 200);
  }
}

function broadcastState(room) { room.seats.forEach(s => { if (s?.ws?.readyState === 1) send(s.ws, tableSnapshot(room, s.id)); }); }

function advPhase(room) {
  const G = room.G; clearActionTimer(room);
  room.seats.forEach(s => { if (s) s.bet = 0; }); G.currentBet = 0; G.lastRaiseIncrement = G.curBB || BB;
  G.firstRaiseAction = true;
  const next = { preflop: 'flop', flop: 'turn', turn: 'river' };
  if (G.phase in next) {
    const prevPhase = G.phase; G.phase = next[G.phase];
    const count = G.phase === 'flop' ? 3 : 1; const newCards = [];
    for (let i = 0; i < count; i++) { const c = G.deck.shift(); G.community.push(c); newCards.push(c); }

    writeLog(room, '');
    writeLog(room, '─'.repeat(70));
    if (G.phase === 'flop') {
      writeLog(room, `FLOP: ${fmtCards(newCards)} | Pot: ${fmtPounds(G.pot)}`);
      writeLog(room, `  Board: ${fmtCards(G.community)}`);
    } else if (G.phase === 'turn') {
      writeLog(room, `TURN: ${fmtCards(newCards)} | Pot: ${fmtPounds(G.pot)}`);
      writeLog(room, `  Board: ${fmtCards(G.community)}`);
    } else if (G.phase === 'river') {
      writeLog(room, `RIVER: ${fmtCards(newCards)} | Pot: ${fmtPounds(G.pot)}`);
      writeLog(room, `  Board: ${fmtCards(G.community)}`);
    }
    writeLog(room, '');

    const stillIn = room.seats.filter(s => s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack && !s.autoFold && !s.voluntaryAutoFold);
    writeLog(room, `STACKS AT START OF ${G.phase.toUpperCase()}:`);
    stillIn.forEach(s => {
      const allIn = s.chips === 0 ? ' [ALL-IN]' : '';
      writeLog(room, `  Seat ${String(s.seat+1).padStart(2)} | ${s.name.padEnd(18)} | ${fmtPounds(s.chips).padStart(8)}${allIn}`);
    });
    writeLog(room, '');
    writeLog(room, `${G.phase.toUpperCase()} ACTION:`);

    broadcastAll(room, { type: 'communityDealt', phase: G.phase, cards: G.community, newCards });
    broadcastState(room);
    const active = activePlaying(room);
    const unfolded = room.seats.filter(s => s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack && !s.autoFold && !s.voluntaryAutoFold);
    if (unfolded.length <= 1) { endRound(room); return; }
    const canAct = active.filter(i => { const p = room.seats[i]; return p && !p.folded && p.chips > 0; });
    if (canAct.length <= 1 && G.phase !== 'river') { setTimeout(() => advPhase(room), 1200); return; }
    if (canAct.length <= 1) { setTimeout(() => { G.phase = 'showdown'; showdown(room); }, 1200); return; }
    const postStart = G.isHeadsUp ? G.bbSeat : nextSeat(room.dealerSeat, active);
    G.toAct = buildActOrder(room, postStart, active);
    setTimeout(() => promptToAct(room), 600);
  } else { G.phase = 'showdown'; showdown(room); }
}

function endRound(room) {
  clearActionTimer(room);
  const remaining = room.seats.filter(s => s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack && !s.autoFold && !s.voluntaryAutoFold);
  if (remaining.length === 1) {
    writeLog(room, '');
    writeLog(room, '─'.repeat(70));
    writeLog(room, `HAND WON UNCONTESTED: ${remaining[0].name} (Seat ${remaining[0].seat+1}) | Pot: ${fmtPounds(room.G?.pot || 0)}`);
    finish(room, [remaining[0]], 'Last player standing');
  } else if (remaining.length === 0) {
    setTimeout(() => startNewHand(room), 3000);
  }
}

function showdown(room) {
  clearActionTimer(room);
  const active = room.seats.filter(s => s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack && !s.autoFold && !s.voluntaryAutoFold);
  if (active.length === 1) { finish(room, [active[0]], 'Last player standing'); return; }
  if (active.length === 0) { setTimeout(() => startNewHand(room), 3000); return; }
  broadcastAll(room, { type: 'showdown', reveals: active.map(s => ({ seat: s.seat, name: s.name, cards: s.cards })) });
  broadcastState(room);

  let bestScore = -1;
  const scored = active.map(p => {
    const allCards = [...p.cards, ...room.G.community];
    const sc = evalBest(allCards);
    const bf = bestFiveCards(allCards);
    if (sc > bestScore) bestScore = sc;
    return { p, sc, bf };
  });

  writeLog(room, '');
  writeLog(room, '─'.repeat(70));
  writeLog(room, `SHOWDOWN | Board: ${fmtCards(room.G.community)} | Pot: ${fmtPounds(room.G.pot)}`);
  writeLog(room, '');
  scored.forEach(({ p, sc, bf }) => {
    const bestHandStr = fmtCards(bf);
    const handRank = handName(sc);
    const isWinner = sc === bestScore;
    const winMark = isWinner ? ' *** WINNER ***' : '';
    writeLog(room, `  Seat ${String(p.seat+1).padStart(2)} | ${p.name.padEnd(18)} | Hole: ${fmtCards(p.cards)} | Best 5: ${bestHandStr} | Hand: ${handRank}${winMark}`);
  });
  writeLog(room, '');

  const winners = scored.filter(({ sc }) => sc === bestScore).map(({ p }) => p);
  const winHandName = handName(bestScore);
  if (winners.length > 1) {
    writeLog(room, `SPLIT POT: ${winners.map(w => w.name).join(' & ')} | Hand: ${winHandName} | Pot: ${fmtPounds(room.G.pot)}`);
  } else {
    writeLog(room, `WINNER: ${winners[0].name} (Seat ${winners[0].seat+1}) | Hand: ${winHandName} | Pot: ${fmtPounds(room.G.pot)}`);
  }
  setTimeout(() => finish(room, winners, winHandName), 1200);
}

function finish(room, winners, label) {
  if (!winners || winners.length === 0) return;
  clearActionTimer(room);
  const G = room.G, totalPot = G.pot; G.pot = 0;
  const allSeats = room.seats.filter(Boolean);
  const contributors = allSeats.filter(s => (s.totalBet||0) > 0).sort((a, b) => (a.totalBet||0) - (b.totalBet||0));
  const potLevels = []; let alreadyTaken = 0;
  for (let i = 0; i < contributors.length; i++) {
    const cap = contributors[i].totalBet; if (cap <= alreadyTaken) continue;
    const levelPot = (cap - alreadyTaken) * (contributors.length - i);
    const eligibleIds = new Set(allSeats.filter(s => !s.folded && !s.autoFold && !s.voluntaryAutoFold && (s.totalBet||0) >= cap).map(s => s.id));
    potLevels.push({ amount: levelPot, eligibleIds, cap }); alreadyTaken = cap;
  }
  const levelTotal = potLevels.reduce((sum, l) => sum + l.amount, 0);
  if (levelTotal !== totalPot && potLevels.length > 0) potLevels[potLevels.length - 1].amount += (totalPot - levelTotal);

  if (potLevels.length > 1) {
    writeLog(room, '');
    writeLog(room, `SIDE POTS (${potLevels.length} pots):`);
    potLevels.forEach((lv, idx) => {
      const eligible = allSeats.filter(s => lv.eligibleIds.has(s.id)).map(s => s.name).join(', ');
      writeLog(room, `  Pot ${idx+1}: ${fmtPounds(lv.amount)} | Eligible: ${eligible}`);
    });
  }

  let totalAwarded = 0;
  potLevels.forEach((level, li) => {
    if (level.amount <= 0) return;
    const eligibleWinners = winners.filter(w => level.eligibleIds.has(w.id));
    if (eligibleWinners.length === 0) {
      const eligible = allSeats.filter(s => !s.folded && !s.autoFold && !s.voluntaryAutoFold && level.eligibleIds.has(s.id));
      if (eligible.length > 0) { eligible[0].chips += level.amount; totalAwarded += level.amount; }
      return;
    }
    if (eligibleWinners.length === 1) { eligibleWinners[0].chips += level.amount; totalAwarded += level.amount; }
    else {
      const perPlayer = Math.floor(level.amount / eligibleWinners.length), remainder = level.amount - perPlayer * eligibleWinners.length;
      [...eligibleWinners].sort((a, b) => a.seat - b.seat).forEach((w, i) => { w.chips += perPlayer + (i === 0 ? remainder : 0); totalAwarded += perPlayer + (i === 0 ? remainder : 0); });
    }
  });
  const returned = totalPot - totalAwarded;
  if (returned > 0) { const oc = allSeats.filter(s => !s.folded && !s.autoFold && !s.voluntaryAutoFold).sort((a, b) => (b.totalBet||0) - (a.totalBet||0))[0]; if (oc) oc.chips += returned; }

  potLevels.forEach((level, li) => {
    if (level.amount <= 0) return;
    const ew = winners.filter(w => level.eligibleIds.has(w.id));
    if (ew.length === 1) {
      writeLog(room, `  POT AWARDED: ${fmtPounds(level.amount)} -> ${ew[0].name} (Seat ${ew[0].seat+1}) | ${label}`);
      broadcastAll(room, { type: 'winner', seat: ew[0].seat, name: ew[0].name, amount: level.amount, label });
    } else if (ew.length > 1) {
      const pp = Math.floor(level.amount / ew.length), rem = level.amount - pp * ew.length;
      ew.sort((a,b)=>a.seat-b.seat).forEach((w,i) => {
        const share = pp+(i===0?rem:0);
        writeLog(room, `  POT SPLIT: ${fmtPounds(share)} -> ${w.name} (Seat ${w.seat+1}) | Split - ${label}`);
        broadcastAll(room, { type: 'winner', seat: w.seat, name: w.name, amount: share, label: `Split - ${label}` });
      });
    }
  });

  writeLog(room, '');
  writeLog(room, 'CHIP COUNTS AFTER HAND:');
  allSeats.forEach(s => {
    const invested = s.buyInTotal || 0;
    const net = s.chips - invested;
    const netStr = (net >= 0 ? '+' : '') + fmtPounds(net);
    writeLog(room, `  Seat ${String(s.seat+1).padStart(2)} | ${s.name.padEnd(18)} | ${fmtPounds(s.chips).padStart(8)} | Net overall: ${netStr}`);
  });
  writeLog(room, '');

  broadcastState(room);
  writeGameSummary(room);
  const logPath = room.G.logPath;
  if (logPath) setTimeout(() => ftpUpload(logPath), 500);

  const busted = room.seats.filter(s => s && s.chips <= 0 && !s.pendingBuyBack && !s.spectator);

  if (room.gameType === 'tournament') {
    if (busted.length > 0) {
      const remainingActive = room.seats.filter(s => s && !s.spectator && s.chips > 0).length;
      const totalPlayers = remainingActive + busted.length + (room.tournamentPlacement || []).length;
      busted.forEach(s => {
        s.spectator = true; s.sittingOut = true;
        const place = remainingActive + 1;
        if (!room.tournamentPlacement) room.tournamentPlacement = [];
        room.tournamentPlacement.push({ id: s.id, name: s.name, place });
        recordPlayerExit(room, s, 'bust');
        writeLog(room, `TOURNAMENT ELIMINATION: ${s.name} (Seat ${s.seat+1}) | Place: ${place} | IP: ${s.ip || 'unknown'}`);
        logEvent(room, `\uD83C\uDFC6 ${s.name} has been eliminated (place ${place})`);
        send(s.ws, { type: 'tournamentEliminated', place, totalPlayers, placement: room.tournamentPlacement });
      });
      broadcastAll(room, { type: 'tournamentEliminatedBroadcast', placement: room.tournamentPlacement });
      broadcastState(room);

      const stillIn = room.seats.filter(s => s && !s.spectator && s.chips > 0);
      if (stillIn.length === 1) {
        const champion = stillIn[0];
        writeLog(room, '');
        writeLog(room, '═'.repeat(70));
        writeLog(room, `TOURNAMENT WINNER: ${champion.name} (Seat ${champion.seat+1}) | IP: ${champion.ip || 'unknown'}`);
        writeLog(room, '═'.repeat(70));
        logEvent(room, `\uD83C\uDFC6 TOURNAMENT OVER - Winner: ${champion.name}`);
        room.tournamentPlacement.push({ id: champion.id, name: champion.name, place: 1 });
        broadcastAll(room, { type: 'tournamentOver', winner: champion.name, winnerSeat: champion.seat, placement: room.tournamentPlacement });
        stopBlindTimer(room);
        room.gameActive = false;
        return;
      }
    }
    setTimeout(() => startNewHand(room), 4000);
  } else {
    setTimeout(() => {
      if (busted.length === 0) { startNewHand(room); return; }
      let pendingCount = busted.length;
      function onBuyBackResolved() { pendingCount--; if (pendingCount <= 0) startNewHand(room); }
      busted.forEach(s => {
        // Bots instantly buy back in
        if (s.isBot) {
          s.chips = room.buyIn; s.buyInCount++; s.buyInTotal += room.buyIn;
          writeLog(room, `BOT BUY-BACK: ${s.name} (Seat ${s.seat+1}) | Rebought for ${fmtPounds(room.buyIn)}`);
          logEvent(room, `🤖 ${s.name} (bot) bought back in`);
          onBuyBackResolved();
          return;
        }
        s.pendingBuyBack = true; s.sittingOut = true;
        writeLog(room, `BUY-BACK OFFER SENT: ${s.name} (Seat ${s.seat+1}) | IP: ${s.ip || 'unknown'} | Offer: ${fmtPounds(room.buyIn)}`);
        logEvent(room, `\ud83d\udcb8 ${s.name} is out of chips - buy-back offer sent`);
        send(s.ws, { type: 'buyBackOffer', chips: room.buyIn });
        if (s._buyBackTimer) clearTimeout(s._buyBackTimer);
        s._buyBackTimer = setTimeout(() => {
          if (!s.pendingBuyBack) return;
          s.pendingBuyBack = false; s.sittingOut = true; s.spectator = true;
          recordPlayerExit(room, s, 'bust');
          writeLog(room, `BUY-BACK TIMEOUT: ${s.name} (Seat ${s.seat+1}) - declined (timed out)`);
          logEvent(room, `\ud83d\udc40 ${s.name} timed out on buy-back - now spectating`);
          send(s.ws, { type: 'spectating' }); broadcastState(room); onBuyBackResolved();
        }, 15000);
        s._onBuyBackResolved = onBuyBackResolved;
      });
    }, 4000);
  }
}

function rv(r) { return RVAL[r] || parseInt(r) || 0; }
function evalBest(cards) { const cs = combs(cards, Math.min(cards.length, 5)); let best = -1; for (const c of cs) { const s = score5(c); if (s > best) best = s; } return best; }
function bestFiveCards(cards) { const cs = combs(cards, Math.min(cards.length, 5)); let best = -1, bestCombo = cards.slice(0, 5); for (const c of cs) { const s = score5(c); if (s > best) { best = s; bestCombo = c; } } return bestCombo; }
function combs(arr, k) {
  if (arr.length <= k) return [arr]; if (k === 1) return arr.map(x => [x]);
  const out = []; for (let i = 0; i <= arr.length - k; i++) for (const c of combs(arr.slice(i + 1), k - 1)) out.push([arr[i], ...c]); return out;
}
function score5(cards) {
  const sorted = [...cards].sort((a, b) => rv(b.r) - rv(a.r)), ranks = sorted.map(c => rv(c.r)), suits = sorted.map(c => c.s);
  const cnt = {}; for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.entries(cnt).map(([r, n]) => ({ r: Number(r), n })).sort((a, b) => b.n - a.n || b.r - a.r);
  const tbRanks = groups.flatMap(g => Array(g.n).fill(g.r)), flush = suits.every(s => s === suits[0]);
  const uniq = [...new Set(ranks)].sort((a, b) => b - a); let isStraight = false, sHigh = 0;
  if (uniq.length === 5) { if (uniq[0] - uniq[4] === 4) { isStraight = true; sHigh = uniq[0]; } else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) { isStraight = true; sHigh = 5; } }
  const pack = rArr => rArr.reduce((acc, r, i) => acc + r * Math.pow(15, 4 - i), 0);
  const freq = groups[0].n, freq2 = groups[1]?.n || 0;
  if (flush && isStraight && sHigh === 14) return 9e8 + pack(ranks);
  if (flush && isStraight) return 8e8 + sHigh * 1e6;
  if (freq === 4) return 7e8 + pack(tbRanks); if (freq === 3 && freq2 === 2) return 6e8 + pack(tbRanks);
  if (flush) return 5e8 + pack(ranks); if (isStraight) return 4e8 + sHigh * 1e6;
  if (freq === 3) return 3e8 + pack(tbRanks); if (freq === 2 && freq2 === 2) return 2e8 + pack(tbRanks);
  if (freq === 2) return 1e8 + pack(tbRanks); return pack(ranks);
}
function handName(s) {
  if (s >= 9e8) return 'Royal Flush'; if (s >= 8e8) return 'Straight Flush'; if (s >= 7e8) return 'Four of a Kind';
  if (s >= 6e8) return 'Full House'; if (s >= 5e8) return 'Flush'; if (s >= 4e8) return 'Straight';
  if (s >= 3e8) return 'Three of a Kind'; if (s >= 2e8) return 'Two Pair'; if (s >= 1e8) return 'One Pair'; return 'High Card';
}

server.listen(PORT, () => {
  const startMsg = `SYFM Poker server started | port=${PORT} | pid=${process.pid}`;
  console.log(`\n\u2663 ${startMsg}`); svrLog(startMsg);
  svrLog(`HTTP: http://localhost:${PORT}`);
  svrLog(`Logs: http://localhost:${PORT}/logs`);
});

function gracefulShutdown(signal) {
  svrLog(`SHUTDOWN: ${signal}`);
  const shutdownMsg = JSON.stringify({ type: 'serverShutdown', reason: 'Server is restarting. Please refresh to reconnect.' });
  wss.clients.forEach(client => { try { if (client.readyState === 1) client.send(shutdownMsg); } catch {} });
  rooms.forEach(room => destroyRoom(room));
  wss.close(() => { server.close(() => { svrLog('SHUTDOWN: clean exit'); process.exit(0); }); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
