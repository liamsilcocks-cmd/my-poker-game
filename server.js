const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const ftp = require('basic-ftp');
const crypto = require('crypto'); // For cryptographically secure random numbers

// FTP configuration - set these as environment variables on Render
const FTP_HOST = process.env.FTP_HOST || '';
const FTP_USER = process.env.FTP_USER || '';
const FTP_PASS = process.env.FTP_PASS || '';
const FTP_REMOTE_DIR = process.env.FTP_REMOTE_DIR || '/poker-logs';

// Email configuration - set these as environment variables on Render
const EMAIL_USER = process.env.EMAIL_USER || ''; // Your email for sending
const EMAIL_PASS = process.env.EMAIL_PASS || ''; // Your email password or app password
const EMAIL_TO = 'crazy2106@hotmail.com'; // Your hotmail to receive logs
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || 'outlook'; // 'gmail' or 'outlook' or 'smtp'
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp-mail.outlook.com'; // SMTP host
const EMAIL_PORT = process.env.EMAIL_PORT || 587; // SMTP port

// Create email transporter
let emailTransporter = null;
if (EMAIL_USER && EMAIL_PASS) {
    emailTransporter = nodemailer.createTransport({
        host: EMAIL_HOST,
        port: EMAIL_PORT,
        secure: false, // true for 465, false for other ports
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });
    console.log('✉️ Email service configured');
} else {
    console.log('⚠️ Email not configured - set EMAIL_USER and EMAIL_PASS environment variables');
}

// Hand counter for email subjects
let handCounter = 0;

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Game logging
let gameLogFile = null;
let gameLogStream = null;

function getTimestamp() {
    const now = new Date();
    return now.toISOString().replace('T', ' ').substring(0, 19);
}

function initGameLog(roomNumber) {
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    gameLogFile = path.join(logsDir, `game-ROOM${roomNumber}-${timestamp}.log`);
    gameLogStream = fs.createWriteStream(gameLogFile, { flags: 'a' });
    
    gameLog('='.repeat(80));
    gameLog('POKER GAME SESSION STARTED');
    gameLog('='.repeat(80));
    gameLog(`Room Number: ${roomNumber}`);
    gameLog(`Session Started: ${getTimestamp()}`);
    gameLog('='.repeat(80));
    gameLog('');
}

function initHandLog(roomNumber, handNumber) {
    // Close previous hand's log if exists
    if (gameLogStream) {
        console.log(`📝 Closing previous hand log file`);
        gameLogStream.end();
    }
    
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    gameLogFile = path.join(logsDir, `game-ROOM${roomNumber}-hand-${handNumber.toString().padStart(3, '0')}-${timestamp}.log`);
    gameLogStream = fs.createWriteStream(gameLogFile, { flags: 'a' });
    
    console.log(`📝 Created NEW log file for hand #${handNumber}: ${path.basename(gameLogFile)}`);
    
    gameLog('='.repeat(80));
    gameLog(`POKER HAND #${handNumber} LOG`);
    gameLog('='.repeat(80));
    gameLog(`Room Number: ${roomNumber}`);
    gameLog(`Hand Number: ${handNumber}`);
    gameLog(`Timestamp: ${getTimestamp()}`);
    gameLog('='.repeat(80));
    gameLog('');
}

function gameLog(message) {
    const logLine = `[${getTimestamp()}] ${message}`;
    console.log(logLine); // Also log to console
    if (gameLogStream) {
        gameLogStream.write(logLine + '\n');
    }
}

function closeGameLog() {
    if (gameLogStream) {
        gameLog('');
        gameLog('='.repeat(80));
        gameLog('GAME SESSION ENDED');
        gameLog('='.repeat(80));
        gameLogStream.end();
        gameLogStream = null;
    }
}

async function emailHandLog(handNumber, roomNumber) {
    if (!emailTransporter || !gameLogFile) {
        console.log('Email not configured or no log file available');
        return;
    }

    try {
        // Read the current log file
        const logContent = fs.readFileSync(gameLogFile, 'utf8');
        
        const mailOptions = {
            from: EMAIL_USER,
            to: EMAIL_TO,
            subject: `Poker Log - Room ${roomNumber} - Hand #${handNumber} - ${new Date().toLocaleString()}`,
            text: `Hand #${handNumber} completed in Room ${roomNumber}\n\nSee attached log file for full details.`,
            html: `
                <h2>🃏 Poker Hand Log</h2>
                <p><strong>Room:</strong> ${roomNumber}</p>
                <p><strong>Hand Number:</strong> ${handNumber}</p>
                <p><strong>Timestamp:</strong> ${new Date().toLocaleString()}</p>
                <p>Complete game log is attached.</p>
                <hr>
                <p style="font-size: 12px; color: #666;">This is an automatic email sent after each completed hand for debugging purposes.</p>
            `,
            attachments: [
                {
                    filename: path.basename(gameLogFile),
                    content: logContent
                }
            ]
        };

        await emailTransporter.sendMail(mailOptions);
        console.log(`✉️ Hand #${handNumber} log emailed successfully to ${EMAIL_TO}`);
        gameLog(`EMAIL: Hand log sent to ${EMAIL_TO}`);
    } catch (error) {
        console.error('❌ Error sending email:', error.message);
        gameLog(`EMAIL ERROR: Failed to send log - ${error.message}`);
    }
}

async function uploadLogToFTP(handNumber, roomNumber) {
    if (!FTP_HOST || !FTP_USER || !FTP_PASS || !gameLogFile) {
        console.log('FTP not configured or no log file available');
        return;
    }

    console.log(`📤 Uploading hand #${handNumber} log file: ${path.basename(gameLogFile)}`);

    const client = new ftp.Client();
    client.ftp.verbose = false; // Set to true for debugging
    
    try {
        await client.access({
            host: FTP_HOST,
            user: FTP_USER,
            password: FTP_PASS,
            secure: false // Use true if your FTP supports FTPS
        });
        
        console.log(`📤 Connected to FTP server: ${FTP_HOST}`);
        
        // Create remote directory if it doesn't exist
        try {
            await client.ensureDir(FTP_REMOTE_DIR);
            console.log(`📁 Directory ensured: ${FTP_REMOTE_DIR}`);
        } catch (err) {
            console.log(`📁 Directory may already exist: ${FTP_REMOTE_DIR}`);
        }
        
        // Upload the log file
        const remoteFilePath = `${FTP_REMOTE_DIR}/${path.basename(gameLogFile)}`;
        await client.uploadFrom(gameLogFile, remoteFilePath);
        
        console.log(`✅ Hand #${handNumber} log uploaded to FTP: ${remoteFilePath}`);
        gameLog(`FTP UPLOAD: Log uploaded to ${FTP_HOST}${remoteFilePath}`);
        
    } catch (error) {
        console.error('❌ FTP upload error:', error.message);
        gameLog(`FTP ERROR: Failed to upload log - ${error.message}`);
    } finally {
        client.close();
    }
}

/*
 * TEXAS HOLD'EM NO LIMIT BETTING RULES (per TDA & standard poker rules)
 * 
 * MINIMUM BET:
 * - The minimum bet in any round equals the big blind (BB)
 * 
 * MINIMUM RAISE:
 * - Must raise by at least the size of the previous bet or raise in the current round
 * - Formula: minRaise = currentBet + lastRaiseIncrement
 * - Example: BB is 50, Player A bets 100 (increment of 100) → min raise is to 200 (100 + 100)
 * - Example: BB is 50, Player A raises to 100 (increment of 50) → min raise is to 150 (100 + 50)
 * 
 * PREFLOP SPECIAL CASE:
 * - BB posts 50 (this is the opening bet, not a raise)
 * - First raise must be to at least 100 (50 + 50), establishing increment of 50
 * - Next raise must be to at least 150 (100 + 50)
 * 
 * POSTFLOP:
 * - No bets yet, so lastRaiseIncrement = 0
 * - First bet must be at least BB (50)
 * - If someone bets 200, increment becomes 200
 * - Next raise must be to at least 400 (200 + 200)
 * 
 * INCOMPLETE RAISES (ALL-IN):
 * - Incomplete raise: All-in < minimum raise → does NOT reopen action
 * - The minimum raise for subsequent players is based on the LAST LEGAL BET, not the incomplete all-in
 * - Example: currentBet=100, increment=50, Player goes all-in for 120 (needs 150)
 *   → Next player: CALL 120 OR RAISE to 150+ (100 + 50, NOT 120 + 50)
 * 
 * IMPLEMENTATION:
 * - currentBet: The current highest bet in this round (what you must match to call)
 * - lastLegalBet: The last LEGAL bet (used for calculating min raise after incomplete raises)
 * - lastRaiseIncrement: The size of the last legal raise (0 if no raises yet)
 */

