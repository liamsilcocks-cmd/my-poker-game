const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// --- CONFIG ---
let STARTING_CHIPS = 6000;
let SB = 25;
let BB = 50;
let BLIND_INTERVAL = 120; 
let TURN_TIME = 15; 

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
let blindTimer = BLIND_INTERVAL;
let turnTimer = TURN_TIME;
let lastRaiser = null;

const cardValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function evaluateHand(cards) {
    let values = cards.map(c => cardValues[c.slice(0,-1)]).sort((a,b)=>b-a);
    let counts = {}; 
    values.forEach(v => counts[v] = (counts[v]||0)+1);
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
        io.to(playerOrder[0]).emit('debug_msg', `[${new Date().toLocaleTimeString()}] ${msg}`);
    }
}

function broadcast() {
    const sbIdx = dealerIndex !== -1 ? (dealerIndex + 1) % playerOrder.length : -1;
    const bbIdx = dealerIndex !== -1 ? (dealerIndex + 2) % playerOrder.length : -1;

    playerOrder.forEach(id => {
        const me = players[id];
        if (!me) return;
        const canCheck = (currentBet === 0) || (gameStage === 'PREFLOP' && id === playerOrder[bbIdx] && currentBet === BB && me.bet === BB);
        const canCall = (currentBet > me.bet);
        const callAmount = currentBet - me.bet;

        io.to(id).emit('update', {
            myId: id,
            players: playerOrder.map((pid, idx) => ({
                id: pid, name: players[pid].name, chips: players[pid].chips, 
                bet: players[pid].bet, status: players[pid].status,
                role: (gameStage === 'LOBBY' || dealerIndex === -1) ? '' : (idx === dealerIndex ? 'D' : (idx === sbIdx ? 'SB' : (idx === bbIdx ? 'BB' : ''))),
                displayCards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['🂠','🂠'] : [])
            })),
            community, pot, gameStage, activeId: playerOrder[turnIndex], currentBet, SB, BB, blindTimer, turnTimer,
            isHost: id === playerOrder[0],
            canCheck, canCall, callAmount
        });
    });
}

setInterval(() => {
    if (gameStage === 'LOBBY' || gameStage === 'SHOWDOWN') return;
    if (blindTimer > 0) blindTimer--;
    else { 
        SB *= 2; BB *= 2; blindTimer = BLIND_INTERVAL; 
        debug(`SYSTEM: Blinds up to ${SB}/${BB}`);
    }
    if (turnTimer > 0) turnTimer--;
}, 1000);

function pickRandomDealer() {
    debug("HIGH CARD: Determining the first dealer...");
    let tempDeck = (function(){
        const suits=['♥','♦','♣','♠'], vals=Object.keys(cardValues);
        let d=[]; for(let s of suits) for(let v of vals) d.push(v+s);
        return d.sort(()=>Math.random()-0.5);
    })();
    let highVal = -1;
    let winnerIdx = 0;
    playerOrder.forEach((id, idx) => {
        let card = tempDeck.pop();
        let val = cardValues[card.slice(0,-1)];
        debug(`DRAW: ${players[id].name} - ${card}`);
        if (val > highVal) { highVal = val; winnerIdx = idx; }
    });
    dealerIndex = winnerIdx;
    debug(`DEALER: ${players[playerOrder[dealerIndex]].name} wins button.`);
}

