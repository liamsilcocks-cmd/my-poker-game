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
let turnTimer = null;
let turnTimeRemaining = 30;

const suits = ['♠','♥','♦','♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const rankValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function log(msg) { io.emit('debug_msg', msg); }
function activityLog(msg) { io.emit('activity_log', { msg }); }

function startTurnTimer() {
    if (turnTimer) clearInterval(turnTimer);
    turnTimeRemaining = 30;
    const currentPlayer = players[playerOrder[turnIndex]];
    if (currentPlayer && currentPlayer.autoFold) {
        currentPlayer.status = 'FOLDED';
        currentPlayer.hand = [];
        playersActedThisRound.add(playerOrder[turnIndex]);
        const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
        if (activeInHand.length <= 1 || (activeInHand.every(id => playersActedThisRound.has(id)) && activeInHand.every(id => players[id].bet === currentBet))) {
            advanceStage();
        } else {
            let nextIdx = turnIndex;
            do { nextIdx = (nextIdx + 1) % playerOrder.length; } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
            turnIndex = nextIdx;
            startTurnTimer();
            broadcast();
        }
        return;
    }
    turnTimer = setInterval(() => {
        turnTimeRemaining--;
        broadcast();
        if (turnTimeRemaining <= 0) {
            clearInterval(turnTimer);
            const currentPlayer = players[playerOrder[turnIndex]];
            currentPlayer.status = 'FOLDED';
            currentPlayer.hand = [];
            playersActedThisRound.add(playerOrder[turnIndex]);
            const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
            if (activeInHand.length <= 1 || (activeInHand.every(id => playersActedThisRound.has(id)) && activeInHand.every(id => players[id].bet === currentBet))) {
                advanceStage();
            } else {
                let nextIdx = turnIndex;
                do { nextIdx = (nextIdx + 1) % playerOrder.length; } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
                turnIndex = nextIdx;
                startTurnTimer();
                broadcast();
            }
        }
    }, 1000);
}

function stopTurnTimer() {
    if (turnTimer) { clearInterval(turnTimer); turnTimer = null; }
    turnTimeRemaining = 30;
}

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
    const suits = parsed.map(c => c.suit);
    const valueCounts = {};
    values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);
    const counts = Object.values(valueCounts).sort((a, b) => b - a);
    const uniqueValues = Object.keys(valueCounts).map(Number).sort((a, b) => b - a);
    const isFlush = suits.every(s => s === suits[0]);
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
    players[playerOrder[sbIdx]].chips -= SB; players[playerOrder[sbIdx]].bet = SB;
    players[playerOrder[bbIdx]].chips -= BB; players[playerOrder[bbIdx]].bet = BB;
    pot = SB + BB;
    
    log(`🃏 NEW HAND STARTED`);
    active.forEach(id => {
        // This is the debug line modification requested
        log(`  ${players[id].name}: ${players[id].hand.join(' ')}`);
    });
    
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    gameStage = 'PREFLOP';
    startTurnTimer();
    broadcast();
}

function handleAction(socket, action) {
    if (playerOrder[turnIndex] !== socket.id) return;
    const p = players[socket.id];
    playersActedThisRound.add(socket.id);
    if (action.type === 'fold') {
        p.status = 'FOLDED'; p.hand = [];
    } else if (action.type === 'call') {
        const amt = currentBet - p.bet;
        const actualAmt = Math.min(amt, p.chips);
        p.chips -= actualAmt; p.bet += actualAmt; pot += actualAmt;
        if (p.chips === 0) p.status = 'ALL_IN';
    } else if (action.type === 'raise') {
        const total = action.amt;
        const diff = total - p.bet;
        const actualDiff = Math.min(diff, p.chips);
        p.chips -= actualDiff; p.bet += actualDiff; pot += actualDiff;
        currentBet = p.bet;
        playersActedThisRound.clear();
        playersActedThisRound.add(socket.id);
        if (p.chips === 0) p.status = 'ALL_IN';
    }
    const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
    if (activeInHand.length <= 1 || (activeInHand.every(id => playersActedThisRound.has(id)) && activeInHand.every(id => players[id].bet === currentBet))) {
        stopTurnTimer();
        advanceStage();
    } else {
        let nextIdx = turnIndex;
        do { nextIdx = (nextIdx + 1) % playerOrder.length; } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
        turnIndex = nextIdx;
        startTurnTimer();
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
    startTurnTimer();
    broadcast();
}

function showdown() {
    stopTurnTimer();
    gameStage = 'SHOWDOWN';
    const inHand = getPlayersInHand();
    if (inHand.length === 1) {
        players[inHand[0]].chips += pot;
    } else {
        const evaluated = inHand.map(id => ({ id, bestHand: findBestHand([...players[id].hand, ...community]) }));
        evaluated.sort((a, b) => compareHands(b.bestHand, a.bestHand));
        const winners = evaluated.filter(e => compareHands(e.bestHand, evaluated[0].bestHand) === 0);
        winners.forEach(w => { players[w.id].chips += Math.floor(pot / winners.length); });
    }
    setTimeout(() => { gameStage = 'LOBBY'; broadcast(); }, 4000);
    broadcast();
}

function broadcast() {
    playerOrder.forEach(id => {
        io.to(id).emit('update', {
            myId: id, players: playerOrder.map(pid => ({
                id: pid, name: players[pid].name, chips: players[pid].chips, bet: players[pid].bet, status: players[pid].status,
                cards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['?','?'] : [])
            })),
            community, pot, gameStage, activeId: playerOrder[turnIndex], timeRemaining: turnTimeRemaining
        });
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name, chips: STARTING_CHIPS, hand: [], bet: 0, status: 'ACTIVE', autoFold: false };
        playerOrder.push(socket.id);
        broadcast();
    });
    socket.on('start_game', () => startNewHand());
    socket.on('action', (data) => handleAction(socket, data));
});

