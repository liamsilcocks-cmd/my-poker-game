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
        if (!me) return;
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
        debug(`Blinds Up: ${SB}/${BB}`);
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
        players[id].status = (players[id].chips > 0) ? 'ACTIVE' : 'OUT';
    });

    let sbIdx = (dealerIndex + 1) % playerOrder.length;
    let bbIdx = (dealerIndex + 2) % playerOrder.length;
    
    players[playerOrder[sbIdx]].chips -= SB; players[playerOrder[sbIdx]].bet = SB;
    players[playerOrder[bbIdx]].chips -= BB; players[playerOrder[bbIdx]].bet = BB;
    pot = SB + BB;
    
    lastRaiser = playerOrder[bbIdx];
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    while(players[playerOrder[turnIndex]].status !== 'ACTIVE') turnIndex = (turnIndex + 1) % playerOrder.length;
    broadcast();
}

function handleAction(id, type, amount = 0) {
    if (id !== playerOrder[turnIndex]) return;
    let p = players[id];

    if (type === 'fold') { p.status = 'FOLDED'; }
    else if (type === 'check') { debug(`${p.name} checked`); }
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
    if (soleWinnerId) { winners = [soleWinnerId]; } 
    else {
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
    }, 5000);
    broadcast();
}

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { background: #0a0a0a; color: white; font-family: 'Arial Black', sans-serif; margin: 0; overflow: hidden; }
            .poker-table { position: relative; width: 1000px; height: 550px; background: radial-gradient(#2d5a27, #102e10); border: 20px solid #2b1d12; border-radius: 300px; margin: 80px auto; box-shadow: inset 0 0 100px #000; }
            
            .player-seat { position: absolute; width: 220px; transform: translate(-50%, -50%); transition: transform 0.2s; }
            .player-box { background: rgba(20, 20, 20, 0.95); border: 4px solid #444; padding: 25px; border-radius: 20px; text-align: center; position: relative; }
            .active-turn { border-color: #f1c40f; box-shadow: 0 0 40px #f1c40f; transform: scale(1.15); z-index: 1000; }
            
            .role-circle { position: absolute; top: -25px; right: -25px; width: 60px; height: 60px; border-radius: 50%; line-height: 60px; font-weight: 900; color: black; font-size: 1.5em; border: 4px solid #000; text-align: center; box-shadow: 0 5px 15px rgba(0,0,0,0.8); z-index: 1100; }
            .role-D { background: #ffffff; }
            .role-SB { background: #3498db; color: white; }
            .role-BB { background: #f1c40f; }

            .controls { position: fixed; bottom: 0; width: 100%; display:none; background: #000; padding: 40px 0; border-top: 8px solid #f1c40f; z-index: 2000; }
            #debug-window { position: fixed; top: 0; right: 0; width: 320px; height: 100vh; background: #000; color: #0f0; font-family: monospace; font-size: 14px; text-align: left; overflow-y: scroll; padding: 15px; display: none; border-left: 3px solid #222; }
            
            button { padding: 25px 45px; margin: 0 15px; cursor: pointer; font-weight: 900; border-radius: 15px; border: none; font-size: 1.4em; text-transform: uppercase; }
            .btn-check { background: #7f8c8d; color: white; }
            .btn-call { background: #e67e22; color: white; }
            .btn-fold { background: #c0392b; color: white; }
            .btn-raise { background: #2980b9; color: white; }
            
            #ui-bar { position: fixed; top: 0; left: 0; width: 100%; padding: 20px; font-size: 2em; background: rgba(0,0,0,0.8); z-index: 1500; text-align: center; border-bottom: 2px solid #333; }
            #pot-display { color: #f1c40f; font-size: 3em; font-weight: 900; margin-top: 30px; text-shadow: 2px 2px 10px #000; }
            #community { font-size: 4em; letter-spacing: 15px; margin-top: 180px; }
            #start-btn { position: fixed; bottom: 30px; left: 30px; padding: 30px 60px; background: #27ae60; color: white; border-radius: 20px; font-size: 2em; z-index: 3000; display: none; }
            #timer-bar { height: 10px; background: #f1c40f; width: 100%; position: absolute; top: 0; }
        </style>
    </head>
    <body>
        <div id="ui-bar">
            BLINDS: <span id="blinds"></span> | NEXT RAISE: <span id="b-timer"></span>s
        </div>
        <div id="debug-window"><b>SERVER STATUS</b><hr></div>
        <div class="poker-table">
            <div id="community"></div>
            <div id="pot-display">POT: £0</div>
            <div id="seats"></div>
        </div>
        <div id="controls" class="controls">
            <div id="timer-bar"></div>
            <button class="btn-fold" onclick="socket.emit('action', {type:'fold'})">FOLD</button>
            <button id="check-btn" class="btn-check" onclick="socket.emit('action', {type:'check'})">CHECK</button>
            <button id="call-btn" class="btn-call" onclick="socket.emit('action', {type:'call'})">CALL</button>
            <button class="btn-raise" onclick="socket.emit('action', {type:'raise', amt:100})">RAISE 100</button>
        </div>
        <button id="start-btn" onclick="socket.emit('start_game')">START GAME</button>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            let name = "";
            while (!name || name.trim().length === 0) {
                name = prompt("Enter Player Name:");
            }
            socket.emit('join', name.trim());

            socket.on('debug_msg', (msg) => {
                const win = document.getElementById('debug-window');
                win.innerHTML += '<div>' + msg + '</div>'; win.scrollTop = win.scrollHeight;
            });

            socket.on('update', (data) => {
                if (data.isHost) document.getElementById('debug-window').style.display = 'block';
                document.getElementById('blinds').innerText = data.SB + "/" + data.BB;
                document.getElementById('b-timer').innerText = data.blindTimer;
                document.getElementById('pot-display').innerText = "POT: £" + data.pot;
                document.getElementById('community').innerText = data.community.join(' ');
                document.getElementById('start-btn').style.display = (data.gameStage === 'LOBBY' && data.isHost) ? 'block' : 'none';
                
                const isMyTurn = socket.id === data.activeId && data.gameStage !== 'SHOWDOWN';
                document.getElementById('controls').style.display = isMyTurn ? 'block' : 'none';
                if (isMyTurn) {
                    document.getElementById('check-btn').style.display = data.canCheck ? 'inline-block' : 'none';
                    document.getElementById('call-btn').style.display = data.canCall ? 'inline-block' : 'none';
                    document.getElementById('timer-bar').style.width = (data.turnTimer / 15 * 100) + "%";
                }

                const area = document.getElementById('seats');
                area.innerHTML = '';
                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI + (Math.PI / 2);
                    const x = Math.cos(angle) * 600; const y = Math.sin(angle) * 350;
                    area.innerHTML += \`
                        <div class="player-seat" style="left:calc(50% + \${x}px); top:calc(50% + \${y}px)">
                            <div class="player-box \${p.id === data.activeId ? 'active-turn' : ''}">
                                \${p.role ? '<div class="role-circle role-'+p.role+'">'+p.role+'</div>' : ''}
                                <div style="font-size: 1.8em; margin-bottom: 5px;">\${p.name}</div>
                                <div style="font-size: 2em; color: #2ecc71;">£\${p.chips}</div>
                                <div style="font-size: 3.5em; margin: 15px 0;">\${p.displayCards.join(' ')}</div>
                                <div style="font-size: 1.4em; color: #f1c40f; font-weight: bold;">
                                    \${p.status === 'FOLDED' ? '<span style="color:red">FOLDED</span>' : 'BET: £' + p.bet}
                                </div>
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
    socket.on('join', (n) => {
        players[socket.id] = { name: n, hand: [], chips: 0, bet: 0, status: 'LOBBY' };
        playerOrder.push(socket.id);
        broadcast();
    });
    socket.on('start_game', () => {
        if (socket.id !== playerOrder[0]) return;
        playerOrder.forEach(id => { players[id].chips = STARTING_CHIPS; players[id].status = 'ACTIVE'; });
        startNewHand();
    });
    socket.on('action', (d) => handleAction(socket.id, d.type, d.amt));
    socket.on('disconnect', () => {
        playerOrder = playerOrder.filter(id => id !== socket.id);
        delete players[socket.id];
        broadcast();
    });
});

const PORT = process.env.PORT || 10000;
http.listen(PORT, () => console.log('Engine Ready'));
