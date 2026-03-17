// server.js — SYFM Poker | Last edited: 2026-02-27
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
const SB    = 10, BB = 20;
const START_CHIPS = 1000;
const ACTION_TIMEOUT = 15000;

// A room with no connected players is destroyed after this much idle time.
const ROOM_EMPTY_TTL_MS = 60_000; // 1 minute

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

function logEvent(room, text) {
  broadcastAll(room, { type: 'logEvent', text });
}

function logBoth(room, text) {
  writeLog(room, text);
  logEvent(room, text);
}

// FTP upload after hand finishes
async function ftpUpload(localPath) {
  const host = process.env.FTP_HOST;
  const user = process.env.FTP_USER;
  const pass = process.env.FTP_PASS;
  const dir  = process.env.FTP_DIR || '/poker-logs';
  if (!host || !user || !pass) { svrLog('FTP: env vars not set \u2014 upload skipped'); return; }
  const client = new ftp.Client();
  client.ftp.verbose = false;
  const fname = path.basename(localPath);
  try {
    await client.access({ host, user, password: pass, secure: false });
    try { await client.ensureDir(dir); } catch {}
    await client.uploadFrom(localPath, `${dir}/${fname}`);
    svrLog(`FTP: \u2705 uploaded ${fname} \u2192 ${host}${dir}/${fname}`);
  } catch (err) {
    svrLog(`FTP: \u274C upload FAILED for ${fname} \u2014 ${err.message}`);
  } finally {
    client.close();
  }
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
    res.end(`<!DOCTYPE html><html><head><title>Logs</title>
      <style>body{font-family:monospace;background:#111;color:#aef;padding:20px}a{color:#ffd700}li{margin:4px 0}</style></head>
      <body><h2>SYFM Poker - Hand Logs (${files.length} files)</h2><ul>${links}</ul>
      <p><a href="/">Back to game</a></p></body></html>`);
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
    const room = params.get('room') || '?';
    const hand = params.get('hand') || '?';
    const ts = new Date().toISOString();
    svrLog(`KEEPALIVE | Room: ${room} | Hand: ${hand}`);
    const r = rooms.get(room);
    if (r && r.G) writeLog(r, `KEEPALIVE: client ping at hand #${hand} | rooms: ${rooms.size} | ws: ${wss.clients.size}`);
    res.writeHead(200, {'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});
    res.end('alive:'+ts);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const rooms = new Map();

// ── Room lifecycle ────────────────────────────────────────────────────────────
function destroyRoom(room) {
  svrLog(`ROOM ${room.id} DESTROY`);
  clearActionTimer(room);
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
    svrLog(`ROOM ${room.id} EMPTY \u2014 scheduling cleanup in ${ROOM_EMPTY_TTL_MS/1000}s`);
    room._emptyTimer = setTimeout(() => {
      const stillEmpty = !room.seats.some(s => s && !s.disconnected && s.ws?.readyState === 1)
        && !room.pendingJoins.some(p => p.ws?.readyState === 1);
      if (stillEmpty) {
        svrLog(`ROOM ${room.id} CLEANUP \u2014 TTL expired, destroying`);
        destroyRoom(room);
      } else {
        svrLog(`ROOM ${room.id} CLEANUP \u2014 cancelled, player reconnected`);
      }
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
      gameHistory: []   // cumulative record of every player ever seated
    });
  }
  const room = rooms.get(roomId);
  if (room._emptyTimer) { clearTimeout(room._emptyTimer); room._emptyTimer = null; }
  return room;
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
    seats: room.seats.map(s => s ? { id: s.id, name: s.name, chips: s.chips, seat: s.seat } : null),
    pending: room.pendingJoins.map(p => ({ id: p.id, name: p.name }))
  };
}

function tableSnapshot(room, forId) {
  const G = room.G;
  if (!G) return {
    type: 'state', phase: 'idle',
    players: room.seats.map(s => {
      if (!s) return null;
      return { seat: s.seat, name: s.name, chips: s.chips, bet: 0,
               folded: false, disconnected: s.disconnected || false,
               pendingCashOut: s.pendingCashOut || false,
               voluntaryAutoFold: s.voluntaryAutoFold || false,
               spectator: s.spectator || false,
               pendingBuyBack: s.pendingBuyBack || false,
               cards: [], active: !s.sittingOut };
    })
  };
  return {
    type: 'state', phase: G.phase, pot: G.pot, currentBet: G.currentBet,
    community: G.community, dealerSeat: room.dealerSeat,
    sbSeat: G.sbSeat, bbSeat: G.bbSeat, toActSeat: G.toAct[0] ?? null,
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
  writeLog(room, `ACTION TIMER: started \u2014 seat ${seat+1} (${room.seats[seat]?.name}) has ${(duration/1000).toFixed(1)}s`);
  room.actionTimer = setTimeout(() => {
    const p = room.seats[seat];
    if (!p || p.folded || !room.G || room.G.toAct[0] !== seat) return;
    writeLog(room, `ACTION TIMER: EXPIRED \u2014 seat ${seat+1} (${p.name}) auto-folding`);
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

// ─── Pause / Resume ───────────────────────────────────────────────────────────
function pauseGame(room, byName) {
  if (room.paused) return;
  room.paused = true;
  room._pausedAt = Date.now();
  clearActionTimer(room);
  broadcastAll(room, { type: 'gamePaused', byName });
  writeLog(room, `GAME PAUSED by ${byName}`);
  svrLog(`ROOM ${room.id} PAUSED by ${byName}`);
}

function resumeGame(room, byName) {
  if (!room.paused) return;
  const pausedForMs = room._pausedAt ? Date.now() - room._pausedAt : 0;
  room.paused = false;
  room._pausedAt = null;
  broadcastAll(room, { type: 'gameResumed', byName });
  writeLog(room, `GAME RESUMED by ${byName} | Was paused for ${(pausedForMs/1000).toFixed(1)}s`);
  svrLog(`ROOM ${room.id} RESUMED by ${byName}`);
  if (room.G && room.actionTimerSeat >= 0 && room.G.toAct[0] === room.actionTimerSeat) {
    startActionTimer(room, room.actionTimerSeat, room.actionTimerRemaining || ACTION_TIMEOUT);
  }
}

// ─── Connections ──────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  let myId = null, myRoomId = null;
  const connectedAt = Date.now();
  const remoteIp = ws._socket?.remoteAddress || 'unknown';
  svrLog(`WS OPEN \u2014 ${remoteIp} (total: ${wss.clients.size})`);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        const rawRoom = String(msg.room || '1').replace(/\D/g, '') || '1';
        myRoomId = rawRoom.slice(0, 6);
        myId = msg.id || ('p_' + Math.random().toString(36).slice(2, 8));
        const name = (msg.name || 'Player').slice(0, 18).trim() || 'Player';
        const room = getOrCreateRoom(myRoomId);
        svrLog(`JOIN \u2014 room ${myRoomId} | id=${myId} | name="${name}"`);

        // ── Reconnect ─────────────────────────────────────────────────────────
        const existing = room.seats.find(s => s?.id === myId);
        if (existing) {
          const wasDisconnectedMs = existing.disconnected ? Date.now() - (existing._disconnectedAt||0) : 0;
          if (existing._disconnectTimer) { clearTimeout(existing._disconnectTimer); existing._disconnectTimer = null; }
          const needsHostApproval = existing.autoFold && (existing._missedHands || 0) >= 1;

          if (needsHostApproval) {
            svrLog(`RECONNECT \u2014 ${name} missed ${existing._missedHands} hand(s), queuing for host re-admission`);
            writeLog(room, `RECONNECT (pending): ${name} returned after missing ${existing._missedHands} hand(s)`);
            if (!room.pendingJoins.find(p => p.id === myId)) {
              room.pendingJoins.push({ ws, id: myId, name: existing.name, isRejoin: true });
            } else {
              const pj = room.pendingJoins.find(p => p.id === myId);
              if (pj) pj.ws = ws;
            }
            send(ws, { type: 'waiting', id: myId, reason: `You missed ${existing._missedHands} hand(s). Waiting for host to re-admit you.` });
            const host = room.seats.find(s => s?.id === room.hostId);
            if (host?.ws?.readyState === 1) send(host.ws, { type: 'joinRequest', id: myId, name: existing.name });
            broadcastAll(room, lobbySnapshot(room));
          } else {
            existing.ws = ws;
            existing.disconnected = false;
            existing.autoFold = false;
            existing._disconnectedAt = null;
            existing._missedHands = 0;
            send(ws, { type: 'joined', id: myId, seat: existing.seat, isHost: myId === room.hostId });
            send(ws, lobbySnapshot(room));
            if (room.G) send(ws, tableSnapshot(room, myId));
            writeLog(room, `RECONNECT: ${name} (Seat ${existing.seat+1}) back | Was gone ~${(wasDisconnectedMs/1000).toFixed(1)}s`);
            logEvent(room, `\uD83D\uDD04 ${existing.name} reconnected`);
            svrLog(`RECONNECT OK \u2014 ${name} seat ${existing.seat+1} room ${myRoomId}`);
          }
          return;
        }

        // ── Brand-new player ──────────────────────────────────────────────────
        const hasSeatedPlayers = room.seats.some(s => s !== null);
        if (!hasSeatedPlayers && room.pendingJoins.length === 0) {
          const hostBuyIn = (msg.buyIn && msg.buyIn > 0) ? Math.round(msg.buyIn) : START_CHIPS;
          room.seats[0] = mkPlayer(ws, myId, name, 0, room, hostBuyIn);
          room.hostId = myId;
          svrLog(`NEW ROOM \u2014 ${name} created room ${myRoomId} as host`);
          writeLog(room, `HOST JOINED: ${name} created room ${myRoomId} | ${buyInTag(room.seats[0])}`);
          send(ws, { type: 'joined', id: myId, seat: 0, isHost: true });
          broadcastAll(room, lobbySnapshot(room));
          return;
        }

        if (room.pendingJoins.find(p => p.id === myId)) {
          const pj = room.pendingJoins.find(p => p.id === myId);
          pj.ws = ws;
          send(ws, { type: 'waiting', id: myId });
          return;
        }

        svrLog(`JOIN PENDING \u2014 ${name} (room ${myRoomId})`);
        writeLog(room, `JOIN REQUEST: ${name} (id: ${myId})`);
        room.pendingJoins.push({ ws, id: myId, name, buyIn: (msg.buyIn && msg.buyIn > 0) ? Math.round(msg.buyIn) : null });
        send(ws, { type: 'waiting', id: myId });
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
            existSeat.ws = p.ws;
            existSeat.disconnected = false;
            existSeat.autoFold = false;
            existSeat._missedHands = 0;
            existSeat._disconnectedAt = null;
            send(p.ws, { type: 'joined', id: p.id, seat: existSeat.seat, isHost: p.id === room.hostId });
            send(p.ws, lobbySnapshot(room));
            if (room.G) send(p.ws, tableSnapshot(room, p.id));
            writeLog(room, `RE-ADMITTED: ${existSeat.name} (Seat ${existSeat.seat+1}) | ${buyInTag(existSeat)}`);
            logEvent(room, `\u2705 ${existSeat.name} re-admitted to the table`);
          } else {
            const seat = room.seats.findIndex(s => s === null);
            if (seat === -1) {
              send(p.ws, { type: 'rejected', reason: 'Table is full' });
              broadcastAll(room, lobbySnapshot(room));
              return;
            }
            room.seats[seat] = mkPlayer(p.ws, p.id, p.name, seat, room, p.buyIn || null);
            send(p.ws, { type: 'joined', id: p.id, seat, isHost: false });
            writeLog(room, `SEATED: ${p.name} assigned Seat ${seat+1} | ${buyInTag(room.seats[seat])}`);
            if (room.gameActive) {
              room.seats[seat].sittingOut = true;
              send(p.ws, { type: 'sittingOut', reason: 'Hand in progress - you will join next hand.' });
              send(p.ws, tableSnapshot(room, p.id));
            }
          }
        } else {
          send(p.ws, { type: 'rejected', reason: 'Host declined your request' });
        }
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'startGame': {
        const room = rooms.get(myRoomId);
        if (!room || myId !== room.hostId) return;
        const playable = room.seats.filter(s => s && !s.autoFold);
        if (playable.length < 2) { send(ws, { type: 'error', msg: 'Need at least 2 players' }); return; }
        svrLog(`GAME START \u2014 room ${myRoomId} | ${playable.length} players`);
        room.gameActive = true;
        broadcastAll(room, { type: 'gameStarting' });
        broadcastAll(room, lobbySnapshot(room));
        startNewHand(room);
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
        const resolve = p._onBuyBackResolved;
        p._onBuyBackResolved = null;
        if (msg.accept) {
          const buyInChips = (msg.buyIn && msg.buyIn > 0) ? Math.round(msg.buyIn) : room.buyIn;
          p.chips = buyInChips;
          p.pendingBuyBack = false;
          p.spectator = false;
          p.buyInCount = (p.buyInCount || 1) + 1;
          p.buyInTotal = (p.buyInTotal || room.buyIn) + buyInChips;
          p.sittingOut = true;
          writeLog(room, `BUY-BACK: ${p.name} bought back in \u2014 joining next hand | ${buyInTag(p)}`);
          logEvent(room, `\u2705 ${p.name} bought back in for \u00a3${(buyInChips/100).toFixed(2)}`);
          send(p.ws, { type: 'buyBackAccepted', chips: buyInChips });
        } else {
          p.pendingBuyBack = false;
          p.sittingOut = true;
          p.spectator = true;
          recordPlayerExit(room, p, 'bust');   // declined buy-back, 0 chips
          writeLog(room, `SPECTATOR: ${p.name} declined buy-back`);
          logEvent(room, `\ud83d\udc40 ${p.name} declined buy-back \u2014 now spectating`);
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
        writeLog(room, `AUTO-FOLD ${afStatus}: ${p.name} (Seat ${p.seat+1}) | ${buyInTag(p)}`);
        logEvent(room, `\uD83D\uDD01 AUTO-FOLD ${afStatus}: ${p.name}`);
        svrLog(`AUTO-FOLD ${afStatus} \u2014 ${p.name} room ${myRoomId}`);
        if (p.voluntaryAutoFold && room.G && room.G.toAct[0] === p.seat) {
          clearActionTimer(room);
          doFold(room, p.seat, 'auto-fold');
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
        const resolve = s._onBuyBackResolved;
        s._onBuyBackResolved = null;
        s.pendingBuyBack = false;
        recordPlayerExit(room, s, 'bust');
        svrLog(`EXIT GAME — ${s.name} room ${room.id}`);
        writeLog(room, `EXIT: ${s.name} chose to exit after busting | ${buyInTag(s)}`);
        logEvent(room, `🚪 ${s.name} has left the game`);
        broadcastAll(room, { type: 'playerLeft', id: s.id, name: s.name, seat: s.seat, chips: 0, reason: 'exit' });
        room.seats[s.seat] = null;
        if (room.hostId === s.id) {
          const newHost = room.seats.find(Boolean);
          if (newHost) { room.hostId = newHost.id; send(newHost.ws, { type: 'logEvent', text: '👑 You are now the host.' }); }
        }
        broadcastAll(room, lobbySnapshot(room));
        broadcastState(room);
        scheduleRoomCleanup(room);
        if (resolve) resolve();
        break;
      }
   
      case 'cashOut': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const s = room.seats.find(s => s?.id === myId);
        if (!s) return;
        const inActiveHand = room.G && !s.folded && !s.sittingOut &&
          room.G.phase !== 'idle' && s.cards && s.cards.length > 0;
        if (inActiveHand) {
          s.pendingCashOut = true;
          send(ws, { type: 'cashOutPending' });
          logEvent(room, `\uD83D\uDCB0 ${s.name} will cash out after this hand`);
          writeLog(room, `CASH OUT PENDING: ${s.name} | Phase: ${room.G.phase}`);
          if (room.G.toAct[0] === s.seat) {
            clearActionTimer(room);
            doFold(room, s.seat, 'cash out');
          } else if (!s.folded) {
            s.folded = true;
            const idx = room.G.toAct.indexOf(s.seat);
            if (idx !== -1) room.G.toAct.splice(idx, 1);
            broadcastAll(room, { type: 'playerAction', seat: s.seat, action: 'fold', amount: 0, name: s.name + ' (cashing out)' });
            broadcastState(room);
            checkRoundEnd(room);
          }
          broadcastState(room);
        } else {
          executeCashOut(room, s);
        }
        break;
      }

      case 'chat': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const s = room.seats.find(s => s?.id === myId);
        if (!s) return;
        writeLog(room, `CHAT: ${s.name}: ${(msg.text||'').slice(0,120)}`);
        broadcastAll(room, { type: 'chat', name: s.name, text: (msg.text || '').slice(0, 120) });
        break;
      }

      case 'setBuyIn': {
        const room = rooms.get(myRoomId);
        if (!room || room.hostId !== myId) return;
        const newBuyIn = Math.max(20, Math.round(Number(msg.buyIn)));
        room.buyIn = newBuyIn;
        writeLog(room, `BUY-IN CHANGED: \u00a3${(newBuyIn/100).toFixed(2)}`);
        logEvent(room, `\uD83D\uDCB0 Buy-in set to \u00a3${(newBuyIn/100).toFixed(2)} by host`);
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'setStack': {
        const room = rooms.get(myRoomId);
        if (!room || room.hostId !== myId) return;
        const target = room.seats.find(s => s?.id === msg.playerId);
        if (!target) return;
        const newChips = Math.max(0, Math.round(Number(msg.chips)));
        const oldChips = target.chips;
        target.chips = newChips;
        writeLog(room, `STACK OVERRIDE: ${target.name} \u00a3${(oldChips/100).toFixed(2)} \u2192 \u00a3${(newChips/100).toFixed(2)}`);
        logEvent(room, `\uD83D\uDD27 ${target.name}'s stack set to \u00a3${(newChips/100).toFixed(2)} by host`);
        broadcastState(room);
        broadcastAll(room, lobbySnapshot(room));
        break;
      }
    }
  });

  ws.on('close', () => {
    svrLog(`WS CLOSE \u2014 id=${myId||'(pre-join)'} room=${myRoomId||'none'}`);
    if (!myId || !myRoomId) return;
    const room = rooms.get(myRoomId);
    if (!room) return;

    const pi = room.pendingJoins.findIndex(p => p.id === myId && p.ws === ws);
    if (pi !== -1) {
      const pj = room.pendingJoins[pi];
      room.pendingJoins.splice(pi, 1);
      writeLog(room, `PENDING JOIN LEFT: ${pj.name}`);
      broadcastAll(room, lobbySnapshot(room));
      scheduleRoomCleanup(room);
      return;
    }

    const s = room.seats.find(s => s?.id === myId);
    if (!s || s.ws !== ws) return;

    s.disconnected = true;
    s.ws = null;
    s._disconnectedAt = Date.now();
    s._missedHands = s._missedHands || 0;
    logEvent(room, `\u26A0 ${s.name} disconnected`);
    writeLog(room, `DISCONNECT: ${s.name} (Seat ${s.seat+1}) | Phase: ${room.G?.phase||'idle'}`);
    svrLog(`DISCONNECT \u2014 ${s.name} seat ${s.seat+1} room ${myRoomId}`);

    s.autoFold = true;
    broadcastState(room);

    if (room.G && room.G.toAct[0] === s.seat) {
      clearActionTimer(room);
      doFold(room, s.seat, 'disconnected');
    } else if (room.G && !s.folded) {
      s.folded = true;
      const idx = room.G.toAct.indexOf(s.seat);
      if (idx !== -1) room.G.toAct.splice(idx, 1);
      broadcastAll(room, { type: 'playerAction', seat: s.seat, action: 'fold', amount: 0, name: s.name + ' (disconnected)' });
      broadcastState(room);
      checkRoundEnd(room);
    }

    scheduleRoomCleanup(room);
  });

  ws.on('error', err => {
    svrLog(`WS ERROR \u2014 id=${myId||'(pre-join)'}: ${err.message}`);
  });
});