function startNewHand() {
    gameStage = 'PREFLOP';
    debug("--- STARTING NEW HAND ---");
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
    if (id !== playerOrder[turnIndex] || gameStage === 'SHOWDOWN') return;
    let p = players[id];
    debug(`ACT: ${p.name} - ${type.toUpperCase()}`);

    if (type === 'fold') { p.status = 'FOLDED'; }
    else if (type === 'call') {
        let diff = currentBet - p.bet;
        p.chips -= diff; p.bet += diff; pot += diff;
    } else if (type === 'raise') {
        let diff = amount - p.bet;
        p.chips -= diff; p.bet = amount; pot += diff;
        currentBet = amount;
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
        else if (gameStage === 'RIVER') { return showdown(); }
        
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
    turnIndex = -1; 
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
    winners.forEach(id => { players[id].chips += winAmt; debug(`WIN: ${players[id].name} +£${winAmt}`); });
    setTimeout(() => { dealerIndex = (dealerIndex + 1) % playerOrder.length; startNewHand(); }, 5000);
    broadcast();
}

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
            body { background: #050505; color: white; font-family: 'Arial Black', sans-serif; margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
            #ui-bar { width: 100%; padding: 15px; font-size: 1.2em; background: #111; text-align: center; border-bottom: 2px solid #444; z-index: 6000; position: relative; }
            .game-container { position: relative; flex-grow: 1; display: flex; justify-content: center; align-items: center; padding: 100px; }
            .poker-table { position: relative; width: 60vw; height: 40vh; max-width: 800px; max-height: 400px; background: radial-gradient(#2d5a27, #102e10); border: 12px solid #2b1d12; border-radius: 200px; box-shadow: inset 0 0 50px #000; display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 1; }
            #community { font-size: 3.5em; letter-spacing: 12px; margin-bottom: 10px; }
            #pot-display { color: #f1c40f; font-size: 2.2em; font-weight: 900; }
            .player-seat { position: absolute; width: 220px; transform: translate(-50%, -50%); z-index: 10; }
            .player-box { background: rgba(20, 20, 20, 0.95); border: 3px solid #555; padding: 15px; border-radius: 15px; text-align: center; transition: all 0.3s ease; }
            .is-me { background: linear-gradient(180deg, #1a2a3a 0%, #0a0a0a 100%); border-color: #3498db !important; box-shadow: 0 0 15px rgba(52, 152, 219, 0.3); }
            .active-turn { border-color: #f1c40f !important; box-shadow: 0 0 30px #f1c40f !important; transform: scale(1.05); }
            .role-circle { position: absolute; top: -15px; right: -15px; width: 45px; height: 45px; border-radius: 50%; line-height: 45px; font-weight: 900; color: black; font-size: 1.2em; border: 3px solid #000; background: white; text-align: center; }
            .role-SB { background: #3498db; color: white; }
            .role-BB { background: #f1c40f; }
            .controls { width: 100%; display: none; background: #111; padding: 20px 0; border-top: 5px solid #f1c40f; z-index: 2000; }
            .controls-inner { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 10px; }
            button { padding: 15px 25px; cursor: pointer; font-weight: 900; border-radius: 10px; border: none; font-size: 1.1em; text-transform: uppercase; }
            input[type="number"] { width: 100px; padding: 15px; font-size: 1.2em; border-radius: 10px; border: 2px solid #f1c40f; background: #222; color: white; text-align: center; }
            #start-btn { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 30px 60px; background: #27ae60; color: white; border-radius: 20px; font-size: 2.5em; z-index: 9000; border: 5px solid white; display: none; }
            #debug-window { position: fixed; top: 0; right: 0; width: 350px; height: 100vh; background: rgba(0,0,0,0.9); color: #0f0; font-family: monospace; font-size: 13px; overflow-y: scroll; padding: 15px; display: none; border-left: 2px solid #333; z-index: 5000; }
            #timer-bar { height: 8px; background: #f1c40f; width: 0%; position: absolute; top: 0; transition: width 1s linear; }
        </style>
    </head>
    <body>
        <div id="ui-bar">BLINDS: <span id="blinds"></span> | NEXT RAISE: <span id="b-timer"></span>s</div>
        <div id="debug-window"><b>ENGINE LOG</b><hr></div>
        <div class="game-container">
            <div class="poker-table"><div id="community"></div><div id="pot-display">POT: £0</div></div>
            <div id="seats"></div>
        </div>
        <div id="controls" class="controls">
            <div id="timer-bar"></div>
            <div class="controls-inner">
                <button style="background:#c0392b;color:white;" onclick="socket.emit('action', {type:'fold'})">FOLD</button>
                <button id="check-btn" style="background:#7f8c8d;color:white;" onclick="socket.emit('action', {type:'check'})">CHECK</button>
                <button id="call-btn" style="background:#e67e22;color:white;" onclick="socket.emit('action', {type:'call'})">CALL</button>
                <input type="number" id="bet-amt" value="100">
                <button style="background:#2980b9;color:white;" onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})">RAISE TO</button>
            </div>
        </div>
        <button id="start-btn" onclick="socket.emit('start_game')">START TOURNAMENT</button>
        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            let pName = "";
            while (!pName || pName.trim() === "") { pName = prompt("Name:"); }
            socket.on('connect', () => { socket.emit('join', pName.trim()); });
            socket.on('debug_msg', (m) => { const w = document.getElementById('debug-window'); w.innerHTML += '<div>'+m+'</div>'; w.scrollTop = w.scrollHeight; });
            socket.on('update', (data) => {
                if (data.isHost) document.getElementById('debug-window').style.display = 'block';
                document.getElementById('blinds').innerText = data.SB + "/" + data.BB;
                document.getElementById('b-timer').innerText = data.blindTimer;
                document.getElementById('pot-display').innerText = "POT: £" + data.pot;
                document.getElementById('community').innerText = data.community.join(' ');
                document.getElementById('start-btn').style.display = (data.gameStage === 'LOBBY' && data.isHost) ? 'block' : 'none';
                const isMyTurn = socket.id === data.activeId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY';
                document.getElementById('controls').style.display = isMyTurn ? 'block' : 'none';
                if (isMyTurn) {
                    document.getElementById('check-btn').style.display = data.canCheck ? 'inline-block' : 'none';
                    document.getElementById('call-btn').style.display = data.canCall ? 'inline-block' : 'none';
                    if (data.canCall) document.getElementById('call-btn').innerText = "CALL £" + data.callAmount;
                    document.getElementById('timer-bar').style.width = (data.turnTimer / 15 * 100) + "%";
                }
                const area = document.getElementById('seats'); area.innerHTML = '';
                const cw = document.querySelector('.game-container').offsetWidth / 2;
                const ch = document.querySelector('.game-container').offsetHeight / 2;
                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI + (Math.PI / 2);
                    const x = cw + (cw * 0.8) * Math.cos(angle);
                    const y = ch + (ch * 0.8) * Math.sin(angle);
                    const isMeClass = p.id === data.myId ? 'is-me' : '';
                    const activeClass = p.id === data.activeId ? 'active-turn' : '';
                    area.innerHTML += \`
                        <div class="player-seat" style="left: \${x}px; top: \${y}px;">
                            <div class="player-box \${isMeClass} \${activeClass}">
                                \${p.role ? '<div class="role-circle role-'+p.role+'">'+p.role+'</div>' : ''}
                                <div style="font-size: 1.4em;">\${p.id === data.myId ? 'YOU' : p.name}</div>
                                <div style="font-size: 1.5em; color: #2ecc71;">£\${p.chips}</div>
                                <div style="font-size: 2.8em; margin: 10px 0;">\${p.displayCards.join(' ')}</div>
                                <div style="font-size: 1.1em; color: #f1c40f;">\${p.status === 'FOLDED' ? 'FOLDED' : 'BET: £'+p.bet}</div>
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
    socket.on('join', (n) => { players[socket.id] = { name: n, hand: [], chips: 0, bet: 0, status: 'LOBBY' }; playerOrder.push(socket.id); broadcast(); });
    socket.on('start_game', () => { if (socket.id !== playerOrder[0]) return; playerOrder.forEach(id => { players[id].chips = STARTING_CHIPS; players[id].status = 'ACTIVE'; }); pickRandomDealer(); startNewHand(); });
    socket.on('action', (d) => handleAction(socket.id, d.type, d.amt));
    socket.on('disconnect', () => { playerOrder = playerOrder.filter(id => id !== socket.id); delete players[socket.id]; broadcast(); });
});

const PORT = process.env.PORT || 10000;
http.listen(PORT, () => console.log('Port: ' + PORT));
