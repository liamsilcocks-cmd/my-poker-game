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
    activityLog('Blinds: ' + sbPlayer.name + ' (£' + sbAmt + ') / ' + bbPlayer.name + ' (£' + bbAmt + ')', 'bet');
    
    // Set first action to left of BB
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    while (players[playerOrder[turnIndex]].status !== 'ACTIVE') {
        turnIndex = (turnIndex + 1) % playerOrder.length;
    }
    
    gameStage = 'PREFLOP';
    turnTimer = TURN_TIME;
    lastRaiser = bbIdx;
    actionCount = 0;  // Reset action counter for new hand
    
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
    
    log('--- CHECK BETTING ROUND ---');
    log('Active players: ' + activePlayers.length);
    log('Action count: ' + actionCount);
    log('Current bet: ' + currentBet);
    
    if (activePlayers.length === 0) {
        // Everyone all-in or folded, go to showdown
        log('No active players, advancing');
        advanceStage();
        return;
    }
    
    if (activePlayers.length === 1) {
        // Only one player can act, advance immediately
        log('Only 1 active player, advancing');
        advanceStage();
        return;
    }
    
    // Check if everyone has matched the current bet
    const allMatched = activePlayers.every(id => players[id].bet === currentBet);
    log('All matched: ' + allMatched);
    activePlayers.forEach(id => {
        log(players[id].name + ' bet: ' + players[id].bet + ' (needs: ' + currentBet + ')');
    });
    
    // Betting round is complete when:
    // 1. Everyone has matched the current bet AND
    // 2. Everyone has had at least one action this round
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
    
    // Move bets to pot
    playerOrder.forEach(id => {
        pot += players[id].bet;
        players[id].bet = 0;
    });
    currentBet = 0;
    lastRaiser = null;
    actionCount = 0;  // Reset action counter for new betting round
    
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
        activityLog('FLOP: ' + community.join(' '), 'action');
    } else if (gameStage === 'FLOP') {
        // Deal turn
        community.push(dealCard());
        gameStage = 'TURN';
        log('TURN: ' + community[3]);
        activityLog('TURN: ' + community[3], 'action');
    } else if (gameStage === 'TURN') {
        // Deal river
        community.push(dealCard());
        gameStage = 'RIVER';
        log('RIVER: ' + community[4]);
        activityLog('RIVER: ' + community[4], 'action');
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
        const highCardName = score.highCard ? getCardName(score.highCard) : '';
        const handDesc = highCardName ? score.name + ' (' + highCardName + ' high)' : score.name;
        log(players[id].name + ': ' + handDesc + ' (score: ' + score.rank + ')');
        
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
        const highCardName = score.highCard ? getCardName(score.highCard) : '';
        const handDesc = highCardName ? score.name + ' (' + highCardName + ' high)' : score.name;
        log(players[id].name + ' wins ' + winAmt);
        activityLog(players[id].name + ' wins £' + winAmt + ' with ' + handDesc, 'win');
    });
    
    pot = 0;
    
    // Eliminate broke players
    playerOrder.forEach(id => {
        if (players[id].chips === 0) {
            players[id].status = 'ELIMINATED';
            log(players[id].name + ' ELIMINATED');
        }
    });
    
    gameStage = 'SHOWDOWN';
    broadcast();
    
    // Don't auto-start next hand - wait for host to click CONTINUE
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
    
    // Get kickers (cards not used in the main hand)
    const getKickers = (usedValues, count = 5) => {
        return uniqueValues.filter(v => !usedValues.includes(v)).slice(0, count);
    };
    
    if (isFlush && isStraight) {
        return { rank: 8000000 + straightHigh, name: 'Straight Flush', highCard: straightHigh };
    }
    if (quads.length > 0) {
        const kicker = getKickers(quads, 1)[0] || 0;
        return { rank: 7000000 + quads[0] * 100 + kicker, name: 'Four of a Kind', highCard: quads[0] };
    }
    if (trips.length > 0 && pairs.length > 0) {
        return { rank: 6000000 + trips[0] * 100 + pairs[0], name: 'Full House', highCard: trips[0] };
    }
    if (isFlush) {
        const flushCards = uniqueValues.slice(0, 5);
        const score = flushCards.reduce((acc, v, i) => acc + v * Math.pow(100, 4-i), 0);
        return { rank: 5000000 + score, name: 'Flush', highCard: flushCards[0] };
    }
    if (isStraight) {
        return { rank: 4000000 + straightHigh, name: 'Straight', highCard: straightHigh };
    }
    if (trips.length > 0) {
        const kickers = getKickers(trips, 2);
        const kickerScore = (kickers[0] || 0) * 100 + (kickers[1] || 0);
        return { rank: 3000000 + trips[0] * 10000 + kickerScore, name: 'Three of a Kind', highCard: trips[0] };
    }
    if (pairs.length >= 2) {
        const kicker = getKickers(pairs.slice(0,2), 1)[0] || 0;
        return { rank: 2000000 + pairs[0] * 10000 + pairs[1] * 100 + kicker, name: 'Two Pair', highCard: pairs[0] };
    }
    if (pairs.length === 1) {
        const kickers = getKickers(pairs, 3);
        const kickerScore = (kickers[0] || 0) * 10000 + (kickers[1] || 0) * 100 + (kickers[2] || 0);
        return { rank: 1000000 + pairs[0] * 100000 + kickerScore, name: 'Pair', highCard: pairs[0] };
    }
    
    // High card
    const topFive = uniqueValues.slice(0, 5);
    const score = topFive.reduce((acc, v, i) => acc + v * Math.pow(100, 4-i), 0);
    return { rank: score, name: 'High Card', highCard: topFive[0] };
}

