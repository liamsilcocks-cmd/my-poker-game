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
let sidePots = [];

const cardValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
const suits = ['♠','♥','♦','♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function log(msg) {
    console.log(msg);
    io.emit('debug_msg', msg);
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
    
    // Reset state
    community = [];
    pot = 0;
    currentBet = 0;
    lastRaiser = null;
    sidePots = [];
    
    // Move dealer
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
    
    // Reset all players for new hand
    playerOrder.forEach(id => {
        players[id].bet = 0;
        players[id].hand = [];
        if (players[id].status === 'ACTIVE') {
            players[id].roundBet = 0;
        }
    });
    
    // Create and shuffle deck
    deck = createDeck();
    
    // Deal 2 cards to each active player
    active.forEach(id => {
        players[id].hand = [dealCard(), dealCard()];
    });
    
    // Post blinds
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
    
    // Set first action to left of BB
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    while (players[playerOrder[turnIndex]].status !== 'ACTIVE') {
        turnIndex = (turnIndex + 1) % playerOrder.length;
    }
    
    gameStage = 'PREFLOP';
    turnTimer = TURN_TIME;
    lastRaiser = bbIdx;
    
    broadcast();
}

function nextPlayer() {
    const initialTurn = turnIndex;
    do {
        turnIndex = (turnIndex + 1) % playerOrder.length;
        if (turnIndex === initialTurn) break; // Prevent infinite loop
    } while (players[playerOrder[turnIndex]].status !== 'ACTIVE');
    
    turnTimer = TURN_TIME;
}

function checkBettingRoundComplete() {
    const activePlayers = getPlayersInHand().filter(id => players[id].status === 'ACTIVE');
    
    if (activePlayers.length === 0) {
        // Everyone all-in or folded, go to showdown
        advanceStage();
        return;
    }
    
    // Check if everyone has acted and matched the bet
    const allMatched = activePlayers.every(id => players[id].bet === currentBet);
    const lastRaiserActed = lastRaiser === null || turnIndex === lastRaiser;
    
    if (allMatched && lastRaiserActed) {
        advanceStage();
    } else {
        nextPlayer();
        broadcast();
    }
}

function advanceStage() {
    log('Advancing from ' + gameStage);
    
    // Move bets to pot
    playerOrder.forEach(id => {
        pot += players[id].bet;
        players[id].bet = 0;
    });
    currentBet = 0;
    lastRaiser = null;
    
    // Set turn back to left of dealer
    turnIndex = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[turnIndex]].status !== 'ACTIVE') {
        turnIndex = (turnIndex + 1) % playerOrder.length;
    }
    
    const playersInHand = getPlayersInHand();
    
    if (playersInHand.length === 1) {
        // Only one player left, they win
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
        // Deal flop
        community = [dealCard(), dealCard(), dealCard()];
        gameStage = 'FLOP';
        log('FLOP: ' + community.join(' '));
    } else if (gameStage === 'FLOP') {
        // Deal turn
        community.push(dealCard());
        gameStage = 'TURN';
        log('TURN: ' + community[3]);
    } else if (gameStage === 'TURN') {
        // Deal river
        community.push(dealCard());
        gameStage = 'RIVER';
        log('RIVER: ' + community[4]);
    } else if (gameStage === 'RIVER') {
        // Showdown
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
        log(players[id].name + ': ' + score.name + ' (score: ' + score.rank + ')');
        
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
        log(players[id].name + ' wins ' + winAmt);
    });
    
    pot = 0;
    
    // Eliminate broke players
    playerOrder.forEach(id => {
        if (players[id].chips === 0) {
            players[id].status = 'ELIMINATED';
            log(players[id].name + ' ELIMINATED');
        }
    });
    
    broadcast();
    
    setTimeout(() => {
        startNewHand();
    }, 5000);
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
    const isFlush = Object.values(suitCounts).some(c => c >= 5);
    const isStraight = checkStraight(values);
    
    const pairs = Object.values(counts).filter(c => c === 2).length;
    const trips = Object.values(counts).some(c => c === 3);
    const quads = Object.values(counts).some(c => c === 4);
    
    if (isFlush && isStraight) return { rank: 8, name: 'Straight Flush' };
    if (quads) return { rank: 7, name: 'Four of a Kind' };
    if (trips && pairs >= 1) return { rank: 6, name: 'Full House' };
    if (isFlush) return { rank: 5, name: 'Flush' };
    if (isStraight) return { rank: 4, name: 'Straight' };
    if (trips) return { rank: 3, name: 'Three of a Kind' };
    if (pairs >= 2) return { rank: 2, name: 'Two Pair' };
    if (pairs === 1) return { rank: 1, name: 'Pair' };
    return { rank: 0, name: 'High Card' };
}

