const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// --- CONFIG ---
let STARTING_CHIPS = 6000;
let SB = 25;
let BB = 50;

// --- STATE ---
let players = {};
let playerOrder = [];
let community = [];
let deck = [];
let pot = 0;
let currentBet = 0;
let dealerIndex = -1; 
let turnIndex = 0;
let gameStage = 'LOBBY'; 
let lastRaiser = null;
let playersActedThisRound = new Set();

const suits = ['♠','♥','♦','♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const rankValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function log(msg) { io.emit('debug_msg', msg); }
function activityLog(msg) { io.emit('activity_log', { msg }); }

function createDeck() {
    const d = [];
    suits.forEach(s => ranks.forEach(r => d.push(r + s)));
    return d.sort(() => Math.random() - 0.5);
}

function parseCard(card) {
    const rank = card.slice(0, -1);
    const suit = card.slice(-1);
    return { rank, suit, value: rankValues[rank] };
}

function evaluateHand(cards) {
    if (cards.length !== 5) return { rank: 0, tiebreakers: [], name: 'Invalid' };
    const parsed = cards.map(parseCard).sort((a, b) => b.value - a.value);
    const values = parsed.map(c => c.value);
    const suitsArr = parsed.map(c => c.suit);
    const valueCounts = {};
    values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);
    const counts = Object.values(valueCounts).sort((a, b) => b - a);
    const uniqueValues = Object.keys(valueCounts).map(Number).sort((a, b) => b - a);
    const isFlush = suitsArr.every(s => s === suitsArr[0]);
    const isStraight = values[0] - values[4] === 4 && new Set(values).size === 5;
    const isLowStraight = values.join(',') === '14,5,4,3,2';
    if (isFlush && isStraight && values[0] === 14) return { rank: 9, tiebreakers: [14], name: 'Royal Flush' };
    if (isFlush && (isStraight || isLowStraight)) return { rank: 8, tiebreakers: [isLowStraight ? 5 : values[0]], name: 'Straight Flush' };
    if (counts[0] === 4) {
        const quad = uniqueValues.find(v => valueCounts[v] === 4);
        const kicker = uniqueValues.find(v => valueCounts[v] === 1);
        return { rank: 7, tiebreakers: [quad, kicker], name: 'Four of a Kind' };
    }
    if (counts[0] === 3 && counts[1] === 2) {
        const trips = uniqueValues.find(v => valueCounts[v] === 3);
        const pair = uniqueValues.find(v => valueCounts[v] === 2);
        return { rank: 6, tiebreakers: [trips, pair], name: 'Full House' };
    }
    if (isFlush) return { rank: 5, tiebreakers: values, name: 'Flush' };
    if (isStraight || isLowStraight) return { rank: 4, tiebreakers: [isLowStraight ? 5 : values[0]], name: 'Straight' };
    if (counts[0] === 3) {
        const trips = uniqueValues.find(v => valueCounts[v] === 3);
        const kickers = uniqueValues.filter(v => valueCounts[v] === 1).sort((a, b) => b - a);
        return { rank: 3, tiebreakers: [trips, ...kickers], name: 'Three of a Kind' };
    }
    if (counts[0] === 2 && counts[1] === 2) {
        const pairs = uniqueValues.filter(v => valueCounts[v] === 2).sort((a, b) => b - a);
        const kicker = uniqueValues.find(v => valueCounts[v] === 1);
        return { rank: 2, tiebreakers: [...pairs, kicker], name: 'Two Pair' };
    }
    if (counts[0] === 2) {
        const pair = uniqueValues.find(v => valueCounts[v] === 2);
        const kickers = uniqueValues.filter(v => valueCounts[v] === 1).sort((a, b) => b - a);
        return { rank: 1, tiebreakers: [pair, ...kickers], name: 'One Pair' };
    }
    return { rank: 0, tiebreakers: values, name: 'High Card' };
}

function findBestHand(sevenCards) {
    let best = null;
    for (let i = 0; i < sevenCards.length; i++) {
        for (let j = i + 1; j < sevenCards.length; j++) {
            const fiveCards = sevenCards.filter((_, idx) => idx !== i && idx !== j);
            const evaluated = evaluateHand(fiveCards);
            if (!best || compareHands(evaluated, best) > 0) {
                best = evaluated;
                best.cards = fiveCards;
            }
        }
    }
    return best;
}

