'use strict';
const http   = require('http');
const { WebSocketServer } = require('ws');
const fs     = require('fs');
const path   = require('path');
const ftp    = require('basic-ftp');
const crypto = require('crypto'); // built-in — no install needed

const PORT  = process.env.PORT || 10000;
const SUITS = ['\u2660','\u2665','\u2666','\u2663'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RVAL  = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
const NP    = 9;
const SB    = 10, BB = 20;
const START_CHIPS = 1000;
const ACTION_TIMEOUT = 15000;

// A room with no connected players is destroyed after this much idle time.
// This prevents stale zombie rooms persisting across Render cold-starts.
const ROOM_EMPTY_TTL_MS = 60_000; // 1 minute

// ─── Logging ─────────────────────────────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Server event log — one file for the whole process lifetime (not per hand)
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

// Write a timestamped line to the current hand's log file
function writeLog(room, line) {
  if (!room.G || !room.G.logPath) return;
  const ts = new Date().toTimeString().slice(0, 8);
  try { fs.appendFileSync(room.G.logPath, `[${ts}] ${line}\n`); } catch {}
}

// logEvent — sends a system notification to the activity/output log panel
// on every client. Unlike `type:'chat'`, this does NOT appear in the player
// chat box — it goes only to the log feed (addLog on the client side).
function logEvent(room, text) {
  broadcastAll(room, { type: 'logEvent', text });
}

// Write to both the hand log and the in-browser activity log in one call
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
  if (!host || !user || !pass) {
    svrLog('FTP: env vars not set — upload skipped');
    return;
  }
  const client = new ftp.Client();
  client.ftp.verbose = false;
  const fname = path.basename(localPath);
  svrLog(`FTP: connecting to ${host} to upload ${fname}`);
  try {
    await client.access({ host, user, password: pass, secure: false });
    try { await client.ensureDir(dir); } catch {}
    await client.uploadFrom(localPath, `${dir}/${fname}`);
    svrLog(`FTP: ✅ uploaded ${fname} → ${host}${dir}/${fname}`);
  } catch (err) {
    svrLog(`FTP: ❌ upload FAILED for ${fname} — ${err.message}`);
    console.error('FTP upload failed:', err.message);
  } finally {
    client.close();
    svrLog(`FTP: connection closed`);
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
    const links = files.map(f =>
      `<li><a href="/logs/download/${encodeURIComponent(f)}">${f}</a></li>`
    ).join('');
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
    if (r && r.G) writeLog(r, `KEEPALIVE: client ping at hand #${hand} — server alive | rooms active: ${rooms.size} | ws connections: ${wss.clients.size}`);
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
// Tears down every timer in the room and removes it from the map.
function destroyRoom(room) {
  const connectedCount = room.seats.filter(s => s?.ws?.readyState === 1).length;
  svrLog(`ROOM ${room.id} DESTROY — ${room.seats.filter(Boolean).length} seats occupied, ${connectedCount} connected, ${room.pendingJoins.length} pending, hand #${room.handNum}`);
  clearActionTimer(room);
  if (room._emptyTimer) { clearTimeout(room._emptyTimer); room._emptyTimer = null; }
  let closedSockets = 0;
  room.seats.forEach(s => {
    if (s) {
      if (s._disconnectTimer) { clearTimeout(s._disconnectTimer); s._disconnectTimer = null; }
      if (s._buyBackTimer)    { clearTimeout(s._buyBackTimer);    s._buyBackTimer    = null; }
      if (s.ws?.readyState === 1) {
        try { s.ws.close(); closedSockets++; } catch {}
      }
    }
  });
  room.pendingJoins.forEach(p => {
    try { if (p.ws?.readyState === 1) { p.ws.close(); closedSockets++; } } catch {}
  });
  svrLog(`ROOM ${room.id} DESTROY — closed ${closedSockets} open socket(s), removed from map`);
  rooms.delete(room.id);
}

// Call this any time a player disconnects or a seat is vacated.
// Starts a TTL that destroys the room if nobody reconnects in time.
function scheduleRoomCleanup(room) {
  if (room._emptyTimer) { clearTimeout(room._emptyTimer); room._emptyTimer = null; }

  const hasConnected = room.seats.some(s => s && !s.disconnected && s.ws?.readyState === 1)
    || room.pendingJoins.some(p => p.ws?.readyState === 1);

  if (!hasConnected) {
    svrLog(`ROOM ${room.id} EMPTY — no connected players, scheduling cleanup in ${ROOM_EMPTY_TTL_MS/1000}s`);
    room._emptyTimer = setTimeout(() => {
      const stillEmpty = !room.seats.some(s => s && !s.disconnected && s.ws?.readyState === 1)
        && !room.pendingJoins.some(p => p.ws?.readyState === 1);
      if (stillEmpty) {
        svrLog(`ROOM ${room.id} CLEANUP — TTL expired with no reconnects, destroying`);
        destroyRoom(room);
      } else {
        svrLog(`ROOM ${room.id} CLEANUP — cancelled, player reconnected during TTL window`);
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
      buyIn: START_CHIPS,   // per-room buy-in amount, host can change in lobby
      _emptyTimer: null   // TTL timer — set by scheduleRoomCleanup
    });
  }
  const room = rooms.get(roomId);
  // Cancel any pending destruction now that someone is joining
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
      // FIX #2: Only show hole cards to the owning player (or everyone at showdown)
      // Never reveal another player's cards, even during buy-back transitions
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
    writeLog(room, `ACTION TIMER: paused — seat ${seat+1} (${room.seats[seat]?.name}) timer held at ${((remainingMs??ACTION_TIMEOUT)/1000).toFixed(1)}s`);
    return;
  }
  const duration = remainingMs != null ? remainingMs : ACTION_TIMEOUT;
  room.actionTimerSeat = seat;
  room.actionTimerRemaining = duration;
  room.actionTimerStarted = Date.now();
  writeLog(room, `ACTION TIMER: started — seat ${seat+1} (${room.seats[seat]?.name}) has ${(duration/1000).toFixed(1)}s to act`);
  room.actionTimer = setTimeout(() => {
    const p = room.seats[seat];
    if (!p || p.folded || !room.G || room.G.toAct[0] !== seat) return;
    writeLog(room, `ACTION TIMER: EXPIRED — seat ${seat+1} (${p.name}) ran out of time, auto-folding`);
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
  writeLog(room, `GAME PAUSED by ${byName} | Hand #${room.handNum} | Phase: ${room.G?.phase||'idle'} | Pot: £${((room.G?.pot||0)/100).toFixed(2)}`);
  svrLog(`ROOM ${room.id} PAUSED by ${byName}`);
}

function resumeGame(room, byName) {
  if (!room.paused) return;
  const pausedForMs = room._pausedAt ? Date.now() - room._pausedAt : 0;
  room.paused = false;
  room._pausedAt = null;
  broadcastAll(room, { type: 'gameResumed', byName });
  writeLog(room, `GAME RESUMED by ${byName} | Was paused for ${(pausedForMs/1000).toFixed(1)}s`);
  svrLog(`ROOM ${room.id} RESUMED by ${byName} after ${(pausedForMs/1000).toFixed(1)}s`);
  if (room.G && room.actionTimerSeat >= 0 && room.G.toAct[0] === room.actionTimerSeat) {
    startActionTimer(room, room.actionTimerSeat, room.actionTimerRemaining || ACTION_TIMEOUT);
  }
}

// ─── Connections ──────────────────────────────────────────────────────────────
// ─── Connections ──────────────────────────────────────────────────────────────
// Players are auto-folded immediately on disconnect. If they miss ABSENT_HAND_LIMIT
// consecutive hands (defined in startNewHand) they are evicted. If they reconnect
// before the next hand starts they rejoin seamlessly with no host approval needed.

wss.on('connection', ws => {
  let myId = null, myRoomId = null;
  const connectedAt = Date.now();
  const remoteIp = ws._socket?.remoteAddress || 'unknown';
  svrLog(`WS OPEN — new connection from ${remoteIp} (total open: ${wss.clients.size})`);

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
        const isNewRoom = room.handNum === 0 && !room.seats.some(Boolean);
        svrLog(`JOIN — room ${myRoomId} | id=${myId} | name="${name}" | ip=${remoteIp} | roomIsNew=${isNewRoom}`);

        // ── Reconnect ─────────────────────────────────────────────────────────
        const existing = room.seats.find(s => s?.id === myId);
        if (existing) {
          const wasDisconnectedMs = existing.disconnected ? Date.now() - (existing._disconnectedAt||0) : 0;
          if (existing._disconnectTimer) {
            clearTimeout(existing._disconnectTimer);
            existing._disconnectTimer = null;
          }

          // If they missed 1+ hands they need host re-admission.
          // If they reconnect before the next hand starts (missedHands still 0),
          // let them back in immediately — no host approval needed.
          const needsHostApproval = existing.autoFold && (existing._missedHands || 0) >= 1;

          if (needsHostApproval) {
            svrLog(`RECONNECT — ${name} (room ${myRoomId}) missed ${existing._missedHands} hand(s), queuing for host re-admission`);
            writeLog(room, `RECONNECT (pending): ${name} returned after missing ${existing._missedHands} hand(s) — host must re-admit | Was disconnected ~${(wasDisconnectedMs/1000).toFixed(1)}s`);
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
            // Reconnected before missing any hands — let them straight back in
            existing.ws = ws;
            existing.disconnected = false;
            existing.autoFold = false;
            existing._disconnectedAt = null;
            existing._missedHands = 0;
            send(ws, { type: 'joined', id: myId, seat: existing.seat, isHost: myId === room.hostId });
            send(ws, lobbySnapshot(room));
            if (room.G) send(ws, tableSnapshot(room, myId));
            writeLog(room, `RECONNECT: ${name} (Seat ${existing.seat+1}) back online | Was disconnected ~${(wasDisconnectedMs/1000).toFixed(1)}s | Stack: £${(existing.chips/100).toFixed(2)}`);
            logEvent(room, `\uD83D\uDD04 ${existing.name} reconnected`);
            svrLog(`RECONNECT OK — ${name} seat ${existing.seat+1} room ${myRoomId}`);
          }
          return;
        }

        // ── Brand-new player ──────────────────────────────────────────────────
        const hasSeatedPlayers = room.seats.some(s => s !== null);
        if (!hasSeatedPlayers && room.pendingJoins.length === 0) {
          room.seats[0] = mkPlayer(ws, myId, name, 0, room);
          room.hostId = myId;
          svrLog(`NEW ROOM — ${name} created room ${myRoomId} as host, assigned seat 0`);
          writeLog(room, `HOST JOINED: ${name} created room ${myRoomId} | ${buyInTag(room.seats[0])}`);
          send(ws, { type: 'joined', id: myId, seat: 0, isHost: true });
          broadcastAll(room, lobbySnapshot(room));
          return;
        }

        if (room.pendingJoins.find(p => p.id === myId)) {
          const pj = room.pendingJoins.find(p => p.id === myId);
          pj.ws = ws;
          send(ws, { type: 'waiting', id: myId });
          svrLog(`JOIN — ${name} (room ${myRoomId}) refreshed pending socket`);
          return;
        }

        svrLog(`JOIN PENDING — ${name} (room ${myRoomId}) waiting for host approval`);
        writeLog(room, `JOIN REQUEST: ${name} (id: ${myId}) requesting entry to room ${myRoomId}`);
        room.pendingJoins.push({ ws, id: myId, name });
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
            if (existSeat._disconnectTimer) {
              clearTimeout(existSeat._disconnectTimer);
              existSeat._disconnectTimer = null;
            }
            existSeat.ws = p.ws;
            existSeat.disconnected = false;
            existSeat.autoFold = false;
            existSeat._missedHands = 0;
            existSeat._disconnectedAt = null;
            send(p.ws, { type: 'joined', id: p.id, seat: existSeat.seat, isHost: p.id === room.hostId });
            send(p.ws, lobbySnapshot(room));
            if (room.G) send(p.ws, tableSnapshot(room, p.id));
            writeLog(room, `RE-ADMITTED: ${existSeat.name} (Seat ${existSeat.seat+1}) re-admitted by host | Stack: £${(existSeat.chips/100).toFixed(2)} | ${buyInTag(existSeat)}`);
            logEvent(room, `✅ ${existSeat.name} re-admitted to the table`);
            svrLog(`APPROVE — ${existSeat.name} re-admitted to room ${myRoomId} seat ${existSeat.seat+1}`);
          } else {
            const seat = room.seats.findIndex(s => s === null);
            if (seat === -1) {
              send(p.ws, { type: 'rejected', reason: 'Table is full' });
              writeLog(room, `REJECTED: ${p.name} — table is full (${NP} seats)`);
              svrLog(`REJECT — ${p.name} room ${myRoomId}: table full`);
              broadcastAll(room, lobbySnapshot(room));
              return;
            }
            room.seats[seat] = mkPlayer(p.ws, p.id, p.name, seat, room);
            send(p.ws, { type: 'joined', id: p.id, seat, isHost: false });
            writeLog(room, `SEATED: ${p.name} assigned Seat ${seat+1} | ${buyInTag(room.seats[seat])}`);
            svrLog(`APPROVE — ${p.name} seated in room ${myRoomId} seat ${seat+1}`);
            if (room.gameActive) {
              room.seats[seat].sittingOut = true;
              writeLog(room, `SITTING OUT: ${p.name} (Seat ${seat+1}) — hand in progress, joins next hand`);
              send(p.ws, { type: 'sittingOut', reason: 'Hand in progress - you will join next hand.' });
              send(p.ws, tableSnapshot(room, p.id));
            }
          }
        } else {
          send(p.ws, { type: 'rejected', reason: 'Host declined your request' });
          writeLog(room, `REJECTED: ${p.name} — declined by host`);
          svrLog(`REJECT — ${p.name} room ${myRoomId}: declined by host`);
        }
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'startGame': {
        const room = rooms.get(myRoomId);
        if (!room || myId !== room.hostId) return;
        const playable = room.seats.filter(s => s && !s.autoFold);
        if (playable.length < 2) { send(ws, { type: 'error', msg: 'Need at least 2 players' }); return; }
        svrLog(`GAME START — room ${myRoomId} | ${playable.length} players | host: ${room.seats.find(s=>s?.id===myId)?.name}`);
        writeLog(room, `GAME STARTED by host | ${playable.length} players seated | ${playable.map(s=>`${s.name}(£${(s.chips/100).toFixed(2)})`).join(', ')}`);
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
        if (!p) return;
        pauseGame(room, p.name);
        break;
      }

      case 'resume': {
        const room = rooms.get(myRoomId);
        if (!room || !room.gameActive) return;
        const p = room.seats.find(s => s?.id === myId);
        if (!p) return;
        resumeGame(room, p.name);
        break;
      }

      // FIX #5: buyBack works for any number of players (no player-count restriction)
      case 'buyBack': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const p = room.seats.find(s => s?.id === myId);
        if (!p || !p.pendingBuyBack) return;

        if (p._buyBackTimer) { clearTimeout(p._buyBackTimer); p._buyBackTimer = null; }
        const resolve = p._onBuyBackResolved;
        p._onBuyBackResolved = null;

        if (msg.accept) {
          p.chips = room.buyIn;
          p.pendingBuyBack = false;
          p.spectator = false;
          p.buyInCount = (p.buyInCount || 1) + 1;
          p.buyInTotal = (p.buyInTotal || room.buyIn) + room.buyIn;
          // Keep sittingOut=true so they don't get action prompts mid-hand.
          // startNewHand() clears sittingOut for all players at hand start.
          p.sittingOut = true;
          writeLog(room, `BUY-BACK: ${p.name} has bought back in for \u00a3${(room.buyIn/100).toFixed(2)} \u2014 will join next hand | ${buyInTag(p)}`);
          logEvent(room, `\u2705 ${p.name} bought back in for \u00a3${(room.buyIn/100).toFixed(2)} \u2014 joining next hand | ${buyInTag(p)}`);
          send(p.ws, { type: 'buyBackAccepted', chips: room.buyIn });
        } else {
          p.pendingBuyBack = false;
          p.sittingOut = true;
          p.spectator = true;
          writeLog(room, `SPECTATOR: ${p.name} declined buy-back \u2014 watching as spectator`);
          logEvent(room, `\ud83d\udc40 ${p.name} declined buy-back \u2014 now spectating`);
          send(p.ws, { type: 'spectating' });
        }
        broadcastState(room);
        if (resolve) resolve(); // may trigger startNewHand if all buy-backs resolved
        break;
      }

      case 'voluntaryAutoFold': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const p = room.seats.find(s => s?.id === myId);
        if (!p) return;
        p.voluntaryAutoFold = msg.enabled === true;
        const afStatus = p.voluntaryAutoFold ? 'ENABLED' : 'DISABLED';
        writeLog(room, `AUTO-FOLD ${afStatus}: ${p.name} (Seat ${p.seat+1}) | Stack: £${(p.chips/100).toFixed(2)} | ${buyInTag(p)}`);
        logEvent(room, `\uD83D\uDD01 AUTO-FOLD ${afStatus}: ${p.name}`);
        svrLog(`AUTO-FOLD ${afStatus} — ${p.name} room ${myRoomId}`);
        if (p.voluntaryAutoFold && room.G && room.G.toAct[0] === p.seat) {
          writeLog(room, `AUTO-FOLD: ${p.name} is current actor — folding immediately`);
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
          writeLog(room, `CASH OUT PENDING: ${s.name} (Seat ${s.seat+1}) | Stack: £${(s.chips/100).toFixed(2)} | Phase: ${room.G.phase} | ${buyInTag(s)}`);
          svrLog(`CASH OUT PENDING — ${s.name} room ${myRoomId} mid-hand`);
          if (room.G.toAct[0] === s.seat) {
            writeLog(room, `CASH OUT: ${s.name} is current actor — folding to process cash out`);
            clearActionTimer(room);
            doFold(room, s.seat, 'cash out');
          } else if (!s.folded) {
            s.folded = true;
            const idx = room.G.toAct.indexOf(s.seat);
            if (idx !== -1) room.G.toAct.splice(idx, 1);
            broadcastAll(room, { type: 'playerAction', seat: s.seat, action: 'fold', amount: 0, name: s.name + ' (cashing out)' });
            writeLog(room, `FOLD (cash out): ${s.name} (Seat ${s.seat+1}) folded to exit hand`);
            broadcastState(room);
            checkRoundEnd(room);
          }
          broadcastState(room);
        } else {
          writeLog(room, `CASH OUT: ${s.name} (Seat ${s.seat+1}) cashing out immediately — not in active hand`);
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
        if (!room) return;
        if (room.hostId !== myId) return;
        const newBuyIn = Math.max(20, Math.round(Number(msg.buyIn))); // minimum 20p
        room.buyIn = newBuyIn;
        writeLog(room, `BUY-IN CHANGED: host set buy-in to \u00a3${(newBuyIn/100).toFixed(2)}`);
        svrLog(`BUY-IN CHANGED — room ${myRoomId} \u00a3${(newBuyIn/100).toFixed(2)}`);
        logEvent(room, `\uD83D\uDCB0 Buy-in amount set to \u00a3${(newBuyIn/100).toFixed(2)} by host`);
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'setStack': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        // Host only
        if (room.hostId !== myId) return;
        const target = room.seats.find(s => s?.id === msg.playerId);
        if (!target) return;
        const newChips = Math.max(0, Math.round(Number(msg.chips)));
        const oldChips = target.chips;
        target.chips = newChips;
        writeLog(room, `STACK OVERRIDE: ${target.name} (Seat ${target.seat+1}) £${(oldChips/100).toFixed(2)} → £${(newChips/100).toFixed(2)} | by host`);
        svrLog(`STACK OVERRIDE — ${target.name} room ${myRoomId} ${oldChips}→${newChips} pence`);
        logEvent(room, `🔧 ${target.name}'s stack set to £${(newChips/100).toFixed(2)} by host`);
        broadcastState(room);
        broadcastAll(room, lobbySnapshot(room));
        break;
      }
    }
  });

  ws.on('close', () => {
    const openDurationMs = Date.now() - connectedAt;
    svrLog(`WS CLOSE — id=${myId||'(pre-join)'} room=${myRoomId||'none'} | open ${(openDurationMs/1000).toFixed(1)}s | remaining: ${wss.clients.size}`);
    if (!myId || !myRoomId) return;
    const room = rooms.get(myRoomId);
    if (!room) return;

    const pi = room.pendingJoins.findIndex(p => p.id === myId && p.ws === ws);
    if (pi !== -1) {
      const pj = room.pendingJoins[pi];
      room.pendingJoins.splice(pi, 1);
      writeLog(room, `PENDING JOIN LEFT: ${pj.name} disconnected before being admitted`);
      svrLog(`PENDING JOIN LEFT — ${pj.name} room ${myRoomId}`);
      broadcastAll(room, lobbySnapshot(room));
      scheduleRoomCleanup(room);
      return;
    }

    const s = room.seats.find(s => s?.id === myId);
    if (!s) return;
    if (s.ws !== ws) {
      svrLog(`WS CLOSE — stale socket for ${s.name} room ${myRoomId}, ignoring`);
      return;
    }

    s.disconnected = true;
    s.ws = null;
    s._disconnectedAt = Date.now();
    s._missedHands = s._missedHands || 0; // hand-based absence counter
    logEvent(room, `\u26A0 ${s.name} disconnected \u2014 will be removed after 3 missed hands`);
    writeLog(room, `DISCONNECT: ${s.name} (Seat ${s.seat+1}) | Stack: \u00a3${(s.chips/100).toFixed(2)} | Phase: ${room.G?.phase||'idle'} | Missed hands so far: ${s._missedHands} | ${buyInTag(s)}`);
    svrLog(`DISCONNECT — ${s.name} seat ${s.seat+1} room ${myRoomId} | missedHands: ${s._missedHands}`);

    // Mark autoFold immediately so they are skipped in promptToAct going forward
    s.autoFold = true;
    broadcastState(room);

    // If they were mid-action right now, fold them out of this hand immediately
    if (room.G && room.G.toAct[0] === s.seat) {
      writeLog(room, `DISCONNECT: ${s.name} was current actor \u2014 folding immediately`);
      clearActionTimer(room);
      doFold(room, s.seat, 'disconnected');
    } else if (room.G && !s.folded) {
      // Not their turn yet but still in the hand — fold them out silently
      s.folded = true;
      const idx = room.G.toAct.indexOf(s.seat);
      if (idx !== -1) room.G.toAct.splice(idx, 1);
      broadcastAll(room, { type: 'playerAction', seat: s.seat, action: 'fold', amount: 0, name: s.name + ' (disconnected)' });
      writeLog(room, `FOLD (disconnect): ${s.name} (Seat ${s.seat+1}) folded out of current hand`);
      broadcastState(room);
      checkRoundEnd(room);
    }

    scheduleRoomCleanup(room);
    // NOTE: No _disconnectTimer here. Eviction is now hand-based — see
    // startNewHand() where _missedHands is incremented each hand the player
    // misses while still disconnected. After 3 missed hands they are evicted.
  });

  ws.on('error', err => {
    svrLog(`WS ERROR \u2014 id=${myId||'(pre-join)'} room=${myRoomId||'none'}: ${err.message}`);
    console.error('WS error:', err.message);
  });
});