function checkStraight(values) {
    const unique = [...new Set(values)].sort((a, b) => b - a);
    for (let i = 0; i < unique.length - 4; i++) {
        if (unique[i] - unique[i + 4] === 4) return true;
    }
    // Check for A-2-3-4-5
    if (unique.includes(14) && unique.includes(2) && unique.includes(3) && unique.includes(4) && unique.includes(5)) {
        return true;
    }
    return false;
}

function handleAction(socket, action) {
    if (gameStage === 'LOBBY' || gameStage === 'SHOWDOWN') return;
    if (playerOrder[turnIndex] !== socket.id) {
        log('Not your turn!');
        return;
    }
    
    const player = players[socket.id];
    
    if (action.type === 'fold') {
        log(player.name + ' folds');
        player.status = 'FOLDED';
        player.hand = [];
        checkBettingRoundComplete();
        
    } else if (action.type === 'call') {
        const callAmt = Math.min(currentBet - player.bet, player.chips);
        player.chips -= callAmt;
        player.bet += callAmt;
        pot += callAmt;
        log(player.name + ' calls ' + callAmt);
        
        if (player.chips === 0) {
            player.status = 'ALL_IN';
            log(player.name + ' is ALL IN');
        }
        
        checkBettingRoundComplete();
        
    } else if (action.type === 'raise') {
        const raiseTotal = Math.min(action.amt, player.chips + player.bet);
        const raiseAmt = raiseTotal - player.bet;
        
        if (raiseTotal <= currentBet) {
            log('Raise must be higher than current bet');
            return;
        }
        
        player.chips -= raiseAmt;
        player.bet = raiseTotal;
        pot += raiseAmt;
        currentBet = raiseTotal;
        lastRaiser = turnIndex;
        
        log(player.name + ' raises to ' + raiseTotal);
        
        if (player.chips === 0) {
            player.status = 'ALL_IN';
            log(player.name + ' is ALL IN');
        }
        
        checkBettingRoundComplete();
    }
}

function broadcast() {
    playerOrder.forEach((id) => {
        const me = players[id];
        if (!me) return;
        
        const isHost = (id === playerOrder[0]);

        io.to(id).emit('update', {
            myId: id,
            isHost: isHost,
            players: playerOrder.map((pid) => ({
                id: pid, 
                name: players[pid].name, 
                chips: players[pid].chips, 
                bet: players[pid].bet, 
                status: players[pid].status,
                isDealer: playerOrder[dealerIndex] === pid,
                displayCards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['🂠','🂠'] : [])
            })),
            community, 
            pot, 
            gameStage, 
            activeId: playerOrder[turnIndex], 
            currentBet, 
            SB, 
            BB, 
            blindTimer, 
            turnTimer,
            callAmount: Math.min(currentBet - me.bet, me.chips)
        });
    });
}