function compareHands(hand1, hand2) {
    if (hand1.rank !== hand2.rank) return hand1.rank > hand2.rank ? 1 : -1;
    for (let i = 0; i < Math.max(hand1.tiebreakers.length, hand2.tiebreakers.length); i++) {
        const t1 = hand1.tiebreakers[i] || 0;
        const t2 = hand2.tiebreakers[i] || 0;
        if (t1 !== t2) return t1 > t2 ? 1 : -1;
    }
    return 0;
}

function getPlayersInHand() {
    return playerOrder.filter(id => (players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN') && players[id].hand.length > 0);
}

function startNewHand() {
    community = []; pot = 0; currentBet = BB;
    playersActedThisRound.clear();
    const active = playerOrder.filter(id => players[id].chips > 0);
    if (active.length < 2) return;
    dealerIndex = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[dealerIndex]].chips <= 0) dealerIndex = (dealerIndex + 1) % playerOrder.length;
    playerOrder.forEach(id => {
        players[id].bet = 0;
        players[id].hand = [];
        players[id].status = players[id].chips > 0 ? 'ACTIVE' : 'OUT';
    });
    deck = createDeck();
    active.forEach(id => { players[id].hand = [deck.pop(), deck.pop()]; });
    const sbIdx = (dealerIndex + 1) % playerOrder.length;
    const bbIdx = (dealerIndex + 2) % playerOrder.length;
    const sbPlayer = playerOrder[sbIdx];
    const bbPlayer = playerOrder[bbIdx];
    players[sbPlayer].chips -= SB; players[sbPlayer].bet = SB;
    players[bbPlayer].chips -= BB; players[bbPlayer].bet = BB;
    pot = SB + BB;
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    gameStage = 'PREFLOP';
    broadcast();
}

function handleAction(socket, action) {
    if (playerOrder[turnIndex] !== socket.id) return;
    const p = players[socket.id];
    playersActedThisRound.add(socket.id);
    if (action.type === 'fold') {
        p.status = 'FOLDED';
    } else if (action.type === 'call') {
        const amt = currentBet - p.bet;
        const actualAmt = Math.min(amt, p.chips);
        p.chips -= actualAmt; 
        p.bet += actualAmt; 
        pot += actualAmt;
        if (p.chips === 0) p.status = 'ALL_IN';
    } else if (action.type === 'raise') {
        const total = action.amt;
        const diff = total - p.bet;
        const actualDiff = Math.min(diff, p.chips);
        p.chips -= actualDiff; 
        p.bet += actualDiff;
        pot += actualDiff;
        currentBet = p.bet;
        playersActedThisRound.clear();
        playersActedThisRound.add(socket.id);
        if (p.chips === 0) p.status = 'ALL_IN';
    }
    const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
    const allActed = activeInHand.every(id => playersActedThisRound.has(id));
    const allMatched = activeInHand.every(id => players[id].bet === currentBet);
    if (activeInHand.length <= 1 || (allActed && allMatched)) {
        advanceStage();
    } else {
        let nextIdx = turnIndex;
        do { nextIdx = (nextIdx + 1) % playerOrder.length; } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
        turnIndex = nextIdx;
        broadcast();
    }
}

function advanceStage() {
    playerOrder.forEach(id => { if(players[id].status !== 'OUT') players[id].bet = 0; });
    currentBet = 0;
    playersActedThisRound.clear();
    if (getPlayersInHand().length <= 1) return showdown();
    if (gameStage === 'PREFLOP') { community = [deck.pop(), deck.pop(), deck.pop()]; gameStage = 'FLOP'; }
    else if (gameStage === 'FLOP') { community.push(deck.pop()); gameStage = 'TURN'; }
    else if (gameStage === 'TURN') { community.push(deck.pop()); gameStage = 'RIVER'; }
    else return showdown();
    let nextIdx = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[nextIdx]].status !== 'ACTIVE') nextIdx = (nextIdx + 1) % playerOrder.length;
    turnIndex = nextIdx;
    broadcast();
}

