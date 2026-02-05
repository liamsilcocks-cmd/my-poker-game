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
    playerOrder.forEach((id) => {
        const me = players[id];
        if (!me) return;
        
        const isHost = (id === playerOrder[0]); // STRICT HOST CHECK
        const sbIdx = dealerIndex !== -1 ? (dealerIndex + 1) % playerOrder.length : -1;
        const bbIdx = dealerIndex !== -1 ? (dealerIndex + 2) % playerOrder.length : -1;
        const canCheck = (currentBet === 0) || (gameStage === 'PREFLOP' && id === playerOrder[bbIdx] && currentBet === BB && me.bet === BB);

        io.to(id).emit('update', {
            myId: id,
            isHost: isHost,
            players: playerOrder.map((pid, pIdx) => ({
                id: pid, name: players[pid].name, chips: players[pid].chips, 
                bet: players[pid].bet, status: players[pid].status,
                role: (gameStage === 'LOBBY' || dealerIndex === -1) ? '' : (pIdx === dealerIndex ? 'D' : (pIdx === sbIdx ? 'SB' : (pIdx === bbIdx ? 'BB' : ''))),
                displayCards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['🂠','🂠'] : [])
            })),
            community, pot, gameStage, activeId: playerOrder[turnIndex], currentBet, SB, BB, blindTimer, turnTimer,
            canCheck, callAmount: currentBet - me.bet
        });
    });
}

setInterval(() => {
    if (gameStage === 'LOBBY' || gameStage === 'SHOWDOWN' || dealerIndex === -1) return;
    if (blindTimer > 0) blindTimer--;
    else { SB *= 2; BB *= 2; blindTimer = BLIND_INTERVAL; debug(`Blinds Up: ${SB}/${BB}`);}
    if (turnTimer > 0) turnTimer--;
}, 1000);