// ─── Execute an immediate cash-out for a player ───────────────────────────────
function executeCashOut(room, s) {
  const chips = s.chips;
  const seatIdx = s.seat;
  const logMsg = `CASH OUT: ${s.name} (Seat ${seatIdx+1}) leaves with £${(chips/100).toFixed(2)} | ${buyInTag(s)}`;
  svrLog(`CASH OUT — ${s.name} room ${room.id} £${(chips/100).toFixed(2)}`);
  if (room.G) writeLog(room, logMsg);

  logEvent(room, `💰 ${s.name} cashed out with £${(chips/100).toFixed(2)} | ${buyInTag(s)}`);
  broadcastAll(room, { type: 'playerLeft', id: s.id, name: s.name, seat: seatIdx, reason: 'cashout' });

  room.seats[seatIdx] = null;

  if (room.hostId === s.id) {
    const newHost = room.seats.find(Boolean);
    if (newHost) {
      room.hostId = newHost.id;
      send(newHost.ws, { type: 'logEvent', text: '👑 You are now the host.' });
    }
  }
  broadcastAll(room, lobbySnapshot(room));
  broadcastState(room);
  scheduleRoomCleanup(room);
}

function mkPlayer(ws, id, name, seat, room) {
  const startChips = room ? room.buyIn : START_CHIPS;
  return {
    ws, id, name, chips: startChips, seat, cards: [], bet: 0,
    folded: false, disconnected: false, autoFold: false,
    pendingCashOut: false, _disconnectTimer: null,
    buyInCount: 1,
    buyInTotal: startChips
  };
}

