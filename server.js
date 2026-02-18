'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const fs   = require('fs');
const path = require('path');
const ftp  = require('basic-ftp');

const PORT  = process.env.PORT || 10000;
const SUITS = ['\u2660','\u2665','\u2666','\u2663'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RVAL  = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
const NP    = 9;
const SB    = 10, BB = 20;
const START_CHIPS = 1000;
const ACTION_TIMEOUT = 15000;

// ─── Logging ─────────────────────────────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function handLogPath(roomId, handNum) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(LOGS_DIR, `room${roomId}_hand${String(handNum).padStart(4,'0')}_${ts}.txt`);
}

function writeLog(room, line) {
  if (!room.G || !room.G.logPath) return;
  const ts = new Date().toTimeString().slice(0, 8);
  try { fs.appendFileSync(room.G.logPath, `[${ts}] ${line}\n`); } catch {}
}

// FTP upload after hand finishes
async function ftpUpload(localPath) {
  const host = process.env.FTP_HOST;
  const user = process.env.FTP_USER;
  const pass = process.env.FTP_PASS;
  const dir  = process.env.FTP_DIR || '/poker-logs';
  if (!host || !user || !pass) { console.log('FTP: env vars not set, skipping'); return; }
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({ host, user, password: pass, secure: false });
    try { await client.ensureDir(dir); } catch {}
    await client.uploadFrom(localPath, `${dir}/${path.basename(localPath)}`);
    console.log('FTP: uploaded', path.basename(localPath));
  } catch (err) {
    console.error('FTP upload failed:', err.message);
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
  res.writeHead(404); res.end('Not found');
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId, seats: Array(NP).fill(null), hostId: null,
      gameActive: false, pendingJoins: [], G: null, dealerSeat: -1,
      actionTimer: null, handNum: 0
    });
  }
  return rooms.get(roomId);
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
    seats: room.seats.map(s => s ? { id: s.id, name: s.name, chips: s.chips, seat: s.seat } : null),
    pending: room.pendingJoins.map(p => ({ id: p.id, name: p.name }))
  };
}

function tableSnapshot(room, forId) {
  const G = room.G;
  if (!G) return { type: 'state', phase: 'idle', players: room.seats.map(() => null) };
  return {
    type: 'state', phase: G.phase, pot: G.pot, currentBet: G.currentBet,
    community: G.community, dealerSeat: room.dealerSeat,
    sbSeat: G.sbSeat, bbSeat: G.bbSeat, toActSeat: G.toAct[0] ?? null,
    players: room.seats.map(s => {
      if (!s) return null;
      const showCards = s.id === forId || (G.phase === 'showdown' && !s.folded);
      return {
        seat: s.seat, name: s.name, chips: s.chips, bet: s.bet,
        folded: s.folded, disconnected: s.disconnected || false,
        cards: showCards ? s.cards : s.cards.map(() => 'back'),
        active: !s.sittingOut
      };
    })
  };
}

function startActionTimer(room, seat) {
  clearActionTimer(room);
  room.actionTimer = setTimeout(() => {
    const p = room.seats[seat];
    if (!p || p.folded || !room.G || room.G.toAct[0] !== seat) return;
    doFold(room, seat, 'timeout');
  }, ACTION_TIMEOUT);
}
function clearActionTimer(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
}

