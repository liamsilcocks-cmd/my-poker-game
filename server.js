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
let actionCount = 0; 
let sidePots = [];

const cardValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
const suits = ['♠','♥','♦','♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function getCardName(value) {
    const names = {2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A'};
    return names[value] || value.toString();
}

function log(msg) {
    console.log(msg);
    io.emit('debug_msg', msg);
}

function activityLog(msg, type = 'action') {
    io.emit('activity_log', { msg, type });
}

function createDeck() {
    const d = [];
    suits.forEach(s => ranks.forEach(r => d.push(r + s)));
    return d.sort(() => Math.random() - 0.5);
}

function dealCard() { return deck.pop(); }

function getActivePlayers() {
    return playerOrder.filter(id => players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN');
}

function getPlayersInHand() {
    return playerOrder.filter(id => 
        (players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN') && 
        players[id].hand.length > 0
    );
}

function startNewHand() {
    log('=== NEW HAND ===');
    activityLog('--- NEW HAND STARTED ---', 'action');
    community = []; pot = 0; currentBet = 0; lastRaiser = null;
    const active = getActivePlayers();
    if (active.length < 2) {
        gameStage = 'LOBBY';
        broadcast();
        return;
    }
    dealerIndex = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[dealerIndex]].status !== 'ACTIVE') {
        dealerIndex = (dealerIndex + 1) % playerOrder.length;
    }
    playerOrder.forEach(id => {
        players[id].bet = 0;
        players[id].hand = [];
        if (players[id].status === 'ACTIVE') players[id].roundBet = 0;
    });
    deck = createDeck();
    active.forEach(id => { players[id].hand = [dealCard(), dealCard()]; });
    
    const sbIdx = (dealerIndex + 1) % playerOrder.length;
    const bbIdx = (dealerIndex + 2) % playerOrder.length;
    const sbPlayer = players[playerOrder[sbIdx]];
    const bbPlayer = players[playerOrder[bbIdx]];
    
    const sbAmt = Math.min(SB, sbPlayer.chips);
    const bbAmt = Math.min(BB, bbPlayer.chips);
    sbPlayer.chips -= sbAmt; sbPlayer.bet = sbAmt; pot += sbAmt;
    bbPlayer.chips -= bbAmt; bbPlayer.bet = bbAmt; pot += bbAmt;
    currentBet = bbAmt;
    
    if (sbPlayer.chips === 0) sbPlayer.status = 'ALL_IN';
    if (bbPlayer.chips === 0) bbPlayer.status = 'ALL_IN';
    
    activityLog(`Blinds: ${sbPlayer.name} posts £${sbAmt}, ${bbPlayer.name} posts £${bbAmt}`, 'bet');
    
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    while (players[playerOrder[turnIndex]].status !== 'ACTIVE') {
        turnIndex = (turnIndex + 1) % playerOrder.length;
    }
    gameStage = 'PREFLOP';
    actionCount = 0;
    broadcast();
}

function checkBettingRoundComplete() {
    const activeInHand = getPlayersInHand().filter(id => players[id].status === 'ACTIVE');
    if (activeInHand.length <= 1) { advanceStage(); return; }
    
    const allMatched = activeInHand.every(id => players[id].bet === currentBet);
    if (allMatched && actionCount >= activeInHand.length) {
        advanceStage();
    } else {
        turnIndex = (turnIndex + 1) % playerOrder.length;
        while (players[playerOrder[turnIndex]].status !== 'ACTIVE') {
            turnIndex = (turnIndex + 1) % playerOrder.length;
        }
        broadcast();
    }
}

function advanceStage() {
    playerOrder.forEach(id => { pot += players[id].bet; players[id].bet = 0; });
    currentBet = 0; actionCount = 0;
    
    if (getPlayersInHand().length === 1) {
        const winner = getPlayersInHand()[0];
        players[winner].chips += pot;
        activityLog(`${players[winner].name} wins £${pot} (Everyone folded)`, 'win');
        pot = 0;
        setTimeout(startNewHand, 3000);
        return;
    }

    if (gameStage === 'PREFLOP') {
        community = [dealCard(), dealCard(), dealCard()];
        gameStage = 'FLOP';
        activityLog(`FLOP: ${community.join(' ')}`, 'action');
    } else if (gameStage === 'FLOP') {
        community.push(dealCard());
        gameStage = 'TURN';
        activityLog(`TURN: ${community[3]}`, 'action');
    } else if (gameStage === 'TURN') {
        community.push(dealCard());
        gameStage = 'RIVER';
        activityLog(`RIVER: ${community[4]}`, 'action');
    } else {
        gameStage = 'SHOWDOWN';
        performShowdown();
        return;
    }
    
    turnIndex = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[turnIndex]].status !== 'ACTIVE') {
        turnIndex = (turnIndex + 1) % playerOrder.length;
    }
    broadcast();
}