// Format a player's buy-in summary for log lines, e.g. "[Buy-ins: 2 | Total in: £20.00]"
function buyInTag(s) {
  return `[Buy-ins: ${s.buyInCount} | Total in: \u00a3${(s.buyInTotal/100).toFixed(2)}]`;
}

// ─── Game helpers ─────────────────────────────────────────────────────────────
// Cryptographically secure Fisher-Yates shuffle using Node's crypto.randomInt.
// crypto.randomInt(min, max) draws from the OS CSPRNG — unpredictable even if
// the process state is somehow observed, unlike Math.random().
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

// FIX #3 / #2: activePlaying must exclude spectators, pendingBuyBack, and 0-chip players
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

// FIX #3 & #4: buildActOrder — properly tracks who still needs to act.
// The "toAct" list should contain every non-folded player with chips who hasn't
// yet matched the current bet OR has not yet had a chance to act this street.
function buildActOrder(room, startSeat, active) {
  const sorted = [...active].sort((a, b) => a - b);
  let startIdx = sorted.indexOf(startSeat);
  if (startIdx === -1) startIdx = 0;
  // Rotate so startSeat is first
  const ordered = [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  return ordered.filter(i => {
    const p = room.seats[i];
    return p && !p.folded && !p.autoFold && !p.voluntaryAutoFold && p.chips > 0;
  });
}

// FIX #3: Count players who can actually make a meaningful decision.
// A player who is all-in cannot act further but is still "in" the hand.
function canActCount(room) {
  if (!room.G) return 0;
  return room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    s.chips > 0
  ).length;
}

