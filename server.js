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
        activityLog(amt === 0 ? `${p.name} checked` : `${p.name} called £${amt}`);
    } else if (action.type === 'raise') {
        const total = action.amt;
        const diff = total - p.bet;
        p.chips -= diff; p.bet = total; pot += diff; currentBet = total;
        activityLog(`${p.name} raised to £${total}`);
    }
    
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

    if (gameStage === 'PREFLOP') { community = [deck.pop(), deck.pop(), deck.pop()]; gameStage = 'FLOP'; activityLog(`FLOP: ${community.join(' ')}`); }
    else if (gameStage === 'FLOP') { community.push(deck.pop()); gameStage = 'TURN'; activityLog(`TURN: ${community[3]}`); }
    else if (gameStage === 'TURN') { community.push(deck.pop()); gameStage = 'RIVER'; activityLog(`RIVER: ${community[4]}`); }
    else return showdown();

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
            body { background: #050505; color: white; font-family: sans-serif; margin: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
            #header { display: flex; justify-content: space-between; padding: 8px 15px; background: #111; border-bottom: 2px solid #333; }
            #title { font-weight: bold; color: #f1c40f; }

            .game-container { position: relative; flex-grow: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; overflow: hidden; }
            
            .poker-table { width: 80vw; height: 32vh; max-width: 650px; background: #1a5c1a; border: 8px solid #4d260a; border-radius: 200px; position: relative; margin-top: -10px; }
            
            #community { position: absolute; top: 40%; left: 50%; transform: translate(-50%, -50%); display: flex; justify-content: center; align-items: center; width: 100%; }
            
            /* Professional Cards */
            .card { background: white; color: black; border: 2px solid #000; border-radius: 5px; padding: 4px 6px; margin: 2px; font-weight: bold; font-size: 1.6em; min-width: 40px; display: inline-flex; justify-content: center; align-items: center; box-shadow: 2px 2px 5px rgba(0,0,0,0.5); }
            .card.red { color: #d63031; }
            .card.hidden { background: #2980b9; color: #2980b9; border-color: #1a5276; }
            .gap { width: 20px; }

            /* Action Guide */
            #action-guide { margin-top: 15px; background: rgba(0,0,0,0.6); padding: 5px 15px; border-radius: 8px; font-size: 13px; color: #f1c40f; z-index: 20; border: 1px solid #444; }

            /* Player Seats */
            .player-seat { position: absolute; transform: translate(-50%, -50%); z-index: 10; text-align: center; }
            .player-box { background: #222; border: 2px solid #555; padding: 6px; border-radius: 8px; font-size: 11px; min-width: 90px; }
            .active-turn { border-color: #f1c40f !important; box-shadow: 0 0 10px #f1c40f; }
            .card-row { display: flex; justify-content: center; gap: 4px; margin: 4px 0; }
            .card-small { background: white; color: black; border-radius: 3px; border: 1px solid #000; font-size: 1.1em; padding: 1px 3px; font-weight: bold; min-width: 25px; }

            #controls { background: #111; padding: 15px; border-top: 2px solid #333; text-align: center; display: none; width: 100%; box-sizing: border-box; }
            #controls button { padding: 14px 20px; font-size: 14px; margin: 3px; border: none; border-radius: 5px; color: white; font-weight: bold; text-transform: uppercase; }
            #controls input { padding: 12px; width: 65px; background: #000; color: #fff; border: 1px solid #444; border-radius: 4px; text-align: center; }

            #activity-log { position: fixed; bottom: 90px; left: 10px; width: 220px; height: 110px; background: rgba(0,0,0,0.85); border: 1px solid #444; font-size: 10px; padding: 6px; overflow-y: scroll; display: none; z-index: 100; border-radius: 5px; }
            #debug-window { position: fixed; top: 60px; right: 10px; width: 190px; height: 110px; background: rgba(0,0,0,0.8); color: lime; font-family: monospace; font-size: 10px; padding: 6px; overflow-y: scroll; border: 1px solid #333; display: none; z-index: 100; }
            
            #footer-btns { position: fixed; bottom: 95px; right: 10px; display: flex; gap: 6px; z-index: 100; }
            .tool-btn { padding: 6px 10px; font-size: 11px; background: #444; color: white; border: none; border-radius: 4px; cursor: pointer; }

            @media (orientation: landscape) {
                .poker-table { height: 35vh; width: 70vw; }
                #controls { padding: 10px; }
                #controls button { padding: 12px 18px; }
                .card { font-size: 1.4em; min-width: 35px; }
            }
        </style>
    </head>
    <body>
        <div id="header">
            <div id="title">SYFM POKER</div>
            <div style="font-size: 12px;">You are player: <span id="my-name" style="color:#f1c40f">...</span></div>
            <div style="font-size: 12px;">Blinds: <span id="blinds-info">0/0</span> | Pot: £<span id="pot">0</span></div>
        </div>
        
        <div class="game-container">
            <div class="poker-table" id="table-main">
                <div id="community"></div>
            </div>
            <div id="action-guide"></div>
            <div id="seats"></div>
            
            <div id="debug-window"><b>ENGINE LOG</b><hr></div>
            <div id="activity-log"></div>
            
            <div id="footer-btns">
                <button class="tool-btn" onclick="let l=document.getElementById('activity-log'); l.style.display=l.style.display==='block'?'none':'block'">ACTIVITY LOG</button>
                <button id="reset-btn" class="tool-btn" style="display:none; background:#c0392b" onclick="socket.emit('reset_engine')">RESET ENGINE</button>
            </div>
        </div>

        <button id="start-btn" onclick="socket.emit('start_game')" style="position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); padding:18px 35px; background:#2980b9; color:white; border:none; border-radius:6px; display:none; z-index:1000; font-weight:bold; font-size:16px;">START / NEXT HAND</button>

        <div id="controls">
            <button onclick="socket.emit('action', {type:'fold'})" style="background: #c0392b;">FOLD</button>
            <button id="call-btn" onclick="socket.emit('action', {type:'call'})" style="background: #27ae60;">CHECK</button>
            <input type="number" id="bet-amt" value="100">
            <button onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})" style="background: #e67e22;">RAISE</button>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            let socket = io();
            const name = prompt("Enter Name:") || "Guest";
            socket.emit('join', name);

            function formatCard(c, isSmall = false) {
                if (c === '?') return \`<div class="card \${isSmall ? 'card-small' : ''} hidden">?</div>\`;
                const isRed = c.includes('♥') || c.includes('♦');
                return \`<div class="card \${isSmall ? 'card-small' : ''} \${isRed ? 'red' : ''}">\${c}</div>\`;
            }

            socket.on('update', data => {
                document.getElementById('my-name').innerText = data.myName;
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
                if (data.gameStage === 'SHOWDOWN') {
                    guide.innerText = "Hand Finished.";
                } else if (isMyTurn) {
                    guide.innerText = data.callAmt > 0 ? "You can Call £"+data.callAmt+", Fold, or Raise" : "You can Check or Raise";
                    document.getElementById('call-btn').innerText = data.callAmt > 0 ? "CALL £"+data.callAmt : "CHECK";
                } else if (data.gameStage !== 'LOBBY') {
                    const activeP = data.players.find(p => p.id === data.activeId);
                    guide.innerText = activeP ? "Waiting for " + activeP.name + "..." : "";
                } else {
                    guide.innerText = "Waiting for Host to start...";
                }

                document.getElementById('controls').style.display = isMyTurn ? 'block' : 'none';

                const area = document.getElementById('seats');
                area.innerHTML = '';
                const rect = document.getElementById('table-main').getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;

                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI - Math.PI/2;
                    const x = centerX + (rect.width/1.6) * Math.cos(angle);
                    const y = centerY + (rect.height/1.1) * Math.sin(angle);
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