function showdown() {
    gameStage = 'SHOWDOWN';
    const inHand = getPlayersInHand();
    if (inHand.length === 1) {
        const winnerId = inHand[0];
        players[winnerId].chips += pot;
        setTimeout(() => { gameStage = 'LOBBY'; broadcast(); }, 3000);
        broadcast();
        return;
    }
    const evaluatedPlayers = inHand.map(id => {
        const sevenCards = [...players[id].hand, ...community];
        const bestHand = findBestHand(sevenCards);
        return { id, bestHand };
    });
    evaluatedPlayers.sort((a, b) => compareHands(b.bestHand, a.bestHand));
    const winners = [evaluatedPlayers[0]];
    for (let i = 1; i < evaluatedPlayers.length; i++) {
        if (compareHands(evaluatedPlayers[i].bestHand, winners[0].bestHand) === 0) winners.push(evaluatedPlayers[i]);
    }
    const winAmt = Math.floor(pot / winners.length);
    winners.forEach(w => { players[w.id].chips += winAmt; });
    setTimeout(() => { gameStage = 'LOBBY'; broadcast(); }, 3000);
    broadcast();
}

function broadcast() {
    const sbIdx = (dealerIndex + 1) % playerOrder.length;
    const bbIdx = (dealerIndex + 2) % playerOrder.length;
    playerOrder.forEach(id => {
        io.to(id).emit('update', {
            myId: id, myName: players[id].name, isHost: (id === playerOrder[0]),
            players: playerOrder.map((pid, idx) => ({
                id: pid, name: players[pid].name, chips: players[pid].chips, bet: players[pid].bet, status: players[pid].status,
                isDealer: idx === dealerIndex, isSB: idx === sbIdx, isBB: idx === bbIdx,
                cards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['?','?'] : [])
            })),
            community, pot, gameStage, activeId: playerOrder[turnIndex], currentBet, SB, BB,
            callAmt: currentBet - players[id].bet
        });
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name, chips: STARTING_CHIPS, hand: [], bet: 0, status: 'ACTIVE' };
        playerOrder.push(socket.id);
        gameStage = 'LOBBY';
        broadcast();
    });
    socket.on('start_game', () => startNewHand());
    socket.on('action', (data) => handleAction(socket, data));
    socket.on('reset_engine', () => { if(playerOrder[0] === socket.id) { players={}; playerOrder=[]; io.emit('force_refresh'); } });
    socket.on('disconnect', () => { delete players[socket.id]; playerOrder = playerOrder.filter(id => id !== socket.id); broadcast(); });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
            * { box-sizing: border-box; }
            body { background: #000; color: white; font-family: sans-serif; margin: 0; padding: 0; overflow: hidden; height: 100dvh; display: flex; flex-direction: column; position: fixed; width: 100%; }
            #top-bar { display: flex; justify-content: space-between; padding: 4px 8px; background: rgba(0,0,0,0.5); z-index: 100; flex-shrink: 0; }
            #pot-display { font-size: 20px; color: #2ecc71; font-weight: bold; }
            .game-area { position: relative; flex: 1; display: flex; justify-content: center; align-items: center; min-height: 0; }
            .poker-table { width: 500px; height: 260px; background: #1a5c1a; border: 4px solid #4d260a; border-radius: 130px; position: absolute; display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 1; box-shadow: inset 0 0 15px #000; left: 50%; top: 45%; transform: translate(-50%, -50%); }
            
            /* UPDATED CARD STYLES */
            .card { 
                background: white; color: black; border: 1px solid #000; border-radius: 6px; 
                margin: 2px; font-weight: bold; font-size: 22px; 
                width: 55px; height: 80px;
                display: inline-flex; flex-direction: column; justify-content: center; align-items: center; position: relative;
            }
            .card-small { 
                background: white; color: black; border-radius: 4px; border: 1px solid #000; 
                font-size: 18px; font-weight: bold; 
                width: 45px; height: 65px;
                display: inline-flex; flex-direction: column; justify-content: center; align-items: center; position: relative;
            }
            .suit-corner {
                position: absolute; top: 2px; right: 4px; font-size: 0.6em; color: #666;
            }
            .card.red, .card-small.red { color: #d63031; }
            .card.hidden, .card-small.hidden { background: #2980b9; color: #2980b9; }

            .player-seat { position: absolute; z-index: 10; }
            .player-box { background: #111; border: 2px solid #444; padding: 6px; border-radius: 8px; font-size: 10px; min-width: 100px; text-align: center; }
            .active-turn { border-color: #f1c40f; box-shadow: 0 0 8px #f1c40f; }
            .card-row { display: flex; justify-content: center; gap: 4px; margin: 4px 0; }
            #controls { background: #111; padding: 12px; border-top: 2px solid #333; display: none; justify-content: center; gap: 8px; width: 100%; position: fixed; bottom: 0; z-index: 101; }
            #controls button { flex: 1; padding: 15px 0; font-size: 14px; border-radius: 4px; color: white; font-weight: bold; cursor: pointer; border:none; }
        </style>
    </head>
    <body>
        <div id="top-bar">
            <div id="blinds-overlay">Blinds: <span id="blinds-info">25/50</span></div>
            <div id="pot-display">Pot: £<span id="pot">0</span></div>
        </div>
        <div class="game-area">
            <div class="poker-table">
                <div id="community"></div>
                <div id="action-guide"></div>
            </div>
            <div id="seats"></div>
        </div>
        <div id="controls">
            <button onclick="socket.emit('action', {type:'fold'})" style="background: #c0392b;">FOLD</button>
            <button id="call-btn" onclick="socket.emit('action', {type:'call'})" style="background: #27ae60;">CHECK</button>
            <input type="number" id="bet-amt" value="100" style="width:70px; text-align:center;">
            <button onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})" style="background: #e67e22;">RAISE</button>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const name = prompt("Enter Name:") || "Player";
            socket.emit('join', name);

            function getSuitLetter(suitSymbol) {
                if (suitSymbol === '♠') return 'S';
                if (suitSymbol === '♥') return 'H';
                if (suitSymbol === '♦') return 'D';
                if (suitSymbol === '♣') return 'C';
                return '';
            }

            function renderCard(cardStr, isSmall = false) {
                if (cardStr === '?') return \`<div class="\${isSmall ? 'card-small' : 'card'} hidden">?</div>\`;
                const rank = cardStr.slice(0, -1);
                const suit = cardStr.slice(-1);
                const suitLetter = getSuitLetter(suit);
                const isRed = suit === '♥' || suit === '♦';
                return \`
                    <div class="\${isSmall ? 'card-small' : 'card'} \${isRed ? 'red' : ''}">
                        <div class="suit-corner">\${suitLetter}</div>
                        <div>\${rank}\${suit}</div>
                    </div>\`;
            }

            socket.on('update', (data) => {
                document.getElementById('pot').innerText = data.pot;
                const commDiv = document.getElementById('community');
                commDiv.innerHTML = data.community.map(c => renderCard(c)).join('');
                
                const seatsDiv = document.getElementById('seats');
                seatsDiv.innerHTML = '';
                data.players.forEach((p, i) => {
                    const angle = (i * (360 / data.players.length)) * (Math.PI / 180);
                    const x = 250 * Math.cos(angle);
                    const y = 130 * Math.sin(angle);
                    
                    const seat = document.createElement('div');
                    seat.className = 'player-seat';
                    seat.style.left = \`calc(50% + \${x}px)\`;
                    seat.style.top = \`calc(45% + \${y}px)\`;
                    seat.style.transform = 'translate(-50%, -50%)';
                    
                    const isTurn = data.activeId === p.id;
                    seat.innerHTML = \`
                        <div class="player-box \${isTurn ? 'active-turn' : ''}">
                            <b>\${p.name}</b><br>
                            £\${p.chips}<br>
                            <div class="card-row">
                                \${p.cards.map(c => renderCard(c, true)).join('')}
                            </div>
                            \${p.bet > 0 ? 'Bet: £'+p.bet : ''}
                        </div>\`;
                    seatsDiv.appendChild(seat);
                });

                const controls = document.getElementById('controls');
                controls.style.display = (data.activeId === data.myId && data.gameStage !== 'SHOWDOWN') ? 'flex' : 'none';
                if (data.gameStage === 'LOBBY' && data.isHost) {
                    controls.style.display = 'flex';
                    controls.innerHTML = '<button onclick="socket.emit(\\'start_game\\')" style="background:#2980b9; max-width:100%">START GAME</button>';
                }
            });
        </script>
    </body>
    </html>
    `);
});

http.listen(3000, () => { console.log('Server running on port 3000'); });