// --- FULL FRONTEND UI ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html><html><head><title>Poker Tournament</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { background: #1a472a; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; }
        .table { width: 80%; border: 10px solid #5d4037; border-radius: 100px; padding: 50px; margin: 20px; position: relative; background: #2e7d32; }
        .card { display: inline-block; width: 45px; height: 65px; background: white; color: black; border-radius: 5px; margin: 5px; line-height: 65px; font-weight: bold; font-size: 1.1em; border: 1px solid #000; text-align: center; vertical-align: middle; }
        .player { margin: 10px; padding: 15px; border: 2px solid #ccc; border-radius: 10px; width: 300px; }
        .active-player { border-color: #ffeb3b; background: rgba(255, 235, 59, 0.2); box-shadow: 0 0 15px #ffeb3b; }
        .controls { background: #333; padding: 20px; border-radius: 10px; margin-top: 10px; }
        #debug { width: 90%; background: #000; color: #0f0; padding: 10px; height: 180px; overflow-y: scroll; font-family: monospace; text-align: left; border: 1px solid #444; }
        button { padding: 10px 15px; margin: 5px; cursor: pointer; font-weight: bold; }
    </style></head>
    <body>
        <h1>Poker Table</h1>
        <div id="lobby">
            <input type="text" id="playerName" placeholder="Your Name" style="padding:10px">
            <button onclick="join()">Join Game</button>
        </div>
        <div id="gameView" style="display:none">
            <div class="table">
                <div id="communityCards"></div>
                <h2 id="potDisplay">Pot: 0</h2>
            </div>
            <div id="playerList" style="display:flex; flex-wrap:wrap; justify-content:center;"></div>
            <div class="controls">
                <button onclick="sendAction('fold')">Fold</button>
                <button onclick="sendAction('call')">Check/Call</button>
                <input type="number" id="raiseAmt" style="width:70px; padding:8px" placeholder="Amt">
                <button onclick="sendAction('raise')">Raise</button>
                <button id="startBtn" onclick="socket.emit('start_game')" style="display:none; background:#4CAF50; color:white;">Deal Hand</button>
            </div>
        </div>
        <h3>Debug Log</h3>
        <div id="debug"></div>

        <script>
            const socket = io();
            function join() {
                const name = document.getElementById('playerName').value;
                if(!name) return;
                socket.emit('join', name);
                document.getElementById('lobby').style.display = 'none';
                document.getElementById('gameView').style.display = 'block';
            }
            function sendAction(type) {
                const amt = parseInt(document.getElementById('raiseAmt').value) || 0;
                socket.emit('action', { type, amt });
            }
            socket.on('update', (data) => {
                document.getElementById('potDisplay').innerText = "Pot: " + data.pot;
                document.getElementById('communityCards').innerHTML = data.community.map(c => '<div class="card">'+c+'</div>').join('');
                let html = '';
                data.players.forEach(p => {
                    const activeClass = p.id === data.activeId ? 'active-player' : '';
                    html += '<div class="player ' + activeClass + '">';
                    html += '<strong>' + p.name + '</strong><br>Chips: ' + p.chips + ' | Bet: ' + p.bet + '<br>';
                    html += p.cards.map(c => '<div class="card">'+c+'</div>').join('');
                    if(p.id === data.activeId) html += '<br>⏳ ' + data.timeRemaining + 's';
                    html += '</div>';
                });
                document.getElementById('playerList').innerHTML = html;
                document.getElementById('startBtn').style.display = (data.gameStage === 'LOBBY' || data.gameStage === 'SHOWDOWN' ? 'inline-block' : 'none');
            });
            socket.on('debug_msg', (msg) => {
                const d = document.getElementById('debug');
                d.innerHTML += msg + '<br>';
                d.scrollTop = d.scrollHeight;
            });
        </script>
    </body></html>`);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log('Server running on port ' + PORT); });