// ─── Execute cash-out ─────────────────────────────────────────────────────────
function executeCashOut(room, s) {
  const chips = s.chips;
  const seatIdx = s.seat;
  recordPlayerExit(room, s, 'cashout');   // record before seat is nulled
  svrLog(`CASH OUT \u2014 ${s.name} room ${room.id} \u00a3${(chips/100).toFixed(2)}`);
  if (room.G) writeLog(room, `CASH OUT: ${s.name} leaves with \u00a3${(chips/100).toFixed(2)} | ${buyInTag(s)}`);
  logEvent(room, `\uD83D\uDCB0 ${s.name} cashed out with \u00a3${(chips/100).toFixed(2)}`);
  broadcastAll(room, { type: 'playerLeft', id: s.id, name: s.name, seat: seatIdx, chips: s.chips, reason: 'cashout' });
  room.seats[seatIdx] = null;
  if (room.hostId === s.id) {
    const newHost = room.seats.find(Boolean);
    if (newHost) {
      room.hostId = newHost.id;
      send(newHost.ws, { type: 'logEvent', text: '\uD83D\uDC51 You are now the host.' });
    }
  }
  broadcastAll(room, lobbySnapshot(room));
  broadcastState(room);
  scheduleRoomCleanup(room);
}

function mkPlayer(ws, id, name, seat, room, chips) {
  const startChips = chips != null ? chips : (room ? room.buyIn : START_CHIPS);
  return {
    ws, id, name, chips: startChips, seat, cards: [], bet: 0,
    folded: false, disconnected: false, autoFold: false,
    pendingCashOut: false, _disconnectTimer: null,
    buyInCount: 1, buyInTotal: startChips
  };
}

