'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

// ═══════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 10000;
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RVAL  = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const NP    = 9;
const SB    = 10, BB = 20;
const START_CHIPS = 1000;   // pence

// ═══════════════════════════════════════════════════════════
//  HTTP server (serves the HTML game)
// ═══════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading game');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

// ═══════════════════════════════════════════════════════════
//  ROOM STATE
// ═══════════════════════════════════════════════════════════
// seats[0..8]: null | { ws, id, name, chips, cards, bet, folded, sittingOut }
let seats      = Array(NP).fill(null);
let hostId     = null;
let gameActive = false;
let pendingJoins = [];   // { ws, id, name } awaiting host approval

let G = null;   // game state (set when hand starts)

function broadcast(msg, excludeId = null) {
  const str = JSON.stringify(msg);
  seats.forEach(s => {
    if (s && s.id !== excludeId && s.ws.readyState === 1) {
      s.ws.send(str);
    }
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function lobbySnapshot() {
  return {
    type: 'lobby',
    seats: seats.map(s => s ? { id: s.id, name: s.name, chips: s.chips, seat: s.seat } : null),
    hostId,
    gameActive,
    pending: pendingJoins.map(p => ({ id: p.id, name: p.name }))
  };
}

function tableSnapshot(forId) {
  if (!G) return null;
  return {
    type: 'state',
    phase:       G.phase,
    pot:         G.pot,
    currentBet:  G.currentBet,
    community:   G.community,
    dealerSeat:  G.dealerSeat,
    toActSeat:   G.toAct[0] ?? null,
    players: seats.map(s => {
      if (!s) return null;
      return {
        seat:    s.seat,
        name:    s.name,
        chips:   s.chips,
        bet:     s.bet,
        folded:  s.folded,
        // Only reveal hole cards to their owner
        cards:   s.id === forId ? s.cards : (s.cards.length ? s.cards.map(() => 'back') : []),
        revealCards: G.phase === 'showdown' && !s.folded ? s.cards : null
      };
    })
  };
}

// ═══════════════════════════════════════════════════════════
//  CONNECTION HANDLER
// ═══════════════════════════════════════════════════════════
wss.on('connection', ws => {
  let myId   = null;
  let mySeat = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── JOIN REQUEST ──────────────────────────────────────
      case 'join': {
        myId = msg.id || ('p_' + Math.random().toString(36).slice(2, 8));
        const name = (msg.name || 'Player').slice(0, 18);

        // Reconnect: same id already seated?
        const existing = seats.find(s => s && s.id === myId);
        if (existing) {
          existing.ws = ws;
          mySeat = existing.seat;
          send(ws, { type: 'joined', id: myId, seat: mySeat, isHost: myId === hostId });
          send(ws, lobbySnapshot());
          if (gameActive) send(ws, tableSnapshot(myId));
          return;
        }

        // First player becomes host
        const isFirst = seats.every(s => s === null) && pendingJoins.length === 0;
        if (isFirst) {
          const seat = 0;
          seats[seat] = { ws, id: myId, name, chips: START_CHIPS, seat, cards: [], bet: 0, folded: false };
          hostId  = myId;
          mySeat  = seat;
          send(ws, { type: 'joined', id: myId, seat, isHost: true });
          broadcast(lobbySnapshot());
          return;
        }

        // Otherwise queue for host approval
        pendingJoins.push({ ws, id: myId, name });
        send(ws, { type: 'waiting', id: myId });

        // Notify host
        const hostSeat = seats.find(s => s && s.id === hostId);
        if (hostSeat) {
          send(hostSeat.ws, {
            type: 'joinRequest',
            id:   myId,
            name
          });
        }
        break;
      }

      // ── HOST APPROVES / REJECTS ───────────────────────────
      case 'approve': {
        if (myId !== hostId) return;
        const idx = pendingJoins.findIndex(p => p.id === msg.id);
        if (idx === -1) return;
        const p = pendingJoins.splice(idx, 1)[0];

        if (msg.accept) {
          // Find first empty seat
          let seat = seats.findIndex(s => s === null);
          if (seat === -1) {
            send(p.ws, { type: 'rejected', reason: 'Table is full' });
            return;
          }
          seats[seat] = { ws: p.ws, id: p.id, name: p.name, chips: START_CHIPS,
                          seat, cards: [], bet: 0, folded: false };
          mySeat = seat;   // update for their ws context if needed
          // Patch mySeat on the connection (we use closure, so message it)
          send(p.ws, { type: 'joined', id: p.id, seat, isHost: false });
          if (gameActive) {
            // Join mid-game: sit out until next hand
            seats[seat].sittingOut = true;
            send(p.ws, { type: 'sittingOut', reason: 'Hand in progress. You will join next hand.' });
            send(p.ws, tableSnapshot(p.id));
          }
          broadcast(lobbySnapshot());
        } else {
          send(p.ws, { type: 'rejected', reason: 'Host declined your request' });
        }
        break;
      }

      // ── HOST STARTS GAME ──────────────────────────────────
      case 'startGame': {
        if (myId !== hostId) return;
        const activePlayers = seats.filter(s => s !== null);
        if (activePlayers.length < 2) {
          send(ws, { type: 'error', msg: 'Need at least 2 players to start' });
          return;
        }
        gameActive = true;
        broadcast(lobbySnapshot());
        startNewHand();
        break;
      }

      // ── PLAYER ACTION ─────────────────────────────────────
      case 'action': {
        if (!G || !gameActive) return;
        const actingSeat = seats.findIndex(s => s && s.id === myId);
        if (actingSeat === -1) return;
        if (G.toAct[0] !== actingSeat) return;   // not your turn

        handleAction(actingSeat, msg.action, msg.amount);
        break;
      }

      // ── CHAT ──────────────────────────────────────────────
      case 'chat': {
        const s = seats.find(s => s && s.id === myId);
        if (!s) return;
        broadcast({ type: 'chat', name: s.name, text: (msg.text || '').slice(0, 120) });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!myId) return;
    // Remove from pending
    const pi = pendingJoins.findIndex(p => p.id === myId);
    if (pi !== -1) pendingJoins.splice(pi, 1);

    // Mark seated player as disconnected
    const s = seats.find(s => s && s.id === myId);
    if (s) {
      s.ws = null;
      broadcast({ type: 'playerLeft', id: myId, name: s.name, seat: s.seat });
      // Auto-fold if it was their turn
      if (G && G.toAct[0] === s.seat) {
        s.folded = true;
        acted(s.seat, false);
      }
    }
    broadcast(lobbySnapshot());
  });
});

// ═══════════════════════════════════════════════════════════
//  GAME LOGIC
// ═══════════════════════════════════════════════════════════
function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = 0 | Math.random() * (i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ s, r });
  return shuffle(d);
}