// ─── Connections ──────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  let myId = null, myRoomId = null;

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

        // Reconnect existing player
        const existing = room.seats.find(s => s?.id === myId);
        if (existing) {
          if (existing.autoFold) {
            // Must get host approval to rejoin
            room.pendingJoins.push({ ws, id: myId, name: existing.name, isRejoin: true });
            send(ws, { type: 'waiting', id: myId });
            const host = room.seats.find(s => s?.id === room.hostId);
            if (host?.ws) send(host.ws, { type: 'joinRequest', id: myId, name: existing.name });
            broadcastAll(room, lobbySnapshot(room));
          } else {
            existing.ws = ws; existing.disconnected = false;
            send(ws, { type: 'joined', id: myId, seat: existing.seat, isHost: myId === room.hostId });
            send(ws, lobbySnapshot(room));
            if (room.G) send(ws, tableSnapshot(room, myId));
            broadcastAll(room, { type: 'chat', name: 'System', text: `${existing.name} reconnected` });
          }
          return;
        }

        // New player
        const isEmpty = room.seats.every(s => s === null) && room.pendingJoins.length === 0;
        if (isEmpty) {
          room.seats[0] = mkPlayer(ws, myId, name, 0);
          room.hostId = myId;
          send(ws, { type: 'joined', id: myId, seat: 0, isHost: true });
          broadcastAll(room, lobbySnapshot(room));
          return;
        }
        room.pendingJoins.push({ ws, id: myId, name });
        send(ws, { type: 'waiting', id: myId });
        const host = room.seats.find(s => s?.id === room.hostId);
        if (host?.ws) send(host.ws, { type: 'joinRequest', id: myId, name });
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
            // Re-admit after disconnect
            existSeat.ws = p.ws; existSeat.disconnected = false; existSeat.autoFold = false;
            send(p.ws, { type: 'joined', id: p.id, seat: existSeat.seat, isHost: p.id === room.hostId });
            send(p.ws, lobbySnapshot(room));
            if (room.G) send(p.ws, tableSnapshot(room, p.id));
            broadcastAll(room, { type: 'chat', name: 'System', text: `${existSeat.name} re-admitted` });
          } else {
            const seat = room.seats.findIndex(s => s === null);
            if (seat === -1) { send(p.ws, { type: 'rejected', reason: 'Table full' }); broadcastAll(room, lobbySnapshot(room)); return; }
            room.seats[seat] = mkPlayer(p.ws, p.id, p.name, seat);
            send(p.ws, { type: 'joined', id: p.id, seat, isHost: false });
            if (room.gameActive) {
              room.seats[seat].sittingOut = true;
              send(p.ws, { type: 'sittingOut', reason: 'Hand in progress - joining next hand.' });
              send(p.ws, tableSnapshot(room, p.id));
            }
          }
        } else {
          send(p.ws, { type: 'rejected', reason: 'Host declined' });
        }
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'startGame': {
        const room = rooms.get(myRoomId);
        if (!room || myId !== room.hostId) return;
        const playable = room.seats.filter(s => s && !s.autoFold);
        if (playable.length < 2) { send(ws, { type: 'error', msg: 'Need at least 2 players' }); return; }
        room.gameActive = true;
        broadcastAll(room, { type: 'gameStarting' });
        broadcastAll(room, lobbySnapshot(room));
        startNewHand(room);
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

      case 'chat': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const s = room.seats.find(s => s?.id === myId);
        if (!s) return;
        broadcastAll(room, { type: 'chat', name: s.name, text: (msg.text || '').slice(0, 120) });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!myId || !myRoomId) return;
    const room = rooms.get(myRoomId);
    if (!room) return;
    const pi = room.pendingJoins.findIndex(p => p.id === myId);
    if (pi !== -1) room.pendingJoins.splice(pi, 1);
    const s = room.seats.find(s => s?.id === myId);
    if (!s) return;
    s.ws = null; s.disconnected = true; s.autoFold = true;
    broadcastAll(room, { type: 'chat', name: 'System', text: `${s.name} disconnected - auto-folding until host re-admits` });
    writeLog(room, `DISCONNECT: ${s.name} (seat ${s.seat + 1}) - auto-fold enabled`);
    if (room.G && room.G.toAct[0] === s.seat) {
      clearActionTimer(room);
      doFold(room, s.seat, 'disconnected');
      return;
    }
    if (room.G && !s.folded) {
      s.folded = true;
      const idx = room.G.toAct.indexOf(s.seat);
      if (idx !== -1) room.G.toAct.splice(idx, 1);
      broadcastAll(room, { type: 'playerAction', seat: s.seat, action: 'fold', amount: 0, name: s.name + ' (disconnected)' });
      broadcastState(room);
      const alive = room.seats.filter(p => p && !p.folded);
      if (alive.length <= 1) endRound(room);
    }
  });

  ws.on('error', err => console.error('WS error:', err));
});

