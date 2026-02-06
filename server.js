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
let actionCount = 0;  // Track how many players have acted this betting round
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

function dealCard() {
    return deck.pop();
}

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
    activityLog('--- NEW HAND ---', 'action');
    
    community = [];
    pot = 0;
    currentBet = 0;
    lastRaiser = null;
    sidePots = [];
    
    const active = getActivePlayers();
    if (active.length < 2) {
        log('Not enough players, ending tournament');
        gameStage = 'LOBBY';
        broadcast();
        return;
    }
    
    dealerIndex = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[dealerIndex]].status !== 'ACTIVE') {
        dealerIndex = (dealerIndex + 1) % playerOrder.length;
    }
    
    log('Dealer: ' + players[playerOrder[dealerIndex]].name);
    
    playerOrder.forEach(id => {
        players[id].bet = 0;
        players[id].hand = [];
        if (players[id].status === 'ACTIVE') {
            players[id].roundBet = 0;
        }
    });
    
    deck = createDeck();
    active.forEach(id => {
        players[id].hand = [dealCard(), dealCard()];
    });
    
    const sbIdx = (dealerIndex + 1) % playerOrder.length;
    const bbIdx = (dealerIndex + 2) % playerOrder.length;
    
    const sbPlayer = players[playerOrder[sbIdx]];
    const bbPlayer = players[playerOrder[bbIdx]];
    
    const sbAmt = Math.min(SB, sbPlayer.chips);
    const bbAmt = Math.min(BB, bbPlayer.chips);
    
    sbPlayer.chips -= sbAmt;
    sbPlayer.bet = sbAmt;
    pot += sbAmt;
    
    bbPlayer.chips -= bbAmt;
    bbPlayer.bet = bbAmt;
    pot += bbAmt;
    currentBet = bbAmt;
    
    if (sbPlayer.chips === 0) sbPlayer.status = 'ALL_IN';
    if (bbPlayer.chips === 0) bbPlayer.status = 'ALL_IN';
    
    log('SB: ' + sbPlayer.name + ' posts ' + sbAmt);
    log('BB: ' + bbPlayer.name + ' posts ' + bbAmt);
    activityLog('Blinds: ' + sbPlayer.name + ' (£' + sbAmt + ') / ' + bbPlayer.name + ' (£' + bbAmt + ')', 'bet');
    
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    while (players[playerOrder[turnIndex]].status !== 'ACTIVE') {
        turnIndex = (turnIndex + 1) % playerOrder.length;
    }
    
    gameStage = 'PREFLOP';
    turnTimer = TURN_TIME;
    lastRaiser = bbIdx;
    actionCount = 0; 
    
    broadcast();
}

function nextPlayer() {
    const initialTurn = turnIndex;
    do {
        turnIndex = (turnIndex + 1) % playerOrder.length;
        if (turnIndex === initialTurn) break; 
    } while (players[playerOrder[turnIndex]].status !== 'ACTIVE');
    
    turnTimer = TURN_TIME;
}

function checkBettingRoundComplete() {
    const activePlayers = getPlayersInHand().filter(id => players[id].status === 'ACTIVE');
    
    log('--- CHECK BETTING ROUND ---');
    log('Active players: ' + activePlayers.length);
    log('Action count: ' + actionCount);
    log('Current bet: ' + currentBet);
    
    if (activePlayers.length === 0) {
        log('No active players, advancing');
        advanceStage();
        return;
    }
    
    if (activePlayers.length === 1) {
        log('Only 1 active player, advancing');
        advanceStage();
        return;
    }
    
    const allMatched = activePlayers.every(id => players[id].bet === currentBet);
    log('All matched: ' + allMatched);
    
    if (allMatched && actionCount >= activePlayers.length) {
        log('Round complete! Advancing stage');
        advanceStage();
    } else {
        log('Round continues, next player');
        nextPlayer();
        broadcast();
    }
}

function advanceStage() {
    log('Advancing from ' + gameStage);
    
    playerOrder.forEach(id => {
        pot += players[id].bet;
        players[id].bet = 0;
    });
    currentBet = 0;
    lastRaiser = null;
    actionCount = 0; 
    
    turnIndex = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[turnIndex]].status !== 'ACTIVE') {
        turnIndex = (turnIndex + 1) % playerOrder.length;
    }
    
    const playersInHand = getPlayersInHand();
    
    if (playersInHand.length === 1) {
        const winner = playersInHand[0];
        players[winner].chips += pot;
        log(players[winner].name + ' wins ' + pot);
        pot = 0;
        
        setTimeout(() => {
            startNewHand();
        }, 3000);
        return;
    }
    
    if (gameStage === 'PREFLOP') {
        community = [dealCard(), dealCard(), dealCard()];
        gameStage = 'FLOP';
    } else if (gameStage === 'FLOP') {
        community.push(dealCard());
        gameStage = 'TURN';
    } else if (gameStage === 'TURN') {
        community.push(dealCard());
        gameStage = 'RIVER';
    } else if (gameStage === 'RIVER') {
        gameStage = 'SHOWDOWN';
        performShowdown();
        return;
    }
    
    turnTimer = TURN_TIME;
    broadcast();
}

