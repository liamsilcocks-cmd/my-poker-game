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
let lastRaiseAmount = BB; // Track the size of the last raise for minimum raise calculations
let dealerIndex = -1; 
let turnIndex = 0;
let gameStage = 'LOBBY'; 
let gameStarted = false; // Track if game has ever started to prevent new joins
let playersActedThisRound = new Set();
let playersAllowedToReraise = new Set(); // Track who can re-raise after incomplete raises
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
    // Clear any previous winner announcement
    io.emit('clear_winner');
    
    community = []; pot = 0; currentBet = BB; lastRaiseAmount = BB;
    playersActedThisRound.clear();
    playersAllowedToReraise.clear();
    gameStarted = true; // Lock the game from new players joining
    
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
    
    const sbAmount = Math.min(SB, players[sbPlayer].chips);
    const bbAmount = Math.min(BB, players[bbPlayer].chips);
    
    players[sbPlayer].chips -= sbAmount; players[sbPlayer].bet = sbAmount;
    players[bbPlayer].chips -= bbAmount; players[bbPlayer].bet = bbAmount;
    pot = sbAmount + bbAmount;
    
    // Mark players as all-in if they don't have enough for blinds
    if (players[sbPlayer].chips === 0) players[sbPlayer].status = 'ALL_IN';
    if (players[bbPlayer].chips === 0) players[bbPlayer].status = 'ALL_IN';
    
    log(`🃏 NEW HAND STARTED`);
    log(`👑 Dealer: ${players[playerOrder[dealerIndex]].name}`);
    log(`💵 SB: ${players[sbPlayer].name} posts ${sbAmount}`);
    log(`💵 BB: ${players[bbPlayer].name} posts ${bbAmount}`);
    log(`🎴 Dealing cards to ${active.length} players`);
    
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    gameStage = 'PREFLOP';
    activityLog("--- NEW HAND ---");
    activityLog(`Dealer: ${players[playerOrder[dealerIndex]].name}`);
    activityLog(`SB ${sbAmount}, BB ${bbAmount}`);
    
    // Initialize players allowed to reraise (everyone active at start)
    active.forEach(id => {
        if (players[id].status === 'ACTIVE') {
            playersAllowedToReraise.add(id);
        }
    });
    
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
        p.hand = []; // Remove cards
        log(`🚫 ${p.name} FOLDED`);
        activityLog(`${p.name} folded (pot was at ${currentBet})`);
        
    } else if (action.type === 'call') {
        const amtToCall = currentBet - p.bet;
        const actualAmt = Math.min(amtToCall, p.chips);
        p.chips -= actualAmt; 
        p.bet += actualAmt; 
        pot += actualAmt;
        
        if (amtToCall === 0) {
            log(`✓ ${p.name} CHECKED`);
            activityLog(`${p.name} checked`);
        } else {
            log(`📞 ${p.name} CALLED ${actualAmt} (total bet: ${p.bet})`);
            activityLog(`${p.name} called ${actualAmt} (total in pot: ${p.bet})`);
        }
        
        if (p.chips === 0) {
            p.status = 'ALL_IN';
            log(`🔥 ${p.name} is ALL IN!`);
            activityLog(`${p.name} is ALL IN with ${p.bet}!`);
        }
        
    } else if (action.type === 'raise') {
        const targetTotal = action.amt;
        const raiseAmount = targetTotal - currentBet;
        const diff = targetTotal - p.bet;
        const actualDiff = Math.min(diff, p.chips);
        
        const previousBet = currentBet;
        
        p.chips -= actualDiff; 
        p.bet += actualDiff;
        pot += actualDiff;
        
        // Check if this is a complete raise (meets minimum)
        const minRaiseTotal = currentBet + lastRaiseAmount;
        const isCompleteRaise = p.bet >= minRaiseTotal || p.chips === 0; // All-in is always allowed
        
        if (p.chips === 0) {
            // All-in situation
            p.status = 'ALL_IN';
            
            if (p.bet >= minRaiseTotal) {
                // Complete raise - reopens action for everyone
                currentBet = p.bet;
                lastRaiseAmount = p.bet - previousBet;
                playersActedThisRound.clear();
                playersActedThisRound.add(socket.id);
                playersAllowedToReraise = new Set(playerOrder.filter(id => players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN'));
                
                log(`🔥💰 ${p.name} RAISED ALL IN to ${p.bet} (complete raise of ${lastRaiseAmount}) - ACTION REOPENED`);
                activityLog(`${p.name} raised all-in to ${p.bet} (raise of ${lastRaiseAmount}) - reopened betting`);
            } else {
                // Incomplete raise (under-raise) - does NOT reopen action
                const oldBet = currentBet;
                currentBet = p.bet;
                
                log(`🔥 ${p.name} ALL IN for ${p.bet} (incomplete raise from ${previousBet}, doesn't reopen action)`);
                activityLog(`${p.name} all-in ${p.bet} (under-raise by ${minRaiseTotal - p.bet}, betting capped)`);
                
                // Don't clear playersActedThisRound - players who already acted cannot re-raise
                // Only players who haven't acted yet can call or raise
            }
        } else {
            // Regular raise (not all-in)
            currentBet = p.bet;
            lastRaiseAmount = p.bet - previousBet;
            playersActedThisRound.clear();
            playersActedThisRound.add(socket.id);
            playersAllowedToReraise = new Set(playerOrder.filter(id => players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN'));
            
            log(`🎲 ${p.name} RAISED to ${p.bet} (raise of ${lastRaiseAmount}, min next raise: ${currentBet + lastRaiseAmount})`);
            activityLog(`${p.name} raised to ${p.bet} (raise of ${lastRaiseAmount})`);
        }
        
    } else if (action.type === 'allin') {
        // ALL IN button - bet everything
        const allInAmount = p.chips;
        const previousBet = currentBet;
        
        p.bet += allInAmount;
        pot += allInAmount;
        p.chips = 0;
        p.status = 'ALL_IN';
        
        // Check if this is a complete raise
        const minRaiseTotal = currentBet + lastRaiseAmount;
        
        if (p.bet >= minRaiseTotal) {
            // Complete raise - reopens action
            lastRaiseAmount = p.bet - previousBet;
            currentBet = p.bet;
            playersActedThisRound.clear();
            playersActedThisRound.add(socket.id);
            playersAllowedToReraise = new Set(playerOrder.filter(id => players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN'));
            
            log(`🔥💰 ${p.name} WENT ALL IN for ${p.bet} (complete raise of ${lastRaiseAmount}) - ACTION REOPENED`);
            activityLog(`${p.name} ALL IN ${p.bet} (raise of ${lastRaiseAmount}) - reopened betting`);
        } else if (p.bet > currentBet) {
            // Incomplete raise - doesn't reopen action
            currentBet = p.bet;
            log(`🔥 ${p.name} ALL IN for ${p.bet} (incomplete raise from ${previousBet}, doesn't reopen action)`);
            activityLog(`${p.name} ALL IN ${p.bet} (under-raise, betting capped)`);
        } else {
            // Just calling all-in
            log(`🔥 ${p.name} CALLED ALL IN for ${p.bet}`);
            activityLog(`${p.name} called all-in with ${p.bet}`);
        }
    }
    
    const activeInHand = playerOrder.filter(id => players[id].status === 'ACTIVE');
    const allActed = activeInHand.every(id => playersActedThisRound.has(id));
    const allMatched = activeInHand.every(id => players[id].bet === currentBet);

    log(`📊 Round status: ${activeInHand.length} active, all acted: ${allActed}, all matched: ${allMatched}`);

    if (activeInHand.length <= 1 || (allActed && allMatched)) {
        stopTurnTimer();
        advanceStage();
    } else {
        let nextIdx = turnIndex;
        do {
            nextIdx = (nextIdx + 1) % playerOrder.length;
        } while (players[playerOrder[nextIdx]].status !== 'ACTIVE');
        turnIndex = nextIdx;
        log(`⏭️ Next to act: ${players[playerOrder[turnIndex]].name}`);
        startTurnTimer();
        broadcast();
    }
}

function advanceStage() {
    log(`🎬 ADVANCING STAGE from ${gameStage}`);
    playerOrder.forEach(id => { if(players[id].status !== 'OUT') players[id].bet = 0; });
    currentBet = 0;
    lastRaiseAmount = 0; // Reset for new betting round
    playersActedThisRound.clear();
    playersAllowedToReraise.clear();
    
    // Re-initialize players allowed to reraise
    playerOrder.forEach(id => {
        if (players[id].status === 'ACTIVE') {
            playersAllowedToReraise.add(id);
        }
    });

    if (getPlayersInHand().length <= 1) return showdown();

    if (gameStage === 'PREFLOP') { 
        community = [deck.pop(), deck.pop(), deck.pop()]; 
        gameStage = 'FLOP'; 
        log(`🃏 FLOP: ${community.join(' ')}`);
        activityLog(`--- FLOP: ${community.join(' ')} ---`);
    }
    else if (gameStage === 'FLOP') { 
        community.push(deck.pop()); 
        gameStage = 'TURN'; 
        log(`🃏 TURN: ${community[3]}`);
        activityLog(`--- TURN: ${community[3]} ---`);
    }
    else if (gameStage === 'TURN') { 
        community.push(deck.pop()); 
        gameStage = 'RIVER'; 
        log(`🃏 RIVER: ${community[4]}`);
        activityLog(`--- RIVER: ${community[4]} ---`);
    }
    else return showdown();

    let nextIdx = (dealerIndex + 1) % playerOrder.length;
    while (players[playerOrder[nextIdx]].status !== 'ACTIVE') nextIdx = (nextIdx + 1) % playerOrder.length;
    turnIndex = nextIdx;
    log(`⏭️ ${gameStage} betting starts with: ${players[playerOrder[turnIndex]].name}`);
    startTurnTimer();
    broadcast();
}

function showdown() {
    stopTurnTimer();
    gameStage = 'SHOWDOWN';
    log(`🏆 ============ SHOWDOWN ============`);
    log(`🎴 Community cards: ${community.join(' ')}`);
    
    const inHand = getPlayersInHand();
    
    if (inHand.length === 1) {
        const winnerId = inHand[0];
        players[winnerId].chips += pot;
        log(`🏆 ${players[winnerId].name} wins ${pot} (all others folded)`);
        activityLog(`🏆 ${players[winnerId].name} wins ${pot} (all others folded)`);
        io.emit('winner_announcement', `${players[winnerId].name} wins ${pot}`);
        setTimeout(() => {
            gameStage = 'LOBBY';
            io.emit('clear_winner');
            broadcast();
        }, 5000);
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
        return { 
            id, 
            bestHand,
            amountInPot: players[id].bet
        };
    });
    
    // Build side pots
    // Get all players who contributed to the pot (including folded)
    const allContributions = playerOrder.map(id => ({
        id,
        amount: players[id].bet,
        inHand: inHand.includes(id)
    })).filter(p => p.amount > 0);
    
    // Get unique bet amounts sorted ascending
    const uniqueAmounts = [...new Set(allContributions.map(p => p.amount))].sort((a, b) => a - b);
    
    const sidePots = [];
    let previousAmount = 0;
    
    uniqueAmounts.forEach(amount => {
        const increment = amount - previousAmount;
        
        // Count how many players contributed at least this much
        const contributors = allContributions.filter(p => p.amount >= amount);
        const potSize = increment * contributors.length;
        
        // Only players still in hand at this level can win
        const eligiblePlayers = contributors.filter(p => p.inHand).map(p => p.id);
        
        if (potSize > 0 && eligiblePlayers.length > 0) {
            sidePots.push({
                amount: potSize,
                eligiblePlayers: eligiblePlayers
            });
        }
        
        previousAmount = amount;
    });
    
    // If no side pots (everyone all-in or matched exactly), create one main pot
    if (sidePots.length === 0) {
        sidePots.push({
            amount: pot,
            eligiblePlayers: inHand
        });
    }
    
    log(`💰 SIDE POTS: ${sidePots.length} pot(s)`);
    sidePots.forEach((sp, idx) => {
        log(`  Pot ${idx + 1}: ${sp.amount} - Eligible: ${sp.eligiblePlayers.map(id => players[id].name).join(', ')}`);
    });
    
    let winnerAnnouncement = '';
    
    // Award each pot to its winner(s), starting from highest (side pots awarded first in poker)
    for (let potIndex = sidePots.length - 1; potIndex >= 0; potIndex--) {
        const sidePot = sidePots[potIndex];
        
        // Get hands for eligible players only
        const eligibleHands = evaluatedPlayers.filter(ep => 
            sidePot.eligiblePlayers.includes(ep.id)
        );
        
        if (eligibleHands.length === 0) continue;
        
        // Sort by hand strength (best first)
        eligibleHands.sort((a, b) => compareHands(b.bestHand, a.bestHand));
        
        // Find all winners (handle ties)
        const winners = [eligibleHands[0]];
        for (let i = 1; i < eligibleHands.length; i++) {
            if (compareHands(eligibleHands[i].bestHand, winners[0].bestHand) === 0) {
                winners.push(eligibleHands[i]);
            }
        }
        
        const winAmt = Math.floor(sidePot.amount / winners.length);
        
        const potLabel = sidePots.length > 1 ? `Pot ${potIndex + 1}` : 'Main Pot';
        log(`🏆 ${potLabel} (${sidePot.amount}) WINNER(S):`);
        
        winners.forEach(w => {
            players[w.id].chips += winAmt;
            log(`  💰 ${players[w.id].name} wins ${winAmt} with ${w.bestHand.name}`);
            activityLog(`🏆 ${players[w.id].name} wins ${winAmt} with ${w.bestHand.name} (${w.bestHand.cards.join(' ')})`);
            
            if (winnerAnnouncement) winnerAnnouncement += ' | ';
            winnerAnnouncement += `${players[w.id].name}: ${winAmt} (${w.bestHand.name})`;
        });
    }
    
    io.emit('winner_announcement', winnerAnnouncement);
    
    log(`============ HAND COMPLETE ============`);
    
    // Stay in SHOWDOWN state - don't clear until START is pressed
    broadcast();
}

function broadcast() {
    const sbIdx = (dealerIndex + 1) % playerOrder.length;
    const bbIdx = (dealerIndex + 2) % playerOrder.length;

    playerOrder.forEach(id => {
        const myChips = players[id].chips;
        const minRaiseTotal = currentBet + lastRaiseAmount;
        const canRaise = myChips + players[id].bet >= minRaiseTotal;
        
        // Determine if this is a "bet" or "raise" situation
        // It's a BET if: currentBet is 0, OR we're preflop and only the BB has been posted (no voluntary raises)
        const isBetSituation = (currentBet === 0) || 
                               (gameStage === 'PREFLOP' && currentBet === BB && lastRaiseAmount === BB);
        
        io.to(id).emit('update', {
            myId: id, 
            myName: players[id].name, 
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
                cards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : (players[pid].hand.length ? ['?','?'] : []),
                autoFold: players[pid].autoFold
            })),
            community, 
            pot, 
            gameStage, 
            activeId: playerOrder[turnIndex], 
            currentBet, 
            SB, 
            BB,
            myBet: players[id].bet,
            callAmt: currentBet - players[id].bet,
            minRaise: minRaiseTotal,
            canRaise: canRaise,
            myChips: myChips,
            isBetSituation: isBetSituation,
            timeRemaining: turnTimeRemaining
        });
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        // Prevent joining if game has already started
        if (gameStarted) {
            socket.emit('join_rejected', 'Game already in progress. Please wait for the next game.');
            log(`⛔ ${name} tried to join but game is in progress`);
            return;
        }
        
        players[socket.id] = { name, chips: STARTING_CHIPS, hand: [], bet: 0, status: 'ACTIVE', autoFold: false };
        playerOrder.push(socket.id);
        log(`➕ ${name} joined the game (${playerOrder.length} players total)`);
        activityLog(`${name} joined the table`);
        gameStage = 'LOBBY'; // Ensure we're in LOBBY when players join
        broadcast();
    });
    socket.on('start_game', () => startNewHand());
    socket.on('action', (data) => handleAction(socket, data));
    socket.on('toggle_autofold', (value) => {
        if (players[socket.id]) {
            players[socket.id].autoFold = value;
            log(`${players[socket.id].name} ${value ? 'enabled' : 'disabled'} auto-fold`);
            broadcast();
        }
    });
    socket.on('reset_engine', () => { 
        if(playerOrder[0] === socket.id) { 
            log(`🔄 Game reset by ${players[socket.id].name}`);
            players={}; 
            playerOrder=[];
            gameStarted = false; // Allow new players to join again
            io.emit('force_refresh'); 
        } 
    });
    socket.on('disconnect', () => { 
        if (players[socket.id]) {
            log(`➖ ${players[socket.id].name} disconnected`);
            activityLog(`${players[socket.id].name} left the table`);
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
        <meta name="apple-mobile-web-app-capable" content="yes">
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
        <meta name="mobile-web-app-capable" content="yes">
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
                justify-content: center;
                align-items: center;
                padding: 6px 8px;
                background: rgba(0,0,0,0.5);
                z-index: 100;
                flex-shrink: 0;
                position: relative;
            }
            #blinds-overlay { 
                font-size: 24px; 
                color: #888;
                position: absolute;
                left: 8px;
            }
            #pot-display { 
                font-size: 28px; 
                color: #2ecc71; 
                font-weight: bold;
                text-align: center;
            }
            
            @media (max-width: 768px) and (orientation: landscape) {
                #top-bar {
                    padding: 4px 8px;
                }
                #pot-display {
                    font-size: 24px;
                }
                #blinds-overlay {
                    font-size: 22px;
                }
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
                width: 500px;
                height: 240px;
                background: #1a5c1a; 
                border: 4px solid #4d260a; 
                border-radius: 120px; 
                position: absolute; 
                display: flex; 
                flex-direction: column; 
                justify-content: center; 
                align-items: center; 
                z-index: 1; 
                box-shadow: inset 0 0 15px #000;
                left: 50%;
                top: 45%;
                transform: translate(-50%, -50%);
            }
            
            @media (max-width: 768px) and (orientation: landscape) {
                .poker-table {
                    width: 60vw;
                    height: 50vh;
                    max-width: 600px;
                    max-height: 280px;
                }
            }
            
            @media (max-width: 768px) and (orientation: portrait) {
                .poker-table {
                    width: 80vw;
                    height: 35vh;
                }
            }
            
            #table-logo { 
                font-size: 60px; 
                font-weight: bold; 
                color: rgba(255,255,255,0.15); 
                text-transform: uppercase; 
                margin-bottom: 3px;
                letter-spacing: 3px;
            }
            
            @media (max-width: 768px) and (orientation: landscape) {
                #table-logo {
                    font-size: 50px;
                }
            }
            
            @media (max-width: 768px) and (orientation: portrait) {
                #table-logo {
                    font-size: 45px;
                }
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
            #winner-announcement {
                font-size: 12px;
                color: #2ecc71;
                text-align: center;
                font-weight: bold;
                margin-top: 5px;
                min-height: 20px;
            }
            
            .card { 
                background: white; 
                color: black; 
                border: 2px solid #000; 
                border-radius: 6px; 
                padding: 4px 6px; 
                margin: 2px; 
                font-weight: bold; 
                font-size: 1.6em; 
                min-width: 40px;
                min-height: 50px;
                display: inline-flex; 
                justify-content: center; 
                align-items: center;
                position: relative;
            }
            .card.red { color: #d63031; }
            .card.hidden { background: #2980b9; color: #2980b9; }
            .card .suit-letter {
                position: absolute;
                top: 2px;
                right: 4px;
                font-size: 0.5em;
                font-weight: bold;
                opacity: 0.7;
            }
            
            .player-seat { 
                position: absolute; 
                z-index: 10; 
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
                overflow: visible;
            }
            .timer-display {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 100px;
                height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 25;
                pointer-events: none;
            }
            .chevron-left, .chevron-right {
                position: absolute;
                width: 20px;
                height: 20px;
                border-right: 4px solid #f1c40f;
                border-bottom: 4px solid #f1c40f;
                top: 50%;
                margin-top: -10px;
            }
            .chevron-left {
                transform: rotate(-45deg);
                animation: chevron-slide-left 1s infinite;
            }
            .chevron-right {
                transform: rotate(135deg);
                animation: chevron-slide-right 1s infinite;
            }
            .chevron-left:nth-child(1) {
                left: -50px;
                animation-delay: 0s;
            }
            .chevron-left:nth-child(2) {
                left: -40px;
                animation-delay: 0.15s;
                opacity: 0.7;
            }
            .chevron-left:nth-child(3) {
                left: -30px;
                animation-delay: 0.3s;
                opacity: 0.4;
            }
            .chevron-right:nth-child(4) {
                right: -50px;
                animation-delay: 0s;
            }
            .chevron-right:nth-child(5) {
                right: -40px;
                animation-delay: 0.15s;
                opacity: 0.7;
            }
            .chevron-right:nth-child(6) {
                right: -30px;
                animation-delay: 0.3s;
                opacity: 0.4;
            }
            .timer-display.warning .chevron-left,
            .timer-display.warning .chevron-right {
                border-right-color: #e74c3c;
                border-bottom-color: #e74c3c;
            }
            .timer-display.warning .chevron-left {
                animation: chevron-slide-left-fast 0.5s infinite;
            }
            .timer-display.warning .chevron-right {
                animation: chevron-slide-right-fast 0.5s infinite;
            }
            @keyframes chevron-slide-left {
                0% {
                    left: -50px;
                    opacity: 0;
                }
                50% {
                    opacity: 1;
                }
                100% {
                    left: -15px;
                    opacity: 0;
                }
            }
            @keyframes chevron-slide-right {
                0% {
                    right: -50px;
                    opacity: 0;
                }
                50% {
                    opacity: 1;
                }
                100% {
                    right: -15px;
                    opacity: 0;
                }
            }
            @keyframes chevron-slide-left-fast {
                0% {
                    left: -50px;
                    opacity: 0;
                }
                50% {
                    opacity: 1;
                }
                100% {
                    left: -15px;
                    opacity: 0;
                }
            }
            @keyframes chevron-slide-right-fast {
                0% {
                    right: -50px;
                    opacity: 0;
                }
                50% {
                    opacity: 1;
                }
                100% {
                    right: -15px;
                    opacity: 0;
                }
            }
            
            #turn-timer-display {
                position: fixed;
                top: 50%;
                left: 20px;
                transform: translateY(-50%);
                font-size: 48px;
                font-weight: bold;
                color: #f1c40f;
                z-index: 150;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.8);
                display: none;
            }
            #turn-timer-display.warning {
                color: #e74c3c;
                animation: timer-pulse 0.5s infinite;
            }
            @keyframes timer-pulse {
                0%, 100% { opacity: 1; transform: translateY(-50%) scale(1); }
                50% { opacity: 0.7; transform: translateY(-50%) scale(1.1); }
            }
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.6; }
            }
            .auto-fold-container {
                margin-top: 2px;
                font-size: 9px;
            }
            .auto-fold-checkbox {
                margin-right: 3px;
                cursor: pointer;
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
                gap: 3px; 
                margin: 3px 0; 
            }
            .card-small { 
                background: white; 
                color: black; 
                border-radius: 6px; 
                border: 2px solid #000; 
                font-size: 1.6em; 
                padding: 4px 6px; 
                font-weight: bold; 
                min-width: 40px;
                min-height: 50px;
                display: inline-flex;
                justify-content: center;
                align-items: center;
                position: relative;
            }
            .card-small.red { color: #d63031; }
            .card-small.hidden { background: #2980b9; color: #2980b9; }
            .card-small .suit-letter {
                position: absolute;
                top: 2px;
                right: 3px;
                font-size: 0.5em;
                font-weight: bold;
                opacity: 0.7;
            }
            
            @media (max-width: 768px) and (orientation: landscape) {
                .card-small {
                    font-size: 1.4em;
                    min-width: 36px;
                    min-height: 46px;
                    padding: 3px 5px;
                }
            }
            
            .disc { 
                position: absolute; 
                top: -20px; 
                right: -20px;
                width: 36px; 
                height: 36px; 
                border-radius: 50%; 
                font-size: 14px; 
                font-weight: bold; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                border: 3px solid black;
                z-index: 20;
            }
            .disc.d { background: white; color: black; }
            .disc.sb { background: #3498db; color: white; }
            .disc.bb { background: #f1c40f; color: black; }
            .disc.bb-bottom { 
                top: auto;
                bottom: -20px;
                right: -20px;
            }
            
            #controls { 
                background: #111; 
                padding: 8px; 
                border-top: 2px solid #333; 
                display: none; 
                justify-content: center; 
                gap: 6px; 
                width: 100%; 
                flex-shrink: 0;
                position: fixed;
                bottom: 0;
                left: 0;
                z-index: 101;
            }
            
            @media (max-width: 768px) and (orientation: landscape) {
                #controls {
                    padding: 6px 8px;
                }
                #controls button {
                    padding: 10px 8px;
                    font-size: 12px;
                }
                #controls input {
                    width: 50px;
                    font-size: 13px;
                    padding: 8px 4px;
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
                max-width: 90px;
                cursor: pointer;
            }
            #controls input { 
                width: 55px; 
                background: #000; 
                color: #fff; 
                border: 1px solid #444; 
                text-align: center; 
                font-size: 14px;
                border-radius: 4px;
                padding: 10px 2px;
            }
            
            #debug-window { 
                position: fixed; 
                top: 30px; 
                right: 10px; 
                width: 300px; 
                height: 300px; 
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
                right: 10px; 
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
            #fullscreen-btn {
                background: #9b59b6;
                position: fixed;
                top: 40px;
                left: 8px;
                z-index: 103;
                padding: 6px 12px;
                font-size: 11px;
                font-weight: bold;
            }
            
            /* iOS Install Prompt */
            #ios-prompt {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(0,0,0,0.95);
                border: 3px solid #9b59b6;
                padding: 20px;
                border-radius: 12px;
                z-index: 300;
                display: none;
                max-width: 90%;
                text-align: center;
                color: white;
            }
            #ios-prompt h3 {
                margin: 0 0 15px 0;
                color: #9b59b6;
            }
            #ios-prompt p {
                margin: 10px 0;
                line-height: 1.6;
            }
            #ios-prompt button {
                background: #9b59b6;
                color: white;
                border: none;
                padding: 12px 24px;
                border-radius: 6px;
                font-weight: bold;
                margin-top: 15px;
                cursor: pointer;
            }
            .share-icon {
                display: inline-block;
                width: 20px;
                height: 20px;
                background: #007AFF;
                border-radius: 4px;
                margin: 0 4px;
                vertical-align: middle;
            }
            
            #start-btn {
                position: absolute;
                top: 30%;
                left: 50%;
                transform: translate(-50%, -50%);
                padding: 15px 30px;
                background: #2980b9;
                color: white;
                border: none;
                border-radius: 6px;
                display: none;
                z-index: 15;
                font-weight: bold;
                font-size: 16px;
                cursor: pointer;
            }
            
            /* POSITION CONTROLS */
            #position-controls {
                position: fixed;
                top: 40px;
                left: 10px;
                background: rgba(0,0,0,0.95);
                border: 2px solid #f39c12;
                padding: 10px;
                border-radius: 8px;
                z-index: 250;
                display: none;
                color: #fff;
                font-size: 11px;
                max-height: 80vh;
                overflow-y: auto;
                min-width: 280px;
            }
            #position-controls h3 {
                margin: 0 0 10px 0;
                color: #f39c12;
                font-size: 13px;
                border-bottom: 1px solid #f39c12;
                padding-bottom: 5px;
            }
            .pos-section {
                margin-bottom: 15px;
                padding: 8px;
                background: rgba(255,255,255,0.05);
                border-radius: 4px;
            }
            .pos-section h4 {
                margin: 0 0 8px 0;
                color: #3498db;
                font-size: 12px;
            }
            .slider-group {
                margin: 5px 0;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .slider-group label {
                min-width: 30px;
                color: #aaa;
            }
            .slider-group input[type="range"] {
                flex: 1;
                height: 20px;
            }
            .slider-group span {
                min-width: 50px;
                text-align: right;
                color: #2ecc71;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
        <div id="top-bar">
            <div id="blinds-overlay">Blinds: <span id="blinds-info">--/--</span></div>
            <div id="pot-display">Pot: <span id="pot">0</span></div>
        </div>
        
        <button id="fullscreen-btn" class="tool-btn" onclick="toggleFullscreen()">FULLSCREEN</button>
        
        <div id="turn-timer-display"></div>
        
        <div id="ios-prompt">
            <h3>📱 iPhone Fullscreen Mode</h3>
            <p>To use fullscreen on iPhone:</p>
            <p>1. Tap the Share button <span class="share-icon">⬆️</span> at the bottom of Safari</p>
            <p>2. Scroll down and tap "Add to Home Screen"</p>
            <p>3. Open the app from your home screen</p>
            <p style="color: #aaa; font-size: 12px; margin-top: 15px;">This will give you a true fullscreen experience without Safari's bars!</p>
            <button onclick="document.getElementById('ios-prompt').style.display='none'">Got It!</button>
        </div>
        
        <div class="game-area">
            <div id="debug-window"><b>🔧 DEBUG LOG</b><hr></div>
            <div id="activity-log"><b>📋 ACTIVITY</b><hr></div>
            <div class="poker-table" id="poker-table">
                <div id="table-logo">SYFM POKER</div>
                <button id="start-btn" onclick="socket.emit('start_game')">START</button>
                <div id="community"></div>
                <div id="winner-announcement"></div>
                <div id="action-guide"></div>
            </div>
            <div id="seats"></div>
        </div>
        
        <div id="controls">
            <button onclick="socket.emit('action', {type:'fold'})" style="background: #c0392b;">FOLD</button>
            <button id="check-btn" onclick="socket.emit('action', {type:'call'})" style="background: #27ae60; display:none;">CHECK</button>
            <button id="call-btn" onclick="socket.emit('action', {type:'call'})" style="background: #3498db; display:none;">CALL</button>
            <input type="number" id="bet-amt" value="100">
            <button id="raise-btn" onclick="socket.emit('action', {type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})" style="background: #e67e22;">RAISE</button>
            <button id="allin-btn" onclick="socket.emit('action', {type:'allin'})" style="background: #8e44ad;">ALL IN</button>
        </div>
        
        <div id="position-controls">
            <h3>🎯 POSITION CONTROLS</h3>
            
            <div class="pos-section">
                <h4>Poker Table</h4>
                <div class="slider-group">
                    <label>X:</label>
                    <input type="range" id="table-x" min="0" max="100" value="50" step="1">
                    <span id="table-x-val">50%</span>
                </div>
                <div class="slider-group">
                    <label>Y:</label>
                    <input type="range" id="table-y" min="0" max="100" value="45" step="1">
                    <span id="table-y-val">45%</span>
                </div>
            </div>
            
            <div class="pos-section">
                <h4>Player Seats Orbit</h4>
                <div class="slider-group">
                    <label>X:</label>
                    <input type="range" id="seats-x" min="0" max="100" value="50" step="1">
                    <span id="seats-x-val">50%</span>
                </div>
                <div class="slider-group">
                    <label>Y:</label>
                    <input type="range" id="seats-y" min="0" max="100" value="45" step="1">
                    <span id="seats-y-val">45%</span>
                </div>
                <div class="slider-group">
                    <label>RX:</label>
                    <input type="range" id="seats-rx" min="50" max="500" value="220" step="10">
                    <span id="seats-rx-val">220px</span>
                </div>
                <div class="slider-group">
                    <label>RY:</label>
                    <input type="range" id="seats-ry" min="50" max="400" value="120" step="10">
                    <span id="seats-ry-val">120px</span>
                </div>
            </div>
            
            <div class="pos-section">
                <h4>Action Buttons</h4>
                <div class="slider-group">
                    <label>Y:</label>
                    <input type="range" id="controls-y" min="0" max="100" value="100" step="1">
                    <span id="controls-y-val">100%</span>
                </div>
            </div>
        </div>
        
        <div id="footer-btns">
            <button class="tool-btn" onclick="let l=document.getElementById('activity-log'); l.style.display=l.style.display==='block'?'none':'block'">LOG</button>
            <button id="debug-btn" class="tool-btn" style="display:none; background:#16a085" onclick="let d=document.getElementById('debug-window'); d.style.display=d.style.display==='block'?'none':'block'">DEBUG</button>
            <button id="position-btn" class="tool-btn" style="background:#f39c12" onclick="let p=document.getElementById('position-controls'); p.style.display=p.style.display==='block'?'none':'block'">POSITION</button>
            <button id="reset-btn" class="tool-btn" style="display:none; background:#c0392b" onclick="socket.emit('reset_engine')">RESET</button>
        </div>
        
        <button id="start-btn" onclick="socket.emit('start_game')">START</button>
        
        <script src="/socket.io/socket.io.js"></script>
        <script>
            // Fullscreen function
            function toggleFullscreen() {
                // Check if iOS
                const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
                const isInStandaloneMode = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
                
                if (isIOS && !isInStandaloneMode) {
                    // Show iOS prompt
                    document.getElementById('ios-prompt').style.display = 'block';
                    return;
                }
                
                if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                    // Enter fullscreen
                    const elem = document.documentElement;
                    if (elem.requestFullscreen) {
                        elem.requestFullscreen();
                    } else if (elem.webkitRequestFullscreen) { // Safari
                        elem.webkitRequestFullscreen();
                    } else if (elem.mozRequestFullScreen) { // Firefox
                        elem.mozRequestFullScreen();
                    } else if (elem.msRequestFullscreen) { // IE/Edge
                        elem.msRequestFullscreen();
                    }
                    document.getElementById('fullscreen-btn').innerText = 'EXIT FULLSCREEN';
                } else {
                    // Exit fullscreen
                    if (document.exitFullscreen) {
                        document.exitFullscreen();
                    } else if (document.webkitExitFullscreen) { // Safari
                        document.webkitExitFullscreen();
                    } else if (document.mozCancelFullScreen) { // Firefox
                        document.mozCancelFullScreen();
                    } else if (document.msExitFullscreen) { // IE/Edge
                        document.msExitFullscreen();
                    }
                    document.getElementById('fullscreen-btn').innerText = 'FULLSCREEN';
                }
            }
            
            // Listen for fullscreen changes
            document.addEventListener('fullscreenchange', updateFullscreenButton);
            document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
            document.addEventListener('mozfullscreenchange', updateFullscreenButton);
            document.addEventListener('MSFullscreenChange', updateFullscreenButton);
            
            function updateFullscreenButton() {
                const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
                document.getElementById('fullscreen-btn').innerText = isFullscreen ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
            }
            
            // Hide fullscreen button if already in iOS standalone mode
            window.addEventListener('load', () => {
                const isInStandaloneMode = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
                if (isInStandaloneMode) {
                    document.getElementById('fullscreen-btn').style.display = 'none';
                }
            });
            
            // Audio beep functions
            let audioContext = null;
            let lastTimeRemaining = 30;
            let hasPlayedTurnBeep = false;
            let hasPlayed10SecBeep = false;
            let lastActiveId = null; // Track when turn changes to reset bet input
            
            function initAudio() {
                if (!audioContext) {
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
            }
            
            function playBeep(frequency = 800, duration = 150) {
                initAudio();
                if (!audioContext) return;
                
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                
                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);
                
                oscillator.frequency.value = frequency;
                oscillator.type = 'sine';
                
                gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration / 1000);
                
                oscillator.start(audioContext.currentTime);
                oscillator.stop(audioContext.currentTime + duration / 1000);
            }
            
            let socket = io();
            const name = prompt("Name:") || "Guest";
            socket.emit('join', name);
            
            // Handle join rejection
            socket.on('join_rejected', (message) => {
                alert(message);
                window.location.reload();
            });
            
            // Position state
            let positions = {
                tableX: 50, tableY: 45,
                seatsX: 50, seatsY: 45, seatsRX: 220, seatsRY: 120,
                controlsY: 100
            };
            
            function logPosition(label, data) {
                const msg = \`📍 \${label}: \${JSON.stringify(data)}\`;
                console.log(msg);
                const d = document.getElementById('debug-window');
                d.innerHTML += '<div style="color:#f39c12">' + msg + '</div>';
                d.scrollTop = d.scrollHeight;
            }
            
            // Table position sliders
            document.getElementById('table-x').addEventListener('input', (e) => {
                positions.tableX = e.target.value;
                document.getElementById('table-x-val').innerText = e.target.value + '%';
                const table = document.getElementById('poker-table');
                table.style.left = e.target.value + '%';
                logPosition('TABLE', {x: e.target.value + '%', y: positions.tableY + '%'});
            });
            
            document.getElementById('table-y').addEventListener('input', (e) => {
                positions.tableY = e.target.value;
                document.getElementById('table-y-val').innerText = e.target.value + '%';
                const table = document.getElementById('poker-table');
                table.style.top = e.target.value + '%';
                logPosition('TABLE', {x: positions.tableX + '%', y: e.target.value + '%'});
            });
            
            // Seats position sliders
            document.getElementById('seats-x').addEventListener('input', (e) => {
                positions.seatsX = e.target.value;
                document.getElementById('seats-x-val').innerText = e.target.value + '%';
                updateSeats();
                logPosition('SEATS', {x: e.target.value + '%', y: positions.seatsY + '%', rx: positions.seatsRX + 'px', ry: positions.seatsRY + 'px'});
            });
            
            document.getElementById('seats-y').addEventListener('input', (e) => {
                positions.seatsY = e.target.value;
                document.getElementById('seats-y-val').innerText = e.target.value + '%';
                updateSeats();
                logPosition('SEATS', {x: positions.seatsX + '%', y: e.target.value + '%', rx: positions.seatsRX + 'px', ry: positions.seatsRY + 'px'});
            });
            
            document.getElementById('seats-rx').addEventListener('input', (e) => {
                positions.seatsRX = e.target.value;
                document.getElementById('seats-rx-val').innerText = e.target.value + 'px';
                updateSeats();
                logPosition('SEATS', {x: positions.seatsX + '%', y: positions.seatsY + '%', rx: e.target.value + 'px', ry: positions.seatsRY + 'px'});
            });
            
            document.getElementById('seats-ry').addEventListener('input', (e) => {
                positions.seatsRY = e.target.value;
                document.getElementById('seats-ry-val').innerText = e.target.value + 'px';
                updateSeats();
                logPosition('SEATS', {x: positions.seatsX + '%', y: positions.seatsY + '%', rx: positions.seatsRX + 'px', ry: e.target.value + 'px'});
            });
            
            // Controls position slider
            document.getElementById('controls-y').addEventListener('input', (e) => {
                positions.controlsY = e.target.value;
                document.getElementById('controls-y-val').innerText = e.target.value + '%';
                const controls = document.getElementById('controls');
                if (e.target.value == 100) {
                    controls.style.bottom = '0';
                    controls.style.top = 'auto';
                } else {
                    controls.style.top = e.target.value + '%';
                    controls.style.bottom = 'auto';
                }
                logPosition('CONTROLS', {y: e.target.value + '%'});
            });
            
            let currentData = null;
            
            function updateSeats() {
                if (!currentData) return;
                renderSeats(currentData);
            }
            
            function formatCard(c, isSmall = false) {
                if (c === '?') return \`<div class="card \${isSmall ? 'card-small' : ''} hidden">?</div>\`;
                const isRed = c.includes('♥') || c.includes('♦');
                
                // Extract suit letter
                let suitLetter = '';
                if (c.includes('♠')) suitLetter = 'S';
                else if (c.includes('♥')) suitLetter = 'H';
                else if (c.includes('♦')) suitLetter = 'D';
                else if (c.includes('♣')) suitLetter = 'C';
                
                return \`<div class="card \${isSmall ? 'card-small' : ''} \${isRed ? 'red' : ''}">
                    <span class="suit-letter">\${suitLetter}</span>
                    \${c}
                </div>\`;
            }
            
            function renderSeats(data) {
                const area = document.getElementById('seats');
                area.innerHTML = '';
                
                const vW = window.innerWidth;
                const vH = window.innerHeight;
                
                const cX = vW * (positions.seatsX / 100);
                const cY = vH * (positions.seatsY / 100);
                
                const rX = positions.seatsRX;
                const rY = positions.seatsRY;

                const isHeadsUp = data.players.length === 2;
                
                // Find current player's index
                const myIndex = data.players.findIndex(p => p.id === data.myId);
                
                // Reorder so current player is first (will be at top)
                const reorderedPlayers = [];
                for (let i = 0; i < data.players.length; i++) {
                    const idx = (myIndex + i) % data.players.length;
                    reorderedPlayers.push(data.players[idx]);
                }
                
                // Update left-side timer display
                const timerDisplay = document.getElementById('turn-timer-display');
                if (data.activeId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY') {
                    timerDisplay.innerText = data.timeRemaining;
                    timerDisplay.style.display = 'block';
                    if (data.timeRemaining <= 10) {
                        timerDisplay.classList.add('warning');
                    } else {
                        timerDisplay.classList.remove('warning');
                    }
                } else {
                    timerDisplay.style.display = 'none';
                }

                reorderedPlayers.forEach((p, i) => {
                    // Position players in a circle, with index 0 at top (270 degrees / -90 degrees)
                    const angle = (i / reorderedPlayers.length) * 2 * Math.PI - Math.PI/2;
                    const x = cX + rX * Math.cos(angle);
                    const y = cY + rY * Math.sin(angle);
                    
                    const seat = document.createElement('div');
                    seat.className = "player-seat";
                    seat.style.left = x + "px";
                    seat.style.top = y + "px";
                    seat.style.transform = "translate(-50%, -50%)";
                    
                    let disc = '';
                    // In heads-up, dealer also has BB, so show both
                    if (isHeadsUp && p.isDealer && p.isBB) {
                        disc = '<div class="disc d">D</div><div class="disc bb bb-bottom">BB</div>';
                    } else if (p.isDealer) {
                        disc = '<div class="disc d">D</div>';
                    } else if (p.isSB) {
                        disc = '<div class="disc sb">SB</div>';
                    } else if (p.isBB) {
                        disc = '<div class="disc bb">BB</div>';
                    }

                    const cardsHtml = (p.cards && p.cards.length > 0 && data.gameStage !== 'LOBBY') ? p.cards.map(c => formatCard(c, true)).join('') : '';
                    const isMe = p.id === data.myId;
                    const boxClasses = ['player-box'];
                    if (p.id === data.activeId) boxClasses.push('active-turn');
                    if (isMe) boxClasses.push('my-seat');
                    
                    // Chevron indicator - coming from left and right
                    let chevronHtml = '';
                    if (p.id === data.activeId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY') {
                        const chevronClass = data.timeRemaining <= 10 ? 'timer-display warning' : 'timer-display';
                        chevronHtml = \`<div class="\${chevronClass}">
                            <div class="chevron-left"></div>
                            <div class="chevron-left"></div>
                            <div class="chevron-left"></div>
                            <div class="chevron-right"></div>
                            <div class="chevron-right"></div>
                            <div class="chevron-right"></div>
                        </div>\`;
                    }
                    
                    // Auto-fold checkbox (only for current player)
                    let autoFoldHtml = '';
                    if (isMe) {
                        autoFoldHtml = \`<div class="auto-fold-container">
                            <input type="checkbox" class="auto-fold-checkbox" id="autofold-\${p.id}" 
                                \${p.autoFold ? 'checked' : ''} 
                                onchange="socket.emit('toggle_autofold', this.checked)">
                            <label for="autofold-\${p.id}" style="color:\${isMe ? '#666' : '#aaa'}">Auto-fold</label>
                        </div>\`;
                    }
                    
                    seat.innerHTML = \`
                        <div class="\${boxClasses.join(' ')}">
                            \${disc}
                            \${chevronHtml}
                            <b style="color:\${isMe ? '#16a085' : '#f1c40f'}; font-size: 12px;">
                                \${p.name}: <span style="font-size: 14px; color:\${isMe ? '#000' : '#fff'}">\${p.chips}</span>
                            </b><br>
                            <div class="card-row">\${cardsHtml}</div>
                            \${p.bet > 0 ? '<div class="bet-amount" style="color:'+(isMe ? '#2980b9' : 'cyan')+'; font-weight:bold;">'+p.bet+'</div>' : ''}
                            \${autoFoldHtml}
                        </div>\`;
                    area.appendChild(seat);
                });
            }
            
            socket.on('update', data => {
                currentData = data;
                
                // Check if it's now my turn (beep on turn start)
                const isMyTurnForBeep = (data.activeId === data.myId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY');
                if (isMyTurnForBeep && !hasPlayedTurnBeep) {
                    playBeep(800, 150);
                    hasPlayedTurnBeep = true;
                    hasPlayed10SecBeep = false;
                } else if (!isMyTurnForBeep) {
                    hasPlayedTurnBeep = false;
                }
                
                // Check for 10 second warning (beep once)
                if (isMyTurnForBeep && data.timeRemaining === 10 && !hasPlayed10SecBeep) {
                    playBeep(600, 200);
                    hasPlayed10SecBeep = true;
                }
                
                lastTimeRemaining = data.timeRemaining;
                
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
                
                const startBtn = document.getElementById('start-btn');
                if (data.isHost && (data.gameStage === 'LOBBY' || data.gameStage === 'SHOWDOWN')) {
                    startBtn.style.display = 'block';
                    startBtn.innerText = data.gameStage === 'SHOWDOWN' ? 'NEXT HAND' : 'START';
                } else {
                    startBtn.style.display = 'none';
                }
                
                const isMyTurn = (data.activeId === data.myId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY');
                const guide = document.getElementById('action-guide');
                guide.innerText = isMyTurn ? "YOUR TURN" : (data.gameStage === 'SHOWDOWN' ? "SHOWDOWN" : (data.gameStage === 'LOBBY' ? "" : "WAITING..."));
                
                // Check if turn has changed (to reset bet input only once)
                const turnChanged = lastActiveId !== data.activeId;
                if (turnChanged) {
                    lastActiveId = data.activeId;
                }
                
                document.getElementById('controls').style.display = isMyTurn ? 'flex' : 'none';
                if(isMyTurn) {
                    const checkBtn = document.getElementById('check-btn');
                    const callBtn = document.getElementById('call-btn');
                    const betInput = document.getElementById('bet-amt');
                    const raiseBtn = document.getElementById('raise-btn');
                    
                    // Show CHECK or CALL button based on whether there's a bet to call
                    if (data.callAmt > 0) {
                        checkBtn.style.display = 'none';
                        callBtn.style.display = 'block';
                        callBtn.innerText = "CALL " + data.callAmt;
                    } else {
                        checkBtn.style.display = 'block';
                        callBtn.style.display = 'none';
                    }
                    
                    // Calculate the max total bet (current bet + remaining chips)
                    const maxTotalBet = data.myBet + data.myChips;
                    
                    // Default to minimum raise, or max if player can't afford minimum
                    const defaultBetAmount = Math.min(data.minRaise, maxTotalBet);
                    
                    // Only reset input value when turn first starts (not on every update)
                    if (turnChanged && isMyTurn) {
                        betInput.value = defaultBetAmount;
                    }
                    
                    // Allow player to type any amount from minRaise up to their full stack
                    betInput.min = data.minRaise;
                    betInput.max = maxTotalBet;
                    
                    // Determine if button should say "BET" or "RAISE"
                    const actionWord = data.isBetSituation ? "BET" : "RAISE";
                    const currentBetValue = parseInt(betInput.value) || defaultBetAmount;
                    raiseBtn.innerText = actionWord + " TO " + currentBetValue;
                    
                    // Hide raise/bet button if can't make minimum raise
                    if (!data.canRaise) {
                        raiseBtn.style.display = 'none';
                    } else {
                        raiseBtn.style.display = 'block';
                    }
                    
                    // Update raise/bet button text on input change (allow manual override)
                    betInput.oninput = function() {
                        const val = parseInt(this.value) || 0;
                        raiseBtn.innerText = actionWord + " TO " + val;
                    };
                }
                
                renderSeats(data);
            });
            
            socket.on('activity_log', data => {
                const log = document.getElementById('activity-log');
                log.innerHTML += '<div>' + data.msg + '</div>';
                log.scrollTop = log.scrollHeight;
            });
            
            socket.on('winner_announcement', msg => {
                const announcement = document.getElementById('winner-announcement');
                announcement.innerText = msg;
            });
            
            socket.on('clear_winner', () => {
                const announcement = document.getElementById('winner-announcement');
                announcement.innerText = '';
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
