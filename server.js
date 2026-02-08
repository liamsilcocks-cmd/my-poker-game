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
let lastRaiser = null;
let playersActedThisRound = new Set();

const suits = ['♠','♥','♦','♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const rankValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function log(msg) { io.emit('debug_msg', msg); }
function activityLog(msg) { io.emit('activity_log', { msg }); }

function createDeck() {
    const d = [];
    suits.forEach(s => ranks.forEach(r => d.push(r + s)));
    return d.sort(() => Math.random() - 0.5);
}

function parseCard(card) {
    const rank = card.slice(0, -1);
    const suit = card.slice(-1);
    return { rank, suit, value: rankValues[rank] };
}

// Evaluate poker hand - returns {rank, tiebreakers, name}
function evaluateHand(cards) {
    if (cards.length !== 5) return { rank: 0, tiebreakers: [], name: 'Invalid' };
    
    const parsed = cards.map(parseCard).sort((a, b) => b.value - a.value);
    const values = parsed.map(c => c.value);
    const suits = parsed.map(c => c.suit);
    
    // Count occurrences
    const valueCounts = {};
    values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);
    const counts = Object.values(valueCounts).sort((a, b) => b - a);
    const uniqueValues = Object.keys(valueCounts).map(Number).sort((a, b) => b - a);
    
    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = values[0] - values[4] === 4 && new Set(values).size === 5;
    const isLowStraight = values.join(',') === '14,5,4,3,2'; // A-2-3-4-5
    
    // Royal Flush
    if (isFlush && isStraight && values[0] === 14) {
        return { rank: 9, tiebreakers: [14], name: 'Royal Flush' };
    }
    
    // Straight Flush
    if (isFlush && (isStraight || isLowStraight)) {
        return { rank: 8, tiebreakers: [isLowStraight ? 5 : values[0]], name: 'Straight Flush' };
    }
    
    // Four of a Kind
    if (counts[0] === 4) {
        const quad = uniqueValues.find(v => valueCounts[v] === 4);
        const kicker = uniqueValues.find(v => valueCounts[v] === 1);
        return { rank: 7, tiebreakers: [quad, kicker], name: 'Four of a Kind' };
    }
    
    // Full House
    if (counts[0] === 3 && counts[1] === 2) {
        const trips = uniqueValues.find(v => valueCounts[v] === 3);
        const pair = uniqueValues.find(v => valueCounts[v] === 2);
        return { rank: 6, tiebreakers: [trips, pair], name: 'Full House' };
    }
    
    // Flush
    if (isFlush) {
        return { rank: 5, tiebreakers: values, name: 'Flush' };
    }
    
    // Straight
    if (isStraight || isLowStraight) {
        return { rank: 4, tiebreakers: [isLowStraight ? 5 : values[0]], name: 'Straight' };
    }
    
    // Three of a Kind
    if (counts[0] === 3) {
        const trips = uniqueValues.find(v => valueCounts[v] === 3);
        const kickers = uniqueValues.filter(v => valueCounts[v] === 1).sort((a, b) => b - a);
        return { rank: 3, tiebreakers: [trips, ...kickers], name: 'Three of a Kind' };
    }
    
    // Two Pair
    if (counts[0] === 2 && counts[1] === 2) {
        const pairs = uniqueValues.filter(v => valueCounts[v] === 2).sort((a, b) => b - a);
        const kicker = uniqueValues.find(v => valueCounts[v] === 1);
        return { rank: 2, tiebreakers: [...pairs, kicker], name: 'Two Pair' };
    }
    
    // One Pair
    if (counts[0] === 2) {
        const pair = uniqueValues.find(v => valueCounts[v] === 2);
        const kickers = uniqueValues.filter(v => valueCounts[v] === 1).sort((a, b) => b - a);
        return { rank: 1, tiebreakers: [pair, ...kickers], name: 'One Pair' };
    }
    
    // High Card
    return { rank: 0, tiebreakers: values, name: 'High Card' };
}