// --- CONFIG ---
let STARTING_CHIPS = 6000;

// Blind schedule: [SB, BB, durationMinutes]
const BLIND_SCHEDULE = [
    [25, 50, 5],
    [50, 100, 5],
    [100, 200, 5],
    [200, 400, 5],
    [300, 600, 3],
    [400, 800, 3],
    [500, 1000, 3],
    [600, 1200, 3],
    [800, 1600, 3],
    [1000, 2000, 3],
    [1500, 3000, 3],
    [2000, 4000, 3],
    [4000, 8000, 3],
    [6000, 12000, 3],
    [8000, 16000, 3],
    [10000, 20000, 3]
];

// --- STATE (Single game at a time, but room number is flexible) ---
let players = {};
let playerOrder = [];
let community = [];
let deck = [];
let pot = 0;
let currentBet = 0;
let lastLegalBet = 0;
let lastRaiseIncrement = 50;
let dealerIndex = -1; 
let turnIndex = 0;
let gameStage = 'LOBBY'; 
let gameStarted = false;
let playersActedThisRound = new Set();
let playersAllowedToReraise = new Set();
let turnTimer = null;
let turnTimeRemaining = 30;
let lastHandResults = [];
let SB = BLIND_SCHEDULE[0][0];
let BB = BLIND_SCHEDULE[0][1];
let blindLevel = 0;
let blindTimer = null;
let blindTimeRemaining = BLIND_SCHEDULE[0][2] * 60;
let currentRoomNumber = null; // Which room number is currently playing

