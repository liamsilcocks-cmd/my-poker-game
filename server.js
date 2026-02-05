const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Game Variables ---
let players = {};
let playerOrder = [];
let turnIndex = 0;
let deck = [];
let communityCards = [];
let pot = 0;
let currentBet = 0;
let stage = 'WAITING'; // WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN

function createDeck() {
    const suits = ['H', 'D', 'C', 'S'];
    const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let newDeck = [];
    for (let s of suits) for (let v of values) newDeck.push(v + s);
    return newDeck.sort(() => Math.random() - 0.5);
}

function nextTurn() {
    turnIndex = (turnIndex + 1) % playerOrder.length;
    broadcastState();
}

function broadcastState() {
    io.emit('update', {
        players,
        community: communityCards,
        pot,
        currentBet,
        stage,
        activePlayer: playerOrder[turnIndex]
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name: name, hand: [], chips: 1000, bet: 0, status: 'IN' };
        playerOrder.push(socket.id);
        broadcastState();
    });

    socket.on('start_game', () => {
        deck = createDeck();
        communityCards = [];
        pot = 0;
        stage = 'PREFLOP';
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

        const player = players[socket.id];
        if (data.type === 'fold') player.status = 'FOLDED';
        if (data.type === 'call') {
            const amount = currentBet - player.bet;
            player.chips -= amount;
            player.bet += amount;
            pot += amount;
        }
        if (data.type === 'raise') {
            const amount = (currentBet + 50) - player.bet; // Fixed raise for simplicity
            player.chips -= amount;
            player.bet += amount;
            pot += amount;
            currentBet = player.bet;
        }

        nextTurn();
    });

    socket.on('next_stage', () => {
        if (stage === 'PREFLOP') {
            communityCards = [deck.pop(), deck.pop(), deck.pop()];
            stage = 'FLOP';
        } else if (stage === 'FLOP' || stage === 'TURN') {
            communityCards.push(deck.pop());
            stage = (stage === 'FLOP') ? 'TURN' : 'RIVER';
        }
        currentBet = 0;
        Object.keys(players).forEach(id => players[id].bet = 0);
        broadcastState();
    });
});

server.listen(process.env.PORT || 3000);
