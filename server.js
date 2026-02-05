const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { background: #1a1a1a; color: white; font-family: sans-serif; margin: 0; overflow: hidden; }
          
          /* The Table Container */
          .game-container { position: relative; width: 100vw; height: 100vh; display: flex; justify-content: center; align-items: center; }
          
          .poker-table { 
            position: relative; width: 600px; height: 350px; background: #1a472a; 
            border: 15px solid #5d3a1a; border-radius: 200px; box-shadow: inset 0 0 50px #000;
            display: flex; justify-content: center; align-items: center; flex-direction: column;
          }

          /* Community Cards in center of table */
          #community { font-size: 2em; letter-spacing: 5px; text-shadow: 2px 2px 4px #000; }

          /* Individual Player Seats */
          .player-seat { 
            position: absolute; width: 120px; text-align: center; 
            transition: all 0.5s ease; transform: translate(-50%, -50%);
          }

          .player-box { background: rgba(0,0,0,0.8); border: 2px solid #fff; border-radius: 10px; padding: 10px; }
          .me { border-color: #f1c40f; box-shadow: 0 0 15px #f1c40f; }
          .cards { font-size: 1.5em; display: block; margin-top: 5px; }

          .controls { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 100; }
          button { padding: 12px 20px; cursor: pointer; border: none; border-radius: 5px; font-weight: bold; margin: 0 5px; }
        </style>
      </head>
      <body>
        <div class="game-container">
          <div class="poker-table">
             <div id="community">Waiting...</div>
             <div id="players-area"></div>
          </div>
        </div>

        <div class="controls">
            <button style="background: #e74c3c; color: white;" onclick="socket.emit('deal')">NEW HAND</button>
            <button style="background: #3498db; color: white;" onclick="socket.emit('next')">DEAL NEXT</button>
        </div>
        
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          const name = prompt("Name?") || "Player";
          socket.emit('join', name);

          socket.on('update', (data) => {
            // Update Community Cards
            document.getElementById('community').innerText = data.community.join(' ') || "Place Your Bets";
            
            const area = document.getElementById('players-area');
            area.innerHTML = '';
            
            const totalPlayers = data.players.length;
            const radiusX = 380; // Distance from center horizontally
            const radiusY = 250; // Distance from center vertically

            data.players.forEach((p, index) => {
                const isMe = p.id === socket.id;
                
                // MATH: Positioning players in an ellipse around the table center
                const angle = (index / totalPlayers) * 2 * Math.PI + (Math.PI / 2);
                const x = Math.cos(angle) * radiusX;
                const y = Math.sin(angle) * radiusY;

                const seat = document.createElement('div');
                seat.className = 'player-seat';
                seat.style.left = \`calc(50% + \${x}px)\`;
                seat.style.top = \`calc(50% + \${y}px)\`;

                seat.innerHTML = \`
                    <div class="player-box \${isMe ? 'me' : ''}">
                        <b>\${p.name}</b>
                        <span class="cards">\${p.displayCards.join(' ')}</span>
                    </div>
                \`;
                area.appendChild(seat);
            });
          });
        </script>
      </body>
    </html>
  `);
});

// --- SERVER LOGIC (Keep the same as before) ---
let players = {};
let community = [];
let deck = [];

function shuffle() {
    const suits = ['♥', '♦', '♣', '♠'];
    const vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let d = [];
    for(let s of suits) for(let v of vals) d.push(v+s);
    return d.sort(() => Math.random() - 0.5);
}

function getSafeState(socketId) {
    return {
        community: community,
        players: Object.keys(players).map(id => ({
            id: id,
            name: players[id].name,
            displayCards: (id === socketId) ? players[id].hand : (players[id].hand.length ? ['🂠', '🂠'] : [])
        }))
    };
}

function broadcast() {
    io.sockets.sockets.forEach((socket) => {
        socket.emit('update', getSafeState(socket.id));
    });
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        players[socket.id] = { name: name, hand: [] };
        broadcast();
    });
    socket.on('deal', () => {
        deck = shuffle();
        community = [];
        Object.keys(players).forEach(id => { players[id].hand = [deck.pop(), deck.pop()]; });
        broadcast();
    });
    socket.on('next', () => {
        if (community.length === 0) community = [deck.pop(), deck.pop(), deck.pop()];
        else if (community.length < 5) community.push(deck.pop());
        broadcast();
    });
    socket.on('disconnect', () => {
        delete players[socket.id];
        broadcast();
    });
});

const PORT = process.env.PORT || 10000;
http.listen(PORT, () => console.log('Ready on port ' + PORT));