function performShowdown() {
    log('=== SHOWDOWN ===');
    const playersInHand = getPlayersInHand();
    let winners = [];
    let bestScore = -1;
    
    playersInHand.forEach(id => {
        const score = evaluateHand(players[id].hand, community);
        if (score.rank > bestScore) {
            bestScore = score.rank;
            winners = [id];
        } else if (score.rank === bestScore) {
            winners.push(id);
        }
    });
    
    const winAmt = Math.floor(pot / winners.length);
    winners.forEach(id => {
        players[id].chips += winAmt;
        const score = evaluateHand(players[id].hand, community);
        activityLog(players[id].name + ' wins £' + winAmt + ' with ' + score.name, 'win');
    });
    
    pot = 0;
    playerOrder.forEach(id => {
        if (players[id].chips === 0) players[id].status = 'ELIMINATED';
    });
    
    gameStage = 'SHOWDOWN';
    broadcast();
}

function evaluateHand(hand, board) {
    const cards = [...hand, ...board];
    const counts = {};
    const suitCounts = {};
    cards.forEach(c => {
        const rank = c.slice(0, -1);
        const suit = c.slice(-1);
        counts[rank] = (counts[rank] || 0) + 1;
        suitCounts[suit] = (suitCounts[suit] || 0) + 1;
    });
    const values = cards.map(c => cardValues[c.slice(0, -1)]).sort((a, b) => b - a);
    const uniqueValues = [...new Set(values)].sort((a, b) => b - a);
    const isFlush = Object.values(suitCounts).some(c => c >= 5);
    const straightInfo = checkStraight(values);
    const isStraight = straightInfo.isStraight;
    const straightHigh = straightInfo.highCard;
    const pairs = Object.entries(counts).filter(([k,v]) => v === 2).map(([k,v]) => cardValues[k]).sort((a,b) => b-a);
    const trips = Object.entries(counts).filter(([k,v]) => v === 3).map(([k,v]) => cardValues[k]).sort((a,b) => b-a);
    const quads = Object.entries(counts).filter(([k,v]) => v === 4).map(([k,v]) => cardValues[k]).sort((a,b) => b-a);
    
    if (isFlush && isStraight) return { rank: 8000000 + straightHigh, name: 'Straight Flush', highCard: straightHigh };
    if (quads.length > 0) return { rank: 7000000 + quads[0] * 100, name: 'Four of a Kind', highCard: quads[0] };
    if (trips.length > 0 && pairs.length > 0) return { rank: 6000000 + trips[0] * 100 + pairs[0], name: 'Full House', highCard: trips[0] };
    if (isFlush) return { rank: 5000000 + uniqueValues[0], name: 'Flush', highCard: uniqueValues[0] };
    if (isStraight) return { rank: 4000000 + straightHigh, name: 'Straight', highCard: straightHigh };
    if (trips.length > 0) return { rank: 3000000 + trips[0] * 100, name: 'Three of a Kind', highCard: trips[0] };
    if (pairs.length >= 2) return { rank: 2000000 + pairs[0] * 100 + pairs[1], name: 'Two Pair', highCard: pairs[0] };
    if (pairs.length === 1) return { rank: 1000000 + pairs[0] * 100, name: 'Pair', highCard: pairs[0] };
    return { rank: values[0], name: 'High Card', highCard: values[0] };
}

function checkStraight(values) {
    const unique = [...new Set(values)].sort((a, b) => b - a);
    for (let i = 0; i < unique.length - 4; i++) {
        if (unique[i] - unique[i + 4] === 4) return { isStraight: true, highCard: unique[i] };
    }
    if (unique.includes(14) && unique.includes(5) && unique.includes(4) && unique.includes(3) && unique.includes(2)) return { isStraight: true, highCard: 5 };
    return { isStraight: false, highCard: 0 };
}