const suits = ['♠','♥','♦','♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const rankValues = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

// Cryptographically secure random number generator (casino-grade)
// Returns a number between 0 and 1 using crypto.randomBytes
function secureRandom() {
    const randomBytes = crypto.randomBytes(4);
    const randomNumber = randomBytes.readUInt32BE(0);
    return randomNumber / 0x100000000; // Divide by 2^32 to get 0-1 range
}

function log(msg) { io.emit('debug_msg', msg); }
function activityLog(msg) { io.emit('activity_log', { msg }); }

function startBlindTimer() {
    if (blindTimer) clearInterval(blindTimer);
    
    blindTimer = setInterval(() => {
        blindTimeRemaining--;
        
        if (blindTimeRemaining <= 0) {
            // Move to next blind level
            if (blindLevel < BLIND_SCHEDULE.length - 1) {
                blindLevel++;
                const newBlinds = BLIND_SCHEDULE[blindLevel];
                SB = newBlinds[0];
                BB = newBlinds[1];
                blindTimeRemaining = newBlinds[2] * 60;
                
                log(`📈 BLINDS INCREASED! New blinds: ${SB}/${BB}`);
                activityLog(`Blinds increased to ${SB}/${BB}`);
                gameLog('');
                gameLog(`!!! BLIND LEVEL INCREASED !!!`);
                gameLog(`  New Blinds: ${SB}/${BB}`);
                gameLog(`  Level: ${blindLevel + 1}`);
                gameLog(`  Duration: ${newBlinds[2]} minutes`);
                gameLog('');
                
                broadcast();
            } else {
                // At max blind level, just reset timer
                blindTimeRemaining = BLIND_SCHEDULE[blindLevel][2] * 60;
            }
        }
        
        // Broadcast periodically to update timer display
        if (blindTimeRemaining % 10 === 0 || blindTimeRemaining <= 10) {
            broadcast();
        }
    }, 1000);
}

function stopBlindTimer() {
    if (blindTimer) {
        clearInterval(blindTimer);
        blindTimer = null;
    }
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}



function startTurnTimer() {
    if (turnTimer) clearInterval(turnTimer);
    turnTimeRemaining = 30;
    
    const currentPlayer = players[playerOrder[turnIndex]];
    if (currentPlayer && currentPlayer.autoFold) {
        log(`🤖 ${currentPlayer.name} has auto-fold enabled - folding immediately`);
        activityLog(`${currentPlayer.name} auto-folded`);
        
        currentPlayer.status = 'FOLDED';
        playersActedThisRound.add(playerOrder[turnIndex]);
        
        const playersInHand = playerOrder.filter(id => players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN');
        const playersCanAct = playerOrder.filter(id => players[id].status === 'ACTIVE');
        const onlyOneRemaining = playersInHand.length <= 1;
        const allActed = playersCanAct.every(id => playersActedThisRound.has(id));
        const allMatched = playersCanAct.every(id => players[id].bet === currentBet);

        if (onlyOneRemaining || (allActed && allMatched)) {
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
            
            log(`⏰ TIME OUT! ${currentPlayer.name} auto-folded`);
            activityLog(`${currentPlayer.name} timed out and folded`);
            
            currentPlayer.status = 'FOLDED';
            playersActedThisRound.add(playerOrder[turnIndex]);
            
            const playersInHand = playerOrder.filter(id => players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN');
            const playersCanAct = playerOrder.filter(id => players[id].status === 'ACTIVE');
            const onlyOneRemaining = playersInHand.length <= 1;
            const allActed = playersCanAct.every(id => playersActedThisRound.has(id));
            const allMatched = playersCanAct.every(id => players[id].bet === currentBet);

            if (onlyOneRemaining || (allActed && allMatched)) {
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
    
    // Fisher-Yates shuffle with CRYPTOGRAPHICALLY SECURE randomness (casino-grade)
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(secureRandom() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]]; // Swap
    }
    
    console.log('🎲 Deck shuffled using CRYPTOGRAPHICALLY SECURE randomness (crypto.randomBytes)');
    
    return d;
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
    
    if (isFlush && isStraight && values[0] === 14) {
        return { rank: 9, tiebreakers: [14], name: 'Royal Flush' };
    }
    if (isFlush && (isStraight || isLowStraight)) {
        return { rank: 8, tiebreakers: [isLowStraight ? 5 : values[0]], name: 'Straight Flush' };
    }
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
    if (isFlush) {
        return { rank: 5, tiebreakers: values, name: 'Flush' };
    }
    if (isStraight || isLowStraight) {
        return { rank: 4, tiebreakers: [isLowStraight ? 5 : values[0]], name: 'Straight' };
    }
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
    if (hand1.rank !== hand2.rank) {
        return hand1.rank > hand2.rank ? 1 : -1;
    }
    for (let i = 0; i < Math.max(hand1.tiebreakers.length, hand2.tiebreakers.length); i++) {
        const t1 = hand1.tiebreakers[i] || 0;
        const t2 = hand2.tiebreakers[i] || 0;
        if (t1 !== t2) {
            return t1 > t2 ? 1 : -1;
        }
    }
    return 0;
}

function getPlayersInHand() {
    return playerOrder.filter(id => (players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN') && players[id].hand.length > 0);
}

function checkGameOver() {
    // Check if only one player has chips remaining
    const playersWithChips = playerOrder.filter(id => players[id].chips > 0);
    if (playersWithChips.length === 1) {
        gameStage = 'GAME_OVER';
        log(`🏆 GAME OVER! ${players[playersWithChips[0]].name} wins!`);
        activityLog(`🏆 GAME OVER! ${players[playersWithChips[0]].name} has all the chips!`);
        broadcast();
        return true;
    }
    return false;
}

function startNewHand() {
    io.emit('clear_winner');
    lastHandResults = []; // Clear previous hand results
    
    // Increment hand counter
    handCounter++;
    
    // Create new log file for this hand
    if (currentRoomNumber) {
        initHandLog(currentRoomNumber, handCounter);
    }
    
    // Start blind timer on first hand
    if (!blindTimer && !gameStarted) {
        startBlindTimer();
        log(`⏰ Blind timer started at level ${blindLevel + 1}: ${SB}/${BB}`);
    }
    
    community = []; 
    pot = 0; 
    currentBet = BB; 
    lastLegalBet = BB; // BB is the opening bet
    lastRaiseIncrement = 0; // No raises yet, only the BB post
    playersActedThisRound.clear();
    playersAllowedToReraise.clear();
    gameStarted = true;
    
    const active = playerOrder.filter(id => players[id].chips > 0);
    if (active.length < 2) {
        log('⚠️ Not enough players with chips to start hand');
        checkGameOver();
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
    
    // Log hand start with all hole cards
    gameLog('');
    gameLog('*'.repeat(80));
    gameLog(`HAND START - Dealer: ${players[playerOrder[dealerIndex]].name}`);
    gameLog('*'.repeat(80));
    gameLog('HOLE CARDS DEALT:');
    active.forEach(id => {
        gameLog(`  ${players[id].name}: ${players[id].hand.join(' ')}`);
    });
    gameLog('');
    
    const sbIdx = (dealerIndex + 1) % playerOrder.length;
    const bbIdx = (dealerIndex + 2) % playerOrder.length;
    
    const sbPlayer = playerOrder[sbIdx];
    const bbPlayer = playerOrder[bbIdx];
    
    const sbAmount = Math.min(SB, players[sbPlayer].chips);
    const bbAmount = Math.min(BB, players[bbPlayer].chips);
    
    players[sbPlayer].chips -= sbAmount; players[sbPlayer].bet = sbAmount;
    players[bbPlayer].chips -= bbAmount; players[bbPlayer].bet = bbAmount;
    pot = sbAmount + bbAmount;
    
    gameLog(`BLINDS POSTED:`);
    gameLog(`  Small Blind: ${players[sbPlayer].name} posts ${sbAmount} (${players[sbPlayer].chips} chips remaining)`);
    gameLog(`  Big Blind: ${players[bbPlayer].name} posts ${bbAmount} (${players[bbPlayer].chips} chips remaining)`);
    gameLog(`  Pot: ${pot}`);
    gameLog('');
    
    if (players[sbPlayer].chips === 0) players[sbPlayer].status = 'ALL_IN';
    if (players[bbPlayer].chips === 0) players[bbPlayer].status = 'ALL_IN';
    
    log(`🃏 NEW HAND STARTED`);
    log(`👑 Dealer: ${players[playerOrder[dealerIndex]].name}`);
    log(`💵 SB: ${players[sbPlayer].name} posts ${sbAmount}`);
    log(`💵 BB: ${players[bbPlayer].name} posts ${bbAmount}`);
    log(`📊 Initial: currentBet=${currentBet}, lastLegalBet=${lastLegalBet}, lastRaiseInc=${lastRaiseIncrement}, minRaise=${currentBet + BB}`);
    
    turnIndex = (dealerIndex + 3) % playerOrder.length;
    gameStage = 'PREFLOP';
    activityLog("--- NEW HAND ---");
    activityLog(`Dealer: ${players[playerOrder[dealerIndex]].name}`);
    activityLog(`SB ${sbAmount}, BB ${bbAmount}`);
    
    active.forEach(id => {
        if (players[id].status === 'ACTIVE') {
            playersAllowedToReraise.add(id);
        }
    });
    
    // Check if only one or zero players can act after blinds
    const playersCanAct = playerOrder.filter(id => players[id].status === 'ACTIVE');
    if (playersCanAct.length <= 1) {
        log(`🔥 Only ${playersCanAct.length} player(s) can act after blinds, dealing to showdown...`);
        activityLog(`All players all-in after blinds, dealing to showdown`);
        broadcast();
        
        setTimeout(() => {
            advanceStage();
        }, 2000);
        return;
    }
    
    startTurnTimer();
    broadcast();
}

function handleAction(socket, action) {
    if (playerOrder[turnIndex] !== socket.id) {
        log(`⚠️ Action rejected: not ${socket.id}'s turn`);
        socket.emit('action_rejected', 'Not your turn');
        return;
    }
    const p = players[socket.id];
    
    if (!p || p.status !== 'ACTIVE') {
        log(`⚠️ Action rejected: ${socket.id} is not active`);
        socket.emit('action_rejected', 'You are not active in this hand');
        return;
    }
    
    playersActedThisRound.add(socket.id);
    
    if (action.type === 'fold') {
        p.status = 'FOLDED';
        log(`🚫 ${p.name} FOLDED`);
        activityLog(`${p.name} folded (pot was at ${currentBet})`);
        gameLog(`ACTION: ${p.name} FOLDS (Pot: ${pot})`);
        
    } else if (action.type === 'call') {
        const amtToCall = currentBet - p.bet;
        const actualAmt = Math.min(amtToCall, p.chips);
        p.chips -= actualAmt; 
        p.bet += actualAmt; 
        pot += actualAmt;
        
        if (amtToCall === 0) {
            log(`✓ ${p.name} CHECKED`);
            activityLog(`${p.name} checked`);
            gameLog(`ACTION: ${p.name} CHECKS`);
        } else {
            log(`📞 ${p.name} CALLED ${actualAmt} (total bet: ${p.bet}, to match ${currentBet})`);
            activityLog(`${p.name} called ${actualAmt} (total in pot: ${p.bet})`);
            gameLog(`ACTION: ${p.name} CALLS ${actualAmt} (Total bet: ${p.bet}, Chips remaining: ${p.chips}, Pot: ${pot})`);
        }
        
        if (p.chips === 0) {
            p.status = 'ALL_IN';
            log(`🔥 ${p.name} is ALL IN!`);
            activityLog(`${p.name} is ALL IN with ${p.bet}!`);
            gameLog(`  >> ${p.name} is ALL-IN!`);
        }
        
    } else if (action.type === 'raise' || action.type === 'allin') {
        const isAllIn = (action.type === 'allin');
        const targetTotal = isAllIn ? (p.bet + p.chips) : action.amt;
        const amountToAdd = targetTotal - p.bet;
        const actualAmountToAdd = Math.min(amountToAdd, p.chips);
        
        // CRITICAL: Store currentBet BEFORE we update anything
        const previousCurrentBet = currentBet;
        
        log(`💰 ${p.name} attempting ${isAllIn ? 'ALL-IN' : 'RAISE'} to ${targetTotal} (adding ${actualAmountToAdd})`);
        log(`📊 BEFORE: currentBet=${currentBet}, lastLegalBet=${lastLegalBet}, lastRaiseInc=${lastRaiseIncrement}`);
        
        p.chips -= actualAmountToAdd;
        p.bet += actualAmountToAdd;
        pot += actualAmountToAdd;
        
        // Calculate minimum raise
        let minRaiseTotal;
        if (lastRaiseIncrement === 0) {
            minRaiseTotal = currentBet + BB;
        } else {
            minRaiseTotal = lastLegalBet + lastRaiseIncrement;
        }
        
        log(`📊 Player bet=${p.bet}, minRaiseTotal=${minRaiseTotal}, chips left=${p.chips}`);
        
        if (p.bet >= minRaiseTotal || p.chips === 0) {
            // LEGAL RAISE or ALL-IN (always allowed)
            if (p.chips === 0) p.status = 'ALL_IN';
            
            if (p.bet >= minRaiseTotal) {
                // COMPLETE RAISE - reopens action
                // CRITICAL: Calculate increment from PREVIOUS currentBet
                const raiseIncrement = p.bet - previousCurrentBet;
                lastRaiseIncrement = raiseIncrement;
                lastLegalBet = p.bet;
                currentBet = p.bet;
                
                playersActedThisRound.clear();
                playersActedThisRound.add(socket.id);
                playersAllowedToReraise = new Set(playerOrder.filter(id => players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN'));
                
                log(`✅ COMPLETE RAISE to ${p.bet} (increment of ${raiseIncrement}) - ACTION REOPENED`);
                log(`📊 AFTER: currentBet=${currentBet}, lastLegalBet=${lastLegalBet}, lastRaiseInc=${lastRaiseIncrement}`);
                activityLog(`${p.name} ${p.chips === 0 ? 'all-in' : 'raised'} to ${p.bet} (raise of ${raiseIncrement})`);
                gameLog(`ACTION: ${p.name} RAISES to ${p.bet} (Raise amount: ${raiseIncrement}, Chips remaining: ${p.chips}, Pot: ${pot})`);
                if (p.chips === 0) {
                    gameLog(`  >> ${p.name} is ALL-IN!`);
                }
            } else {
                // INCOMPLETE RAISE (all-in but < minimum) - does NOT reopen action
                currentBet = p.bet; // Players must call this amount
                // lastLegalBet and lastRaiseIncrement stay UNCHANGED
                
                log(`⚠️ INCOMPLETE RAISE to ${p.bet} (needed ${minRaiseTotal}) - BETTING CAPPED`);
                log(`📊 AFTER: currentBet=${currentBet}, lastLegalBet=${lastLegalBet}, lastRaiseInc=${lastRaiseIncrement}`);
                activityLog(`${p.name} all-in ${p.bet} (under-raise, betting capped)`);
                gameLog(`ACTION: ${p.name} ALL-IN (INCOMPLETE RAISE) to ${p.bet} (Needed: ${minRaiseTotal}, Pot: ${pot})`);
            }
        } else {
            // INVALID - shouldn't happen with client validation, treat as call
            log(`❌ INVALID RAISE attempt to ${p.bet}, needed ${minRaiseTotal} - treating as CALL`);
            
            // Refund and convert to call
            p.chips += actualAmountToAdd;
            p.bet -= actualAmountToAdd;
            pot -= actualAmountToAdd;
            
            const callAmount = currentBet - p.bet;
            const actualCall = Math.min(callAmount, p.chips);
            p.chips -= actualCall;
            p.bet += actualCall;
            pot += actualCall;
            
            if (p.chips === 0) p.status = 'ALL_IN';
            activityLog(`${p.name} called ${actualCall}`);
        }
    }
    
    // Players still in the hand (can win pot)
    const playersInHand = playerOrder.filter(id => 
        players[id].status === 'ACTIVE' || players[id].status === 'ALL_IN'
    );
    
    // Players who can still make actions
    const playersCanAct = playerOrder.filter(id => players[id].status === 'ACTIVE');
    
    // Check if betting round should end
    const onlyOneRemaining = playersInHand.length <= 1;
    const allActed = playersCanAct.every(id => playersActedThisRound.has(id));
    const allMatched = playersCanAct.every(id => players[id].bet === currentBet);
    const onlyOneCanAct = playersCanAct.length <= 1; // If only one or zero players can act, no more betting

    log(`📊 Round status: ${playersInHand.length} in hand (${playersCanAct.length} can act), all acted: ${allActed}, all matched: ${allMatched}, only one can act: ${onlyOneCanAct}`);

    if (onlyOneRemaining || (allActed && allMatched) || onlyOneCanAct) {
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
    
    // Reset for new betting round
    currentBet = 0;
    lastLegalBet = 0; // No bets yet in this round
    lastRaiseIncrement = 0; // No raises yet
    
    log(`📊 Betting reset: currentBet=0, lastLegalBet=0, lastRaiseInc=0 (first bet must be ≥BB)`);
    playersActedThisRound.clear();
    playersAllowedToReraise.clear();
    
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
        gameLog('');
        gameLog(`--- FLOP: ${community.join(' ')} ---`);
        gameLog('');
    }
    else if (gameStage === 'FLOP') { 
        community.push(deck.pop()); 
        gameStage = 'TURN'; 
        log(`🃏 TURN: ${community[3]}`);
        activityLog(`--- TURN: ${community[3]} ---`);
        gameLog('');
        gameLog(`--- TURN: ${community[3]} (Board: ${community.join(' ')}) ---`);
        gameLog('');
    }
    else if (gameStage === 'TURN') { 
        community.push(deck.pop()); 
        gameStage = 'RIVER'; 
        log(`🃏 RIVER: ${community[4]}`);
        activityLog(`--- RIVER: ${community[4]} ---`);
        gameLog('');
        gameLog(`--- RIVER: ${community[4]} (Final Board: ${community.join(' ')}) ---`);
        gameLog('');
    }
    else return showdown();

    // Check if there are any ACTIVE players who can act
    const activePlayers = playerOrder.filter(id => players[id].status === 'ACTIVE');
    
    if (activePlayers.length === 0) {
        // All players are all-in, deal remaining cards immediately
        log(`🔥 All players are all-in, dealing remaining cards...`);
        activityLog(`All players all-in, dealing to showdown`);
        broadcast();
        
        // Continue to next stage after a short delay
        setTimeout(() => {
            advanceStage();
        }, 2000);
        return;
    } else if (activePlayers.length === 1 && currentBet > 0) {
        // Only one active player left and there's a bet to call
        // Check if that player has already matched the bet
        const lastActivePlayer = players[activePlayers[0]];
        if (lastActivePlayer.bet >= currentBet) {
            // Player has matched, no action needed
            log(`🔥 Only one active player left who has matched bet, dealing to showdown...`);
            activityLog(`Only one player can act, dealing to showdown`);
            broadcast();
            
            setTimeout(() => {
                advanceStage();
            }, 2000);
            return;
        }
    }

    // Find next active player to act
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
    gameLog('');
    gameLog('='.repeat(80));
    gameLog('SHOWDOWN');
    gameLog('='.repeat(80));
    gameLog(`Final Board: ${community.join(' ')}`);
    gameLog('');
    
    const inHand = getPlayersInHand();
    
    if (inHand.length === 1) {
        const winnerId = inHand[0];
        players[winnerId].chips += pot;
        log(`🏆 ${players[winnerId].name} wins ${pot} (all others folded)`);
        activityLog(`🏆 ${players[winnerId].name} wins ${pot} (all others folded)`);
        gameLog(`WINNER: ${players[winnerId].name} wins ${pot} (all others folded)`);
        gameLog(`  Cards: ${players[winnerId].hand.join(' ')}`);
        gameLog(`  New chip count: ${players[winnerId].chips}`);
        gameLog('');
        
        io.emit('winner_announcement', `${players[winnerId].name} wins ${pot}`);
        
        // Store result for ALL players
        lastHandResults = playerOrder.map(id => ({
            playerId: id,
            playerName: players[id].name,
            hand: players[id].hand,
            bestHand: null,
            wonAmount: id === winnerId ? pot : 0,
            status: players[id].status
        }));
        
        gameLog(`HAND #${handCounter} COMPLETE`);
        gameLog('');
        
        // Close this hand's log file
        if (gameLogStream) {
            gameLogStream.end();
            gameLogStream = null;
        }
        
        // Upload log to FTP after this hand
        uploadLogToFTP(handCounter, currentRoomNumber);
        
        broadcast();
        checkGameOver();
        return;
    }
    
    const evaluatedPlayers = inHand.map(id => {
        const sevenCards = [...players[id].hand, ...community];
        const bestHand = findBestHand(sevenCards);
        log(`👤 ${players[id].name}: ${players[id].hand.join(' ')}`);
        log(`   Best hand: ${bestHand.name} (${bestHand.cards.join(' ')})`);
        return { id, bestHand, amountInPot: players[id].bet };
    });
    
    gameLog('PLAYER HANDS:');
    inHand.forEach(id => {
        const evaluated = evaluatedPlayers.find(ep => ep.id === id);
        gameLog(`  ${players[id].name}:`);
        gameLog(`    Hole Cards: ${players[id].hand.join(' ')}`);
        gameLog(`    Best Hand: ${evaluated.bestHand.name}`);
        gameLog(`    Hand Cards: ${evaluated.bestHand.cards.join(' ')}`);
        gameLog(`    Amount in pot: ${players[id].bet}`);
    });
    gameLog('');
    
    const allContributions = playerOrder.map(id => ({
        id, amount: players[id].bet, inHand: inHand.includes(id)
    })).filter(p => p.amount > 0);
    
    const uniqueAmounts = [...new Set(allContributions.map(p => p.amount))].sort((a, b) => a - b);
    const sidePots = [];
    let previousAmount = 0;
    
    uniqueAmounts.forEach(amount => {
        const increment = amount - previousAmount;
        const contributors = allContributions.filter(p => p.amount >= amount);
        const potSize = increment * contributors.length;
        const eligiblePlayers = contributors.filter(p => p.inHand).map(p => p.id);
        
        if (potSize > 0 && eligiblePlayers.length > 0) {
            sidePots.push({ amount: potSize, eligiblePlayers: eligiblePlayers });
        }
        previousAmount = amount;
    });
    
    if (sidePots.length === 0) {
        sidePots.push({ amount: pot, eligiblePlayers: inHand });
    }
    
    log(`💰 SIDE POTS: ${sidePots.length} pot(s)`);
    let winnerAnnouncement = '';
    
    // Store results for display - initialize with ALL players
    lastHandResults = [];
    const wonAmounts = {};
    
    for (let potIndex = sidePots.length - 1; potIndex >= 0; potIndex--) {
        const sidePot = sidePots[potIndex];
        const eligibleHands = evaluatedPlayers.filter(ep => sidePot.eligiblePlayers.includes(ep.id));
        if (eligibleHands.length === 0) continue;
        
        eligibleHands.sort((a, b) => compareHands(b.bestHand, a.bestHand));
        const winners = [eligibleHands[0]];
        for (let i = 1; i < eligibleHands.length; i++) {
            if (compareHands(eligibleHands[i].bestHand, winners[0].bestHand) === 0) {
                winners.push(eligibleHands[i]);
            }
        }
        
        const winAmt = Math.floor(sidePot.amount / winners.length);
        const potLabel = sidePots.length > 1 ? `Pot ${potIndex + 1}` : 'Main Pot';
        
        winners.forEach(w => {
            players[w.id].chips += winAmt;
            wonAmounts[w.id] = (wonAmounts[w.id] || 0) + winAmt;
            log(`🏆 ${potLabel}: ${players[w.id].name} wins ${winAmt} with ${w.bestHand.name}`);
            activityLog(`🏆 ${players[w.id].name} wins ${winAmt} with ${w.bestHand.name}`);
            gameLog(`${potLabel} WINNER: ${players[w.id].name} wins ${winAmt} with ${w.bestHand.name}`);
            gameLog(`  New chip count: ${players[w.id].chips}`);
            if (winnerAnnouncement) winnerAnnouncement += ' | ';
            winnerAnnouncement += `${players[w.id].name}: ${winAmt} (${w.bestHand.name})`;
        });
    }
    
    gameLog('');
    gameLog('FINAL CHIP COUNTS:');
    playerOrder.forEach(id => {
        gameLog(`  ${players[id].name}: ${players[id].chips} chips`);
    });
    gameLog('='.repeat(80));
    gameLog('');
    
    // Add ALL players to results
    playerOrder.forEach(id => {
        const playerData = {
            playerId: id,
            playerName: players[id].name,
            hand: players[id].hand,
            bestHand: null,
            wonAmount: wonAmounts[id] || 0,
            status: players[id].status
        };
        
        // If player was in hand, add their evaluated hand
        const evaluated = evaluatedPlayers.find(ep => ep.id === id);
        if (evaluated) {
            playerData.bestHand = evaluated.bestHand;
        }
        
        lastHandResults.push(playerData);
    });
    
    // Sort results: winners first (by hand rank), then losers (by hand rank), then folded players
    lastHandResults.sort((a, b) => {
        // Winners at top
        if (a.wonAmount > 0 && b.wonAmount === 0) return -1;
        if (a.wonAmount === 0 && b.wonAmount > 0) return 1;
        
        // Among winners or losers, sort by hand rank
        if (a.bestHand && b.bestHand) {
            return compareHands(b.bestHand, a.bestHand);
        }
        
        // Folded/out players at bottom
        if (!a.bestHand && b.bestHand) return 1;
        if (a.bestHand && !b.bestHand) return -1;
        
        return 0;
    });
    
    gameLog(`HAND #${handCounter} COMPLETE`);
    gameLog('');
    
    // Close this hand's log file
    if (gameLogStream) {
        gameLogStream.end();
        gameLogStream = null;
    }
    
    // Upload log to FTP after this hand
    uploadLogToFTP(handCounter, currentRoomNumber);
    
    io.emit('winner_announcement', winnerAnnouncement);
    broadcast();
    checkGameOver();
}

function broadcast() {
    const sbIdx = (dealerIndex + 1) % playerOrder.length;
    const bbIdx = (dealerIndex + 2) % playerOrder.length;

    // Log global state for debugging
    log(`🔍 BROADCAST: currentBet=${currentBet}, lastLegalBet=${lastLegalBet}, lastRaiseInc=${lastRaiseIncrement}, gameStage=${gameStage}`);

    playerOrder.forEach(id => {
        const myChips = players[id].chips;
        const myBet = players[id].bet;
        
        // Calculate minimum raise - ALWAYS fresh from global state
        let minRaiseTotal;
        
        if (currentBet === 0) {
            // No bets yet this round - minimum is BB
            minRaiseTotal = BB;
            log(`🔍 ${players[id].name}: No bets yet, minRaise = BB = ${BB}`);
        } else if (lastRaiseIncrement === 0) {
            // Opening bet posted (like BB preflop), no raises yet
            minRaiseTotal = currentBet + BB;
            log(`🔍 ${players[id].name}: Opening bet ${currentBet}, minRaise = ${currentBet} + ${BB} = ${minRaiseTotal}`);
        } else {
            // There was a raise, must match the increment
            minRaiseTotal = lastLegalBet + lastRaiseIncrement;
            log(`🔍 ${players[id].name}: After raise, minRaise = ${lastLegalBet} + ${lastRaiseIncrement} = ${minRaiseTotal}`);
        }
        
        const maxTotalBet = myBet + myChips;
        const canRaise = maxTotalBet >= minRaiseTotal;
        
        const isBetSituation = (currentBet === 0);
        
        if (playerOrder[turnIndex] === id && gameStage !== 'SHOWDOWN' && gameStage !== 'LOBBY' && gameStage !== 'GAME_OVER') {
            log(`💰 ${players[id].name}'s turn: CB=${currentBet}, LLB=${lastLegalBet}, LRI=${lastRaiseIncrement}, minR=${minRaiseTotal}, isBet=${isBetSituation}`);
        }
        
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
                cards: (pid === id || gameStage === 'SHOWDOWN') ? players[pid].hand : 
                       (players[pid].hand.length && players[pid].status !== 'FOLDED' ? ['?','?'] : []),
                autoFold: players[pid].autoFold
            })),
            community, 
            pot, 
            gameStage, 
            activeId: playerOrder[turnIndex], 
            currentBet, 
            SB, 
            BB,
            myBet: myBet,
            callAmt: currentBet - myBet,
            minRaise: minRaiseTotal,
            canRaise: canRaise,
            myChips: myChips,
            isBetSituation: isBetSituation,
            timeRemaining: turnTimeRemaining,
            handResults: lastHandResults,
            lastCommunity: community, // Include community cards for hand results display
            blindLevel: blindLevel + 1, // Display as 1-indexed
            blindTimeRemaining: blindTimeRemaining,
            nextBlinds: blindLevel < BLIND_SCHEDULE.length - 1 ? 
                `${BLIND_SCHEDULE[blindLevel + 1][0]}/${BLIND_SCHEDULE[blindLevel + 1][1]}` : 
                'MAX',
            roomNumber: currentRoomNumber
        });
    });
}

io.on('connection', (socket) => {
    socket.on('join', (data) => {
        const name = data.name || 'Guest';
        const roomNumber = data.roomNumber || '1234';
        
        // If no game exists, this player creates it with their room number
        if (playerOrder.length === 0) {
            currentRoomNumber = roomNumber;
            handCounter = 0; // Reset hand counter for new game
            log(`🎮 Room ${roomNumber} created by ${name}`);
        }
        
        // If a game exists with a different room number, reject
        if (currentRoomNumber && currentRoomNumber !== roomNumber) {
            socket.emit('join_rejected', `Room ${currentRoomNumber} is currently playing. Please use room number "${currentRoomNumber}" to join, or wait until that game ends.`);
            log(`⛔ ${name} tried to join room ${roomNumber} but room ${currentRoomNumber} is active`);
            gameLog(`REJECTED: ${name} attempted to join with wrong room number (${roomNumber})`);
            return;
        }
        
        // Check if game already started
        if (gameStarted) {
            socket.emit('join_rejected', 'Game already in progress. Please wait for the next game.');
            log(`⛔ ${name} tried to join but game is in progress`);
            gameLog(`REJECTED: ${name} attempted to join game in progress`);
            return;
        }
        
        // Successfully join
        players[socket.id] = { name, chips: STARTING_CHIPS, hand: [], bet: 0, status: 'ACTIVE', autoFold: false };
        playerOrder.push(socket.id);
        
        const isFirstPlayer = playerOrder.length === 1;
        log(`➕ ${name} ${isFirstPlayer ? 'created' : 'joined'} room ${roomNumber} (${playerOrder.length} players total)`);
        activityLog(`${name} joined the table`);
        gameLog(`PLAYER JOINED: ${name} (Total players: ${playerOrder.length}, Starting chips: ${STARTING_CHIPS})`);
        gameStage = 'LOBBY';
        
        if (isFirstPlayer) {
            socket.emit('first_player_message', "You're the host! Wait for players, then click START GAME.");
        } else {
            socket.emit('first_player_message', `Joined room ${roomNumber}! Waiting for host to start...`);
        }
        
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
    
    socket.on('new_game', () => {
        if (playerOrder[0] === socket.id) {
            log(`🔄 New game started by ${players[socket.id].name}`);
            activityLog(`New game started`);
            
            // Stop and reset blind timer
            stopBlindTimer();
            blindLevel = 0;
            blindTimeRemaining = BLIND_SCHEDULE[0][2] * 60;
            SB = BLIND_SCHEDULE[0][0];
            BB = BLIND_SCHEDULE[0][1];
            
            // Reset all player chips
            playerOrder.forEach(id => {
                players[id].chips = STARTING_CHIPS;
                players[id].status = 'ACTIVE';
                players[id].bet = 0;
                players[id].hand = [];
            });
            
            gameStarted = false;
            gameStage = 'LOBBY';
            dealerIndex = -1;
            lastHandResults = [];
            
            broadcast();
        }
    });
    
    socket.on('reset_engine', () => { 
        if(playerOrder[0] === socket.id) { 
            log(`🔄 Game reset by ${players[socket.id].name}`);
            stopBlindTimer();
            stopTurnTimer();
            players={}; 
            playerOrder=[];
            gameStarted = false;
            lastHandResults = [];
            currentRoomNumber = null;
            blindLevel = 0;
            blindTimeRemaining = BLIND_SCHEDULE[0][2] * 60;
            SB = BLIND_SCHEDULE[0][0];
            BB = BLIND_SCHEDULE[0][1];
            io.emit('force_refresh'); 
        } 
    });
    
    socket.on('disconnect', () => { 
        if (players[socket.id]) {
            log(`➖ ${players[socket.id].name} disconnected`);
            activityLog(`${players[socket.id].name} left the table`);
            gameLog(`PLAYER DISCONNECTED: ${players[socket.id].name} (Chips: ${players[socket.id].chips})`);
        }
        delete players[socket.id]; 
        playerOrder = playerOrder.filter(id => id !== socket.id);
        
        // If everyone left, reset the room so a new group can use any room number
        if (playerOrder.length === 0) {
            log(`🔄 Room ${currentRoomNumber} is now empty - server available for new games`);
            gameLog('');
            gameLog('ALL PLAYERS LEFT - GAME SESSION ENDING');
            closeGameLog();
            stopBlindTimer();
            stopTurnTimer();
            currentRoomNumber = null;
            gameStarted = false;
            gameStage = 'LOBBY';
            blindLevel = 0;
            blindTimeRemaining = BLIND_SCHEDULE[0][2] * 60;
            SB = BLIND_SCHEDULE[0][0];
            BB = BLIND_SCHEDULE[0][1];
            lastHandResults = [];
        } else {
            broadcast();
        }
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
                position: absolute;
                left: 8px;
                display: flex;
                flex-direction: column;
                align-items: flex-start;
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
                    font-size: 16px;
                }
                #blind-timer {
                    font-size: 12px !important;
                }
                #next-blinds {
                    font-size: 10px !important;
                }
                #room-display {
                    font-size: 14px !important;
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
            
            #first-player-message {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(46, 204, 113, 0.95);
                color: white;
                padding: 30px 50px;
                border-radius: 12px;
                font-size: 24px;
                font-weight: bold;
                z-index: 300;
                display: none;
                text-align: center;
                box-shadow: 0 0 30px rgba(46, 204, 113, 0.8);
                border: 3px solid #27ae60;
            }
            
            /* Login Screen */
            #login-screen {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.95);
                z-index: 400;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }
            #login-box {
                background: #111;
                border: 3px solid #f39c12;
                border-radius: 12px;
                padding: 30px;
                max-width: 400px;
                width: 100%;
                box-shadow: 0 0 30px rgba(243, 156, 18, 0.6);
            }
            #login-box h1 {
                font-size: 32px;
                text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
            }
            #login-form input:focus {
                outline: none;
                border-color: #f39c12;
            }
            #login-form button:hover {
                background: #27ae60;
            }
            #login-form button:active {
                transform: scale(0.98);
            }
            
            @media (max-width: 480px) {
                #login-box {
                    padding: 20px;
                }
                #login-box h1 {
                    font-size: 24px;
                    margin-bottom: 15px !important;
                }
                #login-form input {
                    padding: 8px !important;
                    font-size: 14px !important;
                }
                #login-form button {
                    padding: 12px !important;
                    font-size: 16px !important;
                }
            }
            
            /* Hand Results Panel */
            #hand-results {
                position: fixed;
                top: 80px;
                left: 10px;
                width: 260px;
                max-height: 70vh;
                background: rgba(0,0,0,0.95);
                border: 2px solid #f39c12;
                border-radius: 8px;
                padding: 10px;
                z-index: 150;
                display: none;
                overflow-y: auto;
            }
            #hand-results h3 {
                margin: 0 0 10px 0;
                color: #f39c12;
                font-size: 14px;
                text-align: center;
                border-bottom: 1px solid #f39c12;
                padding-bottom: 5px;
            }
            #hand-results-community {
                background: rgba(26, 92, 26, 0.4);
                border: 1px solid #4d260a;
                border-radius: 6px;
                padding: 8px;
                margin-bottom: 10px;
                text-align: center;
            }
            #hand-results-community .label {
                font-size: 10px;
                color: #888;
                margin-bottom: 5px;
            }
            #hand-results-community .cards {
                display: flex;
                gap: 3px;
                justify-content: center;
                flex-wrap: wrap;
            }
            .hand-result-item {
                background: rgba(255,255,255,0.05);
                border-radius: 4px;
                padding: 8px;
                margin-bottom: 8px;
                border-left: 3px solid #2ecc71;
            }
            .hand-result-item.loser {
                border-left-color: #e74c3c;
            }
            .hand-result-item.folded {
                border-left-color: #95a5a6;
                opacity: 0.6;
            }
            .hand-result-name {
                font-weight: bold;
                color: #f1c40f;
                font-size: 13px;
                margin-bottom: 4px;
            }
            .hand-result-hand {
                font-size: 11px;
                color: #aaa;
                margin-bottom: 3px;
            }
            .hand-result-cards {
                display: flex;
                gap: 3px;
                margin-bottom: 4px;
                flex-wrap: wrap;
            }
            .hand-result-card {
                background: white;
                color: black;
                border-radius: 4px;
                padding: 4px 6px;
                font-size: 13px;
                font-weight: bold;
                min-width: 28px;
                text-align: center;
                border: 1px solid #000;
            }
            .hand-result-card.red {
                color: #d63031;
            }
            .hand-result-amount {
                color: #2ecc71;
                font-weight: bold;
                font-size: 12px;
            }
            .hand-result-odds {
                color: #3498db;
                font-size: 10px;
                font-style: italic;
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
            .you-label {
                position: absolute;
                top: -18px;
                left: 50%;
                transform: translateX(-50%);
                background: #2ecc71;
                color: white;
                padding: 2px 8px;
                border-radius: 3px;
                font-size: 9px;
                font-weight: bold;
                z-index: 21;
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
            <div id="blinds-overlay">
                <div style="font-size: 20px;">Blinds: <span id="blinds-info">--/--</span></div>
                <div id="blind-timer" style="font-size: 14px; color: #3498db; margin-top: 2px;">
                    Level <span id="blind-level">1</span> | <span id="blind-time">5:00</span>
                </div>
                <div id="next-blinds" style="font-size: 12px; color: #95a5a6; margin-top: 2px;">
                    Next: <span id="next-blinds-value">50/100</span>
                </div>
            </div>
            <div id="pot-display">Pot: <span id="pot">0</span></div>
            <div id="room-display" style="position: absolute; right: 8px; font-size: 16px; color: #95a5a6;">
                Room: <span id="room-number">--</span>
            </div>
        </div>
        
        <div id="first-player-message"></div>
        
        <!-- Login Screen -->
        <div id="login-screen">
            <div id="login-box">
                <h1 style="margin: 0 0 20px 0; color: #f39c12; text-align: center;">SYFM POKER</h1>
                <form id="login-form">
                    <div style="margin-bottom: 15px;">
                        <label for="player-name" style="display: block; margin-bottom: 5px; color: #aaa; font-size: 14px;">Your Name</label>
                        <input type="text" id="player-name" required maxlength="20" autofocus
                            style="width: 100%; padding: 10px; font-size: 16px; border: 2px solid #444; border-radius: 4px; background: #222; color: white;">
                    </div>
                    <div style="margin-bottom: 20px;">
                        <label for="room-number" style="display: block; margin-bottom: 5px; color: #aaa; font-size: 14px;">Game Room Number</label>
                        <input type="text" id="room-number-input" required value="1234" maxlength="10"
                            style="width: 100%; padding: 10px; font-size: 16px; border: 2px solid #444; border-radius: 4px; background: #222; color: white;">
                        <div style="font-size: 12px; color: #888; margin-top: 5px;">Enter a number to create or join a game</div>
                    </div>
                    <button type="submit" style="width: 100%; padding: 15px; font-size: 18px; font-weight: bold; background: #2ecc71; color: white; border: none; border-radius: 4px; cursor: pointer;">
                        CREATE / JOIN GAME
                    </button>
                </form>
            </div>
        </div>
        
        <button id="fullscreen-btn" class="tool-btn" onclick="toggleFullscreen()">FULLSCREEN</button>
        
        <div id="turn-timer-display"></div>
        
        <!-- Hand Results Panel -->
        <div id="hand-results">
            <h3>🏆 LAST HAND RESULTS</h3>
            <div id="hand-results-community"></div>
            <div id="hand-results-content"></div>
        </div>
        
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
                <div id="community"></div>
                <div id="winner-announcement"></div>
                <div id="action-guide"></div>
            </div>
            <div id="seats"></div>
        </div>
        
        <div id="controls">
            <button id="fold-btn" onclick="sendAction({type:'fold'})" style="background: #c0392b;">FOLD</button>
            <button id="check-btn" onclick="sendAction({type:'call'})" style="background: #27ae60; display:none;">CHECK</button>
            <button id="call-btn" onclick="sendAction({type:'call'})" style="background: #3498db; display:none;">CALL</button>
            <input type="number" id="bet-amt" value="100">
            <button id="raise-btn" onclick="sendAction({type:'raise', amt:parseInt(document.getElementById('bet-amt').value)})" style="background: #e67e22;">RAISE</button>
            <button id="allin-btn" onclick="sendAction({type:'allin'})" style="background: #8e44ad;">ALL IN</button>
            <button id="start-btn" onclick="socket.emit('start_game')" style="background: #2ecc71; display:none; max-width: 150px;">START GAME</button>
            <button id="next-hand-btn" onclick="socket.emit('start_game')" style="background: #2980b9; display:none; max-width: 150px;">NEXT HAND</button>
            <button id="new-game-btn" onclick="socket.emit('new_game')" style="background: #27ae60; display:none; max-width: 150px;">NEW GAME</button>
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
            <button class="tool-btn" style="background:#9b59b6" onclick="let h=document.getElementById('hand-results'); h.style.display=h.style.display==='block'?'none':'block'">HANDS</button>
            <button id="position-btn" class="tool-btn" style="background:#f39c12" onclick="let p=document.getElementById('position-controls'); p.style.display=p.style.display==='block'?'none':'block'">POSITION</button>
            <button id="reset-btn" class="tool-btn" style="display:none; background:#c0392b" onclick="socket.emit('reset_engine')">RESET</button>
        </div>
        
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
            
            // Validate that it's the player's turn before sending action
            function canTakeAction() {
                const controls = document.getElementById('controls');
                return controls.getAttribute('data-my-turn') === 'true';
            }
            
            function sendAction(actionData) {
                if (!canTakeAction()) {
                    console.warn('Blocked action - not your turn');
                    return;
                }
                
                // Validate bet/raise amounts
                if (actionData.type === 'raise') {
                    const betInput = document.getElementById('bet-amt');
                    const amount = parseInt(betInput.value);
                    const minAmount = parseInt(betInput.min);
                    
                    console.log('🔍 RAISE VALIDATION:', {
                        inputValue: betInput.value,
                        inputMin: betInput.min,
                        parsedAmount: amount,
                        parsedMin: minAmount,
                        isValid: !(isNaN(amount) || amount < minAmount)
                    });
                    
                    if (isNaN(amount) || amount < minAmount) {
                        alert('Bet amount must be at least ' + minAmount + ' (you entered: ' + amount + ')');
                        return;
                    }
                }
                
                socket.emit('action', actionData);
            }
            
            let socket;
            
            // Position state
            let positions = {
                tableX: 50, tableY: 45,
                seatsX: 50, seatsY: 45, seatsRX: 220, seatsRY: 120,
                controlsY: 100
            };
            
            let currentData = null;
            
            function logPosition(label, data) {
                const msg = \`📍 \${label}: \${JSON.stringify(data)}\`;
                console.log(msg);
                const d = document.getElementById('debug-window');
                d.innerHTML += '<div style="color:#f39c12">' + msg + '</div>';
                d.scrollTop = d.scrollHeight;
            }
            
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
            
            function updateHandResults(results) {
                const container = document.getElementById('hand-results-content');
                const communityContainer = document.getElementById('hand-results-community');
                
                if (!results || results.length === 0) {
                    container.innerHTML = '<div style="color:#888; text-align:center; padding:20px;">No hands to display</div>';
                    communityContainer.innerHTML = '';
                    return;
                }
                
                // Display community cards if available - use lastCommunity from the data
                if (currentData && currentData.lastCommunity && currentData.lastCommunity.length > 0) {
                    const communityCardsHtml = currentData.lastCommunity.map(c => {
                        const isRed = c.includes('♥') || c.includes('♦');
                        return \`<div class="hand-result-card \${isRed ? 'red' : ''}">\${c}</div>\`;
                    }).join('');
                    communityContainer.innerHTML = \`
                        <div class="label">COMMUNITY CARDS</div>
                        <div class="cards">\${communityCardsHtml}</div>
                    \`;
                } else {
                    communityContainer.innerHTML = '';
                }
                
                // Calculate hand strength percentages for odds display
                const playersWithHands = results.filter(r => r.bestHand);
                const maxRank = playersWithHands.length > 0 ? Math.max(...playersWithHands.map(r => r.bestHand.rank)) : 0;
                
                container.innerHTML = '';
                results.forEach(result => {
                    const isWinner = result.wonAmount > 0;
                    const isFolded = result.status === 'FOLDED';
                    const isOut = result.status === 'OUT';
                    
                    let itemClass = 'hand-result-item';
                    if (isFolded || isOut) {
                        itemClass += ' folded';
                    } else if (!isWinner) {
                        itemClass += ' loser';
                    }
                    
                    const item = document.createElement('div');
                    item.className = itemClass;
                    
                    const cardsHtml = result.hand && result.hand.length > 0 ? result.hand.map(c => {
                        const isRed = c.includes('♥') || c.includes('♦');
                        return \`<div class="hand-result-card \${isRed ? 'red' : ''}">\${c}</div>\`;
                    }).join('') : '<span style="color:#666">No cards</span>';
                    
                    // Calculate simplified odds - hand rank based strength
                    let oddsText = '';
                    if (result.bestHand) {
                        // Hand strength as percentage (0-100)
                        // Royal Flush (9) = 100%, Straight Flush (8) = 95%, etc.
                        const baseStrength = (result.bestHand.rank / 9) * 85 + 10; // 10-95% range
                        
                        // Adjust based on relative position to best hand
                        const relativeStrength = maxRank > 0 ? (result.bestHand.rank / maxRank) * 100 : 50;
                        
                        const finalStrength = Math.round((baseStrength + relativeStrength) / 2);
                        oddsText = \`<div class="hand-result-odds">Win probability: ~\${finalStrength}%</div>\`;
                    } else if (isFolded) {
                        oddsText = '<div class="hand-result-odds" style="color:#95a5a6">Folded</div>';
                    } else if (isOut) {
                        oddsText = '<div class="hand-result-odds" style="color:#95a5a6">Out of chips</div>';
                    }
                    
                    item.innerHTML = \`
                        <div class="hand-result-name">\${result.playerName}\${isWinner ? ' 🏆' : ''}</div>
                        <div class="hand-result-cards">\${cardsHtml}</div>
                        \${result.bestHand ? \`<div class="hand-result-hand">\${result.bestHand.name}</div>\` : ''}
                        \${oddsText}
                        \${isWinner ? \`<div class="hand-result-amount">Won \${result.wonAmount}</div>\` : ''}
                    \`;
                    container.appendChild(item);
                });
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
                if (data.activeId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY' && data.gameStage !== 'GAME_OVER') {
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
                    
                    // Add YOU label for current player
                    const youLabel = isMe ? '<div class="you-label">YOU</div>' : '';
                    
                    // Chevron indicator - coming from left and right
                    let chevronHtml = '';
                    if (p.id === data.activeId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY' && data.gameStage !== 'GAME_OVER') {
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
                            \${youLabel}
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
            
            // Wait for page to load before setting up login
            window.addEventListener('load', () => {
                socket = io();
                
                // Handle login form submission
                document.getElementById('login-form').addEventListener('submit', (e) => {
                    e.preventDefault();
                    const name = document.getElementById('player-name').value.trim() || 'Guest';
                    const roomNumber = document.getElementById('room-number-input').value.trim() || '1234';
                    
                    // Hide login screen
                    document.getElementById('login-screen').style.display = 'none';
                    
                    // Send join request
                    socket.emit('join', { name, roomNumber });
                });
                
                // Handle join rejection - show login screen again with preserved values
                socket.on('join_rejected', (message) => {
                    alert(message);
                    document.getElementById('login-screen').style.display = 'flex';
                    // Name is already preserved in the input field, just refocus
                    document.getElementById('player-name').focus();
                });
                
                // Handle action rejection
                socket.on('action_rejected', (message) => {
                    alert('Action rejected: ' + message);
                });
                
                // Handle first player message
                socket.on('first_player_message', (message) => {
                    const msgElement = document.getElementById('first-player-message');
                    msgElement.innerText = message;
                    msgElement.style.display = 'block';
                    
                    // Hide after 5 seconds
                    setTimeout(() => {
                        msgElement.style.display = 'none';
                    }, 5000);
                });
                
                socket.on('update', data => {
                    currentData = data;
                    
                    // Check if it's now my turn (beep on turn start)
                    const isMyTurnForBeep = (data.activeId === data.myId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY' && data.gameStage !== 'GAME_OVER');
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
                    
                    // Update blind timer display
                    if (data.blindLevel) {
                        document.getElementById('blind-level').innerText = data.blindLevel;
                        const mins = Math.floor(data.blindTimeRemaining / 60);
                        const secs = data.blindTimeRemaining % 60;
                        document.getElementById('blind-time').innerText = mins + ':' + secs.toString().padStart(2, '0');
                        document.getElementById('next-blinds-value').innerText = data.nextBlinds;
                        
                        // Warning color when less than 1 minute
                        const timerEl = document.getElementById('blind-timer');
                        if (data.blindTimeRemaining < 60) {
                            timerEl.style.color = '#e74c3c';
                        } else {
                            timerEl.style.color = '#3498db';
                        }
                    }
                    
                    // Update room number display
                    if (data.roomNumber) {
                        document.getElementById('room-number').innerText = data.roomNumber;
                    }
                    
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
                    
                    // Update hand results panel
                    if (data.handResults && data.handResults.length > 0) {
                        updateHandResults(data.handResults);
                    }
                    
                    const isMyTurn = (data.activeId === data.myId && data.gameStage !== 'SHOWDOWN' && data.gameStage !== 'LOBBY' && data.gameStage !== 'GAME_OVER');
                    const guide = document.getElementById('action-guide');
                    if (data.gameStage === 'GAME_OVER') {
                        guide.innerText = "GAME OVER";
                    } else if (data.gameStage === 'LOBBY') {
                        const playerCount = data.players.length;
                        guide.innerText = playerCount + " PLAYER" + (playerCount !== 1 ? 'S' : '') + " IN LOBBY";
                    } else {
                        guide.innerText = isMyTurn ? "YOUR TURN" : (data.gameStage === 'SHOWDOWN' ? "SHOWDOWN" : "WAITING...");
                    }
                    
                    // Store whether it's my turn for button validation
                    const controls = document.getElementById('controls');
                    controls.setAttribute('data-my-turn', isMyTurn ? 'true' : 'false');
                    
                    // Check if turn has changed (to reset bet input only once)
                    const turnChanged = lastActiveId !== data.activeId;
                    if (turnChanged) {
                        lastActiveId = data.activeId;
                    }
                    
                    // Hide regular action buttons
                    const actionButtons = ['fold-btn', 'check-btn', 'call-btn', 'bet-amt', 'raise-btn', 'allin-btn'];
                    const nextHandBtn = document.getElementById('next-hand-btn');
                    const newGameBtn = document.getElementById('new-game-btn');
                    const startBtn = document.getElementById('start-btn');
                    
                    if (data.gameStage === 'GAME_OVER') {
                        // Show New Game button only for host
                        controls.style.display = data.isHost ? 'flex' : 'none';
                        actionButtons.forEach(id => {
                            const el = document.getElementById(id);
                            if (el) el.style.display = 'none';
                        });
                        nextHandBtn.style.display = 'none';
                        newGameBtn.style.display = data.isHost ? 'block' : 'none';
                        startBtn.style.display = 'none';
                    } else if (data.gameStage === 'SHOWDOWN') {
                        // Show Next Hand button only for host
                        controls.style.display = data.isHost ? 'flex' : 'none';
                        actionButtons.forEach(id => {
                            const el = document.getElementById(id);
                            if (el) el.style.display = 'none';
                        });
                        nextHandBtn.style.display = data.isHost ? 'block' : 'none';
                        newGameBtn.style.display = 'none';
                        startBtn.style.display = 'none';
                    } else if (data.gameStage === 'LOBBY') {
                        // Show Start button only for host
                        controls.style.display = data.isHost ? 'flex' : 'none';
                        actionButtons.forEach(id => {
                            const el = document.getElementById(id);
                            if (el) el.style.display = 'none';
                        });
                        nextHandBtn.style.display = 'none';
                        newGameBtn.style.display = 'none';
                        startBtn.style.display = data.isHost ? 'block' : 'none';
                    } else if (isMyTurn) {
                        // Show action buttons
                        controls.style.display = 'flex';
                        nextHandBtn.style.display = 'none';
                        newGameBtn.style.display = 'none';
                        startBtn.style.display = 'none';
                        
                        const checkBtn = document.getElementById('check-btn');
                        const callBtn = document.getElementById('call-btn');
                        const betInput = document.getElementById('bet-amt');
                        const raiseBtn = document.getElementById('raise-btn');
                        const foldBtn = document.getElementById('fold-btn');
                        
                        // Show fold button
                        foldBtn.style.display = 'block';
                        
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
                        betInput.style.display = 'block';
                        
                        // Determine if button should say "BET" or "RAISE TO"
                        const actionWord = data.isBetSituation ? "BET" : "RAISE TO";
                        const currentBetValue = Math.max(parseInt(betInput.value) || defaultBetAmount, defaultBetAmount);
                        const buttonText = data.isBetSituation ? actionWord + " " + currentBetValue : actionWord + " " + currentBetValue;
                        raiseBtn.innerText = buttonText;
                        
                        // Hide raise/bet button if can't make minimum raise
                        if (!data.canRaise) {
                            raiseBtn.style.display = 'none';
                        } else {
                            raiseBtn.style.display = 'block';
                        }
                        
                        // Show all-in button
                        document.getElementById('allin-btn').style.display = 'block';
                        
                        // Update raise/bet button text on input change (allow manual override)
                        betInput.oninput = function() {
                            const val = Math.max(parseInt(this.value) || defaultBetAmount, data.minRaise);
                            const actionWord = data.isBetSituation ? "BET" : "RAISE TO";
                            const buttonText = data.isBetSituation ? actionWord + " " + val : actionWord + " " + val;
                            raiseBtn.innerText = buttonText;
                        };
                    } else {
                        controls.style.display = 'none';
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
            });
        </script>
    </body>
    </html>
    `);
});