function activeSeatIndices() {
  return seats.map((s, i) => s && !s.sittingOut ? i : null).filter(i => i !== null);
}

function startNewHand() {
  // Clear sitting-out flag for players who joined mid-hand
  seats.forEach(s => { if (s) s.sittingOut = false; });

  const active = activeSeatIndices();
  if (active.length < 2) {
    broadcast({ type: 'waitingForPlayers' });
    gameActive = false;
    broadcast(lobbySnapshot());
    return;
  }

  const deck = buildDeck();

  // Find dealer seat (cycle through active seats)
  const dealerSeat = G ? nextActiveSeat(G.dealerSeat, active) : active[0];

  G = {
    deck,
    phase:      'preflop',
    pot:        0,
    currentBet: BB,
    community:  [],
    dealerSeat,
    toAct:      []
  };

  // Reset player state
  seats.forEach(s => {
    if (s) { s.cards = []; s.bet = 0; s.folded = false; }
  });

  // Blinds
  const sbIdx = nextActiveSeat(dealerSeat, active);
  const bbIdx = nextActiveSeat(sbIdx, active);
  seats[sbIdx].chips -= SB; seats[sbIdx].bet = SB;
  seats[bbIdx].chips -= BB; seats[bbIdx].bet = BB;
  G.pot = SB + BB;

  // Deal hole cards
  for (let round = 0; round < 2; round++) {
    for (const si of active) {
      seats[si].cards.push(G.deck.shift());
    }
  }

  // Build toAct order starting left of BB
  const startSeat = nextActiveSeat(bbIdx, active);
  G.toAct = buildActOrder(startSeat, active);

  // Broadcast — each player gets their own view
  broadcast({ type: 'newHand', dealerSeat, sbSeat: sbIdx, bbSeat: bbIdx, pot: G.pot });
  seats.forEach(s => {
    if (s && s.ws && s.ws.readyState === 1) {
      send(s.ws, tableSnapshot(s.id));
    }
  });
  promptToAct();
}