function pickRandomDealer() {
    dealerIndex = Math.floor(Math.random() * playerOrder.length);
}

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

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
            body { background: #050505; color: white; font-family: sans-serif; margin: 0; padding: 0; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
            #ui-bar { width: 100%; padding: 15px; background: #111; text-align: center; border-bottom: 2px solid #444; }
            .game-container { position: relative; flex-grow: 1; display: flex; justify-content: center; align-items: center; }
            .poker-table { width: 60vw; height: 40vh; background: radial-gradient(#2d5a27, #102e10); border: 12px solid #2b1d12; border-radius: 200px; display: flex; flex-direction: column; justify-content: center; align-items: center; }
            #community { font-size: 3.5em; letter-spacing: 12px; }
            .player-seat { position: absolute; width: 200px; transform: translate(-50%, -50%); z-index: 10; }
            .player-box { background: rgba(20, 20, 20, 0.95); border: 4px solid #555; padding: 10px; border-radius: 15px; text-align: center; }
            
            /* RAINBOW ONLY FOR THE LOCAL PLAYER */
            @keyframes rainbow {
                0% { border-color: red; }
                33% { border-color: lime; }
                66% { border-color: blue; }
                100% { border-color: red; }
            }
            .is-me { animation: rainbow 3s infinite linear; box-shadow: 0 0 15px rgba(255,255,255,0.2); }
            
            /* TURN INDICATOR (SQUARE GOLD BORDER) */
            .active-turn { border: 6px solid #f1c40f !important; transform: scale(1.1); }
            
            #host-layer { position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 99999; }
            .host-ui { pointer-events: auto; }
            #start-btn { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 30px 60px; background: #27ae60; color: white; border-radius: 15px; font-size: 2.5em; border: 4px solid white; cursor: pointer; display: none; }
            #reset-btn { position: absolute; bottom: 80px; right: 20px; padding: 10px 20px; background: #c0392b; color: white; border-radius: 8px; border: 2px solid white; cursor: pointer; display: none; }
            #debug-window { position: absolute; top: 60px; right: 10px; width: 280px; height: 150px; background: rgba(0,0,0,0.9); color: #0f0; font-family: monospace; font-size: 11px; overflow-y: scroll; padding: 10px; border: 1px solid #333; display: none; }
            
            .controls { width: 100%; display: none; background: #111; padding: 20px 0; border-top: 5px solid #f1c40f; }
        </style>
    </head>
    <body>
        <div id="ui-bar">BLINDS: <span id="blinds"></span> | NEXT: <span id="b-timer"></span>s</div>
        
        <div id="host-layer">
            <button id="start-btn" class="host-ui" onclick="socket.emit('start_game')">START GAME</button>
            <button id="reset-btn" class="host-ui" onclick="socket.emit('reset_engine')">RESET ENGINE</button>
            <div id="debug-window" class="host-ui"><b>ENGINE LOG</b><hr></div>
        </div>

        <div class="game-container">
            <div class="poker-table">
                <div id="community"></div>
                <div id="pot-display" style="color:#f1c40f; font-size: 2em;">POT: £0</div>
            </div>
            <div id="seats"></div>
        </div>

        <div id="controls" class="controls">
            <div style="display:flex; justify-content:center; gap:10px;">
                <button style="background:#c0392b; color:white; padding:15px;" onclick="socket.emit('action', {type:'fold'})">FOLD</button>
                <button id="call-btn" style="background:#e67e22; color:white; padding:15px;" onclick="socket.emit('action', {type:'call'})"></button>
                <input type="number" id="bet-amt" value="100" style="width:70px;">
                <button style="background:#2980b9; color:white; padding:15px;" onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})">RAISE</button>
            </div>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            let pName = "";
            while(!pName) { pName = prompt("Name:"); }
            socket.on('connect', () => { socket.emit('join', pName); });
            socket.on('force_refresh', () => { location.reload(); });
            socket.on('debug_msg', (m) => { 
                const d = document.getElementById('debug-window');
                d.innerHTML += '<div>' + m + '</div>';
                d.scrollTop = d.scrollHeight;
            });

            socket.on('update', (data) => {
                document.getElementById('blinds').innerText = data.SB + "/" + data.BB;
                document.getElementById('b-timer').innerText = data.gameStage === 'LOBBY' ? "--" : data.blindTimer;
                document.getElementById('pot-display').innerText = "POT: £" + data.pot;
                document.getElementById('community').innerText = data.community.join(' ');

                // HOST ONLY
                if(data.isHost) {
                    document.getElementById('start-btn').style.display = (data.gameStage === 'LOBBY') ? 'block' : 'none';
                    document.getElementById('reset-btn').style.display = 'block';
                    document.getElementById('debug-window').style.display = 'block';
                }

                const isTurn = socket.id === data.activeId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY';
                document.getElementById('controls').style.display = isTurn ? 'block' : 'none';
                if(isTurn) document.getElementById('call-btn').innerText = data.canCheck ? "CHECK" : "CALL £"+data.callAmount;

                const area = document.getElementById('seats'); area.innerHTML = '';
                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI + (Math.PI / 2);
                    const x = (window.innerWidth / 2) + (window.innerWidth * 0.35) * Math.cos(angle);
                    const y = (window.innerHeight / 2) + (window.innerHeight * 0.3) * Math.sin(angle);
                    
                    // Logic: Is this box ME? (Rainbow) Is this box THE TURN? (Gold)
                    const meClass = p.id === data.myId ? 'is-me' : '';
                    const turnClass = p.id === data.activeId ? 'active-turn' : '';
                    
                    area.innerHTML += \`
                        <div class="player-seat" style="left: \${x}px; top: \${y}px;">
                            <div class="player-box \${meClass} \${turnClass}">
                                <div>\${p.id === data.myId ? 'YOU' : p.name}</div>
                                <div style="color:#2ecc71;">£\${p.chips}</div>
                                <div style="font-size:1.8em;">\${p.displayCards.join(' ')}</div>
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
        pickRandomDealer();
        startNewHand();
    });
    socket.on('reset_engine', () => {
        if (socket.id !== playerOrder[0]) return;
        players = {}; playerOrder = []; gameStage = 'LOBBY';
        io.emit('force_refresh');
    });
    socket.on('disconnect', () => {
        playerOrder = playerOrder.filter(id => id !== socket.id);
        delete players[socket.id];
        broadcast();
    });
});

const PORT = process.env.PORT || 10000;
http.listen(PORT, () => console.log('Server Live'));