function buyInTag(s) {
  return `[Buy-ins: ${s.buyInCount} | Total in: \u00a3${(s.buyInTotal/100).toFixed(2)}]`;
}

// ─── Game history helpers ──────────────────────────────────────────────────────

// Register or refresh a seated player in the room's permanent game history.
// Called once per player at the start of every hand to keep buyInTotal current.
function ensurePlayerHistory(room, s) {
  if (!room.gameHistory) room.gameHistory = [];
  const existing = room.gameHistory.find(h => h.id === s.id);
  if (!existing) {
    room.gameHistory.push({
      id: s.id, name: s.name,
      buyInTotal: s.buyInTotal || room.buyIn,
      chips: s.chips, status: 'active',
    });
  } else {
    existing.name       = s.name;
    existing.buyInTotal = s.buyInTotal || existing.buyInTotal;
    if (existing.status !== 'cashout' && existing.status !== 'evicted') {
      existing.status = 'active';
    }
  }
}

// Record a player's final state when they exit (cashout / eviction / bust).
function recordPlayerExit(room, s, status) {
  if (!room.gameHistory) room.gameHistory = [];
  const idx = room.gameHistory.findIndex(h => h.id === s.id);
  const record = {
    id: s.id, name: s.name,
    buyInTotal: s.buyInTotal || room.buyIn,
    chips: s.chips, status,
  };
  if (idx >= 0) { room.gameHistory[idx] = record; }
  else          { room.gameHistory.push(record);   }
}