function nextActiveSeat(from, active) {
  const sorted = [...active].sort((a, b) => a - b);
  // find first active seat after 'from'
  const next = sorted.find(i => i > from);
  return next !== undefined ? next : sorted[0];
}

function buildActOrder(startSeat, active) {
  const sorted = [...active].sort((a, b) => a - b);
  const startIdx = sorted.indexOf(startSeat);
  const reordered = [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  return reordered.filter(i => !seats[i].folded && seats[i].chips > 0);
}

function promptToAct() {
  if (!G) return;
  // Remove folded / broke players from queue
  while (G.toAct.length && (seats[G.toAct[0]].folded || seats[G.toAct[0]].chips === 0)) {
    G.toAct.shift();
  }
  const activePlayers = seats.filter(s => s && !s.folded);
  if (activePlayers.length <= 1) { endRound(); return; }
  if (!G.toAct.length)           { advPhase(); return; }

  const seat = G.toAct[0];
  const p    = seats[seat];
  const callAmt = Math.min(G.currentBet - p.bet, p.chips);

  broadcast({
    type:     'yourTurn',
    seat,
    callAmt,
    minRaise: BB * 2,
    pot:      G.pot,
    currentBet: G.currentBet
  });

  // Also send a targeted 'act' message to the acting player
  if (p.ws && p.ws.readyState === 1) {
    send(p.ws, { type: 'act', callAmt, minRaise: BB * 2 });
  }
}

function handleAction(seat, action, amount) {
  const p = seats[seat];
  if (!p) return;

  switch (action) {
    case 'fold': {
      p.folded = true;
      broadcast({ type: 'playerAction', seat, action: 'fold', name: p.name });
      acted(seat, false);
      break;
    }
    case 'check':
    case 'call': {
      const ca = Math.min(G.currentBet - p.bet, p.chips);
      p.chips -= ca; p.bet += ca; G.pot += ca;
      const actionName = ca === 0 ? 'check' : 'call';
      broadcast({ type: 'playerAction', seat, action: actionName, amount: ca, name: p.name, pot: G.pot });
      broadcastState();
      acted(seat, false);
      break;
    }
    case 'raise': {
      const minR  = BB * 2;
      const raise = Math.min(Math.max(amount || minR, minR), p.chips);
      p.chips -= raise; p.bet += raise; G.pot += raise;
      G.currentBet = Math.max(G.currentBet, p.bet);
      broadcast({ type: 'playerAction', seat, action: 'raise', amount: raise, name: p.name, pot: G.pot });
      broadcastState();
      acted(seat, true);
      break;
    }
  }
}

function broadcastState() {
  seats.forEach(s => {
    if (s && s.ws && s.ws.readyState === 1) {
      send(s.ws, tableSnapshot(s.id));
    }
  });
}

function acted(seat, isRaise) {
  G.toAct.shift();
  if (isRaise) {
    // Everyone still active and not yet matched must act again
    const active = activeSeatIndices().filter(i => !seats[i].folded && seats[i].chips > 0 && i !== seat);
    const needToAct = active.filter(i => seats[i].bet < G.currentBet);
    G.toAct = [];
    // Order from left of raiser
    const sorted = [...activeSeatIndices()].sort((a, b) => a - b);
    const startIdx = (sorted.indexOf(seat) + 1) % sorted.length;
    const ordered  = [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
    G.toAct = ordered.filter(i => needToAct.includes(i));
  }
  setTimeout(promptToAct, 200);
}

function advPhase() {
  seats.forEach(s => { if (s) s.bet = 0; });
  G.currentBet = 0;
  const active = activeSeatIndices();
  const map = { preflop: 'flop', flop: 'turn', turn: 'river' };

  if (G.phase in map) {
    G.phase = map[G.phase];
    const count = G.phase === 'flop' ? 3 : 1;
    for (let i = 0; i < count; i++) G.community.push(G.deck.shift());

    broadcast({ type: 'communityDealt', phase: G.phase, cards: G.community });
    broadcastState();

    // Rebuild act order from left of dealer
    const startSeat = nextActiveSeat(G.dealerSeat, active);
    G.toAct = buildActOrder(startSeat, active);
    setTimeout(promptToAct, 400);
  } else {
    G.phase = 'showdown';
    showdown();
  }
}

function endRound() {
  const remaining = seats.filter(s => s && !s.folded);
  if (remaining.length === 1) finish(remaining[0], 'Last player standing');
}

function showdown() {
  const active = seats.filter(s => s && !s.folded);
  if (active.length === 1) { finish(active[0], 'Last player standing'); return; }

  // Reveal all hands
  const reveals = active.map(s => ({ seat: s.seat, name: s.name, cards: s.cards }));
  broadcast({ type: 'showdown', reveals });

  let best = null, bestScore = -1;
  for (const p of active) {
    const sc = evalBest([...p.cards, ...G.community]);
    if (sc > bestScore) { bestScore = sc; best = p; }
  }
  setTimeout(() => finish(best, handName(bestScore)), 800);
}

function finish(winner, label) {
  const won = G.pot;
  winner.chips += won;
  G.pot = 0;
  broadcast({ type: 'winner', seat: winner.seat, name: winner.name, amount: won, label });
  broadcastState();
  setTimeout(() => {
    // Remove busted players
    seats.forEach((s, i) => { if (s && s.chips <= 0) { broadcast({ type: 'playerLeft', id: s.id, name: s.name, seat: i, reason: 'busted' }); seats[i] = null; } });
    startNewHand();
  }, 5000);
}

// ═══════════════════════════════════════════════════════════
//  HAND EVALUATION
// ═══════════════════════════════════════════════════════════
function rv(r) { return RVAL[r] || parseInt(r) || 0; }
function evalBest(cards) {
  const cs = combs(cards, Math.min(cards.length, 5)); let best = 0;
  for (const c of cs) { const s = score5(c); if (s > best) best = s; } return best;
}
function combs(arr, k) {
  if (arr.length <= k) return [arr]; if (k === 1) return arr.map(x => [x]);
  const out = [];
  for (let i = 0; i <= arr.length - k; i++)
    for (const c of combs(arr.slice(i + 1), k - 1)) out.push([arr[i], ...c]);
  return out;
}
function score5(cards) {
  const ranks = cards.map(c => rv(c.r)).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const cnt   = {}; for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  const freq  = Object.values(cnt).sort((a, b) => b - a);
  const flush = suits.every(s => s === suits[0]);
  const uniq  = [...new Set(ranks)].sort((a, b) => b - a);
  let straight = uniq.length >= 5 && (uniq[0] - uniq[4] === 4);
  if (!straight && uniq[0] === 14) {
    const low = uniq.slice(1);
    if (low.length >= 4 && low[0] - low[3] === 3 && low[3] === 2) straight = true;
  }
  const base = ranks.reduce((a, r, i) => a + r * Math.pow(15, 4 - i), 0) / 1e8;
  const hi   = ranks[0];
  if (flush && straight && hi === 14) return 9 + base;
  if (flush && straight) return 8 + base;
  if (freq[0] === 4) return 7 + base;
  if (freq[0] === 3 && freq[1] === 2) return 6 + base;
  if (flush) return 5 + base;
  if (straight) return 4 + base;
  if (freq[0] === 3) return 3 + base;
  if (freq[0] === 2 && freq[1] === 2) return 2 + base;
  if (freq[0] === 2) return 1 + base;
  return base;
}
function handName(s) {
  if (s >= 9) return 'Royal Flush 👑';
  if (s >= 8) return 'Straight Flush';
  if (s >= 7) return 'Four of a Kind';
  if (s >= 6) return 'Full House';
  if (s >= 5) return 'Flush';
  if (s >= 4) return 'Straight';
  if (s >= 3) return 'Three of a Kind';
  if (s >= 2) return 'Two Pair';
  if (s >= 1) return 'One Pair';
  return 'High Card';
}

server.listen(PORT, () => console.log(`Poker server running on port ${PORT}`));