function performShowdown() {
    const inHand = getPlayersInHand();
    let winners = []; let best = -1;
    inHand.forEach(id => {
        const res = evaluateHand(players[id].hand, community);
        if (res.rank > best) { best = res.rank; winners = [id]; }
        else if (res.rank === best) winners.push(id);
    });
    const share = Math.floor(pot / winners.length);
    winners.forEach(id => {
        players[id].chips += share;
        activityLog(`${players[id].name} wins £${share} with ${evaluateHand(players[id].hand, community).name}`, 'win');
    });
    pot = 0;
    broadcast();
}

function evaluateHand(hand, board) {
    const cards = [...hand, ...board];
    const values = cards.map(c => cardValues[c.slice(0, -1)]).sort((a,b) => b-a);
    const counts = {}; cards.forEach(c => { const r = c.slice(0,-1); counts[r] = (counts[r]||0)+1; });
    const pairs = Object.entries(counts).filter(([k,v])=>v===2).length;
    const trips = Object.entries(counts).filter(([k,v])=>v===3).length;
    if (trips && pairs) return {rank: 600, name: "Full House"};
    if (trips) return {rank: 300, name: "Three of a Kind"};
    if (pairs >= 2) return {rank: 200, name: "Two Pair"};
    if (pairs === 1) return {rank: 100, name: "Pair"};
    return {rank: values[0], name: "High Card"};
}

function handleAction(socket, action) {
    if (playerOrder[turnIndex] !== socket.id) return;
    const p = players[socket.id];
    actionCount++;
    if (action.type === 'fold') {
        p.status = 'FOLDED'; p.hand = [];
        activityLog(`${p.name} folds`, 'fold');
    } else if (action.type === 'call') {
        const amt = Math.min(currentBet - p.bet, p.chips);
        p.chips -= amt; p.bet += amt;
        activityLog(amt === 0 ? `${p.name} checks` : `${p.name} calls £${amt}`, 'bet');
    } else if (action.type === 'raise') {
        const total = Math.min(action.amt, p.chips + p.bet);
        const diff = total - p.bet;
        p.chips -= diff; p.bet = total; currentBet = total; actionCount = 1;
        activityLog(`${p.name} raises to £${total}`, 'bet');
    }
    if (p.chips === 0 && p.status !== 'FOLDED') p.status = 'ALL_IN';
    checkBettingRoundComplete();
}

