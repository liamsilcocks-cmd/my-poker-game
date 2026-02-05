const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// --- CONFIG ---
let STARTING_CHIPS = 6000;
let SB = 25;
let BB = 50;
let BLIND_INTERVAL = 15; 
let TURN_TIME = 15; 

// --- STATE ---
let players = {};
let playerOrder = [];
let community = [];
let deck = [];
let pot = 0;
let currentBet = 0;
let dealerIndex = 0;
let turnIndex = 0;
let gameStage = 'LOBBY'; 
let blindTimer = BLIND_INTERVAL;
let turnTimer = TURN_TIME;

const cardValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function evaluateHand(cards) {
    let values = cards.map(c => cardValues[c.slice(0,-1)]).sort((a,b)=>b-a);
    let counts = {}; values.forEach(v => counts[v] = (counts[v]||0)+1);
    let freq = Object.values(counts).sort((a,b)=>b-a);
    if (freq[0] === 4) return 700 + values[0];
    if (freq[0] === 3 && freq[1] === 2) return 600 + values[0];
    if (freq[0] === 3) return 300 + values[0];
    if (freq[0] === 2 && freq[1] === 2) return 200 + values[0];
    if (freq[0] === 2) return 100 + values[0];
    return values[0];
}

function debug(msg) {
    if (playerOrder.length > 0) {
        io.to(playerOrder[0]).emit('debug_msg', `[DEBUG ${new Date().toLocaleTimeString()}] ${msg}`);
    }
}

function broadcast() {
    playerOrder.forEach(id => {
        io.to(id).emit('update', {
            players: playerOrder.map(pid => ({
                id: pid, name: players[pid].name, chips: players[pid].chips, 
                bet: players[pid].bet, status: players[pid].status,
                displayCards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['🂠','🂠'] : [])
            })),
            community, pot, gameStage, dealerId: playerOrder[dealerIndex], 
            activeId: playerOrder[turnIndex], currentBet, SB, BB, blindTimer, turnTimer,
            isHost: id === playerOrder[0]
        });
    });
}

setInterval(() => {
    if (gameStage === 'LOBBY') return;
    if (blindTimer > 0) blindTimer--;
    else { 
        SB *= 2; BB *= 2; blindTimer = BLIND_INTERVAL; 
        debug(`Blinds Up: ${SB}/${BB}`);
    }
    if (!['SHOWDOWN', 'DEALER_DRAW', 'LOBBY'].includes(gameStage)) {
        if (turnTimer > 0) turnTimer--;
        else handleAction(playerOrder[turnIndex], 'fold');
    }
}, 1000);

function startNewHand() {
    gameStage = 'PREFLOP';
    deck = (function(){
        const suits=['♥','♦','♣','♠'], vals=Object.keys(cardValues);
        let d=[]; for(let s of suits) for(let v of vals) d.push(v+s);
        return d.sort(()=>Math.random()-0.5);
    })();
    community = []; pot = 0; currentBet = BB; turnTimer = TURN_TIME;
    playerOrder.forEach(id => {
        players[id].hand = [deck.pop(), deck.pop()];
        players[id].bet = 0;
        players[id].status = players[id].chips > 0 ? 'ACTIVE' : 'OUT';
    });
    let sbIdx = (dealerIndex + 1) % playerOrder.length;
    let bbIdx = (dealerIndex + 2) % playerOrder.length;
    players[playerOrder[sbIdx]].chips -= SB; players[playerOrder[sbIdx]].bet = SB;
    players[playerOrder[bbIdx]].chips -= BB; players[playerOrder[bbIdx]].bet = BB;
    pot = SB + BB;
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    broadcast();
}

function handleAction(id, type, amount = 0) {
    if (id !== playerOrder[turnIndex]) return;
    let p = players[id];
    if (type === 'fold') p.status = 'FOLDED';
    else if (type === 'call') {
        let diff = currentBet - p.bet;
        p.chips -= diff; p.bet += diff; pot += diff;
    } else if (type === 'raise') {
        let totalRaise = currentBet + amount;
        let diff = totalRaise - p.bet;
        p.chips -= diff; p.bet += totalRaise; pot += diff;
        currentBet = totalRaise;
    }
    turnTimer = TURN_TIME;
    nextStep();
}

function nextStep() {
    let active = playerOrder.filter(id => players[id].status === 'ACTIVE');
    let roundOver = active.every(id => players[id].bet === currentBet);
    if (roundOver) {
        if (gameStage === 'PREFLOP') { community = [deck.pop(), deck.pop(), deck.pop()]; gameStage = 'FLOP'; }
        else if (gameStage === 'FLOP') { community.push(deck.pop()); gameStage = 'TURN'; }
        else if (gameStage === 'TURN') { community.push(deck.pop()); gameStage = 'RIVER'; }
        else if (gameStage === 'RIVER') return showdown();
        currentBet = 0;
        playerOrder.forEach(id => players[id].bet = 0);
        turnIndex = (dealerIndex + 1) % playerOrder.length;
    } else {
        turnIndex = (turnIndex + 1) % playerOrder.length;
        if (players[playerOrder[turnIndex]].status !== 'ACTIVE') nextStep();
    }
    broadcast();
}

