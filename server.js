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

const suits = ['♠','♥','♦','♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function log(msg) { io.emit('debug_msg', msg); }
function activityLog(msg) { io.emit('activity_log', { msg }); }

function createDeck() {
    const d = [];
    suits.forEach(s => ranks.forEach(r => d.push(r + s)));
    return d.sort(() => Math.random() - 0.5);
}

function getPlayersInHand() {
    return playerOrder.filter(id => (players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN') && players[id].hand.length > 0);
}

function startNewHand() {
    community = []; pot = 0; currentBet = 0;
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
    currentBet = BB;
    
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    gameStage = 'PREFLOP';
    activityLog("--- NEW HAND STARTED ---");
    broadcast();
}

function handleAction(socket, action) {
    if (playerOrder[turnIndex] !== socket.id) return;
    const p = players[socket.id];
    
    if (action.type === 'fold') {
        p.status = 'FOLDED';
        activityLog(`${p.name} folded`);
    } else if (action.type === 'call') {
        const amt = currentBet - p.bet;
        p.chips -= amt; p.bet += amt; pot += amt;
        activityLog(`${p.name} checked/called`);
    } else if (action.type === 'raise') {
        const total = action.amt;
        const diff = total - p.bet;
        p.chips -= diff; p.bet = total; pot += diff; currentBet = total;
        activityLog(`${p.name} raised to £${total}`);
    }
    
    // Check if betting round is over
    const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
    const roundOver = activeInHand.every(id => players[id].bet === currentBet);

    if (activeInHand.length <= 1 || roundOver) {
        advanceStage();
    } else {
        // Move turnIndex to next ACTIVE player
        let nextIdx = turnIndex;
        do {
            nextIdx = (nextIdx + 1) % playerOrder.length;
        } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
        turnIndex = nextIdx;
        broadcast();
    }
}

function advanceStage() {
    playerOrder.forEach(id => { if(players[id].status !== 'OUT') players[id].bet = 0; });
    currentBet = 0;

    if (getPlayersInHand().length <= 1) return showdown();

    if (gameStage === 'PREFLOP') { community = [deck.pop(), deck.pop(), deck.pop()]; gameStage = 'FLOP'; }
    else if (gameStage === 'FLOP') { community.push(deck.pop()); gameStage = 'TURN'; }
    else if (gameStage === 'TURN') { community.push(deck.pop()); gameStage = 'RIVER'; }
    else return showdown();

    // Reset turn to first active player after dealer
    let nextIdx = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[nextIdx]].status !== 'ACTIVE') {
        nextIdx = (nextIdx + 1) % playerOrder.length;
    }
    turnIndex = nextIdx;
    broadcast();
}

function showdown() {
    gameStage = 'SHOWDOWN';
    const winners = getPlayersInHand();
    if (winners.length > 0) {
        const winAmt = Math.floor(pot / winners.length);
        winners.forEach(id => { 
            players[id].chips += winAmt; 
            activityLog(`${players[id].name} wins £${winAmt}`); 
        });
    }
    broadcast();
}

function broadcast() {
    playerOrder.forEach(id => {
        io.to(id).emit('update', {
            myId: id, myName: players[id].name, isHost: (id === playerOrder[0]),
            players: playerOrder.map(pid => ({
                id: pid, name: players[pid].name, chips: players[pid].chips, bet: players[pid].bet, status: players[pid].status,
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
        log(`${name} joined.`);
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
            body { background: #000; color: white; font-family: sans-serif; margin: 0; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
            #blinds-overlay { position: fixed; top: 10px; left: 10px; font-size: 11px; color: #888; z-index: 100; }
            #pot-display { position: fixed; top: 10px; right: 10px; font-size: 18px; color: #2ecc71; font-weight: bold; z-index: 100; }
            .game-area { position: relative; flex: 1; width: 100vw; overflow: hidden; display: flex; justify-content: center; align-items: center; }
            .poker-table { width: 50vw; height: 35vh; max-width: 400px; max-height: 250px; background: #1a5c1a; border: 6px solid #4d260a; border-radius: 150px; position: relative; display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 1; box-shadow: inset 0 0 20px #000; }
            #table-logo { font-size: 12px; font-weight: bold; color: rgba(255,255,255,0.1); text-transform: uppercase; margin-bottom: 5px; }
            #community { display: flex; justify-content: center; align-items: center; margin-bottom: 10px; }
            #action-guide { font-size: 11px; color: #f1c40f; text-align: center; font-weight: bold; }
            .card { background: white; color: black; border: 1px solid #000; border-radius: 4px; padding: 2px 4px; margin: 1px; font-weight: bold; font-size: 1.3em; min-width: 30px; display: inline-flex; justify-content: center; align-items: center; }
            .card.red { color: #d63031; }
            .card.hidden { background: #2980b9; color: #2980b9; }
            .gap { width: 10px; }
            .player-seat { position: absolute; z-index: 10; transform: translate(-50%, -50%); }
            .player-box { background: #111; border: 2px solid #444; padding: 5px; border-radius: 6px; font-size: 10px; min-width: 85px; text-align: center; }
            .active-turn { border-color: #f1c40f; box-shadow: 0 0 10px #f1c40f; }
            .card-row { display: flex; justify-content: center; gap: 2px; margin: 2px 0; }
            .card-small { background: white; color: black; border-radius: 2px; border: 1px solid #000; font-size: 1em; padding: 1px 2px; font-weight: bold; min-width: 20px; }
            #controls { background: #111; padding: 10px; border-top: 2px solid #333; display: none; justify-content: center; gap: 8px; width: 100%; box-sizing: border-box; }
            #controls button { flex: 1; padding: 15px 0; font-size: 14px; border: none; border-radius: 4px; color: white; font-weight: bold; max-width: 110px; }
            #controls input { width: 65px; background: #000; color: #fff; border: 1px solid #444; text-align: center; font-size: 16px; }
            #debug-window { position: fixed; top: 40px; right: 10px; width: 180px; height: 100px; background: rgba(0,0,0,0.8); color: lime; font-family: monospace; font-size: 9px; padding: 5px; overflow-y: scroll; border: 1px solid #333; display: none; z-index: 200; }
            #activity-log { position: fixed; bottom: 80px; left: 10px; width: 200px; height: 100px; background: rgba(0,0,0,0.8); border: 1px solid #444; font-size: 10px; padding: 5px; overflow-y: scroll; display: none; z-index: 200; }
            #footer-btns { position: fixed; bottom: 85px; right: 10px; display: flex; gap: 5px; z-index: 200; }
            .tool-btn { padding: 5px 10px; font-size: 10px; background: #333; color: white; border: none; border-radius: 3px; cursor: pointer; }
        </style>
    </head>
    <body>
        <div id="blinds-overlay">Blinds: <span id="blinds-info">--/--</span></div>
        <div id="pot-display">£<span id="pot">0</span></div>
        <div class="game-area">
            <div id="debug-window"><b>ENGINE DEBUG</b><hr></div>
            <div id="activity-log"><b>ACTIVITY LOG</b><hr></div>
            <div class="poker-table">
                <div id="table-logo">SYFM POKER</div>
                <div id="community"></div>
                <div id="action-guide"></div>
            </div>
            <div id="seats"></div>
            <div id="footer-btns">
                <button class="tool-btn" onclick="let l=document.getElementById('activity-log'); l.style.display=l.style.display==='block'?'none':'block'">LOG</button>
                <button id="reset-btn" class="tool-btn" style="display:none; background:#c0392b" onclick="socket.emit('reset_engine')">RESET</button>
            </div>
        </div>
        <button id="start-btn" onclick="socket.emit('start_game')" style="position:fixed; top:40%; left:50%; transform:translate(-50%,-50%); padding:15px 30px; background:#2980b9; color:white; border:none; border-radius:6px; display:none; z-index:1000; font-weight:bold;">START GAME</button>
        <div id="controls">
            <button onclick="socket.emit('action', {type:'fold'})" style="background: #c0392b;">FOLD</button>
            <button id="call-btn" onclick="socket.emit('action', {type:'call'})" style="background: #27ae60;">CHECK</button>
            <input type="number" id="bet-amt" value="100">
            <button onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})" style="background: #e67e22;">RAISE</button>
        </div>
        <script src="/socket.io/socket.io.js"></script>
        <script>
            let socket = io();
            const name = prompt("Name:") || "Guest";
            socket.emit('join', name);
            function formatCard(c, isSmall = false) {
                if (c === '?') return \`<div class="card \${isSmall ? 'card-small' : ''} hidden">?</div>\`;
                const isRed = c.includes('♥') || c.includes('♦');
                return \`<div class="card \${isSmall ? 'card-small' : ''} \${isRed ? 'red' : ''}">\${c}</div>\`;
            }
            socket.on('update', data => {
                document.getElementById('pot').innerText = data.pot;
                document.getElementById('blinds-info').innerText = data.SB + "/" + data.BB;
                const comm = document.getElementById('community');
                let html = '';
                if(data.community.length >= 3) {
                    html += formatCard(data.community[0]) + formatCard(data.community[1]) + formatCard(data.community[2]);
                    if(data.community[3]) html += '<div class="gap"></div>' + formatCard(data.community[3]);
                    if(data.community[4]) html += '<div class="gap"></div>' + formatCard(data.community[4]);
                }
                comm.innerHTML = html;
                document.getElementById('debug-window').style.display = data.isHost ? 'block' : 'none';
                document.getElementById('reset-btn').style.display = data.isHost ? 'block' : 'none';
                document.getElementById('start-btn').style.display = (data.isHost && (data.gameStage === 'LOBBY' || data.gameStage === 'SHOWDOWN')) ? 'block' : 'none';
                const guide = document.getElementById('action-guide');
                const isMyTurn = (data.activeId === data.myId && data.gameStage !== 'SHOWDOWN');
                if (data.gameStage === 'SHOWDOWN') guide.innerText = "SHOWDOWN";
                else if (isMyTurn) {
                    guide.innerText = "YOUR TURN";
                    document.getElementById('call-btn').innerText = data.callAmt > 0 ? "CALL £"+data.callAmt : "CHECK";
                } else if (data.gameStage !== 'LOBBY') {
                    const activeP = data.players.find(p => p.id === data.activeId);
                    guide.innerText = activeP ? activeP.name.toUpperCase() + " ACTING..." : "";
                }
                document.getElementById('controls').style.display = isMyTurn ? 'flex' : 'none';
                const area = document.getElementById('seats');
                area.innerHTML = '';
                const vW = window.innerWidth;
                const vH = window.innerHeight;
                const cX = vW / 2;
                const cY = vH / 2 - 30;
                const rX = Math.min(vW * 0.38, 300);
                const rY = Math.min(vH * 0.28, 180);
                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI - Math.PI/2;
                    const x = cX + rX * Math.cos(angle);
                    const y = cY + rY * Math.sin(angle);
                    const seat = document.createElement('div');
                    seat.className = "player-seat";
                    seat.style.left = x + "px"; seat.style.top = y + "px";
                    const cardsHtml = p.cards.map(c => formatCard(c, true)).join('');
                    seat.innerHTML = \`
                        <div class="player-box \${p.id === data.activeId ? 'active-turn' : ''}">
                            <b style="color:#f1c40f">\${p.name}</b><br>
                            <div class="card-row">\${cardsHtml}</div>
                            \${p.chips}
                            \${p.bet > 0 ? '<div style="color:cyan; font-weight:bold;">£'+p.bet+'</div>' : ''}
                        </div>\`;
                    area.appendChild(seat);
                });
            });
            socket.on('activity_log', data => {
                const log = document.getElementById('activity-log');
                log.innerHTML += '<div>' + data.msg + '</div>';
                log.scrollTop = log.scrollHeight;
            });
            socket.on('debug_msg', m => {
                const d = document.getElementById('debug-window');
                d.innerHTML += '<div>' + m + '</div>';
                d.scrollTop = d.scrollHeight;
            });
            socket.on('force_refresh', () => location.reload());
        </script>
    </body>
    </html>
    `);
});

http.listen(3000, () => console.log('Server live on port 3000'));