function broadcast() {
    playerOrder.forEach((id) => {
        const me = players[id];
        const sbIdx = (dealerIndex + 1) % playerOrder.length;
        const bbIdx = (dealerIndex + 2) % playerOrder.length;
        io.to(id).emit('update', {
            myId: id, myName: me.name, isHost: (id === playerOrder[0]),
            players: playerOrder.map((pid, idx) => ({
                id: pid, name: players[pid].name, chips: players[pid].chips, bet: players[pid].bet, status: players[pid].status,
                isDealer: idx === dealerIndex, isSB: idx === sbIdx, isBB: idx === bbIdx,
                displayCards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['🂠','🂠'] : [])
            })),
            community, pot, gameStage, activeId: playerOrder[turnIndex], currentBet, SB, BB,
            callAmount: Math.min(currentBet - me.bet, me.chips)
        });
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name, chips: STARTING_CHIPS, hand: [], bet: 0, status: 'ACTIVE' };
        if (!playerOrder.includes(socket.id)) playerOrder.push(socket.id);
        broadcast();
    });
    socket.on('start_game', () => { if(playerOrder[0] === socket.id) startNewHand(); });
    socket.on('next_hand', () => { if(playerOrder[0] === socket.id) startNewHand(); });
    socket.on('action', (data) => handleAction(socket, data));
    socket.on('reset_engine', () => { if(playerOrder[0] === socket.id) { players={}; playerOrder=[]; io.emit('force_refresh'); } });
    socket.on('disconnect', () => { delete players[socket.id]; playerOrder = playerOrder.filter(id => id !== socket.id); broadcast(); });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>SYFM Poker</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
            body { background: #050505; color: white; font-family: sans-serif; margin: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
            #header-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 15px; background: #111; border-bottom: 2px solid #333; font-size: 0.9em; }
            #title-group { display: flex; align-items: baseline; }
            #title { font-size: 1.2em; font-weight: bold; color: #f1c40f; margin-right: 15px; }
            
            .game-container { position: relative; flex-grow: 1; display: flex; justify-content: center; align-items: center; overflow: hidden; }
            .poker-table { width: 80vw; height: 40vh; max-width: 600px; max-height: 250px; background: #1a5c1a; border: 8px solid #5d2e0c; border-radius: 150px; position: relative; }
            
            #community { position: absolute; top: 40%; left: 50%; transform: translate(-50%, -50%); font-size: 2.2em; text-align: center; width: 100%; }
            #action-guide { position: absolute; bottom: 15%; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.6); padding: 4px 12px; border-radius: 10px; font-size: 0.75em; color: #f1c40f; white-space: nowrap; }

            .player-seat { position: absolute; width: 120px; transform: translate(-50%, -50%); z-index: 10; }
            .player-box { background: #222; border: 2px solid #555; padding: 5px; border-radius: 8px; text-align: center; font-size: 0.7em; }
            .active-turn { border-color: #f1c40f !important; box-shadow: 0 0 10px #f1c40f; }
            .folded { opacity: 0.4; }

            #controls { background: #111; padding: 10px; border-top: 2px solid #f1c40f; text-align: center; display: none; }
            #controls button { padding: 12px 15px; font-size: 0.9em; margin: 2px; border: none; border-radius: 5px; color: white; font-weight: bold; }
            #controls input { padding: 10px; width: 60px; }

            #activity-log { position: fixed; bottom: 70px; left: 10px; width: 250px; height: 150px; background: rgba(0,0,0,0.9); border: 1px solid #444; display: none; z-index: 2000; font-size: 10px; padding: 5px; overflow-y: scroll; }
            #activity-log.visible { display: block; }
            #show-log-btn { position: fixed; bottom: 75px; right: 10px; padding: 5px 10px; background: #34495e; color: white; border-radius: 5px; z-index: 2000; font-size: 10px; }
            #debug-window { position: fixed; top: 50px; right: 10px; width: 200px; height: 150px; background: rgba(0,0,0,0.8); color: lime; font-family: monospace; font-size: 9px; padding: 5px; overflow-y: scroll; border: 1px solid #333; display: none; }

            @media (orientation: landscape) {
                .poker-table { height: 35vh; width: 60vw; }
                .player-seat { width: 100px; }
                #controls { padding: 5px; }
                #controls button { padding: 8px 12px; font-size: 0.8em; }
            }
        </style>
    </head>
    <body>
        <div id="header-row">
            <div id="title-group">
                <div id="title">SYFM POKER</div>
                <div id="user-info">You are: <span id="my-name-display" style="color:#f1c40f">...</span></div>
            </div>
            <div id="ui-bar">BLINDS: <span id="blinds">0/0</span> | POT: £<span id="pot">0</span></div>
        </div>
        
        <div class="game-container">
            <div class="poker-table" id="table-main">
                <div id="community"></div>
                <div id="action-guide">Waiting for players...</div>
            </div>
            <div id="seats"></div>
            <div id="debug-window"><b>ENGINE LOG</b><hr></div>
        </div>

        <button id="start-btn" onclick="socket.emit('start_game')" style="position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); padding:20px; background:green; color:white; display:none; z-index:1000;">START GAME</button>

        <div id="controls">
            <button onclick="socket.emit('action', {type:'fold'})" style="background: #c0392b;">FOLD</button>
            <button id="call-btn" onclick="socket.emit('action', {type:'call'})" style="background: #27ae60;">CHECK</button>
            <input type="number" id="bet-amt" value="100">
            <button onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})" style="background: #e67e22;">RAISE</button>
        </div>

        <button id="show-log-btn" onclick="document.getElementById('activity-log').classList.toggle('visible')">LOG</button>
        <div id="activity-log"><div id="log-entries"></div></div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            let socket = io();
            window.onload = () => {
                let name = prompt("Enter Name:");
                socket.emit('join', name || "Guest");
            };

            socket.on('update', data => {
                document.getElementById('my-name-display').innerText = data.myName;
                document.getElementById('blinds').innerText = data.SB + "/" + data.BB;
                document.getElementById('pot').innerText = "£" + data.pot;
                document.getElementById('community').innerText = data.community.join(' ');
                
                // Guide Logic
                const activePlayer = data.players.find(p => p.id === data.activeId);
                const guide = document.getElementById('action-guide');
                if (data.myId === data.activeId) {
                    guide.innerText = data.callAmount > 0 ? "Your turn: Call £" + data.callAmount + " or Fold/Raise" : "Your turn: Check or Raise";
                } else if (activePlayer) {
                    guide.innerText = "Waiting for " + activePlayer.name + "...";
                }

                document.getElementById('start-btn').style.display = (data.isHost && data.gameStage === 'LOBBY') ? 'block' : 'none';
                document.getElementById('debug-window').style.display = data.isHost ? 'block' : 'none';
                
                const isMyTurn = (socket.id === data.activeId && !['LOBBY','SHOWDOWN'].includes(data.gameStage));
                document.getElementById('controls').style.display = isMyTurn ? 'block' : 'none';
                if(isMyTurn) document.getElementById('call-btn').innerText = data.callAmount > 0 ? "CALL £" + data.callAmount : "CHECK";

                const area = document.getElementById('seats');
                area.innerHTML = '';
                const rect = document.getElementById('table-main').getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;

                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI - Math.PI/2;
                    const x = centerX + (rect.width/1.6) * Math.cos(angle);
                    const y = centerY + (rect.height/1.3) * Math.sin(angle);
                    const seat = document.createElement('div');
                    seat.className = "player-seat";
                    seat.style.left = x + "px"; seat.style.top = y + "px";
                    seat.innerHTML = \`
                        <div class="player-box \${p.id === data.activeId ? 'active-turn' : ''} \${p.status === 'FOLDED' ? 'folded' : ''}">
                            \${p.isDealer ? '<span style="color:white">● D</span> ' : ''}<b>\${p.name}</b><br>£\${p.chips}<br>
                            <small>\${p.displayCards.join(' ')}</small>
                            \${p.bet > 0 ? '<div style="color:#f1c40f">£'+p.bet+'</div>' : ''}
                        </div>\`;
                    area.appendChild(seat);
                });
            });

            socket.on('activity_log', data => {
                const entry = document.createElement('div');
                entry.style.borderBottom = "1px solid #333";
                entry.innerText = data.msg;
                document.getElementById('log-entries').appendChild(entry);
                document.getElementById('activity-log').scrollTop = 9999;
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

http.listen(3000, () => console.log('Server running on port 3000'));