// Find best 5-card hand from 7 cards
function findBestHand(sevenCards) {
    let best = null;
    
    // Generate all 5-card combinations from 7 cards
    for (let i = 0; i < sevenCards.length; i++) {
        for (let j = i + 1; j < sevenCards.length; j++) {
            const fiveCards = sevenCards.filter((_, idx) => idx !== i && idx !== j);
            const evaluated = evaluateHand(fiveCards);
            
            if (!best || compareHands(evaluated, best) > 0) {
                best = evaluated;
                best.cards = fiveCards;
            }
        }
    }
    
    return best;
}

// Compare two hands: returns 1 if hand1 wins, -1 if hand2 wins, 0 if tie
function compareHands(hand1, hand2) {
    if (hand1.rank !== hand2.rank) {
        return hand1.rank > hand2.rank ? 1 : -1;
    }
    
    // Same rank, compare tiebreakers
    for (let i = 0; i < Math.max(hand1.tiebreakers.length, hand2.tiebreakers.length); i++) {
        const t1 = hand1.tiebreakers[i] || 0;
        const t2 = hand2.tiebreakers[i] || 0;
        if (t1 !== t2) {
            return t1 > t2 ? 1 : -1;
        }
    }
    
    return 0; // True tie
}

function getPlayersInHand() {
    return playerOrder.filter(id => (players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN') && players[id].hand.length > 0);
}

function startNewHand() {
    community = []; pot = 0; currentBet = BB;
    playersActedThisRound.clear();
    const active = playerOrder.filter(id => players[id].chips > 0);
    if (active.length < 2) {
        log('⚠️ Not enough players with chips to start hand');
        return;
    }
    
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
    
    const sbPlayer = playerOrder[sbIdx];
    const bbPlayer = playerOrder[bbIdx];
    
    players[sbPlayer].chips -= SB; players[sbPlayer].bet = SB;
    players[bbPlayer].chips -= BB; players[bbPlayer].bet = BB;
    pot = SB + BB;
    
    log(`🃏 NEW HAND STARTED`);
    log(`👑 Dealer: ${players[playerOrder[dealerIndex]].name}`);
    log(`💵 SB: ${players[sbPlayer].name} posts ${SB}`);
    log(`💵 BB: ${players[bbPlayer].name} posts ${BB}`);
    log(`🎴 Dealing cards to ${active.length} players`);
    active.forEach(id => {
        log(`  ${players[id].name}: ${players[id].hand.join(' ')}`);
    });
    
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    gameStage = 'PREFLOP';
    activityLog("--- NEW HAND ---");
    activityLog(`Dealer: ${players[playerOrder[dealerIndex]].name}`);
    broadcast();
}

function handleAction(socket, action) {
    if (playerOrder[turnIndex] !== socket.id) {
        log(`⚠️ Action rejected: not ${socket.id}'s turn`);
        return;
    }
    const p = players[socket.id];
    playersActedThisRound.add(socket.id);
    
    if (action.type === 'fold') {
        p.status = 'FOLDED';
        log(`🚫 ${p.name} FOLDED`);
        activityLog(`${p.name} folded`);
    } else if (action.type === 'call') {
        const amt = currentBet - p.bet;
        const actualAmt = Math.min(amt, p.chips);
        p.chips -= actualAmt; 
        p.bet += actualAmt; 
        pot += actualAmt;
        
        if (amt === 0) {
            log(`✓ ${p.name} CHECKED`);
            activityLog(`${p.name} checked`);
        } else {
            log(`📞 ${p.name} CALLED ${actualAmt} (pot: ${p.bet}/${currentBet})`);
            activityLog(`${p.name} called ${actualAmt}`);
        }
        
        if (p.chips === 0) {
            p.status = 'ALL_IN';
            log(`🔥 ${p.name} is ALL IN!`);
            activityLog(`${p.name} is ALL IN!`);
        }
    } else if (action.type === 'raise') {
        const total = action.amt;
        const diff = total - p.bet;
        const actualDiff = Math.min(diff, p.chips);
        
        p.chips -= actualDiff; 
        p.bet += actualDiff;
        pot += actualDiff;
        currentBet = p.bet;
        
        playersActedThisRound.clear();
        playersActedThisRound.add(socket.id);
        
        log(`🎲 ${p.name} RAISED to ${p.bet} (pot now: ${pot})`);
        log(`  Current bet reset to ${currentBet}, all players must act`);
        activityLog(`${p.name} raised to £${p.bet}`);
        
        if (p.chips === 0) {
            p.status = 'ALL_IN';
            log(`🔥 ${p.name} is ALL IN!`);
            activityLog(`${p.name} is ALL IN!`);
        }
    }
    
    const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
    const allActed = activeInHand.every(id => playersActedThisRound.has(id));
    const allMatched = activeInHand.every(id => players[id].bet === currentBet);

    log(`📊 Round status: ${activeInHand.length} active, all acted: ${allActed}, all matched: ${allMatched}`);

    if (activeInHand.length <= 1 || (allActed && allMatched)) {
        advanceStage();
    } else {
        let nextIdx = turnIndex;
        do {
            nextIdx = (nextIdx + 1) % playerOrder.length;
        } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
        turnIndex = nextIdx;
        log(`⏭️ Next to act: ${players[playerOrder[turnIndex]].name}`);
        broadcast();
    }
}

function advanceStage() {
    log(`🎬 ADVANCING STAGE from ${gameStage}`);
    playerOrder.forEach(id => { if(players[id].status !== 'OUT') players[id].bet = 0; });
    currentBet = 0;
    playersActedThisRound.clear();

    if (getPlayersInHand().length <= 1) return showdown();

    if (gameStage === 'PREFLOP') { 
        community = [deck.pop(), deck.pop(), deck.pop()]; 
        gameStage = 'FLOP'; 
        log(`🃏 FLOP: ${community.join(' ')}`);
        activityLog(`Flop: ${community.join(' ')}`);
    }
    else if (gameStage === 'FLOP') { 
        community.push(deck.pop()); 
        gameStage = 'TURN'; 
        log(`🃏 TURN: ${community[3]}`);
        activityLog(`Turn: ${community[3]}`);
    }
    else if (gameStage === 'TURN') { 
        community.push(deck.pop()); 
        gameStage = 'RIVER'; 
        log(`🃏 RIVER: ${community[4]}`);
        activityLog(`River: ${community[4]}`);
    }
    else return showdown();

    let nextIdx = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[nextIdx]].status !== 'ACTIVE') nextIdx = (nextIdx + 1) % playerOrder.length;
    turnIndex = nextIdx;
    log(`⏭️ ${gameStage} betting starts with: ${players[playerOrder[turnIndex]].name}`);
    broadcast();
}