// Write a full cumulative game summary to the current hand's log file.
// Uses fs.appendFileSync directly (no timestamp prefix) so box-drawing stays clean.
function writeGameSummary(room) {
  if (!room.G || !room.G.logPath) return;

  // Start with exited players from history, then overlay live seat data
  const registry = new Map();
  (room.gameHistory || []).forEach(h => registry.set(h.id, { ...h }));
  room.seats.forEach(s => {
    if (!s) return;
    const prev = registry.get(s.id) || {};
    registry.set(s.id, {
      id: s.id, name: s.name,
      buyInTotal: s.buyInTotal || prev.buyInTotal || room.buyIn,
      chips: s.chips,
      status: s.spectator      ? 'spectating' :
              s.pendingBuyBack ? 'bust'        : 'active',
    });
  });

  if (registry.size === 0) return;

  // Sort: active first, then by net P&L descending
  const ORD = { active: 0, spectating: 1, cashout: 2, bust: 3, evicted: 4 };
  const players = [...registry.values()].sort((a, b) => {
    const od = (ORD[a.status] ?? 5) - (ORD[b.status] ?? 5);
    if (od) return od;
    return ((b.chips ?? 0) - (b.buyInTotal || 0)) -
           ((a.chips ?? 0) - (a.buyInTotal || 0));
  });

  let totalIn = 0, totalOut = 0;
  players.forEach(p => { totalIn += p.buyInTotal || 0; totalOut += p.chips ?? 0; });

  // Column widths: name=18, buyIn=10, chips=10, net=10, status=10  (+ borders = 62 interior)
  const W   = 62;
  const pad = (s, n) => { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
  const fmt = n => '\u00a3' + (n / 100).toFixed(2);
  const net = n => (n >= 0 ? '+' : '-') + '\u00a3' + (Math.abs(n) / 100).toFixed(2);
  const SEP = '\u2560' + '\u2550'.repeat(W) + '\u2563\n';

  const dataRow = (name, bi, chips, n, status) =>
    '\u2551  ' + pad(name, 18) + ' ' + pad(fmt(bi), 10) + ' ' +
    pad(fmt(chips), 10) + ' ' + pad(net(n), 10) + ' ' + pad(status, 8) + '\u2551\n';

  const titleStr = '  GAME SUMMARY \u2014 After Hand #' + String(room.handNum).padStart(4, '0');
  const titleRow = '\u2551' + titleStr + ' '.repeat(W - titleStr.length) + '\u2551\n';
  const hdrStr   = '  ' + pad('Player', 18) + ' ' + pad('Bought In', 10) + ' ' +
                   pad('Has / Out', 10) + ' ' + pad('Net P&L', 10) + ' ' + pad('Status', 8);
  const hdrRow   = '\u2551' + hdrStr + '\u2551\n';

  let out = '\n\u2554' + '\u2550'.repeat(W) + '\u2557\n';
  out += titleRow + SEP + hdrRow + SEP;

  players.forEach(p => {
    const c = p.chips ?? 0;
    out += dataRow(p.name, p.buyInTotal || 0, c, c - (p.buyInTotal || 0), p.status || 'active');
  });

  const totalNet = totalOut - totalIn;
  const balTag   = Math.abs(totalNet) <= 1 ? 'BALANCED' : 'ERR ' + net(totalNet);
  out += SEP + dataRow('TOTALS', totalIn, totalOut, totalNet, balTag);
  out += '\u255a' + '\u2550'.repeat(W) + '\u255d\n';

  try { fs.appendFileSync(room.G.logPath, out); } catch {}
}

// ─── Game helpers ─────────────────────────────────────────────────────────────
function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ s, r });
  return shuffle(d);
}

function activePlaying(room) {
  return room.seats
    .map((s, i) => {
      if (!s) return null;
      if (s.sittingOut) return null;
      if (s.autoFold) return null;
      if (s.spectator) return null;
      if (s.pendingBuyBack) return null;
      if (s.chips <= 0) return null;
      return i;
    })
    .filter(i => i !== null);
}

function nextSeat(from, active) {
  const sorted = [...active].sort((a, b) => a - b);
  const nxt = sorted.find(i => i > from);
  return nxt !== undefined ? nxt : sorted[0];
}

function buildActOrder(room, startSeat, active) {
  const sorted = [...active].sort((a, b) => a - b);
  let startIdx = sorted.indexOf(startSeat);
  if (startIdx === -1) startIdx = 0;
  const ordered = [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  return ordered.filter(i => {
    const p = room.seats[i];
    return p && !p.folded && !p.autoFold && !p.voluntaryAutoFold && p.chips > 0;
  });
}

function canActCount(room) {
  if (!room.G) return 0;
  return room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    s.chips > 0
  ).length;
}

function checkRoundEnd(room) {
  const alive = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    !s.autoFold && !s.voluntaryAutoFold
  );
  if (alive.length <= 1) { endRound(room); return true; }
  return false;
}