// Helper: check if round should end due to one or zero real players remaining unfolded.
// autoFold/voluntaryAutoFold players don't count — they'll be folded automatically.
function checkRoundEnd(room) {
  const alive = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    !s.autoFold && !s.voluntaryAutoFold
  );
  if (alive.length <= 1) {
    endRound(room);
    return true;
  }
  return false;
}

// ─── Hand flow ────────────────────────────────────────────────────────────────
function startNewHand(room) {
  clearActionTimer(room);

  if (room.paused) {
    room.paused = false;
    broadcastAll(room, { type: 'gameResumed' });
  }
  room.actionTimerSeat = -1;
  room.actionTimerRemaining = ACTION_TIMEOUT;
  room.actionTimerStarted = 0;

  // Process any pending cash-outs from the previous hand
  room.seats.forEach((s, i) => {
    if (s && s.pendingCashOut) {
      executeCashOut(room, s);
    }
  });

  // ── Hand-based absence tracking ───────────────────────────────────────────
  // For every disconnected player, count this as one missed hand.
  // After ABSENT_HAND_LIMIT consecutive missed hands → evict the seat.
  // This replaces the old timer-based approach which was unreliable because
  // startNewHand was clearing the disconnect timer before it could fire.
  const ABSENT_HAND_LIMIT = 3;
  room.seats.forEach((s, idx) => {
    if (!s) return;
    if (s._disconnectTimer) { clearTimeout(s._disconnectTimer); s._disconnectTimer = null; }

    if (s.disconnected && s.autoFold) {
      s._missedHands = (s._missedHands || 0) + 1;
      writeLog(room, `ABSENT: ${s.name} (Seat ${s.seat+1}) missed hand — absent ${s._missedHands}/${ABSENT_HAND_LIMIT} | ${buyInTag(s)}`);
      logEvent(room, `\uD83D\uDCA4 ${s.name} absent — missed ${s._missedHands}/${ABSENT_HAND_LIMIT} hand${s._missedHands>1?'s':''}`);
      svrLog(`ABSENT — ${s.name} room ${room.id} missedHands=${s._missedHands}/${ABSENT_HAND_LIMIT}`);

      if (s._missedHands >= ABSENT_HAND_LIMIT) {
        // Evict
        svrLog(`EVICT — ${s.name} room ${room.id} seat ${s.seat+1} after ${ABSENT_HAND_LIMIT} missed hands`);
        logEvent(room, `\u274C ${s.name} removed after ${ABSENT_HAND_LIMIT} missed hands`);
        writeLog(room, `EVICTED: ${s.name} (Seat ${s.seat+1}) removed after ${ABSENT_HAND_LIMIT} consecutive missed hands | ${buyInTag(s)}`);
        broadcastAll(room, { type: 'playerLeft', id: s.id, name: s.name, seat: s.seat, reason: 'absent-eviction' });

        if (room.hostId === s.id) {
          const newHost = room.seats.find(h => h && h.id !== s.id && h.ws?.readyState === 1);
          if (newHost) {
            room.hostId = newHost.id;
            writeLog(room, `HOST TRANSFER: ${s.name} evicted \u2192 ${newHost.name} is new host`);
            svrLog(`HOST TRANSFER — room ${room.id}: ${s.name} \u2192 ${newHost.name}`);
            send(newHost.ws, { type: 'logEvent', text: '\uD83D\uDC51 You are now the host.' });
          } else {
            room.hostId = null;
          }
        }

        room.seats[idx] = null;
        broadcastAll(room, lobbySnapshot(room));
        scheduleRoomCleanup(room);
      }
    } else {
      // Connected player — reset their absence counter
      s._missedHands = 0;
      s.sittingOut = false;
    }
  });

  const active = activePlaying(room);

  if (active.length < 2) {
    const seated = room.seats.filter(Boolean).map(s=>`${s.name}(chips:£${(s.chips/100).toFixed(2)},sittingOut:${!!s.sittingOut},spectator:${!!s.spectator},pendingBB:${!!s.pendingBuyBack})`).join(', ');
    writeLog(room, `WAITING: not enough active players to start hand | active=${active.length} | all seats: ${seated}`);
    svrLog(`ROOM ${room.id} — waiting for players (active: ${active.length})`);
    broadcastAll(room, { type: 'waitingForPlayers' });
    room.gameActive = false;
    broadcastAll(room, lobbySnapshot(room));
    return;
  }

  room.dealerSeat = room.dealerSeat < 0
    ? active[0]
    : nextSeat(room.dealerSeat, active);

  room.handNum = (room.handNum || 0) + 1;

  const isHeadsUp = active.length === 2;
  // Heads-up: dealer posts SB and acts first preflop; BB acts first postflop
  const sbSeat = isHeadsUp ? room.dealerSeat : nextSeat(room.dealerSeat, active);
  const bbSeat = nextSeat(sbSeat, active);
  const preflopStart = nextSeat(bbSeat, active);

  const logPath = handLogPath(room.id, room.handNum);

  room.G = {
    deck: buildDeck(), phase: 'preflop', pot: 0,
    currentBet: BB,
    lastRaiseIncrement: BB,
    community: [], toAct: [], sbSeat, bbSeat, isHeadsUp, logPath
  };

  room.seats.forEach(s => { if (s) { s.cards = []; s.bet = 0; s.folded = false; s.totalBet = 0; } });

  const dealStartSeat = isHeadsUp ? bbSeat : sbSeat;
  const dsIdx = active.indexOf(dealStartSeat);
  const dealOrder = dsIdx >= 0
    ? [...active.slice(dsIdx), ...active.slice(0, dsIdx)]
    : active;

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
    const tagStr = tags.length ? ' ['+tags.join('+')+']' : '';
    return `  Seat ${String(i+1).padStart(2)} | ${s.name.padEnd(18)} | Stack: £${(s.chips/100).toFixed(2).padStart(7)}${tagStr}\n             ${buyInTag(s)}`;
  }).join('\n');

  fs.writeFileSync(logPath,
    '╔' + '═'.repeat(62) + '╗\n' +
    '║  SYFM POKER — HAND LOG' + ' '.repeat(39) + '║\n' +
    '╠' + '═'.repeat(62) + '╣\n' +
    `║  Room: ${room.id.padEnd(10)} Hand: #${String(room.handNum).padEnd(6)} Date: ${dateStr.slice(0,20).padEnd(20)}║\n` +
    `║  Time: ${timeStr.padEnd(54)}║\n` +
    '╠' + '═'.repeat(62) + '╣\n' +
    '║  PLAYERS AT THE TABLE' + ' '.repeat(40) + '║\n' +
    '╠' + '═'.repeat(62) + '╣\n' +
    playerLines.split('\n').map(l => '║' + l.padEnd(63) + '║').join('\n') + '\n' +
    '╠' + '═'.repeat(62) + '╣\n' +
    `║  Format: ${isHeadsUp ? 'HEADS-UP' : active.length+'-handed'} | Blinds: SB £${(SB/100).toFixed(2)} / BB £${(BB/100).toFixed(2)} | Total chips in play: £${(totalChips/100).toFixed(2)}`.padEnd(63) + '║\n' +
    `║  Deal order: ${dealOrder.map(i=>room.seats[i].name).join(' → ')}`.padEnd(63) + '║\n' +
    '╚' + '═'.repeat(62) + '╝\n\n'
  );

  room.seats[sbSeat].chips -= SB; room.seats[sbSeat].bet = SB; room.seats[sbSeat].totalBet = SB;
  room.seats[bbSeat].chips -= BB; room.seats[bbSeat].bet = BB; room.seats[bbSeat].totalBet = BB;
  room.G.pot = SB + BB;
  // Record total chips for conservation check at end of hand
  room._chipsInPlayAtHandStart = room.seats.filter(Boolean).reduce((sum, s) => sum + s.chips, 0) + room.G.pot;

  // FIX #2: Cards are dealt ONLY to active players — no other seat gets cards
  for (let rd = 0; rd < 2; rd++)
    for (const si of dealOrder)
      room.seats[si].cards.push(room.G.deck.shift());

  writeLog(room, '┌─ HOLE CARDS DEALT ─────────────────────────────┐');
  dealOrder.forEach(i => {
    const s = room.seats[i];
    const tags = [];
    if (i === room.dealerSeat) tags.push('D');
    if (i === sbSeat) tags.push('SB');
    if (i === bbSeat) tags.push('BB');
    const tagStr = tags.length ? ' ['+tags.join('+')+']' : '';
    writeLog(room, `│ ${('Seat '+(i+1)+' '+s.name).padEnd(22)}${tagStr.padEnd(8)}: ${s.cards.map(c=>c.r+c.s).join('  ')} │`);
  });
  writeLog(room, '└────────────────────────────────────────────────┘');

  // FIX #4: Pre-flop act order — starts AFTER the BB.
  // BB player is allowed to raise even if no one else has raised (option).
  // We build the full rotation; the BB will appear at the END so they get their option.
  room.G.toAct = buildActOrder(room, preflopStart, active);

  broadcastAll(room, {
    type: 'newHand', dealerSeat: room.dealerSeat, sbSeat, bbSeat,
    pot: room.G.pot, activeSeats: dealOrder
  });

  // FIX #2: Send each player ONLY their own cards via individual tableSnapshot
  room.seats.forEach(s => {
    if (s?.ws?.readyState === 1) send(s.ws, tableSnapshot(room, s.id));
  });

  writeLog(room, '');
  writeLog(room, '┌─ PREFLOP ────────────────────────────────────────────┐');
  writeLog(room, `│  Pot (blinds): £${((room.G.pot)/100).toFixed(2).padEnd(44)}│`);
  writeLog(room, `│  SB: ${room.seats[sbSeat].name.padEnd(18)} posts £${(SB/100).toFixed(2).padEnd(30)}│`);
  writeLog(room, `│  BB: ${room.seats[bbSeat].name.padEnd(18)} posts £${(BB/100).toFixed(2).padEnd(30)}│`);
  writeLog(room, `│  Act order: ${room.G.toAct.map(i=>room.seats[i].name).join(' → ').padEnd(49)}│`);
  writeLog(room, '└──────────────────────────────────────────────────────┘');
  promptToAct(room);
}

