const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <body style="background: #1a472a; color: white; text-align: center; font-family: sans-serif; padding: 20px;">
        <h1>Poker Table</h1>
        <div id="table" style="border: 2px solid #fff; padding: 20px; margin: 20px; border-radius: 15px;">
          <div id="community" style="font-size: 1.5em; margin-bottom: 20px; min-height: 40px;">Waiting...</div>
          <div id="players" style="display: flex; justify-content: center; gap: 15px; flex-wrap: wrap;"></div>
        </div>
        <button style="padding: 15px; background: #e74c3c; color: white; border: none; cursor: pointer;" onclick="socket.emit('deal')">NEW HAND</button>
        <button style="padding: 15px; background: #3498db; color: white; border: none; cursor: pointer;" onclick="socket.emit('next')">DEAL NEXT CARD</button>
        
        <script src="/socket.io/socket.io.js"></script>
        <script>
          const socket = io();
          const name = prompt("Name?") || "Player";
          socket.emit('join', name);

          socket.on('update', (data) => {
            document.getElementById('community').innerText = "Community: " + (data.community.join(' ') || "Pre-Flop");
            
            const playerDiv = document.getElementById('players');
            playerDiv.innerHTML = '';
            
            data.players.forEach(p => {
                const isMe = p.id === socket.id;
                playerDiv.innerHTML += \`
                    <div style="border: 1px solid #fff; padding: 10px; background: rgba(0,0,0,0.2); min-width: 100px;">
                        <b style="color: \${isMe ? '#f1c40f' : '#fff'}">\${p.name} \${isMe ? '(You)' : ''}</b><br>
                        <span style="font-size: 1.3em;">\${p.displayCards.join(' ')}</span>
                    </div>
                \`;
            });
          });
        </script>
      </body>
    </html>
  `);
});

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

// THE FILTER: This is how we hide cards
function getSafeState(socketId) {
    return {
        community: community,
        players: Object.keys(players).map(id => ({
            id: id,
            name: players[id].name,
            // If it's your ID, show cards. Otherwise, show back of cards.
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
        Object.keys(players).forEach(id => {
            players[id].hand = [deck.pop(), deck.pop()];
        });
        broadcast();
    });

    socket.on('next', () => {
        // RULE: Only allow 5 cards max (Flop 3, Turn 1, River 1)
        if (community.length === 0) {
            community = [deck.pop(), deck.pop(), deck.pop()];
        } else if (community.length < 5) {
            community.push(deck.pop());
        }
        broadcast();
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        broadcast();
    });
});

const PORT = process.env.PORT || 10000;
http.listen(PORT, () => console.log('Ready on port ' + PORT));
