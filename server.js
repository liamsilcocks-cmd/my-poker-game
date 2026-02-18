'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const fs   = require('fs');
const path = require('path');

const PORT  = process.env.PORT || 10000;
const SUITS = ['\u2660','\u2665','\u2666','\u2663'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RVAL  = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
const NP    = 9;
const SB    = 10, BB = 20;
const START_CHIPS = 1000;
const ACTION_TIMEOUT = 15000;

// ─── Logging setup ─────────────────────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

function handLogPath(roomId, handNum) {
  const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  return path.join(LOGS_DIR, `room${roomId}_hand${String(handNum).padStart(4,'0')}_${ts}.txt`);
}

function writeLog(room, line) {
  if (!room.G || !room.G.logPath) return;
  const ts = new Date().toTimeString().slice(0,8);
  fs.appendFileSync(room.G.logPath, `[${ts}] ${line}\n`);
}

// ─── HTTP server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Serve index
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error: index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // List logs
  if (req.url === '/logs') {
    let files;
    try { files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.txt')).sort().reverse(); }
    catch { files = []; }
    const links = files.map(f =>
      `<li><a href="/logs/download/${encodeURIComponent(f)}">${f}</a></li>`
    ).join('');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><title>Hand Logs</title>
      <style>body{font-family:monospace;background:#111;color:#aef;padding:20px}
      a{color:#ffd700}li{margin:4px 0}</style></head>
      <body><h2>&#127921; SYFM Poker - Hand Logs</h2>
      <p>${files.length} log files</p><ul>${links}</ul>
      <p><a href="/">Back to game</a></p></body></html>`);
    return;
  }

  // Download a log file
  const dlMatch = req.url.match(/^\/logs\/download\/(.+)$/);
  if (dlMatch) {
    const filename = decodeURIComponent(dlMatch[1]).replace(/[/\\]/g, '');
    const filepath = path.join(LOGS_DIR, filename);
    if (!filepath.startsWith(LOGS_DIR) || !filename.endsWith('.txt')) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filepath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': `attachment; filename="${filename}"`
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ─── WebSocket server ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const rooms = new Map();
let globalHandNum = 0;

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId, seats: Array(NP).fill(null), hostId: null, gameActive: false,
      pendingJoins: [], G: null, dealerSeat: -1, actionTimer: null, handNum: 0
    });
  }
  return rooms.get(roomId);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastAll(room, msg) {
  const str = JSON.stringify(msg);
  room.seats.forEach(s => { if (s && s.ws && s.ws.readyState === 1) s.ws.send(str); });
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
        seat: s.seat, name: s.name, chips: s.chips, bet: s.bet, folded: s.folded,
        disconnected: s.disconnected || false,
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

// ─── Connection handler ────────────────────────────────────────────────────
wss.on('connection', (ws) => {
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

        // Reconnect attempt for existing player
        const existing = room.seats.find(s => s && s.id === myId);
        if (existing) {
          if (existing.autoFold) {
            // Was auto-folding — must wait for host to re-admit
            room.pendingJoins.push({ ws, id: myId, name: existing.name, isRejoin: true });
            send(ws, { type: 'waiting', id: myId, reason: 'Waiting for host to re-admit you after disconnect.' });
            const hostSeat = room.seats.find(s => s && s.id === room.hostId);
            if (hostSeat && hostSeat.ws) send(hostSeat.ws, { type: 'joinRequest', id: myId, name: existing.name });
            broadcastAll(room, lobbySnapshot(room));
          } else {
            // Normal reconnect - link socket back up
            existing.ws = ws;
            existing.disconnected = false;
            send(ws, { type: 'joined', id: myId, seat: existing.seat, isHost: myId === room.hostId });
            send(ws, lobbySnapshot(room));
            if (room.G) send(ws, tableSnapshot(room, myId));
            broadcastAll(room, { type: 'chat', name: 'System', text: `${existing.name} reconnected` });
          }
          return;
        }

        // Brand new player
        const isEmpty = room.seats.every(s => s === null) && room.pendingJoins.length === 0;
        if (isEmpty) {
          room.seats[0] = { ws, id: myId, name, chips: START_CHIPS, seat: 0, cards: [], bet: 0, folded: false, disconnected: false, autoFold: false };
          room.hostId = myId;
          send(ws, { type: 'joined', id: myId, seat: 0, isHost: true });
          broadcastAll(room, lobbySnapshot(room));
          return;
        }

        room.pendingJoins.push({ ws, id: myId, name });
        send(ws, { type: 'waiting', id: myId });
        const hostSeat = room.seats.find(s => s && s.id === room.hostId);
        if (hostSeat && hostSeat.ws) send(hostSeat.ws, { type: 'joinRequest', id: myId, name });
        break;
      }

      case 'approve': {
        const room = rooms.get(myRoomId);
        if (!room || myId !== room.hostId) return;
        const idx = room.pendingJoins.findIndex(p => p.id === msg.id);
        if (idx === -1) return;
        const p = room.pendingJoins.splice(idx, 1)[0];

        if (msg.accept) {
          // Check if this is a rejoin (was already in a seat with autoFold)
          const existingSeat = room.seats.find(s => s && s.id === p.id);
          if (existingSeat) {
            // Re-admit disconnected player - clear autoFold, restore socket
            existingSeat.ws = p.ws;
            existingSeat.disconnected = false;
            existingSeat.autoFold = false;
            send(p.ws, { type: 'joined', id: p.id, seat: existingSeat.seat, isHost: p.id === room.hostId });
            send(p.ws, lobbySnapshot(room));
            if (room.G) send(p.ws, tableSnapshot(room, p.id));
            broadcastAll(room, { type: 'chat', name: 'System', text: `${existingSeat.name} has been re-admitted` });
          } else {
            // New player
            const seat = room.seats.findIndex(s => s === null);
            if (seat === -1) { send(p.ws, { type: 'rejected', reason: 'Table is full' }); broadcastAll(room, lobbySnapshot(room)); return; }
            room.seats[seat] = { ws: p.ws, id: p.id, name: p.name, chips: START_CHIPS, seat, cards: [], bet: 0, folded: false, disconnected: false, autoFold: false };
            send(p.ws, { type: 'joined', id: p.id, seat, isHost: false });
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
        const active = room.seats.filter(s => s !== null);
        if (active.length < 2) { send(ws, { type: 'error', msg: 'Need at least 2 players' }); return; }
        room.gameActive = true;
        broadcastAll(room, { type: 'gameStarting' });
        broadcastAll(room, lobbySnapshot(room));
        startNewHand(room);
        break;
      }

      case 'action': {
        const room = rooms.get(myRoomId);
        if (!room || !room.G || !room.gameActive) return;
        const actingSeat = room.seats.findIndex(s => s && s.id === myId);
        if (actingSeat === -1 || room.G.toAct[0] !== actingSeat) return;
        clearActionTimer(room);
        handleAction(room, actingSeat, msg.action, msg.amount);
        break;
      }

      case 'chat': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const s = room.seats.find(s => s && s.id === myId);
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

    // Remove from pending if they were waiting
    const pi = room.pendingJoins.findIndex(p => p.id === myId);
    if (pi !== -1) room.pendingJoins.splice(pi, 1);

    const s = room.seats.find(s => s && s.id === myId);
    if (!s) return;

    s.ws = null;
    s.disconnected = true;
    s.autoFold = true; // will auto-fold until host re-admits

    broadcastAll(room, { type: 'chat', name: 'System', text: `${s.name} disconnected - auto-folding until re-admitted` });
    writeLog(room, `DISCONNECT: ${s.name} (seat ${s.seat}) disconnected - auto-fold enabled`);

    // If it's their turn RIGHT NOW, fold immediately
    if (room.G && room.G.toAct[0] === s.seat) {
      clearActionTimer(room);
      doFold(room, s.seat, 'disconnected');
      return;
    }

    // If they're in the current hand but not acting, fold them (remove from toAct)
    if (room.G && !s.folded) {
      s.folded = true;
      const toActIdx = room.G.toAct.indexOf(s.seat);
      if (toActIdx !== -1) room.G.toAct.splice(toActIdx, 1);
      broadcastAll(room, { type: 'playerAction', seat: s.seat, action: 'fold', amount: 0, name: s.name + ' (disconnected)' });
      broadcastState(room);

      // Check if only one player left after this fold
      const alive = room.seats.filter(p => p && !p.folded);
      if (alive.length <= 1) endRound(room);
    }
  });

  ws.on('error', err => console.error('WS error:', err));
});

// ─── Game logic ─────────────────────────────────────────────────────────────
function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) { const j = 0 | Math.random() * (i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ s, r });
  return shuffle(d);
}

function activeSeatsFull(room) {
  return room.seats.map((s, i) => (s && !s.sittingOut) ? i : null).filter(i => i !== null);
}

function nextSeat(from, active) {
  const sorted = [...active].sort((a, b) => a - b);
  const nxt = sorted.find(i => i > from);
  return nxt !== undefined ? nxt : sorted[0];
}

function buildActOrder(room, startSeat, active) {
  const sorted = [...active].sort((a, b) => a - b);
  const startIdx = Math.max(0, sorted.indexOf(startSeat));
  const reordered = [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  return reordered.filter(i => room.seats[i] && !room.seats[i].folded && !room.seats[i].autoFold && room.seats[i].chips > 0);
}

function startNewHand(room) {
  clearActionTimer(room);
  room.seats.forEach(s => { if (s) s.sittingOut = false; });
  const active = activeSeatsFull(room);

  if (active.length < 2) {
    broadcastAll(room, { type: 'waitingForPlayers' });
    room.gameActive = false;
    broadcastAll(room, lobbySnapshot(room));
    return;
  }

  room.dealerSeat = room.dealerSeat < 0 ? active[0] : nextSeat(room.dealerSeat, active);
  room.handNum = (room.handNum || 0) + 1;
  globalHandNum++;

  // Heads-up rule: dealer = small blind, acts first preflop
  const isHeadsUp = active.length === 2;
  const sbSeat = isHeadsUp ? room.dealerSeat : nextSeat(room.dealerSeat, active);
  const bbSeat = nextSeat(sbSeat, active);

  const logPath = handLogPath(room.id, room.handNum);
  room.G = {
    deck: buildDeck(), phase: 'preflop', pot: 0, currentBet: BB,
    community: [], toAct: [], sbSeat, bbSeat, isHeadsUp, logPath
  };

  // Write hand header to log
  const playerList = active.map(i => {
    const s = room.seats[i];
    return `${s.name}(seat${i+1}):£${(s.chips/100).toFixed(2)}`;
  }).join(', ');
  fs.writeFileSync(logPath,
    `SYFM Poker - Room ${room.id} - Hand #${room.handNum}\n` +
    `Date: ${new Date().toISOString()}\n` +
    `Players: ${playerList}\n` +
    `Dealer: Seat ${room.dealerSeat+1} | SB: Seat ${sbSeat+1} (${SB}p) | BB: Seat ${bbSeat+1} (${BB}p)\n` +
    `Heads-up: ${isHeadsUp}\n` +
    `${'─'.repeat(60)}\n`
  );

  room.seats.forEach(s => { if (s) { s.cards = []; s.bet = 0; s.folded = false; } });

  // Auto-fold disconnected players immediately - they sit out this hand
  active.forEach(i => {
    if (room.seats[i].autoFold) room.seats[i].folded = true;
  });

  // Post blinds
  room.seats[sbSeat].chips -= SB; room.seats[sbSeat].bet = SB;
  room.seats[bbSeat].chips -= BB; room.seats[bbSeat].bet = BB;
  room.G.pot = SB + BB;

  // Deal 2 cards each (skip folded/autoFold)
  for (let rd = 0; rd < 2; rd++)
    for (const si of active) {
      if (!room.seats[si].folded) room.seats[si].cards.push(room.G.deck.shift());
    }

  // Log hole cards
  active.forEach(i => {
    const s = room.seats[i];
    if (!s.folded) {
      writeLog(room, `DEAL: ${s.name} receives ${s.cards.map(c => c.r + c.s).join(' ')}`);
    } else {
      writeLog(room, `SKIP: ${s.name} auto-folded (disconnected)`);
    }
  });

  const preflopStart = isHeadsUp ? sbSeat : nextSeat(bbSeat, active);
  room.G.toAct = buildActOrder(room, preflopStart, active);

  broadcastAll(room, {
    type: 'newHand', dealerSeat: room.dealerSeat, sbSeat, bbSeat,
    pot: room.G.pot, activeSeats: active
  });

  room.seats.forEach(s => {
    if (s && s.ws && s.ws.readyState === 1) send(s.ws, tableSnapshot(room, s.id));
  });

  writeLog(room, `PREFLOP begins | Pot: ${room.G.pot}p | To act: ${room.G.toAct.map(i=>room.seats[i].name).join(', ')}`);
  promptToAct(room);
}

function promptToAct(room) {
  const G = room.G;
  if (!G) return;

  // Skip folded/disconnected/chips-out players
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

  // Auto-fold disconnected player
  if (p.disconnected || p.autoFold) {
    clearActionTimer(room);
    doFold(room, seat, 'auto (disconnected)');
    return;
  }

  const callAmt = Math.min(G.currentBet - p.bet, p.chips);
  broadcastAll(room, { type: 'yourTurn', seat, callAmt, minRaise: BB * 2, pot: G.pot, currentBet: G.currentBet });
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
    writeLog(room, `ACTION: ${p.name} ${act.toUpperCase()}${ca > 0 ? ` £${(ca/100).toFixed(2)}` : ''} | Pot: £${(G.pot/100).toFixed(2)}`);
    broadcastState(room);
    acted(room, seat, false);

  } else if (action === 'raise') {
    const minR = Math.max(BB * 2, G.currentBet - p.bet + BB);
    const raise = Math.min(Math.max(amount || minR, minR), p.chips);
    p.chips -= raise; p.bet += raise; G.pot += raise;
    G.currentBet = Math.max(G.currentBet, p.bet);
    broadcastAll(room, { type: 'playerAction', seat, action: 'raise', amount: raise, name: p.name, pot: G.pot });
    writeLog(room, `ACTION: ${p.name} RAISES £${(raise/100).toFixed(2)} (total bet: £${(p.bet/100).toFixed(2)}) | Pot: £${(G.pot/100).toFixed(2)}`);
    broadcastState(room);
    acted(room, seat, true);
  }
}

function broadcastState(room) {
  room.seats.forEach(s => {
    if (s && s.ws && s.ws.readyState === 1) send(s.ws, tableSnapshot(room, s.id));
  });
}

function acted(room, seat, isRaise) {
  const G = room.G;
  G.toAct.shift();

  if (isRaise) {
    const active = activeSeatsFull(room).sort((a, b) => a - b);
    const startIdx = (active.indexOf(seat) + 1) % active.length;
    const ordered = [...active.slice(startIdx), ...active.slice(0, startIdx)];
    G.toAct = ordered.filter(i =>
      room.seats[i] && !room.seats[i].folded && !room.seats[i].autoFold &&
      room.seats[i].chips > 0 && room.seats[i].bet < G.currentBet
    );
  }

  setTimeout(() => promptToAct(room), 200);
}

function advPhase(room) {
  const G = room.G;
  clearActionTimer(room);
  room.seats.forEach(s => { if (s) s.bet = 0; });
  G.currentBet = 0;

  const nextPhase = { preflop: 'flop', flop: 'turn', turn: 'river' };

  if (G.phase in nextPhase) {
    G.phase = nextPhase[G.phase];
    const count = G.phase === 'flop' ? 3 : 1;
    const newCards = [];
    for (let i = 0; i < count; i++) { const c = G.deck.shift(); G.community.push(c); newCards.push(c); }

    const cardStr = newCards.map(c => c.r + c.s).join(' ');
    broadcastAll(room, { type: 'communityDealt', phase: G.phase, cards: G.community, newCards });
    writeLog(room, `${G.phase.toUpperCase()}: ${cardStr} | Community: ${G.community.map(c=>c.r+c.s).join(' ')}`);
    broadcastState(room);

    const active = activeSeatsFull(room);
    const postStart = G.isHeadsUp ? G.bbSeat : nextSeat(room.dealerSeat, active);
    G.toAct = buildActOrder(room, postStart, active);
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
    writeLog(room, `RESULT: ${remaining[0].name} wins uncontested (everyone else folded)`);
    finish(room, remaining[0], 'Last player standing');
  }
}

function showdown(room) {
  clearActionTimer(room);
  const active = room.seats.filter(s => s && !s.folded);
  if (active.length === 1) {
    writeLog(room, `RESULT: ${active[0].name} wins uncontested at showdown`);
    finish(room, active[0], 'Last player standing');
    return;
  }

  broadcastAll(room, { type: 'showdown', reveals: active.map(s => ({ seat: s.seat, name: s.name, cards: s.cards })) });
  broadcastState(room);

  writeLog(room, `SHOWDOWN:`);
  let best = null, bestScore = -1;
  const scores = [];
  for (const p of active) {
    const allCards = [...p.cards, ...room.G.community];
    const sc = evalBest(allCards);
    const hn = handName(sc);
    const bestHand = bestFiveCards(allCards);
    scores.push({ p, sc, hn, bestHand });
    writeLog(room, `  ${p.name}: ${p.cards.map(c=>c.r+c.s).join(' ')} → ${hn} [${bestHand.map(c=>c.r+c.s).join(' ')}] (score: ${sc.toFixed(6)})`);
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

  writeLog(room, `POT: £${(won/100).toFixed(2)} awarded to ${winner.name}`);
  writeLog(room, `CHIPS AFTER: ${room.seats.filter(Boolean).map(s=>`${s.name}:£${(s.chips/100).toFixed(2)}`).join(', ')}`);

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

// ─── Hand evaluator ─────────────────────────────────────────────────────────
// Returns numeric score: higher = better hand. Uses integer math for tiebreakers.
// Score format: category * 10^10 + tiebreaker (base-15 packed ranks)

function rv(r) { return RVAL[r] || parseInt(r) || 0; }

function evalBest(cards) {
  // Pick best 5-card combination from any number of cards
  const cs = combs(cards, Math.min(cards.length, 5));
  let best = -1;
  for (const c of cs) {
    const s = score5(c);
    if (s > best) best = s;
  }
  return best;
}

// Returns the actual best 5 cards (for logging)
function bestFiveCards(cards) {
  const cs = combs(cards, Math.min(cards.length, 5));
  let best = -1, bestCombo = cards.slice(0, 5);
  for (const c of cs) {
    const s = score5(c);
    if (s > best) { best = s; bestCombo = c; }
  }
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
  // Sort cards by rank descending for consistent processing
  const sorted = [...cards].sort((a, b) => rv(b.r) - rv(a.r));
  const ranks = sorted.map(c => rv(c.r));
  const suits = sorted.map(c => c.s);

  // Count occurrences of each rank
  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;

  // Sort by frequency desc, then rank desc (for tiebreakers within pairs etc.)
  const groups = Object.entries(cnt)
    .map(([r, n]) => ({ r: Number(r), n }))
    .sort((a, b) => b.n - a.n || b.r - a.r);

  // Flatten groups into tiebreaker order: pairs/trips first, then kickers
  const tbRanks = groups.flatMap(g => Array(g.n).fill(g.r));

  const flush = suits.every(s => s === suits[0]);

  const uniqRanks = [...new Set(ranks)].sort((a, b) => b - a);

  // Straight detection
  let isStraight = false;
  let straightHighCard = 0;
  if (uniqRanks.length === 5) {
    if (uniqRanks[0] - uniqRanks[4] === 4) {
      // Normal straight
      isStraight = true;
      straightHighCard = uniqRanks[0];
    } else if (uniqRanks[0] === 14 && uniqRanks[1] === 5 && uniqRanks[2] === 4 && uniqRanks[3] === 3 && uniqRanks[4] === 2) {
      // Wheel: A-2-3-4-5 — Ace plays LOW, high card is 5
      isStraight = true;
      straightHighCard = 5;
    }
  }

  // Pack tiebreaker ranks into a base-15 number for comparison
  // Uses tbRanks (group-sorted) for pair/trips tiebreakers, or straight high card
  const packRanks = (rArr) => rArr.reduce((acc, r, i) => acc + r * Math.pow(15, 4 - i), 0);

  const freq = groups[0].n;
  const freq2 = groups[1] ? groups[1].n : 0;

  // Royal flush: broadway straight (A-high = 14) AND flush
  if (flush && isStraight && straightHighCard === 14) return 9e8 + packRanks(ranks);
  // Straight flush (including steel wheel A-2-3-4-5 suited — NOT royal)
  if (flush && isStraight) return 8e8 + straightHighCard * 1e6;
  // Four of a kind
  if (freq === 4) return 7e8 + packRanks(tbRanks);
  // Full house
  if (freq === 3 && freq2 === 2) return 6e8 + packRanks(tbRanks);
  // Flush — tiebreak by rank order
  if (flush) return 5e8 + packRanks(ranks);
  // Straight — tiebreak by high card only
  if (isStraight) return 4e8 + straightHighCard * 1e6;
  // Three of a kind
  if (freq === 3) return 3e8 + packRanks(tbRanks);
  // Two pair
  if (freq === 2 && freq2 === 2) return 2e8 + packRanks(tbRanks);
  // One pair
  if (freq === 2) return 1e8 + packRanks(tbRanks);
  // High card
  return packRanks(ranks);
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

// ─── Start server ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n\u2663 SYFM Poker Server running on port ${PORT}`);
  console.log(`   Game:  http://localhost:${PORT}`);
  console.log(`   Logs:  http://localhost:${PORT}/logs\n`);
});