// FIX #3 & #4: promptToAct — the core of the "wrong player asked" and
// "check after bet" bugs. This function now correctly:
// 1. Skips auto-fold/disconnected/0-chip players
// 2. Ends the street when no one is left to act (not by accident)
// 3. Detects when only 1 player can act and skips to showdown/next street
function promptToAct(room) {
  const G = room.G;
  if (!G) return;

  // Clean up toAct list: remove players who can no longer act
  while (G.toAct.length) {
    const si = G.toAct[0];
    const p = room.seats[si];
    if (!p || p.folded || p.autoFold || p.voluntaryAutoFold || p.chips === 0) {
      G.toAct.shift();
    } else {
      break;
    }
  }

  // Count players genuinely still in the hand (not folded, not sitting out,
  // not spectating, not pending buy-back, and NOT on autoFold/voluntaryAutoFold).
  // autoFold players are effectively gone from this hand — they will fold immediately.
  const activeInHand = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    !s.autoFold && !s.voluntaryAutoFold
  );

  // If 1 or fewer real players remain, end the round — no point asking anyone
  if (activeInHand.length <= 1) {
    // First auto-fold anyone left in toAct who is on autoFold so the fold logs correctly
    const toAutoFold = room.seats.filter(s =>
      s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
      (s.autoFold || s.voluntaryAutoFold)
    );
    if (toAutoFold.length > 0) {
      // Fold them silently then end
      for (const af of toAutoFold) {
        if (!af.folded) {
          af.folded = true;
          const label = af.voluntaryAutoFold ? 'auto-fold' : 'auto (disconnected)';
          broadcastAll(room, { type: 'playerAction', seat: af.seat, action: 'fold', amount: 0, name: af.name + ` (${label})` });
          writeLog(room, `FOLD   | ${af.name.padEnd(18)} | auto-fold — no other active players`);
          const idx = G.toAct.indexOf(af.seat);
          if (idx !== -1) G.toAct.splice(idx, 1);
        }
      }
      broadcastState(room);
    }
    endRound(room);
    return;
  }

  // Count unfolded players still in the hand (regardless of chips) — for all-in detection
  const unfolded = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    !s.autoFold && !s.voluntaryAutoFold
  );

  // FIX #3: Count players who CAN still act (have chips and aren't all-in)
  const canAct = unfolded.filter(s => s.chips > 0);

  // If nobody can act (all remaining are all-in), run the board automatically
  if (canAct.length === 0 || G.toAct.length === 0) {
    advPhase(room);
    return;
  }

  // FIX #3: If only 1 player can still act and all others are all-in,
  // skip asking them if their bet is already matched — just run the board.
  if (canAct.length === 1 && G.toAct.length > 0) {
    const soloSeat = G.toAct[0];
    const solo = room.seats[soloSeat];
    if (solo) {
      const callAmt = Math.min(G.currentBet - solo.bet, solo.chips);
      if (callAmt === 0) {
        const othersAllIn = unfolded.filter(s => s.seat !== soloSeat && s.chips === 0);
        if (othersAllIn.length === unfolded.length - 1) {
          advPhase(room);
          return;
        }
      }
    }
  }

  const seat = G.toAct[0];
  const p = room.seats[seat];

  if (!p) { G.toAct.shift(); setTimeout(() => promptToAct(room), 100); return; }

  // Auto-fold disconnected / auto-fold flagged players immediately
  if (p.disconnected || p.autoFold || p.voluntaryAutoFold) {
    clearActionTimer(room);
    const reason = p.voluntaryAutoFold ? 'auto-fold' : 'auto (disconnected)';
    writeLog(room, `PROMPT: ${p.name} (Seat ${seat+1}) — auto-folding (${reason})`);
    doFold(room, seat, reason);
    return;
  }

  // FIX #4: Determine if this is a check (no bet to call) or call situation
  const callAmt  = Math.min(G.currentBet - p.bet, p.chips);
  const minRaise = Math.min(callAmt + G.lastRaiseIncrement, p.chips);
  const firstBet = G.currentBet === 0;

  writeLog(room, `PROMPT: ${p.name.padEnd(18)} (Seat ${seat+1}) | Phase: ${G.phase} | Stack: £${(p.chips/100).toFixed(2)} | ${callAmt===0?'can CHECK':'must CALL £'+(callAmt/100).toFixed(2)} | min${firstBet?'BET':'RAISE'}: £${(minRaise/100).toFixed(2)} | Pot: £${(G.pot/100).toFixed(2)} | toAct: ${G.toAct.map(i=>room.seats[i]?.name||'?').join('→')}`);

  broadcastAll(room, {
    type: 'yourTurn',
    seat,
    callAmt,         // 0 = check, >0 = amount to call
    minRaise,
    pot: G.pot,
    currentBet: G.currentBet,
    firstBet        // true = "BET", false = "RAISE"
  });
  startActionTimer(room, seat);
}

