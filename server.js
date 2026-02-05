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
let lastRaiser = null;

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
        io.to(playerOrder[0]).emit('debug_msg', `[SYSTEM] ${msg}`);
    }
}

function broadcast() {
    const sbIdx = (dealerIndex + 1) % playerOrder.length;
    const bbIdx = (dealerIndex + 2) % playerOrder.length;

    playerOrder.forEach(id => {
        const me = players[id];
        const canCheck = (currentBet === 0) || (gameStage === 'PREFLOP' && id === playerOrder[bbIdx] && currentBet === BB && me.bet === BB);
        const canCall = (currentBet > me.bet);

        io.to(id).emit('update', {
            players: playerOrder.map((pid, idx) => ({
                id: pid, name: players[pid].name, chips: players[pid].chips, 
                bet: players[pid].bet, status: players[pid].status,
                role: idx === dealerIndex ? 'D' : (idx === sbIdx ? 'SB' : (idx === bbIdx ? 'BB' : '')),
                displayCards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['🂠','🂠'] : [])
            })),
            community, pot, gameStage, activeId: playerOrder[turnIndex], currentBet, SB, BB, blindTimer, turnTimer,
            isHost: id === playerOrder[0],
            canCheck, canCall
        });
    });
}

setInterval(() => {
    if (gameStage === 'LOBBY') return;
    if (blindTimer > 0) blindTimer--;
    else { 
        SB *= 2; BB *= 2; blindTimer = BLIND_INTERVAL; 
        debug(`Blinds: ${SB}/${BB}`);
    }
    if (!['SHOWDOWN', 'LOBBY'].includes(gameStage)) {
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
    
    lastRaiser = playerOrder[bbIdx];
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    // Ensure turnIndex is on an active player
    while(players[playerOrder[turnIndex]].status !== 'ACTIVE') turnIndex = (turnIndex + 1) % playerOrder.length;
    broadcast();
}

function handleAction(id, type, amount = 0) {
    if (id !== playerOrder[turnIndex]) return;
    let p = players[id];

    if (type === 'fold') { p.status = 'FOLDED'; }
    else if (type === 'call') {
        let diff = currentBet - p.bet;
        p.chips -= diff; p.bet += diff; pot += diff;
    } else if (type === 'raise') {
        let raiseTotal = currentBet + amount;
        let diff = raiseTotal - p.bet;
        p.chips -= diff; p.bet += raiseTotal; pot += diff;
        currentBet = raiseTotal;
        lastRaiser = id;
    }
    
    turnTimer = TURN_TIME;
    nextStep();
}

function nextStep() {
    let active = playerOrder.filter(id => players[id].status === 'ACTIVE');
    
    // If only one person left, they win immediately
    if (active.length === 1) return showdown(active[0]);

    let allMatched = active.every(id => players[id].bet === currentBet);
    
    if (allMatched && playerOrder[turnIndex] === lastRaiser) {
        if (gameStage === 'PREFLOP') { community = [deck.pop(), deck.pop(), deck.pop()]; gameStage = 'FLOP'; }
        else if (gameStage === 'FLOP') { community.push(deck.pop()); gameStage = 'TURN'; }
        else if (gameStage === 'TURN') { community.push(deck.pop()); gameStage = 'RIVER'; }
        else if (gameStage === 'RIVER') return showdown();
        
        currentBet = 0;
        playerOrder.forEach(id => players[id].bet = 0);
        turnIndex = (dealerIndex + 1) % playerOrder.length;
        while(players[playerOrder[turnIndex]].status !== 'ACTIVE') turnIndex = (turnIndex + 1) % playerOrder.length;
        lastRaiser = playerOrder[(turnIndex + playerOrder.length - 1) % playerOrder.length];
    } else {
        turnIndex = (turnIndex + 1) % playerOrder.length;
        if (players[playerOrder[turnIndex]].status !== 'ACTIVE') return nextStep();
    }
    broadcast();
}

function showdown(soleWinnerId = null) {
    gameStage = 'SHOWDOWN';
    let winners = [];
    if (soleWinnerId) {
        winners = [soleWinnerId];
    } else {
        let bestScore = -1;
        playerOrder.forEach(id => {
            if (players[id].status === 'ACTIVE') {
                let score = evaluateHand([...players[id].hand, ...community]);
                if (score > bestScore) { bestScore = score; winners = [id]; }
                else if (score === bestScore) { winners.push(id); }
            }
        });
    }

    let winAmt = Math.floor(pot / winners.length);
    winners.forEach(id => players[id].chips += winAmt);
    
    setTimeout(() => {
        dealerIndex = (dealerIndex + 1) % playerOrder.length;
        startNewHand();
    }, 4000);
    broadcast();
}

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { background: #121212; color: white; font-family: 'Segoe UI', sans-serif; margin: 0; overflow: hidden; text-align: center; }
            .poker-table { position: relative; width: 800px; height: 450px; background: radial-gradient(#2d5a27, #1a3c1a); border: 15px solid #3d2b1f; border-radius: 250px; margin: 50px auto; box-shadow: 0 0 50px rgba(0,0,0,0.5); }
            .player-seat { position: absolute; width: 150px; transform: translate(-50%, -50%); transition: all 0.3s; }
            .player-box { background: #1a1a1a; border: 2px solid #444; padding: 15px; border-radius: 12px; font-size: 1.1em; position: relative; }
            .active-turn { border-color: #f1c40f; box-shadow: 0 0 20px #f1c40f; transform: scale(1.05); }
            
            .role-circle { position: absolute; top: -12px; right: -12px; width: 30px; height: 30px; border-radius: 50%; line-height: 30px; font-weight: bold; color: black; font-size: 0.8em; border: 2px solid #000; }
            .role-D { background: white; }
            .role-SB { background: #3498db; color: white; }
            .role-BB { background: #f1c40f; }

            .controls { position: fixed; bottom: 0; width: 100%; display:none; background: rgba(0,0,0,0.9); padding: 30px 0; border-top: 4px solid #f1c40f; z-index: 500; }
            #debug-window { position: fixed; top: 0; right: 0; width: 280px; height: 100vh; background: #000; color: #0f0; font-family: monospace; font-size: 11px; text-align: left; overflow-y: scroll; padding: 10px; display: none; border-left: 2px solid #333; }
            #timer-bar { height: 8px; background: #f1c40f; width: 100%; position: absolute; top: 0; }
            button { padding: 15px 30px; margin: 0 10px; cursor: pointer; font-weight: bold; border-radius: 8px; border: none; font-size: 1em; text-transform: uppercase; }
            .btn-check { background: #95a5a6; }
            .btn-call { background: #f39c12; }
            .btn-fold { background: #e74c3c; color: white; }
            .btn-raise { background: #2980b9; color: white; }
            #start-btn { position: fixed; bottom: 20px; left: 20px; padding: 20px 40px; background: #27ae60; color: white; border: none; border-radius: 10px; cursor: pointer; font-size: 1.2em; }
        </style>
    </head>
    <body>
        <div id="debug-window"><b>ENGINE LOGS</b><hr></div>
        <div id="ui" style="padding: 20px; font-size: 1.2em;">Blinds: <span id="blinds"></span> | Raise in: <span id="b-timer"></span>s</div>
        <div class="poker-table">
            <div id="community" style="margin-top: 170px; font-size: 2.5em; letter-spacing: 5px;"></div>
            <div id="pot" style="color: #f1c40f; font-weight: bold; font-size: 1.8em; margin-top: 20px;">Pot: 0</div>
            <div id="seats"></div>
        </div>
        <div id="controls" class="controls">
            <div id="timer-bar"></div>
            <button class="btn-fold" onclick="socket.emit('action', {type:'fold'})">Fold</button>
            <button id="check-btn" class="btn-check" onclick="socket.emit('action', {type:'check'})">Check</button>
            <button id="call-btn" class="btn-call" onclick="socket.emit('action', {type:'call'})">Call</button>
            <button class="btn-raise" onclick="socket.emit('action', {type:'raise', amt:100})">Raise 100</button>
        </div>
        <button id="start-btn" onclick="socket.emit('start_game')">START TOURNAMENT</button>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const name = prompt("Enter Name") || "Player";
            socket.emit('join', name);
            socket.on('debug_msg', (msg) => {
                const win = document.getElementById('debug-window');
                win.innerHTML += '<div>' + msg + '</div>'; win.scrollTop = win.scrollHeight;
            });
            socket.on('update', (data) => {
                if (data.isHost) document.getElementById('debug-window').style.display = 'block';
                document.getElementById('blinds').innerText = data.SB + "/" + data.BB;
                document.getElementById('b-timer').innerText = data.blindTimer;
                document.getElementById('pot').innerText = "POT: £" + data.pot;
                document.getElementById('community').innerText = data.community.join(' ');
                document.getElementById('start-btn').style.display = (data.gameStage === 'LOBBY' && data.isHost) ? 'block' : 'none';
                
                const isMyTurn = socket.id === data.activeId && data.gameStage !== 'SHOWDOWN';
                document.getElementById('controls').style.display = isMyTurn ? 'block' : 'none';
                if (isMyTurn) {
                    document.getElementById('check-btn').style.display = data.canCheck ? 'inline-block' : 'none';
                    document.getElementById('call-btn').style.display = data.canCall ? 'inline-block' : 'none';
                }

                document.getElementById('timer-bar').style.width = (data.turnTimer / 15 * 100) + "%";
                const area = document.getElementById('seats');
                area.innerHTML = '';
                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI + (Math.PI / 2);
                    const x = Math.cos(angle) * 480; const y = Math.sin(angle) * 280;
                    area.innerHTML += \`
                        <div class="player-seat" style="left:calc(50% + \${x}px); top:calc(50% + \${y}px)">
                            <div class="player-box \${p.id === data.activeId ? 'active-turn' : ''}">
                                \${p.role ? '<div class="role-circle role-'+p.role+'">'+p.role+'</div>' : ''}
                                <b style="font-size: 1.2em">\${p.name}</b><br>
                                <span style="color: #27ae60; font-weight: bold;">£\${p.chips}</span><br>
                                <div style="margin: 10px 0; font-size: 1.5em;">\${p.displayCards.join(' ')}</div>
                                <small style="color: \${p.status === 'FOLDED' ? '#e74c3c' : '#bdc3c7'}">
                                    \${p.status === 'FOLDED' ? 'FOLDED' : 'Bet: £' + p.bet}
                                </small>
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
        broadcast();
    });
    socket.on('start_game', () => {
        if (socket.id !== playerOrder[0]) return;
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
http.listen(PORT, () => console.log('Engine Online'));
