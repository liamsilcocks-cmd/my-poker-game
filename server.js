const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let players = {};
let deck = [];

function createDeck() {
    const suits = ['H', 'D', 'C', 'S'];
    const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let newDeck = [];
    for (let s of suits) {
        for (let v of values) newDeck.push(v + s);
    }
    return newDeck.sort(() => Math.random() - 0.5);
}

// Serve a simple interface directly from the script
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Private Poker</title><script src="/socket.io/socket.io.js"></script></head>
        <body style="background: #1a472a; color: white; font-family: sans-serif; text-align: center;">
            <h1>Poker Table</h1>
            <div id="game-info">Connecting...</div>
            <div id="my-hand" style="font-size: 2em; margin: 20px;"></div>
            <button onclick="startGame()" style="padding: 10px 20px;">Start New Hand</button>
            <script>
                const socket = io();
                const name = prompt("Enter Name") || "Player " + Math.floor(Math.random()*100);
                socket.emit('join', name);

                socket.on('update', (data) => {
                    const me = data[socket.id];
                    document.getElementById('game-info').innerText = "Players: " + Object.values(data).map(p => p.name).join(', ');
                    if(me && me.hand.length) {
                        document.getElementById('my-hand').innerText = "Your Hand: " + me.hand.join(' | ');
                    }
                });

                function startGame() { socket.emit('deal'); }
            </script>
        </body>
        </html>
    `);
});

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name: name, hand: [] };
        io.emit('update', players);
    });

    socket.on('deal', () => {
        deck = createDeck();
        for (let id in players) {
            players[id].hand = [deck.pop(), deck.pop()];
        }
        io.emit('update', players);
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('update', players);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Running on port ' + PORT));