function doFold(room, seat, reason) {
  const p = room.seats[seat];
  if (!p) return;
  p.folded = true;
  const label = reason ? ` (${reason})` : '';
  const playersLeft = room.seats.filter(s => s && !s.folded && !s.autoFold && !s.voluntaryAutoFold).length;
  const reasonTag = reason ? `reason=${reason}` : 'voluntary';
  broadcastAll(room, { type: 'playerAction', seat, action: 'fold', amount: 0, name: p.name + label });
  writeLog(room, `FOLD   | ${p.name.padEnd(18)} | ${reasonTag.padEnd(22)} | Stack: £${(p.chips/100).toFixed(2).padStart(7)} | Pot: £${((room.G?.pot||0)/100).toFixed(2)} | Players left: ${playersLeft}`);
  if (room.G) {
    const idx = room.G.toAct.indexOf(seat);
    if (idx !== -1) room.G.toAct.splice(idx, 1);
  }
  broadcastState(room);
  if (!checkRoundEnd(room)) {
    setTimeout(() => promptToAct(room), 200);
  }
}

// FIX #4: handleAction — betting logic corrected
// The key bug was: after a raise, we were not correctly rebuilding toAct
// to include only players who still need to call the new amount.
function handleAction(room, seat, action, amount) {
  const p = room.seats[seat];
  const G = room.G;
  if (!p || !G) return;
  const stackBefore = p.chips;

  if (action === 'fold') {
    doFold(room, seat, null);

  } else if (action === 'check' || action === 'call') {
    const ca = Math.min(G.currentBet - p.bet, p.chips);
    p.chips -= ca; p.bet += ca; p.totalBet = (p.totalBet||0) + ca; G.pot += ca;
    const act = ca === 0 ? 'check' : 'call';
    broadcastAll(room, { type: 'playerAction', seat, action: act, amount: ca, name: p.name, pot: G.pot });
    writeLog(room,
      `${act==='check'?'CHECK ':'CALL  '} | ${p.name.padEnd(18)} | Stack: £${(stackBefore/100).toFixed(2)} → £${(p.chips/100).toFixed(2)}` +
      ` | ${ca>0?'Paid: £'+(ca/100).toFixed(2):'(no payment)'} | Pot: £${(G.pot/100).toFixed(2)} | toAct remaining: ${G.toAct.length-1}`
    );
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
    writeLog(room,
      `${p.bet===p.chips+raiseFromStack&&stackBefore===raiseFromStack?'ALL-IN':'RAISE '} | ${p.name.padEnd(18)}` +
      ` | Stack: £${(stackBefore/100).toFixed(2)} → £${(p.chips/100).toFixed(2)}` +
      ` | Raised: £${(raiseFromStack/100).toFixed(2)} | Total bet this street: £${(p.bet/100).toFixed(2)}` +
      ` | New street ceiling: £${(G.currentBet/100).toFixed(2)} | Pot: £${(G.pot/100).toFixed(2)}`
    );
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
    writeLog(room, `RAISE  | New toAct order: ${G.toAct.map(i=>room.seats[i]?.name||'?').join(' → ')} (${G.toAct.length} to act)`);
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

    writeLog(room, `PHASE: ${prevPhase.toUpperCase()} → ${G.phase.toUpperCase()} | New card(s): ${newCards.map(c=>c.r+c.s).join(' ')} | Board: ${G.community.map(c=>c.r+c.s).join(' ')} | Pot: £${(G.pot/100).toFixed(2)}`);
    broadcastAll(room, { type: 'communityDealt', phase: G.phase, cards: G.community, newCards });
    writeLog(room, '');
    writeLog(room, '┌─ ' + G.phase.toUpperCase().padEnd(10) + '──────────────────────────────────────────┐');
    writeLog(room, '│  New cards : ' + newCards.map(c=>c.r+c.s).join('  ').padEnd(47) + '│');
    writeLog(room, '│  Board     : ' + G.community.map(c=>c.r+c.s).join('  ').padEnd(47) + '│');
    writeLog(room, '│  Pot       : £' + (G.pot/100).toFixed(2).padEnd(46) + '│');
    writeLog(room, '└────────────────────────────────────────────────────┘');
    broadcastState(room);

    const active = activePlaying(room);

    // FIX #3: After dealing community cards, check if anyone can actually act.
    // Exclude autoFold/voluntaryAutoFold players — they are effectively out.
    const unfolded = room.seats.filter(s =>
      s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
      !s.autoFold && !s.voluntaryAutoFold
    );

    if (unfolded.length <= 1) {
      endRound(room);
      return;
    }

    // Players who can still bet/call (have chips)
    const canAct = active.filter(i => {
      const p = room.seats[i];
      return p && !p.folded && p.chips > 0;
    });

    if (canAct.length <= 1 && G.phase !== 'river') {
      // All remaining players are all-in — run board automatically without asking
      writeLog(room, `│  All players all-in — running board automatically     │`);
      setTimeout(() => advPhase(room), 1200);
      return;
    }

    // FIX #3: If only 1 player can act but others are all-in, still run board
    // (no meaningful betting can happen with 1 active vs all-in opponents)
    if (canAct.length <= 1) {
      // We're at the river with no meaningful action possible
      setTimeout(() => {
        G.phase = 'showdown';
        showdown(room);
      }, 1200);
      return;
    }

    // Post-flop act order: starts left of dealer (SB position in normal play)
    const postStart = G.isHeadsUp ? G.bbSeat : nextSeat(room.dealerSeat, active);
    G.toAct = buildActOrder(room, postStart, active);
    writeLog(room, `Act order: ${G.toAct.map(i => room.seats[i].name).join(' → ')}`);
    setTimeout(() => promptToAct(room), 600);

  } else {
    G.phase = 'showdown';
    showdown(room);
  }
}

