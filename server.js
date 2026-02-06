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
    activityLog("--- NEW HAND ---");
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
        activityLog(amt === 0 ? `${p.name} checked` : `${p.name} called £${amt}`);
    } else if (action.type === 'raise') {
        const total = action.amt;
        const diff = total - p.bet;
        p.chips -= diff; p.bet = total; pot += diff; currentBet = total;
        activityLog(`${p.name} raised to £${total}`);
    }
    
    nextTurn();
}

function nextTurn() {
    const inHand = getPlayersInHand().filter(id => players[id].status === 'ACTIVE');
    if (inHand.length <= 1 || inHand.every(id => players[id].bet === currentBet)) {
        advanceStage();
    } else {
        turnIndex = (turnIndex + 1) % playerOrder.length;
        while (players[playerOrder[turnIndex]].status !== 'ACTIVE') turnIndex = (turnIndex + 1) % playerOrder.length;
        broadcast();
    }
}

function advanceStage() {
    playerOrder.forEach(id => players[id].bet = 0);
    currentBet = 0;
    if (getPlayersInHand().length <= 1) return showdown();

    if (gameStage === 'PREFLOP') { community = [deck.pop(), deck.pop(), deck.pop()]; gameStage = 'FLOP'; }
    else if (gameStage === 'FLOP') { community.push(deck.pop()); gameStage = 'TURN'; }
    else if (gameStage === 'TURN') { community.push(deck.pop()); gameStage = 'RIVER'; }
    else return showdown();

    activityLog(`${gameStage}: ${community.join(' ')}`);
    turnIndex = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[turnIndex]].status !== 'ACTIVE') turnIndex = (turnIndex + 1) % playerOrder.length;
    broadcast();
}