// ─── Hand flow ────────────────────────────────────────────────────────────────
function startNewHand(room) {
  clearActionTimer(room);
  if (room.paused) { room.paused = false; broadcastAll(room, { type: 'gameResumed' }); }
  room.actionTimerSeat = -1;
  room.actionTimerRemaining = ACTION_TIMEOUT;
  room.actionTimerStarted = 0;

  // Process pending cash-outs
  room.seats.forEach((s, i) => { if (s && s.pendingCashOut) executeCashOut(room, s); });

  // Hand-based absence tracking
  const ABSENT_HAND_LIMIT = 3;
  room.seats.forEach((s, idx) => {
    if (!s) return;
    if (s._disconnectTimer) { clearTimeout(s._disconnectTimer); s._disconnectTimer = null; }

    if (s.disconnected && s.autoFold) {
      s._missedHands = (s._missedHands || 0) + 1;
      writeLog(room, `ABSENT: ${s.name} missed hand ${s._missedHands}/${ABSENT_HAND_LIMIT}`);
      logEvent(room, `\uD83D\uDCA4 ${s.name} absent \u2014 missed ${s._missedHands}/${ABSENT_HAND_LIMIT} hand${s._missedHands>1?'s':''}`);

      if (s._missedHands >= ABSENT_HAND_LIMIT) {
        svrLog(`EVICT \u2014 ${s.name} room ${room.id} seat ${s.seat+1} after ${ABSENT_HAND_LIMIT} missed hands`);
        logEvent(room, `\u274C ${s.name} removed after ${ABSENT_HAND_LIMIT} missed hands`);
        writeLog(room, `EVICTED: ${s.name} (Seat ${s.seat+1}) | ${buyInTag(s)}`);
        recordPlayerExit(room, s, 'evicted');   // record before seat is nulled
        broadcastAll(room, { type: 'playerLeft', id: s.id, name: s.name, seat: s.seat, reason: 'absent-eviction' });

        if (room.hostId === s.id) {
          const newHost = room.seats.find(h => h && h.id !== s.id && h.ws?.readyState === 1);
          if (newHost) {
            room.hostId = newHost.id;
            writeLog(room, `HOST TRANSFER: ${s.name} evicted \u2192 ${newHost.name} is new host`);
            send(newHost.ws, { type: 'logEvent', text: '\uD83D\uDC51 You are now the host.' });
          } else { room.hostId = null; }
        }
        room.seats[idx] = null;
        broadcastAll(room, lobbySnapshot(room));
        scheduleRoomCleanup(room);
      }
    } else {
      s._missedHands = 0;
      s.sittingOut = false;
    }
  });

  // Snapshot all currently seated players into game history
  room.seats.forEach(s => { if (s) ensurePlayerHistory(room, s); });

  const active = activePlaying(room);

  if (active.length < 2) {
    writeLog(room, `WAITING: not enough active players | active=${active.length}`);
    broadcastAll(room, { type: 'waitingForPlayers' });
    room.gameActive = false;
    broadcastAll(room, lobbySnapshot(room));
    return;
  }

  room.dealerSeat = room.dealerSeat < 0 ? active[0] : nextSeat(room.dealerSeat, active);
  room.handNum = (room.handNum || 0) + 1;

  const isHeadsUp = active.length === 2;
  const sbSeat = isHeadsUp ? room.dealerSeat : nextSeat(room.dealerSeat, active);
  const bbSeat = nextSeat(sbSeat, active);
  const preflopStart = nextSeat(bbSeat, active);

  const logPath = handLogPath(room.id, room.handNum);

  room.G = {
    deck: buildDeck(), phase: 'preflop', pot: 0,
    currentBet: BB, lastRaiseIncrement: BB,
    community: [], toAct: [], sbSeat, bbSeat, isHeadsUp, logPath
  };

  room.seats.forEach(s => { if (s) { s.cards = []; s.bet = 0; s.folded = false; s.totalBet = 0; } });

  const dealStartSeat = isHeadsUp ? bbSeat : sbSeat;
  const dsIdx = active.indexOf(dealStartSeat);
  const dealOrder = dsIdx >= 0 ? [...active.slice(dsIdx), ...active.slice(0, dsIdx)] : active;

  // Hand header log
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', {weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const timeStr = now.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const totalChips = active.reduce((s,i) => s + room.seats[i].chips, 0);
  const playerLines = active.map(i => {
    const s = room.seats[i];
    const tags = [];
    if (i === room.dealerSeat) tags.push('DEALER');
    if (i === sbSeat) tags.push('SB');
    if (i === bbSeat) tags.push('BB');
    if (s.voluntaryAutoFold) tags.push('AUTO-FOLD');
    const tagStr = tags.length ? ' ['+tags.join('+')+']' : '';
    return `  Seat ${String(i+1).padStart(2)} | ${s.name.padEnd(18)} | Stack: \u00a3${(s.chips/100).toFixed(2).padStart(7)}${tagStr}\n             ${buyInTag(s)}`;
  }).join('\n');

  fs.writeFileSync(logPath,
    '\u2554' + '\u2550'.repeat(62) + '\u2557\n' +
    '\u2551  SYFM POKER \u2014 HAND LOG' + ' '.repeat(39) + '\u2551\n' +
    '\u2560' + '\u2550'.repeat(62) + '\u2563\n' +
    `\u2551  Room: ${room.id.padEnd(10)} Hand: #${String(room.handNum).padEnd(6)} Date: ${dateStr.slice(0,20).padEnd(20)}\u2551\n` +
    `\u2551  Time: ${timeStr.padEnd(54)}\u2551\n` +
    '\u2560' + '\u2550'.repeat(62) + '\u2563\n' +
    '\u2551  PLAYERS AT THE TABLE' + ' '.repeat(40) + '\u2551\n' +
    '\u2560' + '\u2550'.repeat(62) + '\u2563\n' +
    playerLines.split('\n').map(l => '\u2551' + l.padEnd(63) + '\u2551').join('\n') + '\n' +
    '\u2560' + '\u2550'.repeat(62) + '\u2563\n' +
    `\u2551  Format: ${isHeadsUp ? 'HEADS-UP' : active.length+'-handed'} | Blinds: SB \u00a3${(SB/100).toFixed(2)} / BB \u00a3${(BB/100).toFixed(2)} | Total chips: \u00a3${(totalChips/100).toFixed(2)}`.padEnd(63) + '\u2551\n' +
    '\u255a' + '\u2550'.repeat(62) + '\u255d\n\n'
  );

  // Post blinds
  room.seats[sbSeat].chips -= SB; room.seats[sbSeat].bet = SB; room.seats[sbSeat].totalBet = SB;
  room.seats[bbSeat].chips -= BB; room.seats[bbSeat].bet = BB; room.seats[bbSeat].totalBet = BB;
  room.G.pot = SB + BB;
  room._chipsInPlayAtHandStart = room.seats.filter(Boolean).reduce((sum, s) => sum + s.chips, 0) + room.G.pot;

  writeLog(room, `BLINDS | ${room.seats[sbSeat].name.padEnd(18)} posts SB £${(SB/100).toFixed(2)} | Stack: £${(room.seats[sbSeat].chips/100).toFixed(2)}`);
  writeLog(room, `BLINDS | ${room.seats[bbSeat].name.padEnd(18)} posts BB £${(BB/100).toFixed(2)} | Stack: £${(room.seats[bbSeat].chips/100).toFixed(2)}`);
  writeLog(room, `BLINDS | Pot after blinds: £${(room.G.pot/100).toFixed(2)} | Total chips in play: £${(room._chipsInPlayAtHandStart/100).toFixed(2)}`);

  // Deal cards to all active players (including voluntaryAutoFold — they pay blinds too)
  for (let rd = 0; rd < 2; rd++)
    for (const si of dealOrder)
      room.seats[si].cards.push(room.G.deck.shift());

  writeLog(room, '\u250c\u2500 HOLE CARDS DEALT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
  dealOrder.forEach(i => {
    const s = room.seats[i];
    const tags = [];
    if (i === room.dealerSeat) tags.push('D');
    if (i === sbSeat) tags.push('SB');
    if (i === bbSeat) tags.push('BB');
    if (s.voluntaryAutoFold) tags.push('VAF');
    const tagStr = tags.length ? ' ['+tags.join('+')+']' : '';
    writeLog(room, `\u2502 ${('Seat '+(i+1)+' '+s.name).padEnd(22)}${tagStr.padEnd(8)}: ${s.cards.map(c=>c.r+c.s).join('  ')} \u2502`);
  });
  writeLog(room, '\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');

  room.G.toAct = buildActOrder(room, preflopStart, active);

  // ── CRITICAL: Fold voluntaryAutoFold players immediately after deal ──────────
  // They paid their blinds, they got their cards, but they never look at them.
  // Setting folded=true here ensures they CANNOT WIN at showdown under any path.
  // buildActOrder already excludes them from toAct so they are never prompted.
  active.forEach(i => {
    const s = room.seats[i];
    if (s && s.voluntaryAutoFold && !s.folded) {
      s.folded = true;
      broadcastAll(room, {
        type: 'playerAction', seat: i, action: 'fold',
        amount: 0, name: s.name + ' (auto-fold)'
      });
      writeLog(room, `FOLD   | ${s.name.padEnd(18)} | voluntary auto-fold \u2014 blinds paid, hand folded immediately`);
    }
  });

  broadcastAll(room, {
    type: 'newHand', dealerSeat: room.dealerSeat, sbSeat, bbSeat,
    pot: room.G.pot, activeSeats: dealOrder, bb: BB
  });

  room.seats.forEach(s => {
    if (s?.ws?.readyState === 1) send(s.ws, tableSnapshot(room, s.id));
  });

  writeLog(room, '\u250c\u2500 PREFLOP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  writeLog(room, `\u2502  Act order: ${room.G.toAct.map(i=>room.seats[i].name).join(' \u2192 ')}`);
  writeLog(room, '\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  promptToAct(room);
}

function promptToAct(room) {
  const G = room.G;
  if (!G) return;

  while (G.toAct.length) {
    const si = G.toAct[0];
    const p = room.seats[si];
    if (!p || p.folded || p.autoFold || p.voluntaryAutoFold || p.chips === 0) {
      G.toAct.shift();
    } else { break; }
  }

  const activeInHand = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    !s.autoFold && !s.voluntaryAutoFold
  );

  if (activeInHand.length <= 1) {
    room.seats.filter(s =>
      s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
      (s.autoFold || s.voluntaryAutoFold)
    ).forEach(af => {
      if (!af.folded) {
        af.folded = true;
        const label = af.voluntaryAutoFold ? 'auto-fold' : 'auto (disconnected)';
        broadcastAll(room, { type: 'playerAction', seat: af.seat, action: 'fold', amount: 0, name: af.name + ` (${label})` });
        const idx = G.toAct.indexOf(af.seat);
        if (idx !== -1) G.toAct.splice(idx, 1);
      }
    });
    broadcastState(room);
    endRound(room);
    return;
  }

  const unfolded = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    !s.autoFold && !s.voluntaryAutoFold
  );
  const canAct = unfolded.filter(s => s.chips > 0);

  if (canAct.length === 0 || G.toAct.length === 0) { advPhase(room); return; }

  if (canAct.length === 1 && G.toAct.length > 0) {
    const soloSeat = G.toAct[0];
    const solo = room.seats[soloSeat];
    if (solo) {
      const callAmt = Math.min(G.currentBet - solo.bet, solo.chips);
      if (callAmt === 0) {
        const othersAllIn = unfolded.filter(s => s.seat !== soloSeat && s.chips === 0);
        if (othersAllIn.length === unfolded.length - 1) { advPhase(room); return; }
      }
    }
  }

  const seat = G.toAct[0];
  const p = room.seats[seat];
  if (!p) { G.toAct.shift(); setTimeout(() => promptToAct(room), 100); return; }

  if (p.disconnected || p.autoFold || p.voluntaryAutoFold) {
    clearActionTimer(room);
    doFold(room, seat, p.voluntaryAutoFold ? 'auto-fold' : 'auto (disconnected)');
    return;
  }

  const callAmt  = Math.min(G.currentBet - p.bet, p.chips);
  const minRaise = Math.min(callAmt + G.lastRaiseIncrement, p.chips);
  const firstBet = G.currentBet === 0;

  writeLog(room, `PROMPT: ${p.name.padEnd(18)} (Seat ${seat+1}) | ${callAmt===0?'CHECK':'CALL \u00a3'+(callAmt/100).toFixed(2)} | Pot: \u00a3${(G.pot/100).toFixed(2)}`);

  broadcastAll(room, { type: 'yourTurn', seat, callAmt, minRaise, pot: G.pot, currentBet: G.currentBet, firstBet });
  startActionTimer(room, seat);
}

function doFold(room, seat, reason) {
  const p = room.seats[seat];
  if (!p) return;
  p.folded = true;
  const label = reason ? ` (${reason})` : '';
  const playersLeft = room.seats.filter(s => s && !s.folded && !s.autoFold && !s.voluntaryAutoFold).length;
  broadcastAll(room, { type: 'playerAction', seat, action: 'fold', amount: 0, name: p.name + label });
  writeLog(room, `FOLD   | ${p.name.padEnd(18)} | ${(reason||'voluntary').padEnd(22)} | Stack: \u00a3${(p.chips/100).toFixed(2)} | Players left: ${playersLeft}`);
  if (room.G) {
    const idx = room.G.toAct.indexOf(seat);
    if (idx !== -1) room.G.toAct.splice(idx, 1);
  }
  broadcastState(room);
  if (!checkRoundEnd(room)) setTimeout(() => promptToAct(room), 200);
}

function handleAction(room, seat, action, amount) {
  const p = room.seats[seat];
  const G = room.G;
  if (!p || !G) return;
  const stackBefore = p.chips;

  function chipCheck(label) {
    const total = room.seats.filter(Boolean).reduce((s, p) => s + p.chips, 0) + G.pot;
    const expected = room._chipsInPlayAtHandStart || 0;
    const diff = total - expected;
    writeLog(room, `       | Chip check [${label}]: stacks+pot=\u00a3${(total/100).toFixed(2)} expected=\u00a3${(expected/100).toFixed(2)}${diff!==0?' \u26a0 DIFF='+(diff>0?'+':'')+(diff/100).toFixed(2):'  \u2713'}`);
  }

  if (action === 'fold') {
    doFold(room, seat, null);

  } else if (action === 'check' || action === 'call') {
    const ca = Math.min(G.currentBet - p.bet, p.chips);
    p.chips -= ca; p.bet += ca; p.totalBet = (p.totalBet||0) + ca; G.pot += ca;
    const act = ca === 0 ? 'check' : 'call';
    broadcastAll(room, { type: 'playerAction', seat, action: act, amount: ca, name: p.name, pot: G.pot });
    writeLog(room, `${act.toUpperCase().padEnd(6)} | ${p.name.padEnd(18)} | \u00a3${(stackBefore/100).toFixed(2)} \u2192 \u00a3${(p.chips/100).toFixed(2)} | Called: \u00a3${(ca/100).toFixed(2)} | Pot: \u00a3${(G.pot/100).toFixed(2)}`);
    chipCheck(act);
    broadcastState(room);
    G.toAct.shift();
    setTimeout(() => promptToAct(room), 200);

  } else if (action === 'raise') {
    const callAmount     = G.currentBet - p.bet;
    const minFromStack   = Math.min(callAmount + G.lastRaiseIncrement, p.chips);
    const raiseFromStack = Math.min(Math.max(amount || minFromStack, minFromStack), p.chips);
    const prevCurrentBet = G.currentBet;
    p.chips -= raiseFromStack;
    p.bet   += raiseFromStack;
    p.totalBet = (p.totalBet||0) + raiseFromStack;
    G.pot   += raiseFromStack;
    G.currentBet = Math.max(G.currentBet, p.bet);
    if (G.currentBet > prevCurrentBet) G.lastRaiseIncrement = G.currentBet - prevCurrentBet;

    broadcastAll(room, { type: 'playerAction', seat, action: 'raise', amount: raiseFromStack, name: p.name, pot: G.pot });
    writeLog(room, `RAISE  | ${p.name.padEnd(18)} | \u00a3${(stackBefore/100).toFixed(2)} \u2192 \u00a3${(p.chips/100).toFixed(2)} | callAmt: \u00a3${(callAmount/100).toFixed(2)} | raised: \u00a3${(raiseFromStack/100).toFixed(2)} | playerBet: \u00a3${(p.bet/100).toFixed(2)} | Pot: \u00a3${(G.pot/100).toFixed(2)}`);
    chipCheck('raise');
    broadcastState(room);

    const active = activePlaying(room).sort((a, b) => a - b);
    const raiserIdx = active.indexOf(seat);
    const rotated = raiserIdx >= 0
      ? [...active.slice(raiserIdx + 1), ...active.slice(0, raiserIdx + 1)]
      : active;
    G.toAct = rotated.filter(i => {
      if (i === seat) return false;
      const op = room.seats[i];
      return op && !op.folded && !op.autoFold && !op.voluntaryAutoFold && op.chips > 0 && op.bet < G.currentBet;
    });
    writeLog(room, `RAISE  | New toAct: ${G.toAct.map(i=>room.seats[i]?.name||'?').join(' \u2192 ')}`);
    setTimeout(() => promptToAct(room), 200);
  }
}

function broadcastState(room) {
  room.seats.forEach(s => { if (s?.ws?.readyState === 1) send(s.ws, tableSnapshot(room, s.id)); });
}

function advPhase(room) {
  const G = room.G;
  clearActionTimer(room);
  room.seats.forEach(s => { if (s) s.bet = 0; });
  G.currentBet = 0;
  G.lastRaiseIncrement = BB;

  const next = { preflop: 'flop', flop: 'turn', turn: 'river' };

  if (G.phase in next) {
    const prevPhase = G.phase;
    G.phase = next[G.phase];
    const count = G.phase === 'flop' ? 3 : 1;
    const newCards = [];
    for (let i = 0; i < count; i++) { const c = G.deck.shift(); G.community.push(c); newCards.push(c); }

    writeLog(room, `PHASE: ${prevPhase.toUpperCase()} \u2192 ${G.phase.toUpperCase()} | Cards: ${newCards.map(c=>c.r+c.s).join(' ')} | Pot: \u00a3${(G.pot/100).toFixed(2)}`);
    const stackSummary = room.seats.filter(Boolean).map(s => `${s.name}=\u00a3${(s.chips/100).toFixed(2)}`).join(' | ');
    writeLog(room, `       | Stacks: ${stackSummary}`);
    broadcastAll(room, { type: 'communityDealt', phase: G.phase, cards: G.community, newCards });
    broadcastState(room);

    const active = activePlaying(room);
    const unfolded = room.seats.filter(s =>
      s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
      !s.autoFold && !s.voluntaryAutoFold
    );

    if (unfolded.length <= 1) { endRound(room); return; }

    const canAct = active.filter(i => { const p = room.seats[i]; return p && !p.folded && p.chips > 0; });

    if (canAct.length <= 1 && G.phase !== 'river') {
      setTimeout(() => advPhase(room), 1200);
      return;
    }

    if (canAct.length <= 1) {
      setTimeout(() => { G.phase = 'showdown'; showdown(room); }, 1200);
      return;
    }

    const postStart = G.isHeadsUp ? G.bbSeat : nextSeat(room.dealerSeat, active);
    G.toAct = buildActOrder(room, postStart, active);
    writeLog(room, `Act order: ${G.toAct.map(i => room.seats[i].name).join(' \u2192 ')}`);
    setTimeout(() => promptToAct(room), 600);

  } else {
    G.phase = 'showdown';
    showdown(room);
  }
}

function endRound(room) {
  clearActionTimer(room);
  const remaining = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    !s.autoFold && !s.voluntaryAutoFold
  );
  if (remaining.length === 1) {
    writeLog(room, `RESULT: ${remaining[0].name} wins uncontested`);
    finish(room, [remaining[0]], 'Last player standing');
  } else if (remaining.length === 0) {
    writeLog(room, `RESULT: No eligible winner \u2014 hand skipped`);
    setTimeout(() => startNewHand(room), 3000);
  }
}