function showdown() {
    gameStage = 'SHOWDOWN';
    log(`🏆 ============ SHOWDOWN ============`);
    log(`🎴 Community cards: ${community.join(' ')}`);
    
    const inHand = getPlayersInHand();
    
    if (inHand.length === 1) {
        const winnerId = inHand[0];
        players[winnerId].chips += pot;
        log(`🏆 ${players[winnerId].name} wins ${pot} (all others folded)`);
        activityLog(`${players[winnerId].name} wins £${pot}`);
        setTimeout(() => {
            gameStage = 'LOBBY';
            broadcast();
        }, 3000);
        broadcast();
        return;
    }
    
    // Evaluate all hands
    const evaluatedPlayers = inHand.map(id => {
        const sevenCards = [...players[id].hand, ...community];
        const bestHand = findBestHand(sevenCards);
        log(`👤 ${players[id].name}: ${players[id].hand.join(' ')}`);
        log(`   Best hand: ${bestHand.name} (${bestHand.cards.join(' ')})`);
        log(`   Rank: ${bestHand.rank}, Tiebreakers: [${bestHand.tiebreakers.join(', ')}]`);
        return { id, bestHand };
    });
    
    // Sort by hand strength (best first)
    evaluatedPlayers.sort((a, b) => compareHands(b.bestHand, a.bestHand));
    
    // Find all winners (handle ties)
    const winners = [evaluatedPlayers[0]];
    for (let i = 1; i < evaluatedPlayers.length; i++) {
        if (compareHands(evaluatedPlayers[i].bestHand, winners[0].bestHand) === 0) {
            winners.push(evaluatedPlayers[i]);
        }
    }
    
    const winAmt = Math.floor(pot / winners.length);
    
    log(`🏆 WINNER(S):`);
    winners.forEach(w => {
        players[w.id].chips += winAmt;
        log(`  💰 ${players[w.id].name} wins ${winAmt} with ${w.bestHand.name}`);
        activityLog(`${players[w.id].name} wins £${winAmt} (${w.bestHand.name})`);
    });
    
    log(`============ HAND COMPLETE ============`);
    
    // Reset to LOBBY after 3 seconds for next hand
    setTimeout(() => {
        gameStage = 'LOBBY';
        broadcast();
    }, 3000);
    
    broadcast();
}

