const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// 1. THIS HANDLES THE "NOT FOUND" ERROR
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <body style="background: #1a472a; color: white; text-align: center; font-family: sans-serif;">
        <h1>Poker Table</h1>
        <div id="status">Connecting...</div>
        <div id="table" style="border: 2px solid #fff; padding: 20px; margin: 20px;">
          <div id="community">Community: Waiting...</div>
          <div id="players"></div>
        </div>
        <button onclick="socket.emit('deal')">DEAL HAND</button>
        <button onclick="socket.emit('next')">NEXT CARDS</button>
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          const name = prompt("Name?") || "Player";
          socket.emit('join', name);
          socket.on('update', (data) => {
            document.getElementById('status').innerText = "Game Active";
            document.getElementById('community').innerText = "Cards: " + data.community.join(' ');
            document.getElementById('players').innerHTML = Object.values(data.players)
              .map(p => "<div>" + p.name + ": " + p.hand.join(' ') + "</div>").join('');
          });
        </script>
      </body>
    </html>
  `);
});

// 2. GAME LOGIC
let state = { players: {}, community: [] };
let deck = ['Ah', 'Kh', 'Qh', 'Jh', '10h', '9h', '8h', '7h', '6h', '5h', '4h', '3h', '2h'];

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    state.players[socket.id] = { name: name, hand: [] };
    io.emit('update', state);
  });

  socket.on('deal', () => {
    state.community = [];
    Object.keys(state.players).forEach(id => {
      state.players[id].hand = [deck[Math.floor(Math.random()*deck.length)], deck[Math.floor(Math.random()*deck.length)]];
    });
    io.emit('update', state);
  });

  socket.on('next', () => {
    state.community.push(deck[Math.floor(Math.random()*deck.length)]);
    io.emit('update', state);
  });
});

// 3. START SERVER
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log('Server is up on port', PORT);
});
