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
let turnTimer = null;
let turnTimeRemaining = 30;

const suits = ['♠','♥','♦','♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const rankValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function log(msg) { io.emit('debug_msg', msg); }
function activityLog(msg) { io.emit('activity_log', { msg }); }

function startTurnTimer() {
    if (turnTimer) clearInterval(turnTimer);
    turnTimeRemaining = 30;
    
    // Check if current player has auto-fold enabled
    const currentPlayer = players[playerOrder[turnIndex]];
    if (currentPlayer && currentPlayer.autoFold) {
        log(`🤖 ${currentPlayer.name} has auto-fold enabled - folding immediately`);
        activityLog(`${currentPlayer.name} auto-folded`);
        
        currentPlayer.status = 'FOLDED';
        currentPlayer.hand = []; // Remove cards
        playersActedThisRound.add(playerOrder[turnIndex]);
        
        const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
        const allActed = activeInHand.every(id => playersActedThisRound.has(id));
        const allMatched = activeInHand.every(id => players[id].bet === currentBet);

        if (activeInHand.length <= 1 || (allActed && allMatched)) {
            advanceStage();
        } else {
            let nextIdx = turnIndex;
            do {
                nextIdx = (nextIdx + 1) % playerOrder.length;
            } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
            turnIndex = nextIdx;
            startTurnTimer();
            broadcast();
        }
        return;
    }
    
    turnTimer = setInterval(() => {
        turnTimeRemaining--;
        broadcast();
        
        if (turnTimeRemaining <= 0) {
            clearInterval(turnTimer);
            const currentPlayer = players[playerOrder[turnIndex]];
            
            // Auto-fold the player
            log(`⏰ TIME OUT! ${currentPlayer.name} auto-folded`);
            activityLog(`${currentPlayer.name} timed out and folded`);
            
            currentPlayer.status = 'FOLDED';
            currentPlayer.hand = []; // Remove cards
            playersActedThisRound.add(playerOrder[turnIndex]);
            
            const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
            const allActed = activeInHand.every(id => playersActedThisRound.has(id));
            const allMatched = activeInHand.every(id => players[id].bet === currentBet);

            if (activeInHand.length <= 1 || (allActed && allMatched)) {
                advanceStage();
            } else {
                let nextIdx = turnIndex;
                do {
                    nextIdx = (nextIdx + 1) % playerOrder.length;
                } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
                turnIndex = nextIdx;
                startTurnTimer();
                broadcast();
            }
        }
    }, 1000);
}

function stopTurnTimer() {
    if (turnTimer) {
        clearInterval(turnTimer);
        turnTimer = null;
    }
    turnTimeRemaining = 30;
}

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

function evaluateHand(cards) {
    if (cards.length !== 5) return { rank: 0, tiebreakers: [], name: 'Invalid' };
    
    const parsed = cards.map(parseCard).sort((a, b) => b.value - a.value);
    const values = parsed.map(c => c.value);
    const suits = parsed.map(c => c.suit);
    
    const valueCounts = {};
    values.forEach(v => valueCounts[v] = (valueCounts[v] || 0) + 1);
    const counts = Object.values(valueCounts).sort((a, b) => b - a);
    const uniqueValues = Object.keys(valueCounts).map(Number).sort((a, b) => b - a);
    
    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = values[0] - values[4] === 4 && new Set(values).size === 5;
    const isLowStraight = values.join(',') === '14,5,4,3,2';
    
    if (isFlush && isStraight && values[0] === 14) return { rank: 9, tiebreakers: [14], name: 'Royal Flush' };
    if (isFlush && (isStraight || isLowStraight)) return { rank: 8, tiebreakers: [isLowStraight ? 5 : values[0]], name: 'Straight Flush' };
    if (counts[0] === 4) {
        const quad = uniqueValues.find(v => valueCounts[v] === 4);
        const kicker = uniqueValues.find(v => valueCounts[v] === 1);
        return { rank: 7, tiebreakers: [quad, kicker], name: 'Four of a Kind' };
    }
    if (counts[0] === 3 && counts[1] === 2) {
        const trips = uniqueValues.find(v => valueCounts[v] === 3);
        const pair = uniqueValues.find(v => valueCounts[v] === 2);
        return { rank: 6, tiebreakers: [trips, pair], name: 'Full House' };
    }
    if (isFlush) return { rank: 5, tiebreakers: values, name: 'Flush' };
    if (isStraight || isLowStraight) return { rank: 4, tiebreakers: [isLowStraight ? 5 : values[0]], name: 'Straight' };
    if (counts[0] === 3) {
        const trips = uniqueValues.find(v => valueCounts[v] === 3);
        const kickers = uniqueValues.filter(v => valueCounts[v] === 1).sort((a, b) => b - a);
        return { rank: 3, tiebreakers: [trips, ...kickers], name: 'Three of a Kind' };
    }
    if (counts[0] === 2 && counts[1] === 2) {
        const pairs = uniqueValues.filter(v => valueCounts[v] === 2).sort((a, b) => b - a);
        const kicker = uniqueValues.find(v => valueCounts[v] === 1);
        return { rank: 2, tiebreakers: [...pairs, kicker], name: 'Two Pair' };
    }
    if (counts[0] === 2) {
        const pair = uniqueValues.find(v => valueCounts[v] === 2);
        const kickers = uniqueValues.filter(v => valueCounts[v] === 1).sort((a, b) => b - a);
        return { rank: 1, tiebreakers: [pair, ...kickers], name: 'One Pair' };
    }
    return { rank: 0, tiebreakers: values, name: 'High Card' };
}

function findBestHand(sevenCards) {
    let best = null;
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

function compareHands(hand1, hand2) {
    if (hand1.rank !== hand2.rank) return hand1.rank > hand2.rank ? 1 : -1;
    for (let i = 0; i < Math.max(hand1.tiebreakers.length, hand2.tiebreakers.length); i++) {
        const t1 = hand1.tiebreakers[i] || 0;
        const t2 = hand2.tiebreakers[i] || 0;
        if (t1 !== t2) return t1 > t2 ? 1 : -1;
    }
    return 0;
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
        // Only this specific debug line modified
        log(`  ${players[id].name}: ${players[id].hand.join(' ')}`);
    });
    
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    gameStage = 'PREFLOP';
    activityLog("--- NEW HAND ---");
    activityLog(`Dealer: ${players[playerOrder[dealerIndex]].name}`);
    startTurnTimer();
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
        p.hand = [];
        log(`🚫 ${p.name} FOLDED`);
        activityLog(`${p.name} folded`);
    } else if (action.type === 'call') {
        const amt = currentBet - p.bet;
        const actualAmt = Math.min(amt, p.chips);
        p.chips -= actualAmt; p.bet += actualAmt; pot += actualAmt;
        if (amt === 0) {
            log(`✓ ${p.name} CHECKED`);
            activityLog(`${p.name} checked`);
        } else {
            log(`📞 ${p.name} CALLED ${actualAmt} (pot: ${p.bet}/${currentBet})`);
            activityLog(`${p.name} called ${actualAmt}`);
        }
        if (p.chips === 0) p.status = 'ALL_IN';
    } else if (action.type === 'raise') {
        const total = action.amt;
        const diff = total - p.bet;
        const actualDiff = Math.min(diff, p.chips);
        p.chips -= actualDiff; p.bet += actualDiff; pot += actualDiff;
        currentBet = p.bet;
        playersActedThisRound.clear();
        playersActedThisRound.add(socket.id);
        log(`🎲 ${p.name} RAISED to ${p.bet} (pot now: ${pot})`);
        activityLog(`${p.name} raised to £${p.bet}`);
        if (p.chips === 0) p.status = 'ALL_IN';
    }
    
    const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
    const allActed = activeInHand.every(id => playersActedThisRound.has(id));
    const allMatched = activeInHand.every(id => players[id].bet === currentBet);

    if (activeInHand.length <= 1 || (allActed && allMatched)) {
        stopTurnTimer();
        advanceStage();
    } else {
        let nextIdx = turnIndex;
        do {
            nextIdx = (nextIdx + 1) % playerOrder.length;
        } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
        turnIndex = nextIdx;
        startTurnTimer();
        broadcast();
    }
}