function showdown(room) {
  clearActionTimer(room);

  // ── CRITICAL: autoFold / voluntaryAutoFold players are NEVER eligible to win ──
  // They folded at hand start (folded=true set in startNewHand). This double-guard
  // ensures they cannot win via any code path — checked by both !s.folded AND
  // !s.autoFold && !s.voluntaryAutoFold.
  const active = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    !s.autoFold && !s.voluntaryAutoFold
  );

  if (active.length === 1) {
    writeLog(room, `RESULT: ${active[0].name} wins at showdown uncontested`);
    finish(room, [active[0]], 'Last player standing');
    return;
  }
  if (active.length === 0) {
    writeLog(room, `RESULT: No players at showdown \u2014 hand skipped`);
    setTimeout(() => startNewHand(room), 3000);
    return;
  }

  broadcastAll(room, { type: 'showdown', reveals: active.map(s => ({ seat: s.seat, name: s.name, cards: s.cards })) });
  broadcastState(room);

  writeLog(room, '\u2554' + '\u2550'.repeat(62) + '\u2557');
  writeLog(room, '\u2551  SHOWDOWN' + ' '.repeat(52) + '\u2551');
  writeLog(room, '\u2560' + '\u2550'.repeat(62) + '\u2563');
  writeLog(room, `\u2551  Board: ${room.G.community.map(c=>c.r+c.s).join('  ').padEnd(53)}\u2551`);
  writeLog(room, '\u2560' + '\u2550'.repeat(62) + '\u2563');

  let bestScore = -1;
  const scored = active.map(p => {
    const allCards = [...p.cards, ...room.G.community];
    const sc = evalBest(allCards);
    const bf = bestFiveCards(allCards);
    if (sc > bestScore) bestScore = sc;
    return { p, sc, bf };
  });

  for (const { p, sc, bf } of scored) {
    writeLog(room, `\u2551  ${('Seat '+(p.seat+1)+' '+p.name).padEnd(22)} | Hole: ${p.cards.map(c=>c.r+c.s).join(' ').padEnd(10)} | Best: ${bf.map(c=>c.r+c.s).join(' ').padEnd(14)} | ${handName(sc).padEnd(16)}\u2551`);
  }

  const winners = scored.filter(({ sc }) => sc === bestScore).map(({ p }) => p);
  const winHandName = handName(bestScore);

  writeLog(room, '\u2560' + '\u2550'.repeat(62) + '\u2563');
  if (winners.length === 1) {
    writeLog(room, `\u2551  \uD83C\uDFC6 WINNER: ${winners[0].name} with ${winHandName}`.padEnd(63) + '\u2551');
  } else {
    writeLog(room, `\u2551  \uD83E\uDD1D SPLIT: ${winners.map(w=>w.name).join(' & ')} \u2014 ${winHandName}`.padEnd(63) + '\u2551');
  }
  writeLog(room, '\u255a' + '\u2550'.repeat(62) + '\u255d');

  setTimeout(() => finish(room, winners, winHandName), 1200);
}