// Password for accessing logs (set as environment variable on Render)
const LOGS_PASSWORD = process.env.LOGS_PASSWORD || 'poker2024'; // Change this!

// Endpoint to list all log files (password protected)
app.get('/logs', (req, res) => {
    const password = req.query.password || req.query.pass || req.query.p;
    
    if (password !== LOGS_PASSWORD) {
        return res.status(401).send(`
            <html><head><title>Access Denied</title><style>
                body{font-family:monospace;background:#000;color:#f00;padding:50px;text-align:center;}
                input{padding:10px;font-size:16px;margin:10px;}
                button{padding:10px 20px;font-size:16px;background:#0f0;border:none;cursor:pointer;}
            </style></head><body>
                <h1>🔒 Password Required</h1>
                <form method="GET">
                    <input type="password" name="password" placeholder="Enter password" autofocus>
                    <button type="submit">Access Logs</button>
                </form>
            </body></html>
        `);
    }
    
    fs.readdir(logsDir, (err, files) => {
        if (err) {
            return res.status(500).send('Error reading logs directory');
        }
        const logFiles = files.filter(f => f.endsWith('.log')).sort().reverse();
        let html = '<html><head><title>Poker Game Logs</title><style>body{font-family:monospace;background:#000;color:#0f0;padding:20px;}a{color:#0ff;text-decoration:none;display:block;padding:5px;}a:hover{background:#222;}</style></head><body>';
        html += '<h1>🃏 Poker Game Logs</h1>';
        html += '<p>Click a log file to download:</p>';
        logFiles.forEach(file => {
            html += `<a href="/logs/${file}?password=${password}" download>${file}</a>`;
        });
        html += '</body></html>';
        res.send(html);
    });
});

// Endpoint to download a specific log file (password protected)
app.get('/logs/:filename', (req, res) => {
    const password = req.query.password || req.query.pass || req.query.p;
    const filename = req.params.filename;
    
    if (password !== LOGS_PASSWORD) {
        return res.status(401).send('Access denied - password required');
    }
    
    const filepath = path.join(logsDir, filename);
    
    // Security: prevent directory traversal
    if (!filename.endsWith('.log') || filename.includes('..')) {
        return res.status(400).send('Invalid filename');
    }
    
    res.download(filepath, filename, (err) => {
        if (err) {
            res.status(404).send('Log file not found');
        }
    });
});

// Endpoint to get current game log filename
app.get('/current-log', (req, res) => {
    if (gameLogFile) {
        res.json({ filename: path.basename(gameLogFile), fullPath: gameLogFile });
    } else {
        res.json({ filename: null });
    }
});

http.listen(process.env.PORT || 3000, () => console.log(`Server live on port ${process.env.PORT || 3000}`));
