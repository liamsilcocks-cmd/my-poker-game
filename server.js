const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- GAME DATA ---
let players = {};
let playerOrder = [];
let turnIndex = 0;
let deck = [];
let communityCards = [];
let pot = 0;
let currentBet = 0;

function createDeck() {
    const suits = ['H', 'D', 'C', 'S'];
    const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let newDeck = [];
    for (let s of suits) for (let v of values) newDeck.push(v + s);
    return newDeck.sort(() => Math.random() - 0.5);
}

function broadcastState() {
    io.emit('update', { players, community: communityCards, pot, currentBet, activePlayer: playerOrder[turnIndex] });
}

// --- THIS SECTION REPLACES THE INDEX.HTML ---
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Private Poker</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { background: #1a472a; color: white; font-family: sans-serif; text-align: center; padding: 20px; }
        .card-box { display:inline-block; margin: 10px; padding: 10px; width: 140px; border-radius: 8px; background: rgba(0,0,0,0.3); }
        button { padding: 10px; margin: 5px; cursor: pointer; border-radius: 5px; border: none; font-weight: bold; }
        .action-btn { background: #f1c40f; color: black; }
        .admin-btn { background: #e74c3c; color: white; }
    </style>
</head>
<body>
    <h1>Pot: £<span id="pot-total">0</span></h1>
    <div id="community-area" style="font-size: 2em; margin: 20px; padding: 20px; border: 2px dashed #fff; border-radius: 10px;">Pre-Flop</div>
    
    <div id="player-list"></div>

    <div id="action-menu" style="display:none; margin-top: 20px; border: 2px solid yellow; padding: 20px;">
        <h3>YOUR TURN</h3>
        <button class="action-btn" onclick="sendAction('fold')">FOLD</button>
        <button class="action-btn" onclick="sendAction('call')">CHECK / CALL</button>
        <button class="action-btn" onclick="sendAction('raise')">RAISE £50</button>
    </div>

    <div style="margin-top: 50px;">
        <button class="admin-btn" onclick="socket.emit('start_game')">DEAL NEW HAND</button>
        <button class="admin-btn" onclick="socket.emit('next_stage')">DEAL NEXT CARDS</button>
    </div>

    <script>
        const socket = io();
        const myName = prompt("Enter Name") || "Player";
        socket.emit('join', myName);

        function sendAction(type) { socket.emit('action', { type }); }

        socket.on('update', (s) => {
            document.getElementById('pot-total').innerText = s.pot;
            document.getElementById('community-area').innerText = s.community.length ? s.community.join(' | ') : "Pre-Flop";
            
            const list = document.getElementById('player-list');
            list.innerHTML = '';
            
            document.getElementById('action-menu').style.display = (socket.id === s.activePlayer) ? 'block' : 'none';

            Object.keys(s.players).forEach(id => {
                const p = s.players[id];
                const isTurn = (id === s.activePlayer);
                const border = isTurn ? 'border: 4px solid yellow;' : 'border: 1px solid white;';
                
                list.innerHTML += \`
                    <div class="card-box" style="\${border}">
                        <b>\${p.name}</b><br>
                        £\${p.chips}<br>
                        <div style="font-size: 1.5em; margin-top: 5px;">
                            \${id === socket.id ? p.hand.join(' ') : (p.status === 'FOLDED' ? '❌' : '🂠 🂠')}
                        </div>
                    </div>
                \`;
            });
        });
    </script>
</body>
</html>
    `);
});

// --- SERVER EVENTS ---
io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name, hand: [], chips: 1000, bet: 0, status: 'IN' };
        if (!playerOrder.includes(socket.id)) playerOrder.push(socket.id);
        broadcastState();
    });

    socket.on('start_game', () => {
        deck = createDeck();
        communityCards = [];
        pot = 0;
        currentBet = 0;
        Object.keys(players).forEach(id => {
            players[id].hand = [deck.pop(), deck.pop()];
            players[id].bet = 0;
            players[id].status = 'IN';
        });
        turnIndex = 0;
        broadcastState();
    });

    socket.on('action', (data) => {
        if (socket.id !== playerOrder[turnIndex]) return;
        const p = players[socket.id];
        if (data.type === 'fold') p.status = 'FOLDED';
        if (data.type === 'call') {
            const amt = currentBet - p.bet;
            p.chips -= amt; p.bet += amt; pot += amt;
        }
        if (data.type === 'raise') {
            const raise = currentBet + 50;
            const amt = raise - p.bet;
            p.chips -= amt; p.bet += amt; pot += amt; currentBet = p.bet;
        }
        turnIndex = (turnIndex + 1) % playerOrder.length;
        broadcastState();
    });

    socket.on('next_stage', () => {
        if (communityCards.length === 0) communityCards = [deck.pop(), deck.pop(), deck.pop()];
        else if (communityCards.length < 5) communityCards.push(deck.pop());
        currentBet = 0;
        Object.keys(players).forEach(id => players[id].bet = 0);
        broadcastState();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        playerOrder = playerOrder.filter(id => id !== socket.id);
        broadcastState();
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('Server running on port ' + PORT));