function advanceStage() {
    playerOrder.forEach(id => { if(players[id].status !== 'OUT') players[id].bet = 0; });
    currentBet = 0;
    playersActedThisRound.clear();
    if (getPlayersInHand().length <= 1) return showdown();

    if (gameStage === 'PREFLOP') { 
        community = [deck.pop(), deck.pop(), deck.pop()]; 
        gameStage = 'FLOP'; 
    }
    else if (gameStage === 'FLOP') { 
        community.push(deck.pop()); 
        gameStage = 'TURN'; 
    }
    else if (gameStage === 'TURN') { 
        community.push(deck.pop()); 
        gameStage = 'RIVER'; 
    }
    else return showdown();

    let nextIdx = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[nextIdx]].status !== 'ACTIVE') nextIdx = (nextIdx + 1) % playerOrder.length;
    turnIndex = nextIdx;
    startTurnTimer();
    broadcast();
}

function showdown() {
    stopTurnTimer();
    gameStage = 'SHOWDOWN';
    const inHand = getPlayersInHand();
    if (inHand.length === 1) {
        const winnerId = inHand[0];
        players[winnerId].chips += pot;
        setTimeout(() => { gameStage = 'LOBBY'; broadcast(); }, 3000);
        broadcast();
        return;
    }
    const evaluatedPlayers = inHand.map(id => {
        const sevenCards = [...players[id].hand, ...community];
        const bestHand = findBestHand(sevenCards);
        return { id, bestHand };
    });
    evaluatedPlayers.sort((a, b) => compareHands(b.bestHand, a.bestHand));
    const winners = [evaluatedPlayers[0]];
    for (let i = 1; i < evaluatedPlayers.length; i++) {
        if (compareHands(evaluatedPlayers[i].bestHand, winners[0].bestHand) === 0) winners.push(evaluatedPlayers[i]);
    }
    const winAmt = Math.floor(pot / winners.length);
    winners.forEach(w => { players[w.id].chips += winAmt; });
    setTimeout(() => { gameStage = 'LOBBY'; broadcast(); }, 3000);
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
                cards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['?','?'] : []),
                autoFold: players[pid].autoFold
            })),
            community, pot, gameStage, activeId: playerOrder[turnIndex], currentBet, SB, BB,
            callAmt: currentBet - players[id].bet,
            timeRemaining: turnTimeRemaining
        });
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name, chips: STARTING_CHIPS, hand: [], bet: 0, status: 'ACTIVE', autoFold: false };
        playerOrder.push(socket.id);
        gameStage = 'LOBBY';
        broadcast();
    });
    socket.on('start_game', () => startNewHand());
    socket.on('action', (data) => handleAction(socket, data));
    socket.on('toggle_autofold', (value) => {
        if (players[socket.id]) { players[socket.id].autoFold = value; broadcast(); }
    });
    socket.on('reset_engine', () => { 
        if(playerOrder[0] === socket.id) { players={}; playerOrder=[]; io.emit('force_refresh'); } 
    });
    socket.on('disconnect', () => { 
        delete players[socket.id]; 
        playerOrder = playerOrder.filter(id => id !== socket.id); 
        broadcast(); 
    });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body>Poker Client</body></html>`);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log('Server running on port ' + PORT); });