function mkPlayer(ws, id, name, seat) {
  return { ws, id, name, chips: START_CHIPS, seat, cards: [], bet: 0, folded: false, disconnected: false, autoFold: false };
}

// ─── Game helpers ─────────────────────────────────────────────────────────────
function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) { const j = 0 | Math.random() * (i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ s, r });
  return shuffle(d);
}

// Active seats = seated, not sitting out, not autoFold/disconnected
function activePlaying(room) {
  return room.seats
    .map((s, i) => (s && !s.sittingOut && !s.autoFold) ? i : null)
    .filter(i => i !== null);
}

function nextSeat(from, active) {
  const sorted = [...active].sort((a, b) => a - b);
  const nxt = sorted.find(i => i > from);
  return nxt !== undefined ? nxt : sorted[0];
}

// Build act order starting from startSeat, cycling through active seats
// Excludes folded, autoFold, and zero-chip players
function buildActOrder(room, startSeat, active) {
  const sorted = [...active].sort((a, b) => a - b);
  let startIdx = sorted.indexOf(startSeat);
  // If startSeat not in active (shouldn't happen but safety), start from 0
  if (startIdx === -1) startIdx = 0;
  const ordered = [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  return ordered.filter(i => {
    const p = room.seats[i];
    return p && !p.folded && !p.autoFold && p.chips > 0;
  });
}

// ─── Hand flow ────────────────────────────────────────────────────────────────
function startNewHand(room) {
  clearActionTimer(room);

  // Clear sittingOut for all (new hand = everyone plays)
  room.seats.forEach(s => { if (s) s.sittingOut = false; });

  // Only include genuinely connected, non-auto-fold players
  const active = activePlaying(room);

  if (active.length < 2) {
    broadcastAll(room, { type: 'waitingForPlayers' });
    room.gameActive = false;
    broadcastAll(room, lobbySnapshot(room));
    return;
  }

  // Advance dealer button (skip autoFold/disconnected)
  room.dealerSeat = room.dealerSeat < 0
    ? active[0]
    : nextSeat(room.dealerSeat, active);

  room.handNum = (room.handNum || 0) + 1;

  // ── Heads-up rule (TDA Rule 34): dealer = SB, acts first preflop ──────────
  // In 3-handed: dealer = UTG (acts first, no blinds posted by dealer)
  //              SB = next left of dealer
  //              BB = next left of SB
  // In 4+ handed: UTG = next left of BB acts first
  //               Dealer acts second-to-last (before SB, BB get option)
  const isHeadsUp = active.length === 2;
  const sbSeat = isHeadsUp ? room.dealerSeat : nextSeat(room.dealerSeat, active);
  const bbSeat = nextSeat(sbSeat, active);

  // Preflop starting seat:
  // Heads-up: SB/dealer acts first
  // 3-handed: dealer = UTG, acts first (nextSeat(bbSeat) wraps back to dealer)
  // 4+ handed: UTG (left of BB) acts first - dealer acts near the end
  const preflopStart = nextSeat(bbSeat, active);

  const logPath = handLogPath(room.id, room.handNum);

  room.G = {
    deck: buildDeck(), phase: 'preflop', pot: 0,
    currentBet: BB,
    lastRaiseIncrement: BB, // tracks the size of the most recent raise, for min-raise calculation
    community: [], toAct: [], sbSeat, bbSeat, isHeadsUp, logPath
  };

  // Reset per-player hand state
  room.seats.forEach(s => { if (s) { s.cards = []; s.bet = 0; s.folded = false; } });

  // Write log header
  const playerSummary = active.map(i => {
    const s = room.seats[i];
    return `${s.name}(seat${i+1}) \u00a3${(s.chips/100).toFixed(2)}`;
  }).join(', ');
  fs.writeFileSync(logPath,
    `SYFM Poker | Room ${room.id} | Hand #${room.handNum}\n` +
    `${new Date().toISOString()}\n` +
    `${'='.repeat(60)}\n` +
    `Players: ${playerSummary}\n` +
    `Dealer: Seat ${room.dealerSeat+1}  SB: Seat ${sbSeat+1} (${SB}p)  BB: Seat ${bbSeat+1} (${BB}p)\n` +
    `Heads-up: ${isHeadsUp}  Active seats: ${active.join(',')}\n` +
    `${'-'.repeat(60)}\n`
  );

  // Post blinds
  room.seats[sbSeat].chips -= SB; room.seats[sbSeat].bet = SB;
  room.seats[bbSeat].chips -= BB; room.seats[bbSeat].bet = BB;
  room.G.pot = SB + BB;

  // Deal 2 hole cards each
  for (let rd = 0; rd < 2; rd++)
    for (const si of active)
      room.seats[si].cards.push(room.G.deck.shift());

  // Log hole cards
  active.forEach(i => {
    const s = room.seats[i];
    writeLog(room, `DEAL: ${s.name} \u2192 ${s.cards.map(c => c.r + c.s).join(' ')}`);
  });

  // Build preflop act order
  room.G.toAct = buildActOrder(room, preflopStart, active);

  broadcastAll(room, {
    type: 'newHand', dealerSeat: room.dealerSeat, sbSeat, bbSeat,
    pot: room.G.pot, activeSeats: active
  });

  room.seats.forEach(s => {
    if (s?.ws?.readyState === 1) send(s.ws, tableSnapshot(room, s.id));
  });

  writeLog(room, `PREFLOP | Pot: ${room.G.pot}p | Act order: ${room.G.toAct.map(i => room.seats[i].name).join(' \u2192 ')}`);
  promptToAct(room);
}

function promptToAct(room) {
  const G = room.G;
  if (!G) return;

  // Skip any players who are now ineligible
  while (G.toAct.length) {
    const si = G.toAct[0];
    const p = room.seats[si];
    if (!p || p.folded || p.autoFold || p.chips === 0) G.toAct.shift();
    else break;
  }

  const alive = room.seats.filter(s => s && !s.folded);
  if (alive.length <= 1) { endRound(room); return; }
  if (!G.toAct.length) { advPhase(room); return; }

  const seat = G.toAct[0];
  const p = room.seats[seat];

  // Auto-fold disconnected/autoFold player immediately
  if (p.disconnected || p.autoFold) {
    clearActionTimer(room);
    doFold(room, seat, 'auto (disconnected)');
    return;
  }

  // ── Min-raise calculation (No-Limit Hold'em rules) ──────────────────────
  // callAmt: what the player needs to put in just to call
  // minRaise: TOTAL chips player must put in from their stack to make the minimum legal raise
  //   = callAmt + lastRaiseIncrement
  //   where lastRaiseIncrement = size of the last raise (or BB if no raise yet)
  // Capped at player's remaining chips (for all-in scenarios)
  const callAmt  = Math.min(G.currentBet - p.bet, p.chips);
  const minRaise = Math.min(callAmt + G.lastRaiseIncrement, p.chips);

  broadcastAll(room, { type: 'yourTurn', seat, callAmt, minRaise, pot: G.pot, currentBet: G.currentBet });
  startActionTimer(room, seat);
}

function doFold(room, seat, reason) {
  const p = room.seats[seat];
  if (!p) return;
  p.folded = true;
  const label = reason ? ` (${reason})` : '';
  broadcastAll(room, { type: 'playerAction', seat, action: 'fold', amount: 0, name: p.name + label });
  writeLog(room, `ACTION: ${p.name} FOLDS${label}`);
  broadcastState(room);
  acted(room, seat, false);
}

function handleAction(room, seat, action, amount) {
  const p = room.seats[seat];
  const G = room.G;
  if (!p || !G) return;

  if (action === 'fold') {
    doFold(room, seat, null);

  } else if (action === 'check' || action === 'call') {
    const ca = Math.min(G.currentBet - p.bet, p.chips);
    p.chips -= ca; p.bet += ca; G.pot += ca;
    const act = ca === 0 ? 'check' : 'call';
    broadcastAll(room, { type: 'playerAction', seat, action: act, amount: ca, name: p.name, pot: G.pot });
    writeLog(room, `ACTION: ${p.name} ${act.toUpperCase()}${ca > 0 ? ` \u00a3${(ca/100).toFixed(2)}` : ''} | Pot: \u00a3${(G.pot/100).toFixed(2)}`);
    broadcastState(room);
    acted(room, seat, false);

  } else if (action === 'raise') {
    // ── Correct No-Limit min-raise ───────────────────────────────────────────
    // minFromStack = callAmount + lastRaiseIncrement
    // Player must put in at LEAST this much from their stack
    const callAmount     = G.currentBet - p.bet;
    const minFromStack   = Math.min(callAmount + G.lastRaiseIncrement, p.chips);
    const raiseFromStack = Math.min(Math.max(amount || minFromStack, minFromStack), p.chips);

    const prevCurrentBet = G.currentBet;
    p.chips -= raiseFromStack;
    p.bet   += raiseFromStack;
    G.pot   += raiseFromStack;
    G.currentBet = Math.max(G.currentBet, p.bet);

    // Update lastRaiseIncrement ONLY if this was a full (non-under) raise
    // Under-raise (all-in less than min) does NOT reset the increment
    if (G.currentBet > prevCurrentBet) {
      G.lastRaiseIncrement = G.currentBet - prevCurrentBet;
    }

    broadcastAll(room, { type: 'playerAction', seat, action: 'raise', amount: raiseFromStack, name: p.name, pot: G.pot });
    writeLog(room,
      `ACTION: ${p.name} RAISES \u00a3${(raiseFromStack/100).toFixed(2)} from stack ` +
      `(total bet: \u00a3${(p.bet/100).toFixed(2)}, new current bet: \u00a3${(G.currentBet/100).toFixed(2)}) ` +
      `| Pot: \u00a3${(G.pot/100).toFixed(2)} | Next min raise increment: \u00a3${(G.lastRaiseIncrement/100).toFixed(2)}`
    );
    broadcastState(room);
    acted(room, seat, true);
  }
}

function broadcastState(room) {
  room.seats.forEach(s => { if (s?.ws?.readyState === 1) send(s.ws, tableSnapshot(room, s.id)); });
}

function acted(room, seat, isRaise) {
  const G = room.G;
  G.toAct.shift();

  if (isRaise) {
    // After a raise: rebuild act order - everyone who hasn't matched currentBet gets another turn
    const active = activePlaying(room).sort((a, b) => a - b);
    const si = active.indexOf(seat);
    const ordered = [...active.slice((si+1)%active.length), ...active.slice(0, (si+1)%active.length)];
    // Proper rotation: start from player after raiser
    const raiserIdx = active.indexOf(seat);
    const rotated = [...active.slice(raiserIdx + 1), ...active.slice(0, raiserIdx + 1)];
    G.toAct = rotated.filter(i => {
      const p = room.seats[i];
      return p && !p.folded && !p.autoFold && p.chips > 0 && p.bet < G.currentBet;
    });
  }

  setTimeout(() => promptToAct(room), 200);
}

function advPhase(room) {
  const G = room.G;
  clearActionTimer(room);
  room.seats.forEach(s => { if (s) s.bet = 0; });
  // Reset betting for new street
  G.currentBet = 0;
  G.lastRaiseIncrement = BB; // min bet on a new street = BB

  const next = { preflop: 'flop', flop: 'turn', turn: 'river' };

  if (G.phase in next) {
    G.phase = next[G.phase];
    const count = G.phase === 'flop' ? 3 : 1;
    const newCards = [];
    for (let i = 0; i < count; i++) { const c = G.deck.shift(); G.community.push(c); newCards.push(c); }

    broadcastAll(room, { type: 'communityDealt', phase: G.phase, cards: G.community, newCards });
    writeLog(room, `${G.phase.toUpperCase()}: ${newCards.map(c => c.r+c.s).join(' ')} | Board: ${G.community.map(c => c.r+c.s).join(' ')}`);
    broadcastState(room);

    const active = activePlaying(room);
    // Postflop: SB (or first active left of dealer) acts first; dealer acts last
    // Heads-up: BB (non-dealer) acts first postflop
    const postStart = G.isHeadsUp ? G.bbSeat : nextSeat(room.dealerSeat, active);
    G.toAct = buildActOrder(room, postStart, active);
    writeLog(room, `${G.phase.toUpperCase()} betting | Act order: ${G.toAct.map(i => room.seats[i].name).join(' \u2192 ')}`);
    setTimeout(() => promptToAct(room), 600);

  } else {
    G.phase = 'showdown';
    showdown(room);
  }
}

function endRound(room) {
  clearActionTimer(room);
  const remaining = room.seats.filter(s => s && !s.folded);
  if (remaining.length === 1) {
    writeLog(room, `RESULT: ${remaining[0].name} wins uncontested`);
    finish(room, remaining[0], 'Last player standing');
  }
}

function showdown(room) {
  clearActionTimer(room);
  const active = room.seats.filter(s => s && !s.folded);
  if (active.length === 1) {
    writeLog(room, `RESULT: ${active[0].name} wins at showdown uncontested`);
    finish(room, active[0], 'Last player standing');
    return;
  }

  broadcastAll(room, { type: 'showdown', reveals: active.map(s => ({ seat: s.seat, name: s.name, cards: s.cards })) });
  broadcastState(room);

  writeLog(room, 'SHOWDOWN:');
  let best = null, bestScore = -1;
  for (const p of active) {
    const allCards = [...p.cards, ...room.G.community];
    const sc = evalBest(allCards);
    const hn = handName(sc);
    const bf = bestFiveCards(allCards);
    writeLog(room, `  ${p.name}: hole=${p.cards.map(c=>c.r+c.s).join(' ')} best=[${bf.map(c=>c.r+c.s).join(' ')}] => ${hn} (${sc.toFixed(0)})`);
    if (sc > bestScore) { bestScore = sc; best = p; }
  }
  writeLog(room, `WINNER: ${best.name} with ${handName(bestScore)}`);
  setTimeout(() => finish(room, best, handName(bestScore)), 1200);
}

function finish(room, winner, label) {
  if (!winner) return;
  clearActionTimer(room);
  const won = room.G.pot;
  winner.chips += won;
  room.G.pot = 0;
  broadcastAll(room, { type: 'winner', seat: winner.seat, name: winner.name, amount: won, label });
  broadcastState(room);

  const chipSummary = room.seats.filter(Boolean).map(s => `${s.name}:\u00a3${(s.chips/100).toFixed(2)}`).join(', ');
  writeLog(room, `POT: \u00a3${(won/100).toFixed(2)} \u2192 ${winner.name}`);
  writeLog(room, `CHIPS: ${chipSummary}`);
  writeLog(room, '='.repeat(60));

  // FTP upload the completed log asynchronously
  const logPath = room.G.logPath;
  if (logPath) setTimeout(() => ftpUpload(logPath), 500);

  setTimeout(() => {
    room.seats.forEach((s, i) => {
      if (s && s.chips <= 0) {
        writeLog(room, `BUST: ${s.name} eliminated`);
        broadcastAll(room, { type: 'playerLeft', id: s.id, name: s.name, seat: i, reason: 'busted' });
        room.seats[i] = null;
      }
    });
    startNewHand(room);
  }, 5000);
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
      isStraight = true; sHigh = uniq[0]; // normal straight
    } else if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) {
      isStraight = true; sHigh = 5; // wheel A-2-3-4-5, Ace plays low → high card = 5
    }
  }

  const pack = rArr => rArr.reduce((acc, r, i) => acc + r * Math.pow(15, 4 - i), 0);
  const freq = groups[0].n, freq2 = groups[1]?.n || 0;

  // Royal flush: broadway (A-high) straight flush only — NOT wheel flush
  if (flush && isStraight && sHigh === 14) return 9e8 + pack(ranks);
  if (flush && isStraight)                  return 8e8 + sHigh * 1e6;  // straight flush inc. steel wheel
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
  console.log(`\n\u2663 SYFM Poker running on port ${PORT}`);
  console.log(`   Game: http://localhost:${PORT}`);
  console.log(`   Logs: http://localhost:${PORT}/logs`);
  console.log(`   FTP:  ${process.env.FTP_HOST || '(not configured)'}\n`);
});