function finish(room, winners, label) {
  if (!winners || winners.length === 0) return;
  clearActionTimer(room);

  const G = room.G;
  const totalPot = G.pot;
  G.pot = 0;

  const allSeats = room.seats.filter(Boolean);
  const contributors = allSeats
    .filter(s => (s.totalBet||0) > 0)
    .sort((a, b) => (a.totalBet||0) - (b.totalBet||0));

  // Log total bets per player for reconciliation
  writeLog(room, '\u250c\u2500 POT BREAKDOWN \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
  writeLog(room, `\u2502 Total pot: \u00a3${(totalPot/100).toFixed(2)}`);
  allSeats.forEach(s => {
    const status = s.folded ? 'folded' : 'active';
    writeLog(room, `\u2502 ${s.name.padEnd(18)} totalBet=\u00a3${((s.totalBet||0)/100).toFixed(2)} stack=\u00a3${(s.chips/100).toFixed(2)} [${status}]`);
  });
  const betSum = allSeats.reduce((sum, s) => sum + (s.totalBet||0), 0);
  writeLog(room, `\u2502 Sum of all totalBets: \u00a3${(betSum/100).toFixed(2)} ${betSum!==totalPot?'\u26a0 MISMATCH with pot! diff=\u00a3'+((betSum-totalPot)/100).toFixed(2):'\u2713 matches pot'}`);

  const potLevels = [];
  let alreadyTaken = 0;

  for (let i = 0; i < contributors.length; i++) {
    const cap = contributors[i].totalBet;
    if (cap <= alreadyTaken) continue;
    const levelPot = (cap - alreadyTaken) * (contributors.length - i);
    const eligibleIds = new Set(
      allSeats
        .filter(s => !s.folded && !s.autoFold && !s.voluntaryAutoFold && (s.totalBet||0) >= cap)
        .map(s => s.id)
    );
    const potLabel = potLevels.length === 0 ? 'main' : `side${potLevels.length}`;
    writeLog(room, `\u2502 ${potLabel} pot: cap=\u00a3${(cap/100).toFixed(2)} x${contributors.length-i} players = \u00a3${(levelPot/100).toFixed(2)} | eligible: ${allSeats.filter(s=>eligibleIds.has(s.id)).map(s=>s.name).join(', ')}`);
    potLevels.push({ amount: levelPot, eligibleIds, cap });
    alreadyTaken = cap;
  }

  const levelTotal = potLevels.reduce((sum, l) => sum + l.amount, 0);
  if (levelTotal !== totalPot && potLevels.length > 0) {
    writeLog(room, `\u2502 \u26a0 Level total \u00a3${(levelTotal/100).toFixed(2)} != pot \u00a3${(totalPot/100).toFixed(2)} | adjusting last level by \u00a3${((totalPot-levelTotal)/100).toFixed(2)}`);
    potLevels[potLevels.length - 1].amount += (totalPot - levelTotal);
  }
  writeLog(room, '\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

  let totalAwarded = 0;
  const awardLog = [];

  potLevels.forEach((level, li) => {
    if (level.amount <= 0) return;
    const eligibleWinners = winners.filter(w => level.eligibleIds.has(w.id));

    if (eligibleWinners.length === 0) {
      const eligible = allSeats.filter(s => !s.folded && !s.autoFold && !s.voluntaryAutoFold && level.eligibleIds.has(s.id));
      if (eligible.length > 0) {
        eligible[0].chips += level.amount;
        awardLog.push(`  ${eligible[0].name} wins \u00a3${(level.amount/100).toFixed(2)} (returned)`);
        totalAwarded += level.amount;
      }
      return;
    }

    if (eligibleWinners.length === 1) {
      eligibleWinners[0].chips += level.amount;
      const potLabel = potLevels.length > 1 ? (li === 0 ? 'main pot' : `side pot ${li}`) : 'pot';
      awardLog.push(`  ${eligibleWinners[0].name} wins \u00a3${(level.amount/100).toFixed(2)} \u2014 ${label} (${potLabel})`);
      totalAwarded += level.amount;
    } else {
      const perPlayer = Math.floor(level.amount / eligibleWinners.length);
      const remainder = level.amount - perPlayer * eligibleWinners.length;
      const sorted = [...eligibleWinners].sort((a, b) => a.seat - b.seat);
      sorted.forEach((w, i) => { w.chips += perPlayer + (i === 0 ? remainder : 0); totalAwarded += perPlayer + (i === 0 ? remainder : 0); });
      awardLog.push(`  \uD83E\uDD1D ${sorted.map(w=>w.name).join(' & ')} split \u00a3${(level.amount/100).toFixed(2)} \u2014 ${label}`);
    }
  });

  const returned = totalPot - totalAwarded;
  if (returned > 0) {
    const overContributor = allSeats
      .filter(s => !s.folded && !s.autoFold && !s.voluntaryAutoFold)
      .sort((a, b) => (b.totalBet||0) - (a.totalBet||0))[0];
    if (overContributor) {
      overContributor.chips += returned;
      awardLog.push(`  \u00a3${(returned/100).toFixed(2)} returned to ${overContributor.name} (unmatched all-in)`);
    }
  }

  potLevels.forEach((level, li) => {
    if (level.amount <= 0) return;
    const eligibleWinners = winners.filter(w => level.eligibleIds.has(w.id));
    if (eligibleWinners.length === 1) {
      broadcastAll(room, { type: 'winner', seat: eligibleWinners[0].seat, name: eligibleWinners[0].name, amount: level.amount, label });
    } else if (eligibleWinners.length > 1) {
      const perPlayer = Math.floor(level.amount / eligibleWinners.length);
      const remainder = level.amount - perPlayer * eligibleWinners.length;
      eligibleWinners.sort((a,b)=>a.seat-b.seat).forEach((w,i) => {
        broadcastAll(room, { type: 'winner', seat: w.seat, name: w.name, amount: perPlayer+(i===0?remainder:0), label: `Split \u2014 ${label}` });
      });
    }
  });

  awardLog.forEach(line => writeLog(room, line));
  broadcastState(room);

  // Chip conservation check
  const chipsAfter = room.seats.filter(Boolean).reduce((sum, s) => sum + s.chips, 0) + (G.pot || 0);
  const chipsBefore = room._chipsInPlayAtHandStart || 0;
  if (chipsBefore > 0 && chipsAfter !== chipsBefore) {
    const diff = chipsAfter - chipsBefore;
    writeLog(room, `\u26a0\ufe0f  CHIP CONSERVATION ERROR: ${diff>0?'+':''}${(diff/100).toFixed(2)} discrepancy!`);
    svrLog(`CHIP ERROR room ${room.id} hand ${room.handNum}: ${diff>0?'+':''}${diff} pence`);
  }

  writeLog(room, 'CHIP COUNTS AFTER HAND:');
  room.seats.filter(Boolean).sort((a,b) => b.chips - a.chips).forEach(s => {
    writeLog(room, `  Seat ${s.seat+1} ${s.name.padEnd(18)} \u00a3${(s.chips/100).toFixed(2)} | ${buyInTag(s)}`);
  });

  // Write cumulative game summary to this hand's log
  writeGameSummary(room);

  const logPath = room.G.logPath;
  if (logPath) setTimeout(() => ftpUpload(logPath), 500);

  setTimeout(() => {
    const busted = room.seats.filter(s => s && s.chips <= 0 && !s.pendingBuyBack && !s.spectator);
    if (busted.length === 0) { startNewHand(room); return; }

    let pendingCount = busted.length;
    function onBuyBackResolved() { pendingCount--; if (pendingCount <= 0) startNewHand(room); }

    busted.forEach(s => {
      s.pendingBuyBack = true;
      s.sittingOut = true;
      writeLog(room, `BUST: ${s.name} \u2014 offering buy-back | ${buyInTag(s)}`);
      logEvent(room, `\ud83d\udcb8 ${s.name} is out of chips \u2014 buy-back offer sent`);
      send(s.ws, { type: 'buyBackOffer', chips: room.buyIn });

      if (s._buyBackTimer) clearTimeout(s._buyBackTimer);
      s._buyBackTimer = setTimeout(() => {
        if (!s.pendingBuyBack) return;
        s.pendingBuyBack = false;
        s.sittingOut = true;
        s.spectator = true;
        recordPlayerExit(room, s, 'bust');   // timed out on buy-back, 0 chips
        writeLog(room, `SPECTATOR (timeout): ${s.name} did not respond`);
        logEvent(room, `\ud83d\udc40 ${s.name} timed out on buy-back \u2014 now spectating`);
        send(s.ws, { type: 'spectating' });
        broadcastState(room);
        onBuyBackResolved();
      }, 15000);

      s._onBuyBackResolved = onBuyBackResolved;
    });
  }, 4000);
}

// ─── Hand evaluator ───────────────────────────────────────────────────────────
function rv(r) { return RVAL[r] || parseInt(r) || 0; }

function evalBest(cards) {
  const cs = combs(cards, Math.min(cards.length, 5));
  let best = -1;
  for (const c of cs) { const s = score5(c); if (s > best) best = s; }
  return best;
}

function bestFiveCards(cards) {
  const cs = combs(cards, Math.min(cards.length, 5));
  let best = -1, bestCombo = cards.slice(0, 5);
  for (const c of cs) { const s = score5(c); if (s > best) { best = s; bestCombo = c; } }
  return bestCombo;
}

function combs(arr, k) {
  if (arr.length <= k) return [arr];
  if (k === 1) return arr.map(x => [x]);
  const out = [];
  for (let i = 0; i <= arr.length - k; i++)
    for (const c of combs(arr.slice(i + 1), k - 1)) out.push([arr[i], ...c]);
  return out;
}

function score5(cards) {
  const sorted = [...cards].sort((a, b) => rv(b.r) - rv(a.r));
  const ranks  = sorted.map(c => rv(c.r));
  const suits  = sorted.map(c => c.s);
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const groups = Object.entries(cnt).map(([r, n]) => ({ r: Number(r), n })).sort((a, b) => b.n - a.n || b.r - a.r);
  const tbRanks = groups.flatMap(g => Array(g.n).fill(g.r));
  const flush = suits.every(s => s === suits[0]);
  const uniq  = [...new Set(ranks)].sort((a, b) => b - a);
  let isStraight = false, sHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) { isStraight = true; sHigh = uniq[0]; }
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) { isStraight = true; sHigh = 5; }
  }
  const pack = rArr => rArr.reduce((acc, r, i) => acc + r * Math.pow(15, 4 - i), 0);
  const freq = groups[0].n, freq2 = groups[1]?.n || 0;
  if (flush && isStraight && sHigh === 14) return 9e8 + pack(ranks);
  if (flush && isStraight)                  return 8e8 + sHigh * 1e6;
  if (freq === 4)                           return 7e8 + pack(tbRanks);
  if (freq === 3 && freq2 === 2)            return 6e8 + pack(tbRanks);
  if (flush)                                return 5e8 + pack(ranks);
  if (isStraight)                           return 4e8 + sHigh * 1e6;
  if (freq === 3)                           return 3e8 + pack(tbRanks);
  if (freq === 2 && freq2 === 2)            return 2e8 + pack(tbRanks);
  if (freq === 2)                           return 1e8 + pack(tbRanks);
  return pack(ranks);
}