function endRound(room) {
  clearActionTimer(room);
  // Remaining = unfolded players who are genuinely still playing (not autoFold)
  const remaining = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack &&
    !s.autoFold && !s.voluntaryAutoFold
  );
  if (remaining.length === 1) {
    writeLog(room, `RESULT: ${remaining[0].name} wins uncontested`);
    finish(room, [remaining[0]], 'Last player standing');
  } else if (remaining.length === 0) {
    writeLog(room, `RESULT: No eligible winner found — hand skipped`);
    setTimeout(() => startNewHand(room), 3000);
  }
}

function showdown(room) {
  clearActionTimer(room);
  const active = room.seats.filter(s =>
    s && !s.folded && !s.sittingOut && !s.spectator && !s.pendingBuyBack
  );
  if (active.length === 1) {
    writeLog(room, `RESULT: ${active[0].name} wins at showdown uncontested`);
    finish(room, [active[0]], 'Last player standing');
    return;
  }
  if (active.length === 0) {
    writeLog(room, `RESULT: No players at showdown — hand skipped`);
    setTimeout(() => startNewHand(room), 3000);
    return;
  }

  broadcastAll(room, { type: 'showdown', reveals: active.map(s => ({ seat: s.seat, name: s.name, cards: s.cards })) });
  broadcastState(room);

  writeLog(room, '');
  writeLog(room, '╔' + '═'.repeat(62) + '╗');
  writeLog(room, '║  SHOWDOWN' + ' '.repeat(52) + '║');
  writeLog(room, '╠' + '═'.repeat(62) + '╣');
  writeLog(room, `║  Board: ${room.G.community.map(c=>c.r+c.s).join('  ').padEnd(53)}║`);
  writeLog(room, '╠' + '═'.repeat(62) + '╣');

  let bestScore = -1;
  const scored = active.map(p => {
    const allCards = [...p.cards, ...room.G.community];
    const sc = evalBest(allCards);
    const bf = bestFiveCards(allCards);
    if (sc > bestScore) bestScore = sc;
    return { p, sc, bf };
  });

  for (const { p, sc, bf } of scored) {
    const holeStr = p.cards.map(c=>c.r+c.s).join(' ');
    const bestStr = bf.map(c=>c.r+c.s).join(' ');
    const hn = handName(sc);
    writeLog(room, `║  ${('Seat '+(p.seat+1)+' '+p.name).padEnd(22)} | Hole: ${holeStr.padEnd(10)} | Best: ${bestStr.padEnd(14)} | ${hn.padEnd(16)}║`);
  }

  const winners = scored.filter(({ sc }) => sc === bestScore).map(({ p }) => p);
  const winHandName = handName(bestScore);

  writeLog(room, '╠' + '═'.repeat(62) + '╣');
  if (winners.length === 1) {
    writeLog(room, `║  🏆 WINNER: ${winners[0].name} with ${winHandName}`.padEnd(63) + '║');
  } else {
    writeLog(room, `║  🤝 SPLIT POT: ${winners.map(w=>w.name).join(' & ')} — ${winHandName}`.padEnd(63) + '║');
  }
  writeLog(room, '╚' + '═'.repeat(62) + '╝');

  setTimeout(() => finish(room, winners, winHandName), 1200);
}