function broadcast() {
    const sbIdx = (dealerIndex + 1) % playerOrder.length;
    const bbIdx = (dealerIndex + 2) % playerOrder.length;

    playerOrder.forEach(id => {
        io.to(id).emit('update', {
            myId: id, myName: players[id].name, isHost: (id === playerOrder[0]),
            players: playerOrder.map((pid, idx) => ({
                id: pid, name: players[pid].name, chips: players[pid].chips, bet: players[pid].bet, status: players[pid].status,
                isDealer: idx === dealerIndex, isSB: idx === sbIdx, isBB: idx === bbIdx,
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
        log(`➕ ${name} joined the game (${playerOrder.length} players total)`);
        activityLog(`${name} joined`);
        gameStage = 'LOBBY'; // Ensure we're in LOBBY when players join
        broadcast();
    });
    socket.on('start_game', () => startNewHand());
    socket.on('action', (data) => handleAction(socket, data));
    socket.on('reset_engine', () => { 
        if(playerOrder[0] === socket.id) { 
            log(`🔄 Game reset by ${players[socket.id].name}`);
            players={}; 
            playerOrder=[]; 
            io.emit('force_refresh'); 
        } 
    });
    socket.on('disconnect', () => { 
        if (players[socket.id]) {
            log(`➖ ${players[socket.id].name} disconnected`);
            activityLog(`${players[socket.id].name} left`);
        }
        delete players[socket.id]; 
        playerOrder = playerOrder.filter(id => id !== socket.id); 
        broadcast(); 
    });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
            * { box-sizing: border-box; }
            body { 
                background: #000; 
                color: white; 
                font-family: sans-serif; 
                margin: 0; 
                padding: 0;
                overflow: hidden; 
                height: 100vh;
                height: 100dvh;
                display: flex; 
                flex-direction: column;
                position: fixed;
                width: 100%;
            }
            
            #top-bar {
                display: flex;
                justify-content: space-between;
                padding: 4px 8px;
                background: rgba(0,0,0,0.5);
                z-index: 100;
                flex-shrink: 0;
            }
            #blinds-overlay { 
                font-size: 11px; 
                color: #888; 
            }
            #pot-display { 
                font-size: 16px; 
                color: #2ecc71; 
                font-weight: bold; 
            }
            
            .game-area { 
                position: relative; 
                flex: 1; 
                overflow: hidden; 
                display: flex; 
                justify-content: center; 
                align-items: center;
                min-height: 0;
            }
            
            .poker-table { 
                width: min(50vw, 400px);
                height: min(30vh, 200px);
                background: #1a5c1a; 
                border: 4px solid #4d260a; 
                border-radius: 100px; 
                position: relative; 
                display: flex; 
                flex-direction: column; 
                justify-content: center; 
                align-items: center; 
                z-index: 1; 
                box-shadow: inset 0 0 15px #000;
            }
            
            @media (max-height: 500px) and (orientation: landscape) {
                #top-bar {
                    padding: 2px 8px;
                }
                #pot-display {
                    font-size: 14px;
                }
                #blinds-overlay {
                    font-size: 10px;
                }
                .poker-table {
                    width: min(45vw, 350px);
                    height: min(25vh, 150px);
                    border-width: 3px;
                    border-radius: 80px;
                }
                #table-logo {
                    font-size: 10px !important;
                    margin-bottom: 2px !important;
                }
                #action-guide {
                    font-size: 10px !important;
                }
                .card {
                    font-size: 1.1em !important;
                    min-width: 25px !important;
                    padding: 1px 3px !important;
                }
                .player-box {
                    font-size: 9px !important;
                    padding: 3px !important;
                    min-width: 70px !important;
                }
                .player-box.my-seat {
                    border-width: 2px !important;
                }
                .card-small {
                    font-size: 0.9em !important;
                    min-width: 18px !important;
                }
                #controls {
                    padding: 6px;
                    gap: 4px;
                }
                #controls button {
                    padding: 10px 0 !important;
                    font-size: 12px !important;
                    max-width: 90px !important;
                }
                #controls input {
                    width: 55px !important;
                    font-size: 14px !important;
                    padding: 8px 2px !important;
                }
            }
            
            #table-logo { 
                font-size: 11px; 
                font-weight: bold; 
                color: rgba(255,255,255,0.1); 
                text-transform: uppercase; 
                margin-bottom: 3px; 
            }
            #community { 
                display: flex; 
                justify-content: center; 
                align-items: center; 
                margin-bottom: 6px; 
            }
            #action-guide { 
                font-size: 11px; 
                color: #f1c40f; 
                text-align: center; 
                font-weight: bold; 
            }
            
            .card { 
                background: white; 
                color: black; 
                border: 1px solid #000; 
                border-radius: 4px; 
                padding: 2px 4px; 
                margin: 1px; 
                font-weight: bold; 
                font-size: 1.3em; 
                min-width: 30px; 
                display: inline-flex; 
                justify-content: center; 
                align-items: center; 
            }
            .card.red { color: #d63031; }
            .card.hidden { background: #2980b9; color: #2980b9; }
            
            .player-seat { 
                position: absolute; 
                z-index: 10; 
                transform: translate(-50%, -50%); 
            }
            .player-box { 
                background: #111; 
                border: 2px solid #444; 
                padding: 4px; 
                border-radius: 6px; 
                font-size: 10px; 
                min-width: 80px; 
                text-align: center; 
                position: relative; 
            }
            .player-box.my-seat {
                background: #fff;
                border: 3px solid #2ecc71;
                box-shadow: 0 0 12px rgba(46, 204, 113, 0.6);
            }
            .player-box.my-seat b {
                color: #16a085 !important;
                font-weight: 900;
            }
            .player-box.my-seat .chip-count {
                color: #000;
                font-weight: bold;
            }
            .player-box.my-seat .bet-amount {
                color: #2980b9 !important;
            }
            .active-turn { 
                border-color: #f1c40f; 
                box-shadow: 0 0 8px #f1c40f; 
            }
            .active-turn.my-seat {
                border-color: #f39c12;
                box-shadow: 0 0 15px rgba(243, 156, 18, 0.8);
            }
            .card-row { 
                display: flex; 
                justify-content: center; 
                gap: 2px; 
                margin: 2px 0; 
            }
            .card-small { 
                background: white; 
                color: black; 
                border-radius: 2px; 
                border: 1px solid #000; 
                font-size: 1em; 
                padding: 1px 2px; 
                font-weight: bold; 
                min-width: 20px; 
            }
            
            .disc { 
                position: absolute; 
                top: -8px; 
                right: -8px; 
                width: 16px; 
                height: 16px; 
                border-radius: 50%; 
                font-size: 9px; 
                font-weight: bold; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                border: 1px solid black; 
            }
            .disc.d { background: white; color: black; }
            .disc.sb { background: #e74c3c; color: white; }
            .disc.bb { background: #3498db; color: white; }
            
            #controls { 
                background: #111; 
                padding: 8px; 
                border-top: 2px solid #333; 
                display: none; 
                justify-content: center; 
                gap: 6px; 
                width: 100%; 
                flex-shrink: 0;
                position: relative;
                z-index: 101;
            }
            
            @media (max-height: 500px) and (orientation: landscape) {
                #controls {
                    padding: 6px;
                    gap: 4px;
                }
                #controls button {
                    padding: 10px 0 !important;
                    font-size: 12px !important;
                    max-width: 90px !important;
                }
                #controls input {
                    width: 55px !important;
                    font-size: 14px !important;
                    padding: 8px 2px !important;
                }
            }
            
            #controls button { 
                flex: 1; 
                padding: 12px 0; 
                font-size: 13px; 
                border: none; 
                border-radius: 4px; 
                color: white; 
                font-weight: bold; 
                max-width: 100px;
                cursor: pointer;
            }
            #controls input { 
                width: 60px; 
                background: #000; 
                color: #fff; 
                border: 1px solid #444; 
                text-align: center; 
                font-size: 15px;
                border-radius: 4px;
                padding: 10px 2px;
            }
            
            #debug-window { 
                position: fixed; 
                top: 30px; 
                right: 10px; 
                width: 240px; 
                height: 200px; 
                background: rgba(0,0,0,0.95); 
                color: lime; 
                font-family: monospace; 
                font-size: 10px; 
                padding: 8px; 
                overflow-y: scroll; 
                border: 1px solid #333; 
                display: none; 
                z-index: 200;
                line-height: 1.3;
            }
            #activity-log { 
                position: fixed; 
                bottom: 60px; 
                left: 10px; 
                width: 200px; 
                height: 120px; 
                background: rgba(0,0,0,0.95); 
                border: 1px solid #444; 
                color: #fff;
                font-size: 11px; 
                padding: 8px; 
                overflow-y: scroll; 
                display: none; 
                z-index: 200;
                line-height: 1.4;
            }
            
            #footer-btns { 
                position: fixed; 
                bottom: 4px; 
                right: 4px; 
                display: flex; 
                gap: 4px; 
                z-index: 102; 
            }
            .tool-btn { 
                padding: 4px 8px; 
                font-size: 10px; 
                background: #333; 
                color: white; 
                border: none; 
                border-radius: 3px;
                cursor: pointer;
            }
            
            #start-btn {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                padding: 15px 30px;
                background: #2980b9;
                color: white;
                border: none;
                border-radius: 6px;
                display: none;
                z-index: 1000;
                font-weight: bold;
                font-size: 16px;
                cursor: pointer;
            }
        </style>
    </head>
    <body>
        <div id="top-bar">
            <div id="blinds-overlay">Blinds: <span id="blinds-info">--/--</span></div>
            <div id="pot-display">£<span id="pot">0</span></div>
        </div>
        
        <div class="game-area">
            <div id="debug-window"><b>🔧 DEBUG LOG</b><hr></div>
            <div id="activity-log"><b>📋 ACTIVITY</b><hr></div>
            <div class="poker-table">
                <div id="table-logo">SYFM POKER</div>
                <div id="community"></div>
                <div id="action-guide"></div>
            </div>
            <div id="seats"></div>
        </div>
        
        <div id="controls">
            <button onclick="socket.emit('action', {type:'fold'})" style="background: #c0392b;">FOLD</button>
            <button id="call-btn" onclick="socket.emit('action', {type:'call'})" style="background: #27ae60;">CHECK</button>
            <input type="number" id="bet-amt" value="100">
            <button onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})" style="background: #e67e22;">RAISE</button>
        </div>
        
        <div id="footer-btns">
            <button class="tool-btn" onclick="let l=document.getElementById('activity-log'); l.style.display=l.style.display==='block'?'none':'block'">LOG</button>
            <button id="debug-btn" class="tool-btn" style="display:none; background:#16a085" onclick="let d=document.getElementById('debug-window'); d.style.display=d.style.display==='block'?'none':'block'">DEBUG</button>
            <button id="reset-btn" class="tool-btn" style="display:none; background:#c0392b" onclick="socket.emit('reset_engine')">RESET</button>
        </div>
        
        <button id="start-btn" onclick="socket.emit('start_game')">START</button>
        
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
                    if(data.community[3]) html += '<div style="width:8px"></div>' + formatCard(data.community[3]);
                    if(data.community[4]) html += '<div style="width:8px"></div>' + formatCard(data.community[4]);
                }
                comm.innerHTML = html;
                
                document.getElementById('debug-btn').style.display = data.isHost ? 'block' : 'none';
                document.getElementById('reset-btn').style.display = data.isHost ? 'block' : 'none';
                document.getElementById('start-btn').style.display = (data.isHost && (data.gameStage === 'LOBBY' || data.gameStage === 'SHOWDOWN')) ? 'block' : 'none';
                
                const isMyTurn = (data.activeId === data.myId && data.gameStage !== 'SHOWDOWN');
                const guide = document.getElementById('action-guide');
                guide.innerText = isMyTurn ? "YOUR TURN" : (data.gameStage === 'SHOWDOWN' ? "SHOWDOWN" : "WAITING...");
                
                document.getElementById('controls').style.display = isMyTurn ? 'flex' : 'none';
                if(isMyTurn) document.getElementById('call-btn').innerText = data.callAmt > 0 ? "CALL £"+data.callAmt : "CHECK";
                
                const area = document.getElementById('seats');
                area.innerHTML = '';
                
                const vW = window.innerWidth;
                const vH = window.innerHeight;
                const topBarHeight = document.getElementById('top-bar').offsetHeight;
                const controlsHeight = isMyTurn ? document.getElementById('controls').offsetHeight : 0;
                const availableHeight = vH - topBarHeight - controlsHeight;
                
                const cX = vW / 2;
                const cY = topBarHeight + (availableHeight / 2);
                
                const isLandscape = vW > vH;
                const rX = isLandscape ? Math.min(vW * 0.38, 300) : Math.min(vW * 0.38, 250);
                const rY = isLandscape ? Math.min(availableHeight * 0.32, 140) : Math.min(availableHeight * 0.28, 180);

                data.players.forEach((p, i) => {
                    const angle = (i / data.players.length) * 2 * Math.PI - Math.PI/2;
                    const x = cX + rX * Math.cos(angle);
                    const y = cY + rY * Math.sin(angle);
                    
                    const seat = document.createElement('div');
                    seat.className = "player-seat";
                    seat.style.left = x + "px";
                    seat.style.top = y + "px";
                    
                    let disc = '';
                    if(p.isDealer) disc = '<div class="disc d">D</div>';
                    else if(p.isSB) disc = '<div class="disc sb">SB</div>';
                    else if(p.isBB) disc = '<div class="disc bb">BB</div>';

                    const cardsHtml = p.cards.map(c => formatCard(c, true)).join('');
                    const isMe = p.id === data.myId;
                    const boxClasses = ['player-box'];
                    if (p.id === data.activeId) boxClasses.push('active-turn');
                    if (isMe) boxClasses.push('my-seat');
                    
                    seat.innerHTML = \`
                        <div class="\${boxClasses.join(' ')}">
                            \${disc}
                            <b style="color:\${isMe ? '#16a085' : '#f1c40f'}">\${p.name}</b><br>
                            <div class="card-row">\${cardsHtml}</div>
                            <div class="chip-count" style="color:\${isMe ? '#000' : '#fff'}">\${p.chips}</div>
                            \${p.bet > 0 ? '<div class="bet-amount" style="color:'+(isMe ? '#2980b9' : 'cyan')+'; font-weight:bold;">£'+p.bet+'</div>' : ''}
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