function showdown() {
    gameStage = 'SHOWDOWN';
    let winners = [];
    let bestScore = -1;
    playerOrder.forEach(id => {
        if (players[id].status === 'ACTIVE') {
            let score = evaluateHand([...players[id].hand, ...community]);
            if (score > bestScore) { bestScore = score; winners = [id]; }
            else if (score === bestScore) { winners.push(id); }
        }
    });
    let winAmt = Math.floor(pot / winners.length);
    winners.forEach(id => players[id].chips += winAmt);
    setTimeout(() => {
        dealerIndex = (dealerIndex + 1) % playerOrder.length;
        startNewHand();
    }, 5000);
}

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { background: #1a1a1a; color: white; font-family: monospace; margin: 0; overflow: hidden; text-align: center; }
            .poker-table { position: relative; width: 600px; height: 350px; background: #1a472a; border: 10px solid #5d3a1a; border-radius: 200px; margin: 40px auto; }
            .player-seat { position: absolute; width: 110px; transform: translate(-50%, -50%); }
            .player-box { background: #000; border: 1px solid #fff; padding: 8px; border-radius: 8px; font-size: 0.8em; }
            .active-turn { border-color: #f1c40f; box-shadow: 0 0 10px #f1c40f; }
            .controls { position: fixed; bottom: 10px; width: 100%; display:none; background: rgba(0,0,0,0.8); padding: 10px 0; }
            #debug-window { position: fixed; top: 0; right: 0; width: 300px; height: 100vh; background: #000; color: #0f0; font-size: 10px; text-align: left; overflow-y: scroll; padding: 10px; border-left: 1px solid #333; display: none; }
            #timer-bar { height: 4px; background: #f1c40f; width: 100%; }
            #start-btn { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); padding: 15px 30px; font-size: 1.2em; cursor: pointer; background: #27ae60; color: white; border: none; border-radius: 5px; z-index: 200; }
        </style>
    </head>
    <body>
        <div id="debug-window"><b>SYSTEM DEBUG LOG</b><hr></div>
        <div id="ui">Blinds: <span id="blinds"></span> | Next Raise: <span id="b-timer"></span>s</div>
        <div class="poker-table">
            <div id="community" style="margin-top: 140px; font-size: 1.5em; letter-spacing: 3px;"></div>
            <div id="pot" style="color: #f1c40f;">Pot: 0</div>
            <div id="seats"></div>
        </div>
        <div id="controls" class="controls">
            <div id="timer-bar"></div><br>
            <button onclick="socket.emit('action', {type:'fold'})">FOLD</button>
            <button onclick="socket.emit('action', {type:'call'})">CALL/CHECK</button>
            <button onclick="socket.emit('action', {type:'raise', amt:100})">RAISE 100</button>
        </div>
        <button id="start-btn" onclick="socket.emit('start_game')">START GAME</button>
        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const name = prompt("Name?") || "Player";
            socket.emit('join', name);
            socket.on('debug_msg', (msg) => {
                const win = document.getElementById('debug-window');
                win.innerHTML += '<div>' + msg + '</div>';
                win.scrollTop = win.scrollHeight;
            });
            socket.on('update', (data) => {
                if (data.isHost) document.getElementById('debug-window').style.display = 'block';
                document.getElementById('blinds').innerText = data.SB + "/" + data.BB;
                document.getElementById('b-timer').innerText = data.blindTimer;
                document.getElementById('pot').innerText = "Pot: £" + data.pot;
                document.getElementById('community').innerText = data.community.join(' ');
                document.getElementById('start-btn').style.display = (data.gameStage === 'LOBBY' && data.isHost) ? 'block' : 'none';
                document.getElementById('controls').style.display = (socket.id === data.activeId) ? 'block' : 'none';
                document.getElementById('timer-bar').style.width = (data.turnTimer / 15 * 100) + "%";
                const area = document.getElementById('seats');
                area.innerHTML = '';
                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI + (Math.PI / 2);
                    const x = Math.cos(angle) * 380; const y = Math.sin(angle) * 230;
                    area.innerHTML += \`
                        <div class="player-seat" style="left:calc(50% + \${x}px); top:calc(50% + \${y}px)">
                            <div class="player-box \${p.id === data.activeId ? 'active-turn' : ''}">
                                <b>\${p.name}</b><br>£\${p.chips}<br>
                                <span style="font-size:1.2em">\${p.displayCards.join(' ')}</span><br>
                                <small>\${p.status === 'FOLDED' ? 'OUT' : 'Bet: ' + p.bet}</small>
                            </div>
                        </div>\`;
                });
            });
        </script>
    </body>
    </html>
    `);
});

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name, hand: [], chips: 0, bet: 0, status: 'LOBBY' };
        playerOrder.push(socket.id);
        debug(`New connection: ${name}`);
        broadcast();
    });
    socket.on('start_game', () => {
        if (socket.id !== playerOrder[0]) return;
        debug("Starting Game: Initializing Chips...");
        playerOrder.forEach(id => {
            players[id].chips = STARTING_CHIPS;
            players[id].status = 'ACTIVE';
        });
        startNewHand();
    });
    socket.on('action', (data) => handleAction(socket.id, data.type, data.amt));
    socket.on('disconnect', () => {
        playerOrder = playerOrder.filter(id => id !== socket.id);
        delete players[socket.id];
        broadcast();
    });
});

const PORT = process.env.PORT || 10000;
http.listen(PORT, () => console.log('DEBUG Engine Online'));