function checkStraight(values) {
    const unique = [...new Set(values)].sort((a, b) => b - a);
    
    // Check for regular straights (5 consecutive cards)
    for (let i = 0; i < unique.length - 4; i++) {
        if (unique[i] - unique[i + 4] === 4) {
            return { isStraight: true, highCard: unique[i] };
        }
    }
    
    // Check for A-2-3-4-5 (wheel/bicycle)
    if (unique.includes(14) && unique.includes(5) && unique.includes(4) && unique.includes(3) && unique.includes(2)) {
        return { isStraight: true, highCard: 5 }; // In A-2-3-4-5, the 5 is the high card
    }
    
    return { isStraight: false, highCard: 0 };
}

function handleAction(socket, action) {
    log('ACTION received: ' + action.type + ' from socket: ' + socket.id);
    log('Current gameStage: ' + gameStage);
    log('Current turnIndex: ' + turnIndex);
    log('Player at turnIndex: ' + (playerOrder[turnIndex] || 'NONE'));
    log('Is it their turn? ' + (playerOrder[turnIndex] === socket.id));
    
    if (gameStage === 'LOBBY' || gameStage === 'SHOWDOWN' || gameStage === 'DEALER_SELECTION') {
        log('Game not active, ignoring action');
        return;
    }
    
    if (playerOrder[turnIndex] !== socket.id) {
        log('Not your turn! Current turn: ' + players[playerOrder[turnIndex]].name);
        return;
    }
    
    const player = players[socket.id];
    actionCount++;  // Increment action counter
    
    if (action.type === 'fold') {
        log(player.name + ' folds');
        activityLog(player.name + ' folds', 'fold');
        player.status = 'FOLDED';
        player.hand = [];
        checkBettingRoundComplete();
        
    } else if (action.type === 'call') {
        const callAmt = Math.min(currentBet - player.bet, player.chips);
        player.chips -= callAmt;
        player.bet += callAmt;
        log(player.name + ' calls ' + callAmt + ' (total bet: ' + player.bet + ')');
        if (callAmt === 0) {
            activityLog(player.name + ' checks', 'action');
        } else {
            activityLog(player.name + ' calls £' + callAmt, 'action');
        }
        
        if (player.chips === 0) {
            player.status = 'ALL_IN';
            log(player.name + ' is ALL IN');
            activityLog(player.name + ' is ALL IN!', 'bet');
        }
        
        checkBettingRoundComplete();
        
    } else if (action.type === 'raise') {
        const raiseTotal = Math.min(action.amt, player.chips + player.bet);
        const raiseAmt = raiseTotal - player.bet;
        
        if (raiseTotal <= currentBet) {
            log('Raise must be higher than current bet');
            broadcast();
            return;
        }
        
        player.chips -= raiseAmt;
        player.bet = raiseTotal;
        currentBet = raiseTotal;
        lastRaiser = turnIndex;
        actionCount = 1;  // Reset counter when someone raises - everyone else needs to act again
        
        log(player.name + ' raises to ' + raiseTotal);
        activityLog(player.name + ' raises to £' + raiseTotal, 'bet');
        
        if (player.chips === 0) {
            player.status = 'ALL_IN';
            log(player.name + ' is ALL IN');
            activityLog(player.name + ' is ALL IN!', 'bet');
        }
        
        checkBettingRoundComplete();
    }
}