function showdown() {
    gameStage = 'SHOWDOWN';
    const winners = getPlayersInHand();
    const winAmt = Math.floor(pot / winners.length);
    winners.forEach(id => {
        players[id].chips += winAmt;
        activityLog(`${players[id].name} wins £${winAmt}`);
    });
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
            community, pot, gameStage, activeId: playerOrder[turnIndex], currentBet,
            callAmt: currentBet - players[id].bet
        });
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name, chips: STARTING_CHIPS, hand: [], bet: 0, status: 'LOBBY' };
        playerOrder.push(socket.id);
        broadcast();
    });
    socket.on('start_game', () => startNewHand());
    socket.on('action', (data) => handleAction(socket, data));
    socket.on('disconnect', () => { delete players[socket.id]; playerOrder = playerOrder.filter(i => i !== socket.id); broadcast(); });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
            body { background: #000; color: white; font-family: sans-serif; margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
            #top-bar { display: flex; justify-content: space-between; padding: 10px; background: #111; font-weight: bold; font-size: 14px; }
            
            #main-layout { display: flex; flex: 1; overflow: hidden; }
            
            /* Table Area */
            #table-container { flex: 2.5; position: relative; background: #0a2e0a; display: flex; align-items: center; justify-content: center; }
            .felt { width: 85%; height: 65%; border: 8px solid #4d260a; border-radius: 200px; background: #1a5c1a; position: relative; }
            
            /* Cards */
            .card { display: inline-block; background: white; border-radius: 3px; padding: 2px 4px; margin: 2px; font-weight: bold; font-size: 16px; border: 1px solid #999; }
            .card.red { color: #d63031; }
            .card.black { color: #2d3436; }
            .card.hidden { background: #2980b9; color: #2980b9; }

            /* Player Boxes */
            .player-box { position: absolute; width: 90px; text-align: center; transform: translate(-50%, -50%); z-index: 5; }
            .name-tag { background: #333; font-size: 10px; padding: 2px; border-radius: 4px 4px 0 0; border: 1px solid #555; border-bottom: none; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .card-area { background: #222; border: 2px solid #555; padding: 5px 0; min-height: 25px; display: flex; justify-content: center; }
            .chip-tag { background: #111; font-size: 11px; padding: 2px; border-radius: 0 0 4px 4px; border: 1px solid #555; border-top: none; display: block; color: #2ecc71; }
            .active-turn .card-area { border-color: #f1c40f; box-shadow: 0 0 8px #f1c40f; }

            /* Betting labels */
            .bet-tag { position: absolute; top: -20px; left: 50%; transform: translateX(-50%); color: #f1c40f; font-weight: bold; font-size: 11px; }

            /* UI Panel */
            #side-panel { flex: 1; display: flex; flex-direction: column; background: #1a1a1a; padding: 8px; border-left: 2px solid #333; }
            #activity-log { flex: 1; font-size: 11px; overflow-y: auto; background: #000; border: 1px solid #333; padding: 5px; margin-bottom: 8px; }
            #debug-engine { height: 60px; font-family: monospace; font-size: 9px; color: lime; overflow-y: auto; background: #050505; border: 1px solid #222; margin-bottom: 8px; display: none; }
            
            #controls { display: none; grid-template-columns: 1fr 1fr; gap: 4px; }
            #controls button { padding: 12px 2px; font-size: 12px; font-weight: bold; color: white; border: none; border-radius: 4px; cursor: pointer; }
            #controls input { width: 100%; padding: 8px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; text-align: center; }

            #guide-text { color: #f1c40f; font-size: 12px; margin-bottom: 8px; text-align: center; font-weight: bold; min-height: 14px; }

            @media (max-height: 500px) { /* Landscape Fixes */
                .felt { height: 80%; width: 90%; }
                .player-box { width: 80px; }
            }
        </style>
    </head>
    <body>
        <div id="top-bar">
            <div>You are player: <span id="my-name-display" style="color:#f1c40f">...</span></div>
            <div>POT: <span id="pot-display" style="color:#2ecc71">£0</span></div>
        </div>

        <div id="main-layout">
            <div id="table-container">
                <div class="felt">
                    <div id="community-cards" style="position:absolute; top:45%; left:50%; transform:translate(-50%,-50%); width:100%; text-align:center;"></div>
                </div>
                <div id="player-area"></div>
            </div>

            <div id="side-panel">
                <div id="debug-engine"><b>ENGINE LOG</b><hr></div>
                <div id="activity-log"></div>
                <div id="guide-text"></div>
                
                <div id="controls">
                    <button onclick="socket.emit('action',{type:'fold'})" style="background:#c0392b">FOLD</button>
                    <button id="call-btn" onclick="socket.emit('action',{type:'call'})" style="background:#27ae60">CHECK</button>
                    <input type="number" id="raise-amt" value="100">
                    <button onclick="socket.emit('action',{type:'raise', amt:parseInt(document.getElementById('raise-amt').value)})" style="background:#e67e22; grid-column: span 2;">RAISE</button>
                </div>

                <button id="host-btn" onclick="socket.emit('start_game')" style="display:none; margin-top:5px; padding:12px; background:#2980b9; color:white; border:none; border-radius:4px; font-weight:bold;">START / NEXT HAND</button>
            </div>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const name = prompt("Enter Name") || "Player";
            socket.emit('join', name);

            function getCardHTML(card) {
                if (card === '?') return '<div class="card hidden">?</div>';
                const suit = card.slice(-1);
                const val = card.slice(0, -1);
                const colorClass = (suit === '♥' || suit === '♦') ? 'red' : 'black';
                return \`<div class="card \${colorClass}">\${val}\${suit}</div>\`;
            }

            socket.on('update', data => {
                document.getElementById('my-name-display').innerText = data.myName;
                document.getElementById('pot-display').innerText = "£" + data.pot;
                
                const comm = document.getElementById('community-cards');
                comm.innerHTML = data.community.map(c => getCardHTML(c)).join('');

                document.getElementById('debug-engine').style.display = data.isHost ? 'block' : 'none';
                document.getElementById('host-btn').style.display = (data.isHost && (data.gameStage === 'LOBBY' || data.gameStage === 'SHOWDOWN')) ? 'block' : 'none';

                const guide = document.getElementById('guide-text');
                const isMyTurn = data.activeId === data.myId && data.gameStage !== 'SHOWDOWN';
                
                if (data.gameStage === 'SHOWDOWN') {
                    guide.innerText = "Hand Finished - Host click Next Hand";
                } else if (isMyTurn) {
                    guide.innerText = data.callAmt > 0 ? "YOUR TURN: Call £" + data.callAmt : "YOUR TURN: Check or Raise";
                    document.getElementById('call-btn').innerText = data.callAmt > 0 ? "CALL £"+data.callAmt : "CHECK";
                } else if (data.gameStage !== 'LOBBY') {
                    const activeP = data.players.find(p => p.id === data.activeId);
                    guide.innerText = activeP ? "Waiting for " + activeP.name + "..." : "";
                }

                document.getElementById('controls').style.display = isMyTurn ? 'grid' : 'none';

                const area = document.getElementById('player-area');
                area.innerHTML = '';
                const positions = [
                    {t:'88%', l:'50%'}, {t:'65%', l:'12%'}, {t:'25%', l:'15%'}, 
                    {t:'8%', l:'50%'}, {t:'25%', l:'85%'}, {t:'65%', l:'88%'}
                ];

                data.players.forEach((p, i) => {
                    const pos = positions[i % positions.length];
                    const div = document.createElement('div');
                    div.className = 'player-box' + (p.id === data.activeId ? ' active-turn' : '');
                    div.style.top = pos.t; div.style.left = pos.l;
                    
                    let cardsHTML = p.cards.map(c => getCardHTML(c)).join('');
                    
                    div.innerHTML = \`
                        \${p.bet > 0 ? '<div class="bet-tag">£'+p.bet+'</div>' : ''}
                        <span class="name-tag">\${p.name}</span>
                        <div class="card-area">\${cardsHTML}</div>
                        <span class="chip-tag">\${p.chips}</span>
                    \`;
                    area.appendChild(div);
                });
            });

            socket.on('activity_log', d => {
                const logDiv = document.getElementById('activity-log');
                const entry = document.createElement('div');
                entry.style.padding = "2px 0";
                entry.style.borderBottom = "1px solid #222";
                entry.innerText = d.msg;
                logDiv.appendChild(entry);
                logDiv.scrollTop = logDiv.scrollHeight;
            });

            socket.on('debug_msg', m => {
                const d = document.getElementById('debug-engine');
                d.innerHTML += '<div>' + m + '</div>';
                d.scrollTop = d.scrollHeight;
            });
        </script>
    </body>
    </html>
    `);
});

http.listen(3000, () => console.log('Server live on port 3000'));