function finish(room, winners, label) {
  if (!winners || winners.length === 0) return;
  clearActionTimer(room);

  const G = room.G;
  const totalPot = G.pot;
  G.pot = 0;

  // ── Side-pot calculation ─────────────────────────────────────────────────
  // Every seated player (folded or not) has a totalBet — what they put in.
  // We calculate how much of the pot each player is eligible to win.
  //
  // Algorithm:
  //   Sort all contributors by totalBet ascending.
  //   For each level, the "main pot" at that level is:
  //     min(totalBet[i], totalBet[everyone]) * number_of_contributors_at_this_level
  //   Eligible winners at each level = winners who contributed >= this level.
  //   Award each pot level to the best hand among eligible winners.
  //
  // Folded players contribute chips to the pot but are never eligible to win.

  const allSeats = room.seats.filter(Boolean);

  // Gather contributors — everyone who put chips in this hand
  const contributors = allSeats
    .filter(s => (s.totalBet||0) > 0)
    .sort((a, b) => (a.totalBet||0) - (b.totalBet||0));

  // Build pot levels
  const potLevels = []; // { amount, eligibleIds }
  let alreadyTaken = 0;

  for (let i = 0; i < contributors.length; i++) {
    const cap = contributors[i].totalBet;
    if (cap <= alreadyTaken) continue;
    const levelContrib = cap - alreadyTaken;
    // Each contributor at this level puts in levelContrib (capped by their totalBet)
    const participantCount = contributors.filter(c => (c.totalBet||0) >= cap).length;
    // Also count contributors below this cap for the portion they already contributed
    const belowCount = contributors.filter(c => (c.totalBet||0) < cap).length;
    // Pot for this level = levelContrib * number of people who contributed >= cap
    // + any remaining from people below (already accounted in previous levels)
    const levelPot = levelContrib * (contributors.length - i);
    // Eligible to win this level: unfolded players whose totalBet >= cap
    const eligibleIds = new Set(
      allSeats
        .filter(s => !s.folded && (s.totalBet||0) >= cap)
        .map(s => s.id)
    );
    potLevels.push({ amount: levelPot, eligibleIds, cap });
    alreadyTaken = cap;
  }

  // Sanity: if pot levels don't add up to totalPot (rounding), add remainder to last level
  const levelTotal = potLevels.reduce((sum, l) => sum + l.amount, 0);
  if (levelTotal !== totalPot && potLevels.length > 0) {
    potLevels[potLevels.length - 1].amount += (totalPot - levelTotal);
  }

  writeLog(room, '');
  writeLog(room, '┌─ HAND RESULT ─────────────────────────────────────────┐');

  let totalAwarded = 0;
  const awardLog = [];

  potLevels.forEach((level, li) => {
    if (level.amount <= 0) return;

    // Find winners eligible for this pot level
    const eligibleWinners = winners.filter(w => level.eligibleIds.has(w.id));

    if (eligibleWinners.length === 0) {
      // No eligible winner (e.g. the only all-in player lost) — return to eligible unfolded players
      // Give to the best eligible unfolded player
      const eligible = allSeats.filter(s => !s.folded && level.eligibleIds.has(s.id));
      if (eligible.length > 0) {
        eligible[0].chips += level.amount;
        awardLog.push(`│  ${eligible[0].name} wins £${(level.amount/100).toFixed(2)} (returned — no eligible winner)`.padEnd(63) + '│');
        totalAwarded += level.amount;
      }
      return;
    }

    if (eligibleWinners.length === 1) {
      const w = eligibleWinners[0];
      w.chips += level.amount;
      const potLabel = potLevels.length > 1 ? (li === 0 ? 'main pot' : `side pot ${li}`) : 'pot';
      awardLog.push(`│  ${w.name} wins £${(level.amount/100).toFixed(2)} — ${label} (${potLabel})`.padEnd(63) + '│');
      totalAwarded += level.amount;
    } else {
      // Split among eligible winners
      const perPlayer = Math.floor(level.amount / eligibleWinners.length);
      const remainder = level.amount - perPlayer * eligibleWinners.length;
      const sorted = [...eligibleWinners].sort((a, b) => a.seat - b.seat);
      sorted.forEach((w, i) => {
        const share = perPlayer + (i === 0 ? remainder : 0);
        w.chips += share;
        totalAwarded += share;
      });
      const potLabel = potLevels.length > 1 ? (li === 0 ? 'main pot' : `side pot ${li}`) : 'pot';
      awardLog.push(`│  🤝 ${sorted.map(w=>w.name).join(' & ')} split £${(level.amount/100).toFixed(2)} — ${label} (${potLabel})`.padEnd(63) + '│');
    }
  });

  // Return any un-matchable chips to the player who over-contributed
  // (e.g. the bigger stack went all-in for more than the smaller stack could match)
  const returned = totalPot - totalAwarded;
  if (returned > 0) {
    // Find the player with the largest totalBet who is still in (not folded)
    const overContributor = allSeats
      .filter(s => !s.folded)
      .sort((a, b) => (b.totalBet||0) - (a.totalBet||0))[0];
    if (overContributor) {
      overContributor.chips += returned;
      awardLog.push(`│  £${(returned/100).toFixed(2)} returned to ${overContributor.name} (unmatched all-in)`.padEnd(63) + '│');
    }
  }

  // Broadcast individual winner messages
  potLevels.forEach((level, li) => {
    if (level.amount <= 0) return;
    const eligibleWinners = winners.filter(w => level.eligibleIds.has(w.id));
    if (eligibleWinners.length === 1) {
      broadcastAll(room, { type: 'winner', seat: eligibleWinners[0].seat, name: eligibleWinners[0].name, amount: level.amount, label });
    } else if (eligibleWinners.length > 1) {
      const perPlayer = Math.floor(level.amount / eligibleWinners.length);
      const remainder = level.amount - perPlayer * eligibleWinners.length;
      eligibleWinners.sort((a,b)=>a.seat-b.seat).forEach((w,i) => {
        broadcastAll(room, { type: 'winner', seat: w.seat, name: w.name, amount: perPlayer+(i===0?remainder:0), label: `Split — ${label}` });
      });
    }
  });

  awardLog.forEach(line => writeLog(room, line));
  broadcastState(room);

  // ── Chip conservation check ───────────────────────────────────────────────
  // Total chips held by all seated players + any remaining pot must equal
  // the running total that was in play at the start of this hand.
  const chipsAfter = room.seats.filter(Boolean).reduce((sum, s) => sum + s.chips, 0) + (G.pot || 0);
  const chipsBefore = room._chipsInPlayAtHandStart || 0;
  if (chipsBefore > 0 && chipsAfter !== chipsBefore) {
    const diff = chipsAfter - chipsBefore;
    writeLog(room, `⚠️  CHIP CONSERVATION ERROR: ${diff > 0 ? '+' : ''}${(diff/100).toFixed(2)} pence discrepancy! Before: £${(chipsBefore/100).toFixed(2)} After: £${(chipsAfter/100).toFixed(2)}`);
    svrLog(`CHIP ERROR room ${room.id} hand ${room.handNum}: ${diff>0?'+':''}${diff} pence`);
  }

  writeLog(room, '├─ CHIP COUNTS AFTER HAND ──────────────────────────────┤');
  room.seats.filter(Boolean).sort((a,b) => b.chips - a.chips).forEach(s => {
    const bar  = '█'.repeat(Math.round(s.chips / START_CHIPS * 20));
    const note = s.pendingCashOut ? ' [CASHING OUT]' : '';
    writeLog(room, `│  ${('Seat '+(s.seat+1)+' '+s.name).padEnd(22)} £${(s.chips/100).toFixed(2).padStart(7)}  ${bar}${note}`);
    writeLog(room, `│      ${buyInTag(s)}`.padEnd(63) + '│');
  });
  writeLog(room, '└───────────────────────────────────────────────────────┘');
  writeLog(room, '');

  const logPath = room.G.logPath;
  if (logPath) setTimeout(() => ftpUpload(logPath), 500);

  setTimeout(() => {
    // Offer buy-back to every busted player regardless of player count.
    // KEY FIX: we must NOT call startNewHand until every pending buy-back
    // has resolved (accept OR timeout), otherwise in 2-player mode the
    // hand starts with only 1 eligible player → waitingForPlayers fires
    // and the host sees a dead "Start Game" button.
    const busted = room.seats.filter(s =>
      s && s.chips <= 0 && !s.pendingBuyBack && !s.spectator
    );

    if (busted.length === 0) {
      startNewHand(room);
      return;
    }

    let pendingCount = busted.length;

    function onBuyBackResolved() {
      pendingCount--;
      if (pendingCount <= 0) startNewHand(room);
    }

    busted.forEach(s => {
      s.pendingBuyBack = true;
      s.sittingOut = true;
      writeLog(room, `BUST: ${s.name} (Seat ${s.seat+1}) is out of chips — offering buy-back (15s) | ${buyInTag(s)}`);
      logEvent(room, `\ud83d\udcb8 ${s.name} is out of chips \u2014 buy-back offer sent | ${buyInTag(s)}`);
      send(s.ws, { type: 'buyBackOffer', chips: room.buyIn });

      if (s._buyBackTimer) clearTimeout(s._buyBackTimer);
      s._buyBackTimer = setTimeout(() => {
        if (!s.pendingBuyBack) return;
        s.pendingBuyBack = false;
        s.sittingOut = true;
        s.spectator = true;
        writeLog(room, `SPECTATOR (timeout): ${s.name} did not respond \u2014 now spectating | ${buyInTag(s)}`);
        logEvent(room, `\ud83d\udc40 ${s.name} did not respond to buy-back \u2014 now spectating | ${buyInTag(s)}`);
        send(s.ws, { type: 'spectating' });
        broadcastState(room);
        onBuyBackResolved();
      }, 15000);

      // Store resolver so the buyBack message handler can fire it
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
  const groups = Object.entries(cnt)
    .map(([r, n]) => ({ r: Number(r), n }))
    .sort((a, b) => b.n - a.n || b.r - a.r);
  const tbRanks = groups.flatMap(g => Array(g.n).fill(g.r));

  const flush = suits.every(s => s === suits[0]);
  const uniq  = [...new Set(ranks)].sort((a, b) => b - a);

  let isStraight = false, sHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) {
      isStraight = true; sHigh = uniq[0];
    } else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) {
      isStraight = true; sHigh = 5;
    }
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
  console.log(`\n♣ ${startMsg}`);
  svrLog(startMsg);
  svrLog(`HTTP: http://localhost:${PORT}`);
  svrLog(`Logs: http://localhost:${PORT}/logs`);
  svrLog(`FTP:  ${process.env.FTP_HOST || '(not configured)'}`);
});

// ─── Graceful shutdown (Render.com sends SIGTERM before killing the process) ──
// Without this, the process dies dirty leaving sockets half-open.
// With it, we close all WebSocket connections cleanly first so clients
// immediately get a "connection closed" event and can show a reconnect UI.
function gracefulShutdown(signal) {
  const ts = new Date().toISOString();
  svrLog(`SHUTDOWN: ${signal} received at ${ts} | rooms=${rooms.size} | wsConnections=${wss.clients.size}`);
  rooms.forEach(room => {
    const players = room.seats.filter(Boolean).map(s=>`${s.name}(£${(s.chips/100).toFixed(2)})`).join(', ');
    svrLog(`SHUTDOWN: closing room ${room.id} | hand #${room.handNum} | players: ${players||'none'}`);
    writeLog(room, `SERVER SHUTDOWN: ${signal} received — server closing | All sessions terminated`);
  });

  const shutdownMsg = JSON.stringify({ type: 'serverShutdown', reason: 'Server is restarting. Please refresh to reconnect.' });
  let notified = 0;
  wss.clients.forEach(client => {
    try { if (client.readyState === 1) { client.send(shutdownMsg); notified++; } } catch {}
  });
  svrLog(`SHUTDOWN: notified ${notified} client(s) via serverShutdown message`);

  rooms.forEach(room => destroyRoom(room));

  wss.close(() => {
    svrLog('SHUTDOWN: WebSocket server closed');
    server.close(() => {
      svrLog('SHUTDOWN: HTTP server closed — clean exit');
      process.exit(0);
    });
  });

  setTimeout(() => {
    svrLog('SHUTDOWN: force exit after 5s timeout');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