function handleAction(socket, action) {
    if (gameStage === 'LOBBY' || gameStage === 'SHOWDOWN') return;
    if (playerOrder[turnIndex] !== socket.id) return;
    const player = players[socket.id];
    actionCount++; 
    if (action.type === 'fold') {
        player.status = 'FOLDED';
        player.hand = [];
        checkBettingRoundComplete();
    } else if (action.type === 'call') {
        const callAmt = Math.min(currentBet - player.bet, player.chips);
        player.chips -= callAmt;
        player.bet += callAmt;
        if (player.chips === 0) player.status = 'ALL_IN';
        checkBettingRoundComplete();
    } else if (action.type === 'raise') {
        const raiseTotal = Math.min(action.amt, player.chips + player.bet);
        const raiseAmt = raiseTotal - player.bet;
        if (raiseTotal <= currentBet) { broadcast(); return; }
        player.chips -= raiseAmt;
        player.bet = raiseTotal;
        currentBet = raiseTotal;
        actionCount = 1; 
        if (player.chips === 0) player.status = 'ALL_IN';
        checkBettingRoundComplete();
    }
}

function broadcast() {
    playerOrder.forEach((id) => {
        const me = players[id];
        if (!me) return;
        const sbIdx = dealerIndex >= 0 ? (dealerIndex + 1) % playerOrder.length : -1;
        const bbIdx = dealerIndex >= 0 ? (dealerIndex + 2) % playerOrder.length : -1;
        io.to(id).emit('update', {
            myId: id,
            isHost: (id === playerOrder[0]),
            players: playerOrder.map((pid, idx) => ({
                id: pid, 
                name: players[pid].name, 
                chips: players[pid].chips, 
                bet: players[pid].bet, 
                status: players[pid].status,
                isDealer: idx === dealerIndex,
                isSB: idx === sbIdx,
                isBB: idx === bbIdx,
                displayCards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['🂠','🂠'] : [])
            })),
            community, pot, gameStage, activeId: playerOrder[turnIndex], currentBet, SB, BB, blindTimer, turnTimer,
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
            
            /* Consolidated Top Bar */
            #header-row { display: flex; align-items: baseline; padding: 10px 15px; background: #111; border-bottom: 2px solid #333; z-index: 1000; }
            #title { font-size: 1.4em; font-weight: bold; color: #f1c40f; margin-right: 20px; text-transform: uppercase; }
            #ui-bar { font-size: 0.85em; color: #ccc; }
            #ui-bar span { font-weight: bold; color: white; }

            .game-container { position: relative; flex-grow: 1; display: flex; justify-content: center; align-items: flex-start; padding-top: 5vh; overflow: hidden; }
            .poker-table { width: 550px; height: 260px; background: #1a5c1a; border: 8px solid #5d2e0c; border-radius: 130px; position: relative; box-shadow: inset 0 0 50px rgba(0,0,0,0.5); }
            
            #community { position: absolute; top: 55%; left: 50%; transform: translate(-50%, -50%); font-size: 2.5em; letter-spacing: 5px; text-align: center; width: 100%; }

            /* Player Seats anchored to the table container */
            .player-seat { position: absolute; width: 140px; transform: translate(-50%, -50%); z-index: 10; }
            .player-box { background: #222; border: 2px solid #555; padding: 8px; border-radius: 10px; text-align: center; font-size: 0.8em; }
            .active-turn { border-color: #f1c40f !important; box-shadow: 0 0 15px #f1c40f; }
            .folded { opacity: 0.4; }

            .dealer-chip { background: white; color: black; border-radius: 50%; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; position: absolute; top: -10px; left: 50%; transform: translateX(-50%); }

            #controls { background: #111; padding: 15px; border-top: 2px solid #f1c40f; text-align: center; z-index: 100; }
            #controls button { margin: 2px; padding: 12px 18px; font-size: 14px; cursor: pointer; color: white; border: none; border-radius: 5px; font-weight: bold; }
            #controls input { padding: 10px; width: 80px; font-size: 14px; }

            #activity-log { position: fixed; bottom: 80px; left: 10px; width: 300px; height: 200px; background: rgba(0,0,0,0.9); color: #fff; font-family: monospace; padding: 10px; overflow-y: scroll; border: 1px solid #444; display: none; z-index: 2000; font-size: 11px; }
            #activity-log.visible { display: block; }
            #show-log-btn { position: fixed; bottom: 85px; right: 10px; padding: 8px 15px; background: #34495e; color: white; border-radius: 5px; z-index: 2000; cursor: pointer; font-size: 12px; }

            #host-layer #start-btn { position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%); padding: 20px 40px; background: #27ae60; color: white; border-radius: 10px; display: none; z-index: 500; font-size: 1.5em; cursor: pointer; }

            @media (orientation: landscape) {
                .poker-table { width: 480px; height: 200px; }
                #community { font-size: 2em; }
                .player-seat { width: 110px; }
                .player-box { font-size: 0.7em; }
                #controls { padding: 5px; }
            }
        </style>
    </head>
    <body>
        <div id="header-row">
            <div id="title">SYFM POKER</div>
            <div id="ui-bar">
                BLINDS: <span id="blinds">--</span> | POT: £<span id="pot">0</span> | STAGE: <span id="stage">LOBBY</span>
            </div>
        </div>
        
        <div class="game-container">
            <div class="poker-table" id="table-main">
                <div id="community"></div>
            </div>
            <div id="seats"></div>
        </div>

        <div id="host-layer">
            <button id="start-btn" onclick="socket.emit('start_game')">START TOURNAMENT</button>
            <button id="continue-btn" onclick="socket.emit('next_hand')" style="position:fixed; bottom:100px; left:50%; transform:translateX(-50%); display:none; padding:15px 30px; background:green; color:white; border-radius:10px;">CONTINUE</button>
        </div>

        <div id="controls">
            <button onclick="socket.emit('action', {type:'fold'})" style="background: #c0392b;">FOLD</button>
            <button id="call-btn" onclick="socket.emit('action', {type:'call'})" style="background: #27ae60;">CHECK/CALL</button>
            <input type="number" id="bet-amt" value="100">
            <button onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})" style="background: #e67e22;">RAISE</button>
        </div>

        <button id="show-log-btn" onclick="document.getElementById('activity-log').classList.toggle('visible')">SHOW LOG</button>
        <div id="activity-log"><div id="log-entries"></div></div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            let socket = io();
            window.onload = () => {
                let name = prompt("Name:");
                socket.emit('join', name || "Player");
            };

            socket.on('update', data => {
                document.getElementById('blinds').innerText = data.SB + "/" + data.BB;
                document.getElementById('pot').innerText = data.pot;
                document.getElementById('stage').innerText = data.gameStage;
                document.getElementById('community').innerText = data.community.join(' ');
                
                document.getElementById('start-btn').style.display = (data.isHost && data.gameStage === 'LOBBY') ? 'block' : 'none';
                document.getElementById('continue-btn').style.display = (data.isHost && data.gameStage === 'SHOWDOWN') ? 'block' : 'none';
                
                const isMyTurn = (socket.id === data.activeId && !['LOBBY','SHOWDOWN'].includes(data.gameStage));
                document.getElementById('controls').style.display = isMyTurn ? 'block' : 'none';
                if(isMyTurn) {
                    document.getElementById('call-btn').innerText = data.callAmount > 0 ? "CALL £" + data.callAmount : "CHECK";
                }

                const area = document.getElementById('seats');
                area.innerHTML = '';
                const table = document.getElementById('table-main');
                const rect = table.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;

                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI - Math.PI/2;
                    const rx = rect.width / 1.7; // Radius X
                    const ry = rect.height / 1.5; // Radius Y
                    const x = centerX + rx * Math.cos(angle);
                    const y = centerY + ry * Math.sin(angle);

                    const seat = document.createElement('div');
                    seat.className = "player-seat";
                    seat.style.left = x + "px";
                    seat.style.top = y + "px";
                    seat.innerHTML = \`
                        <div class="player-box \${p.id === data.activeId ? 'active-turn' : ''} \${p.status === 'FOLDED' ? 'folded' : ''}">
                            \${p.isDealer ? '<div class="dealer-chip">D</div>' : ''}
                            <b>\${p.name}</b><br>£\${p.chips}<br>
                            <small>\${p.displayCards.join(' ')}</small>
                            \${p.bet > 0 ? '<div style="color:#f1c40f">Bet: £'+p.bet+'</div>' : ''}
                        </div>
                    \`;
                    area.appendChild(seat);
                });
            });

            socket.on('activity_log', data => {
                const entry = document.createElement('div');
                entry.style.borderBottom = "1px solid #333";
                entry.innerText = data.msg;
                const container = document.getElementById('log-entries');
                container.appendChild(entry);
                document.getElementById('activity-log').scrollTop = document.getElementById('activity-log').scrollHeight;
            });
            socket.on('force_refresh', () => location.reload());
        </script>
    </body>
    </html>
    `);
});

http.listen(3000, () => console.log('Server running on port 3000'));
