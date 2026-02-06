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
    broadcast();
}

function handleAction(socket, action) {
    if (playerOrder[turnIndex] !== socket.id) return;
    const p = players[socket.id];
    
    if (action.type === 'fold') {
        p.status = 'FOLDED';
    } else if (action.type === 'call') {
        const amt = currentBet - p.bet;
        p.chips -= amt; p.bet += amt; pot += amt;
    } else if (action.type === 'raise') {
        const total = action.amt;
        const diff = total - p.bet;
        p.chips -= diff; p.bet = total; pot += diff; currentBet = total;
    }
    
    const inHand = getPlayersInHand().filter(id => players[id].status === 'ACTIVE');
    const allMatched = inHand.every(id => players[id].bet === currentBet);

    if (inHand.length <= 1 || allMatched) {
        advanceStage();
    } else {
        do {
            turnIndex = (turnIndex + 1) % playerOrder.length;
        } while (players[playerOrder[turnIndex]].status !== 'ACTIVE');
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

    turnIndex = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[turnIndex]].status !== 'ACTIVE') turnIndex = (turnIndex + 1) % playerOrder.length;
    broadcast();
}

function showdown() {
    gameStage = 'SHOWDOWN';
    const winners = getPlayersInHand();
    const winAmt = Math.floor(pot / winners.length);
    winners.forEach(id => { players[id].chips += winAmt; });
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
            callAmt: currentBet - players[id].bet, SB, BB
        });
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name, chips: STARTING_CHIPS, hand: [], bet: 0, status: 'ACTIVE' };
        playerOrder.push(socket.id);
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
            
            /* Overlays */
            #blinds-overlay { position: fixed; top: 5px; left: 5px; font-size: 11px; color: #888; z-index: 100; }
            #pot-display { position: fixed; top: 5px; right: 5px; font-size: 16px; color: #2ecc71; font-weight: bold; z-index: 100; }

            .game-container { position: relative; flex: 1; display: flex; justify-content: center; align-items: center; min-height: 0; }
            
            /* Narrower side-to-side Table */
            .poker-table { width: 55vw; height: 40vh; max-width: 450px; background: #1a5c1a; border: 6px solid #4d260a; border-radius: 180px; position: relative; display: flex; flex-direction: column; justify-content: center; align-items: center; }
            
            #table-logo { font-size: 14px; font-weight: bold; color: rgba(255,255,255,0.1); text-transform: uppercase; margin-bottom: 10px; }
            #community { display: flex; justify-content: center; align-items: center; margin-bottom: 10px; }
            
            /* Status text INSIDE table */
            #action-guide { font-size: 11px; color: #f1c40f; font-weight: bold; text-align: center; max-width: 80%; }

            .card { background: white; color: black; border: 1px solid #000; border-radius: 4px; padding: 2px 4px; margin: 1px; font-weight: bold; font-size: 1.4em; min-width: 32px; display: inline-flex; justify-content: center; align-items: center; }
            .card.red { color: #d63031; }
            .card.hidden { background: #2980b9; color: #2980b9; }
            .gap { width: 10px; }

            /* Player Seats - Tighter to table */
            .player-seat { position: absolute; transform: translate(-50%, -50%); z-index: 10; text-align: center; }
            .player-box { background: #111; border: 2px solid #444; padding: 4px; border-radius: 6px; font-size: 10px; min-width: 80px; }
            .active-turn { border-color: #f1c40f !important; box-shadow: 0 0 8px #f1c40f; }
            .card-row { display: flex; justify-content: center; gap: 2px; margin: 2px 0; }
            .card-small { background: white; color: black; border-radius: 2px; border: 1px solid #000; font-size: 1em; padding: 1px 2px; font-weight: bold; min-width: 22px; }

            /* Mobile-Fixed Controls */
            #controls { background: #111; padding: 8px; border-top: 2px solid #333; display: none; justify-content: center; align-items: center; gap: 5px; width: 100%; z-index: 200; }
            #controls button { flex: 1; padding: 12px 0; font-size: 13px; border: none; border-radius: 4px; color: white; font-weight: bold; max-width: 100px; }
            #controls input { width: 60px; padding: 10px 0; background: #000; color: #fff; border: 1px solid #444; text-align: center; font-size: 14px; }

            #reset-btn { position: fixed; bottom: 60px; right: 5px; padding: 5px 10px; font-size: 10px; background: #c0392b; color: white; border: none; border-radius: 3px; z-index: 100; }

            @media (orientation: landscape) {
                .poker-table { height: 50vh; width: 50vw; }
                #controls { padding: 5px; }
                #controls button { padding: 10px 0; }
            }
        </style>
    </head>
    <body>
        <div id="blinds-overlay">Blinds: <span id="blinds-info">--/--</span></div>
        <div id="pot-display">£<span id="pot">0</span></div>
        
        <div class="game-container">
            <div class="poker-table" id="table-main">
                <div id="table-logo">SYFM POKER</div>
                <div id="community"></div>
                <div id="action-guide"></div>
            </div>
            <div id="seats"></div>
            <button id="reset-btn" style="display:none" onclick="socket.emit('reset_engine')">RESET</button>
        </div>

        <button id="start-btn" onclick="socket.emit('start_game')" style="position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); padding:15px 30px; background:#2980b9; color:white; border:none; border-radius:6px; display:none; z-index:1000; font-weight:bold;">START GAME</button>

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
                
                document.getElementById('reset-btn').style.display = data.isHost ? 'block' : 'none';
                document.getElementById('start-btn').style.display = (data.isHost && (data.gameStage === 'LOBBY' || data.gameStage === 'SHOWDOWN')) ? 'block' : 'none';
                
                const guide = document.getElementById('action-guide');
                const isMyTurn = (data.activeId === data.myId && data.gameStage !== 'SHOWDOWN');
                
                if (data.gameStage === 'SHOWDOWN') guide.innerText = "Showdown - Host click Start";
                else if (isMyTurn) {
                    guide.innerText = data.callAmt > 0 ? "Your Turn: £"+data.callAmt : "Your Turn: Check";
                    document.getElementById('call-btn').innerText = data.callAmt > 0 ? "CALL £"+data.callAmt : "CHECK";
                } else if (data.gameStage !== 'LOBBY') {
                    const activeP = data.players.find(p => p.id === data.activeId);
                    guide.innerText = activeP ? "Waiting for " + activeP.name : "";
                }

                document.getElementById('controls').style.display = isMyTurn ? 'flex' : 'none';

                const area = document.getElementById('seats');
                area.innerHTML = '';
                const rect = document.getElementById('table-main').getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;

                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI - Math.PI/2;
                    // Tighter positioning: reduced multipliers from 1.6/1.1 to 1.3/1.0
                    const x = centerX + (rect.width/1.3) * Math.cos(angle);
                    const y = centerY + (rect.height/1.0) * Math.sin(angle);
                    
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

            socket.on('force_refresh', () => location.reload());
        </script>
    </body>
    </html>
    `);
});

http.listen(3000, () => console.log('Server live on port 3000'));