// Timer Loop
setInterval(() => {
    if (gameStage === 'LOBBY' || gameStage === 'SHOWDOWN') return;
    
    if (blindTimer > 0) {
        blindTimer--;
        if (blindTimer === 0) {
            SB *= 2;
            BB *= 2;
            blindTimer = BLIND_INTERVAL;
            log('BLINDS INCREASED: ' + SB + '/' + BB);
        }
    }
    
    if (turnTimer > 0) {
        turnTimer--;
        if (turnTimer === 0) {
            // Auto-fold on timeout
            const currentPlayer = players[playerOrder[turnIndex]];
            if (currentPlayer && currentPlayer.status === 'ACTIVE') {
                log(currentPlayer.name + ' timed out - auto fold');
                currentPlayer.status = 'FOLDED';
                currentPlayer.hand = [];
                checkBettingRoundComplete();
            }
        }
    }
    
    broadcast();
}, 1000);

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { background: #050505; color: white; font-family: sans-serif; margin: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
            #ui-bar { background: #111; padding: 15px; text-align: center; border-bottom: 2px solid #444; }
            .game-container { position: relative; flex-grow: 1; display: flex; justify-content: center; align-items: center; }
            .poker-table { width: 600px; height: 300px; background: green; border: 10px solid #2b1d12; border-radius: 150px; display: flex; flex-direction: column; justify-content: center; align-items: center; }
            
            .player-seat { position: absolute; width: 180px; transform: translate(-50%, -50%); }
            .player-box { background: #222; border: 3px solid #555; padding: 10px; border-radius: 10px; text-align: center; }
            
            .dealer-chip { background: white; color: black; border-radius: 50%; width: 20px; height: 20px; display: inline-block; font-weight: bold; line-height: 20px; }
            
            @keyframes rainbow {
                0% { border-color: red; } 50% { border-color: lime; } 100% { border-color: red; }
            }
            .is-me { animation: rainbow 2s infinite linear; }
            
            .active-turn { border: 5px solid #f1c40f !important; box-shadow: 0 0 20px #f1c40f; }
            .folded { opacity: 0.3; }
            .all-in { border-color: red !important; }

            #host-layer { position: fixed; inset: 0; pointer-events: none; z-index: 9999; }
            .host-btn { pointer-events: auto; cursor: pointer; border: 3px solid white; font-weight: bold; }
            #start-btn { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 30px 60px; background: #27ae60; font-size: 2em; display: none; }
            #reset-btn { position: absolute; bottom: 100px; right: 20px; padding: 10px 20px; background: #c0392b; display: none; }
            #debug-window { position: absolute; top: 70px; right: 20px; width: 300px; height: 200px; background: rgba(0,0,0,0.9); color: lime; font-family: monospace; padding: 10px; overflow-y: auto; display: none; font-size: 11px; border: 1px solid #333; }
            
            #controls { background: #111; padding: 20px; display: none; border-top: 3px solid #f1c40f; text-align: center; }
            #controls button { margin: 5px; padding: 15px 30px; font-size: 16px; cursor: pointer; }
            #controls input { padding: 15px; font-size: 16px; }
        </style>
    </head>
    <body>
        <div id="ui-bar">
            BLINDS: <span id="blinds"></span> | 
            POT: £<span id="pot"></span> | 
            STAGE: <span id="stage"></span> |
            TIMER: <span id="timer"></span>s
        </div>
        
        <div id="host-layer">
            <button id="start-btn" class="host-btn" onclick="socket.emit('start_game')">START TOURNAMENT</button>
            <button id="reset-btn" class="host-btn" onclick="socket.emit('reset_engine')">RESET ENGINE</button>
            <div id="debug-window"><b>ENGINE LOG</b><hr></div>
        </div>

        <div class="game-container">
            <div class="poker-table">
                <div id="community" style="font-size: 3em;"></div>
            </div>
            <div id="seats"></div>
        </div>

        <div id="controls">
            <button onclick="socket.emit('action', {type:'fold'})" style="background: #c0392b;">FOLD</button>
            <button id="call-btn" onclick="socket.emit('action', {type:'call'})" style="background: #27ae60;"></button>
            <input type="number" id="bet-amt" placeholder="Amount" style="width: 100px;">
            <button onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value) || 100})" style="background: #e67e22;">RAISE</button>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const pName = prompt("Enter your name:") || "Player";
            socket.emit('join', pName);

            socket.on('force_refresh', () => location.reload());
            
            socket.on('debug_msg', m => {
                const d = document.getElementById('debug-window');
                d.innerHTML += '<div>' + new Date().toLocaleTimeString() + ' - ' + m + '</div>';
                d.scrollTop = d.scrollHeight;
            });

            socket.on('update', data => {
                document.getElementById('blinds').innerText = data.SB + "/" + data.BB;
                document.getElementById('pot').innerText = data.pot;
                document.getElementById('stage').innerText = data.gameStage;
                document.getElementById('timer').innerText = data.turnTimer;
                document.getElementById('community').innerText = data.community.join(' ');

                // Host Controls
                if(data.isHost) {
                    document.getElementById('start-btn').style.display = (data.gameStage === 'LOBBY') ? 'block' : 'none';
                    document.getElementById('reset-btn').style.display = 'block';
                    document.getElementById('debug-window').style.display = 'block';
                }

                // Player Controls
                const isMyTurn = socket.id === data.activeId && data.gameStage !== 'LOBBY' && data.gameStage !== 'SHOWDOWN';
                document.getElementById('controls').style.display = isMyTurn ? 'block' : 'none';
                if(isMyTurn) {
                    document.getElementById('call-btn').innerText = data.callAmount > 0 ? "CALL £" + data.callAmount : "CHECK";
                    document.getElementById('bet-amt').value = Math.max(data.currentBet * 2, 100);
                }

                // Render Players
                const area = document.getElementById('seats'); 
                area.innerHTML = '';
                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI - Math.PI/2;
                    const x = (window.innerWidth/2) + 350 * Math.cos(angle);
                    const y = (window.innerHeight/2) + 180 * Math.sin(angle);
                    
                    const meClass = p.id === data.myId ? 'is-me' : '';
                    const turnClass = p.id === data.activeId && data.gameStage !== 'LOBBY' ? 'active-turn' : '';
                    const statusClass = p.status === 'FOLDED' ? 'folded' : (p.status === 'ALL_IN' ? 'all-in' : '');
                    const dealerChip = p.isDealer ? '<span class="dealer-chip">D</span> ' : '';
                    
                    area.innerHTML += \`
                        <div class="player-seat" style="left: \${x}px; top: \${y}px;">
                            <div class="player-box \${meClass} \${turnClass} \${statusClass}">
                                \${dealerChip}<b>\${p.id === data.myId ? 'YOU' : p.name}</b><br>
                                £\${p.chips} \${p.bet > 0 ? '(bet: £'+p.bet+')' : ''}<br>
                                <span style="font-size:1.5em;">\${p.displayCards.join(' ')}</span><br>
                                <small>\${p.status}</small>
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
        players[socket.id] = { 
            name: n, 
            hand: [], 
            chips: 0, 
            bet: 0, 
            status: 'LOBBY' 
        };
        playerOrder.push(socket.id);
        log(n + ' joined');
        broadcast();
    });
    
    socket.on('start_game', () => {
        if(socket.id !== playerOrder[0]) return;
        if(gameStage !== 'LOBBY') return;
        
        log('=== TOURNAMENT START ===');
        playerOrder.forEach(id => { 
            players[id].chips = STARTING_CHIPS; 
            players[id].status = 'ACTIVE'; 
        });
        dealerIndex = -1;
        blindTimer = BLIND_INTERVAL;
        startNewHand();
    });
    
    socket.on('reset_engine', () => {
        if(socket.id !== playerOrder[0]) return;
        log('ENGINE RESET');
        players = {}; 
        playerOrder = [];
        gameStage = 'LOBBY';
        dealerIndex = -1;
        SB = 25;
        BB = 50;
        io.emit('force_refresh');
    });
    
    socket.on('action', (action) => {
        handleAction(socket, action);
    });
    
    socket.on('disconnect', () => {
        const p = players[socket.id];
        if (p) {
            log(p.name + ' disconnected');
            p.status = 'ELIMINATED';
        }
        playerOrder = playerOrder.filter(id => id !== socket.id);
        delete players[socket.id];
        broadcast();
    });
});

http.listen(10000, () => console.log("Poker Server Running on http://localhost:10000"));
