const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
    io.emit('update', {
        players,
        community: communityCards,
        pot,
        currentBet,
        activePlayer: playerOrder[turnIndex]
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name: name || "Player", hand: [], chips: 1000, bet: 0, status: 'IN' };
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
        // Validation: Is it actually this player's turn?
        if (socket.id !== playerOrder[turnIndex]) return;

        const player = players[socket.id];
        console.log(`Action received: ${data.type} from ${player.name}`);

        if (data.type === 'fold') player.status = 'FOLDED';
        if (data.type === 'call') {
            const amountNeeded = currentBet - player.bet;
            player.chips -= amountNeeded;
            player.bet += amountNeeded;
            pot += amountNeeded;
        }
        if (data.type === 'raise') {
            const raiseTo = currentBet + 50;
            const amountToPay = raiseTo - player.bet;
            player.chips -= amountToPay;
            player.bet += amountToPay;
            pot += amountToPay;
            currentBet = player.bet;
        }

        // Move to next player
        turnIndex = (turnIndex + 1) % playerOrder.length;
        broadcastState();
    });

    socket.on('next_stage', () => {
        if (communityCards.length === 0) {
            communityCards = [deck.pop(), deck.pop(), deck.pop()]; // Flop
        } else if (communityCards.length < 5) {
            communityCards.push(deck.pop()); // Turn then River
        }
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

server.listen(process.env.PORT || 3000);