function broadcast() {
    playerOrder.forEach((id) => {
        const me = players[id];
        if (!me) return;
        
        const isHost = (id === playerOrder[0]);
        
        // Calculate SB and BB positions
        const sbIdx = dealerIndex >= 0 ? (dealerIndex + 1) % playerOrder.length : -1;
        const bbIdx = dealerIndex >= 0 ? (dealerIndex + 2) % playerOrder.length : -1;

        io.to(id).emit('update', {
            myId: id,
            isHost: isHost,
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

// Timer Loop - DISABLED FOR DEVELOPMENT
/*
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
*/

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { background: #050505; color: white; font-family: sans-serif; margin: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
            #ui-bar { background: #111; padding: 15px; text-align: center; border-bottom: 2px solid #444; }
            .game-container { position: relative; flex-grow: 1; display: flex; justify-content: center; align-items: center; }
            .poker-table { width: 600px; height: 300px; background: #1a5c1a; border: 10px solid #8b4513; border-radius: 150px; display: flex; flex-direction: column; justify-content: center; align-items: center; }
            
            .player-seat { position: absolute; width: 180px; transform: translate(-50%, -50%); }
            .player-box { background: #222; border: 3px solid #555; padding: 10px; border-radius: 10px; text-align: center; }
            
            .dealer-chip { background: white; color: black; border-radius: 50%; width: 24px; height: 24px; display: inline-block; font-weight: bold; line-height: 24px; margin: 2px; font-size: 14px; }
            .sb-chip { background: #3498db; color: white; border-radius: 50%; width: 24px; height: 24px; display: inline-block; font-weight: bold; line-height: 24px; margin: 2px; font-size: 12px; }
            .bb-chip { background: #f1c40f; color: black; border-radius: 50%; width: 24px; height: 24px; display: inline-block; font-weight: bold; line-height: 24px; margin: 2px; font-size: 12px; }
            
            @keyframes rainbow {
                0% { border-color: red; } 50% { border-color: lime; } 100% { border-color: red; }
            }
            .is-me { animation: rainbow 2s infinite linear; }
            
            .active-turn { border: 5px solid #f1c40f !important; box-shadow: 0 0 20px #f1c40f; }
            .folded { opacity: 0.3; }
            .all-in { border-color: red !important; }

            #host-layer { position: fixed; inset: 0; pointer-events: none; z-index: 9999; }
            .host-btn { pointer-events: auto; cursor: pointer; border: 3px solid white; font-weight: bold; border-radius: 10px; }
            #start-btn { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 30px 60px; background: #27ae60; color: white; font-size: 2em; display: none; box-shadow: 0 0 30px rgba(39, 174, 96, 0.8); }
            #reset-btn { position: absolute; bottom: 100px; right: 20px; padding: 10px 20px; background: #c0392b; color: white; display: none; }
            #debug-window { position: absolute; top: 70px; right: 20px; width: 300px; height: 200px; background: rgba(0,0,0,0.9); color: lime; font-family: monospace; padding: 10px; overflow-y: scroll; display: none; font-size: 11px; border: 1px solid #333; white-space: pre-wrap; word-wrap: break-word; }
            
            #controls { background: #111; padding: 20px; display: none; border-top: 3px solid #f1c40f; text-align: center; }
            #controls button { margin: 5px; padding: 15px 30px; font-size: 16px; cursor: pointer; }
            #controls input { padding: 15px; font-size: 16px; }
            
            #activity-log { position: fixed; bottom: 20px; left: 20px; width: 350px; height: 300px; background: rgba(0,0,0,0.85); color: #ecf0f1; font-family: monospace; padding: 10px; overflow-y: scroll; border: 2px solid #34495e; border-radius: 5px; font-size: 12px; }
            #activity-log .log-entry { margin: 3px 0; padding: 2px 0; border-bottom: 1px solid #2c3e50; }
            #activity-log .log-win { color: #2ecc71; font-weight: bold; }
            #activity-log .log-action { color: #3498db; }
            #activity-log .log-bet { color: #e67e22; }
            #activity-log .log-fold { color: #95a5a6; }
        </style>
    </head>
    <body>
        <div id="ui-bar">
            BLINDS: <span id="blinds"></span> | 
            POT: £<span id="pot"></span> | 
            STAGE: <span id="stage"></span>
        </div>
        
        <div id="host-layer">
            <button id="start-btn" class="host-btn" onclick="socket.emit('start_game')">START TOURNAMENT</button>
            <button id="continue-btn" class="host-btn" onclick="socket.emit('next_hand')" style="position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 20px 50px; background: #27ae60; color: white; font-size: 1.5em; display: none; box-shadow: 0 0 30px rgba(39, 174, 96, 0.8); border-radius: 10px;">CONTINUE</button>
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
        
        <div id="activity-log">
            <b>ACTIVITY LOG</b>
            <hr style="margin: 5px 0;">
            <div id="log-entries"></div>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            let pName = prompt("Enter your name:");
            while (!pName || pName.trim() === '') {
                pName = prompt("Please enter your name:");
            }
            socket.emit('join', pName.trim());

            // Show start button immediately for first player
            socket.on('connect', () => {
                // Will be updated properly when server sends update
            });

            socket.on('force_refresh', () => location.reload());
            
            socket.on('debug_msg', m => {
                const d = document.getElementById('debug-window');
                d.innerHTML += '<div>' + new Date().toLocaleTimeString() + ' - ' + m + '</div>';
                d.scrollTop = d.scrollHeight;
            });
            
            socket.on('activity_log', data => {
                const logDiv = document.getElementById('log-entries');
                const entry = document.createElement('div');
                entry.className = 'log-entry log-' + data.type;
                entry.textContent = data.msg;
                logDiv.appendChild(entry);
                
                // Auto-scroll to bottom
                const activityLog = document.getElementById('activity-log');
                activityLog.scrollTop = activityLog.scrollHeight;
                
                // Keep only last 50 entries
                while (logDiv.children.length > 50) {
                    logDiv.removeChild(logDiv.firstChild);
                }
            });

            socket.on('update', data => {
                console.log('Update received:', {
                    isHost: data.isHost,
                    gameStage: data.gameStage,
                    myId: data.myId
                });
                
                document.getElementById('blinds').innerText = data.SB + "/" + data.BB;
                document.getElementById('pot').innerText = data.pot;
                document.getElementById('stage').innerText = data.gameStage;
                document.getElementById('community').innerText = data.community.join(' ');

                // Host Controls
                if(data.isHost) {
                    const shouldShow = (data.gameStage === 'LOBBY');
                    const shouldShowContinue = (data.gameStage === 'SHOWDOWN');
                    console.log('I am host! Start button should show:', shouldShow);
                    document.getElementById('start-btn').style.display = shouldShow ? 'block' : 'none';
                    document.getElementById('continue-btn').style.display = shouldShowContinue ? 'block' : 'none';
                    document.getElementById('reset-btn').style.display = 'block';
                    document.getElementById('debug-window').style.display = 'block';
                } else {
                    console.log('I am NOT host');
                }

                // Player Controls
                const isMyTurn = socket.id === data.activeId && 
                                data.gameStage !== 'LOBBY' && 
                                data.gameStage !== 'SHOWDOWN' && 
                                data.gameStage !== 'DEALER_SELECTION';
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
                    const dealerChip = p.isDealer ? '<span class="dealer-chip">D</span>' : '';
                    const sbChip = p.isSB ? '<span class="sb-chip">SB</span>' : '';
                    const bbChip = p.isBB ? '<span class="bb-chip">BB</span>' : '';
                    const chips = dealerChip + sbChip + bbChip;
                    
                    area.innerHTML += \`
                        <div class="player-seat" style="left: \${x}px; top: \${y}px;">
                            <div class="player-box \${meClass} \${turnClass} \${statusClass}">
                                \${chips ? chips + '<br>' : ''}<b>\${p.id === data.myId ? 'YOU' : p.name}</b><br>
                                <span style="color: #2ecc71; font-size: 1.2em;">£\${p.chips}</span><br>
                                \${p.bet > 0 ? '<span style="color: #e74c3c;">BET: £'+p.bet+'</span><br>' : ''}
                                <span style="font-size:1.5em;">\${p.displayCards.join(' ')}</span><br>
                                <small style="color: #95a5a6;">\${p.status}</small>
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
        
        // Deal one card to each player to determine initial dealer (high card)
        deck = createDeck();
        let highCard = { value: 0, playerId: null, card: '' };
        
        playerOrder.forEach(id => {
            const card = dealCard();
            const value = cardValues[card.slice(0, -1)];
            players[id].hand = [card]; // Temporarily show the card
            log(players[id].name + ' draws ' + card + ' (value: ' + value + ')');
            
            if (value > highCard.value) {
                highCard = { value, playerId: id, card };
            }
        });
        
        dealerIndex = playerOrder.indexOf(highCard.playerId);
        log(players[highCard.playerId].name + ' has high card ' + highCard.card + ' - IS DEALER');
        
        gameStage = 'DEALER_SELECTION';
        broadcast();
        
        // Clear the cards after 3 seconds and start first hand
        setTimeout(() => {
            playerOrder.forEach(id => { players[id].hand = []; });
            blindTimer = BLIND_INTERVAL;
            startNewHand();
        }, 3000);
    });
    
    socket.on('next_hand', () => {
        if(socket.id !== playerOrder[0]) return;
        if(gameStage !== 'SHOWDOWN') return;
        
        log('=== NEXT HAND ===');
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
