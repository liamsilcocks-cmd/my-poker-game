const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let players = {};
let deck = [];
let communityCards = [];

function createDeck() {
    const suits = ['H', 'D', 'C', 'S'];
    const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let newDeck = [];
    for (let s of suits) {
        for (let v of values) newDeck.push(v + s);
    }
    return newDeck.sort(() => Math.random() - 0.5);
}

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Browser Poker</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { background: #1a472a; color: white; font-family: Arial; text-align: center; }
        .table { border: 5px solid #5d3a1a; border-radius: 100px; padding: 50px; margin: 20px; min-height: 200px; }
        .player-slot { display: inline-block; margin: 10px; padding: 10px; border: 1px solid #fff; border-radius: 10px; background: rgba(0,0,0,0.2); }
        .card { background: white; color: black; padding: 5px 10px; border-radius: 5px; font-weight: bold; margin: 2px; display: inline-block; }
        .card.red { color: red; }
        .community { margin: 20px; font-size: 1.5em; }
        .controls { margin-top: 30px; }
    </style>
</head>
<body>
    <h1>Private Poker Table</h1>
    
    <div class="table" id="poker-table">
        <div id="opponents"></div>
        <div class="community">
            Community: <span id="community-area">Waiting...</span>
        </div>
    </div>

    <div id="my-zone">
        <h3>Your Seat: <span id="my-name">...</span></h3>
        <div id="my-cards"></div>
    </div>

    <div class="controls">
        <button onclick="dealHand()">Deal New Hand</button>
        <button onclick="revealFlop()">Deal Flop</button>
    </div>

    <script>
        const socket = io();
        const playerName = prompt("Enter Name") || "Guest";
        document.getElementById('my-name').innerText = playerName;

        socket.emit('join', playerName);

        socket.on('update', (data) => {
            const opponentsDiv = document.getElementById('opponents');
            const myCardsDiv = document.getElementById('my-cards');
            const communityDiv = document.getElementById('community-area');
            
            opponentsDiv.innerHTML = '';
            myCardsDiv.innerHTML = '';

            // Update Community Cards
            communityDiv.innerText = data.community.length ? data.community.join(' | ') : "Empty";

            // Update Players
            Object.keys(data.players).forEach(id => {
                if (id === socket.id) {
                    // This is YOU - show your cards
                    data.players[id].hand.forEach(c => {
                        myCardsDiv.innerHTML += '<span class="card">' + c + '</span>';
                    });
                } else {
                    // This is an OPPONENT - hide their cards
                    const handCount = data.players[id].hand.length;
                    opponentsDiv.innerHTML += \`
                        <div class="player-slot">
                            <b>\${data.players[id].name}</b><br>
                            \${handCount > 0 ? '🂠 🂠' : 'No Cards'}
                        </div>
                    \`;
                }
            });
        });

        function dealHand() { socket.emit('deal'); }
        function revealFlop() { socket.emit('flop'); }
    </script>
</body>
</html>
    `);
});

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name: name, hand: [] };
        io.emit('update', { players, community: communityCards });
    });

    socket.on('deal', () => {
        deck = createDeck();
        communityCards = [];
        for (let id in players) {
            players[id].hand = [deck.pop(), deck.pop()];
        }
        io.emit('update', { players, community: communityCards });
    });

    socket.on('flop', () => {
        if(deck.length > 3) {
            communityCards = [deck.pop(), deck.pop(), deck.pop()];
            io.emit('update', { players, community: communityCards });
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update', { players, community: communityCards });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server live on ' + PORT));