function handName(s) {
  if (s >= 9e8) return 'Royal Flush';
  if (s >= 8e8) return 'Straight Flush';
  if (s >= 7e8) return 'Four of a Kind';
  if (s >= 6e8) return 'Full House';
  if (s >= 5e8) return 'Flush';
  if (s >= 4e8) return 'Straight';
  if (s >= 3e8) return 'Three of a Kind';
  if (s >= 2e8) return 'Two Pair';
  if (s >= 1e8) return 'One Pair';
  return 'High Card';
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const startMsg = `SYFM Poker server started | port=${PORT} | pid=${process.pid} | node=${process.version}`;
  console.log(`\n\u2663 ${startMsg}`);
  svrLog(startMsg);
  svrLog(`HTTP: http://localhost:${PORT}`);
  svrLog(`Logs: http://localhost:${PORT}/logs`);
  svrLog(`FTP:  ${process.env.FTP_HOST || '(not configured)'}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  svrLog(`SHUTDOWN: ${signal} | rooms=${rooms.size} | ws=${wss.clients.size}`);
  rooms.forEach(room => { writeLog(room, `SERVER SHUTDOWN: ${signal}`); });
  const shutdownMsg = JSON.stringify({ type: 'serverShutdown', reason: 'Server is restarting. Please refresh to reconnect.' });
  wss.clients.forEach(client => { try { if (client.readyState === 1) client.send(shutdownMsg); } catch {} });
  rooms.forEach(room => destroyRoom(room));
  wss.close(() => { server.close(() => { svrLog('SHUTDOWN: clean exit'); process.exit(0); }); });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
