'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');
const fs   = require('fs');
const path = require('path');

const PORT  = process.env.PORT || 10000;
const SUITS = ['\u2660','\u2665','\u2666','\u2663'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RVAL  = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const NP    = 9;
const SB    = 10, BB = 20;
const START_CHIPS = 1000;
const ACTION_TIMEOUT = 15000;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error: index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id:roomId, seats:Array(NP).fill(null), hostId:null, gameActive:false,
      pendingJoins:[], G:null, dealerSeat:-1, actionTimer:null
    });
  }
  return rooms.get(roomId);
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastAll(room, msg) {
  const str = JSON.stringify(msg);
  room.seats.forEach(s => { if (s && s.ws && s.ws.readyState === 1) s.ws.send(str); });
}

function lobbySnapshot(room) {
  return {
    type:'lobby', roomId:room.id, hostId:room.hostId, gameActive:room.gameActive,
    seats:room.seats.map(s => s ? {id:s.id,name:s.name,chips:s.chips,seat:s.seat} : null),
    pending:room.pendingJoins.map(p => ({id:p.id,name:p.name}))
  };
}

function tableSnapshot(room, forId) {
  const G = room.G;
  if (!G) return {type:'state',phase:'idle',players:room.seats.map(()=>null)};
  return {
    type:'state', phase:G.phase, pot:G.pot, currentBet:G.currentBet,
    community:G.community, dealerSeat:room.dealerSeat,
    sbSeat:G.sbSeat, bbSeat:G.bbSeat, toActSeat:G.toAct[0]??null,
    players:room.seats.map(s => {
      if (!s) return null;
      const showCards = s.id===forId || (G.phase==='showdown'&&!s.folded);
      return {
        seat:s.seat, name:s.name, chips:s.chips, bet:s.bet, folded:s.folded,
        cards:showCards?s.cards:s.cards.map(()=>'back'), active:!s.sittingOut
      };
    })
  };
}

function startActionTimer(room, seat) {
  if(room.actionTimer) clearTimeout(room.actionTimer);
  room.actionTimer = setTimeout(() => {
    const p = room.seats[seat];
    if (!p || p.folded || !room.G || room.G.toAct[0] !== seat) return;
    p.folded = true;
    broadcastAll(room, {type:'playerAction',seat,action:'fold',name:p.name+' (timeout)'});
    broadcastState(room);
    acted(room, seat, false);
  }, ACTION_TIMEOUT);
}

function clearActionTimer(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer=null; }
}

wss.on('connection', (ws) => {
  let myId=null, myRoomId=null;

  ws.on('message', raw => {
    let msg;
    try { msg=JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        const rawRoom = String(msg.room||'1').replace(/\D/g,'')||'1';
        myRoomId = rawRoom.slice(0,6);
        myId = msg.id || ('p_'+Math.random().toString(36).slice(2,8));
        const name = (msg.name||'Player').slice(0,18).trim()||'Player';
        const room = getOrCreateRoom(myRoomId);

        const existing = room.seats.find(s=>s&&s.id===myId);
        if (existing) {
          existing.ws=ws; existing.disconnected=false;
          send(ws, {type:'joined',id:myId,seat:existing.seat,isHost:myId===room.hostId});
          send(ws, lobbySnapshot(room));
          if (room.G) send(ws, tableSnapshot(room,myId));
          broadcastAll(room, {type:'chat',name:'System',text:`${existing.name} reconnected`});
          return;
        }

        const isEmpty = room.seats.every(s=>s===null) && room.pendingJoins.length===0;
        if (isEmpty) {
          room.seats[0]={ws,id:myId,name,chips:START_CHIPS,seat:0,cards:[],bet:0,folded:false,disconnected:false};
          room.hostId=myId;
          send(ws, {type:'joined',id:myId,seat:0,isHost:true});
          broadcastAll(room, lobbySnapshot(room));
          return;
        }

        room.pendingJoins.push({ws,id:myId,name});
        send(ws, {type:'waiting',id:myId});
        const hostSeat = room.seats.find(s=>s&&s.id===room.hostId);
        if (hostSeat&&hostSeat.ws) send(hostSeat.ws, {type:'joinRequest',id:myId,name});
        break;
      }

      case 'approve': {
        const room = rooms.get(myRoomId);
        if (!room||myId!==room.hostId) return;
        const idx = room.pendingJoins.findIndex(p=>p.id===msg.id);
        if (idx===-1) return;
        const p = room.pendingJoins.splice(idx,1)[0];
        if (msg.accept) {
          const seat = room.seats.findIndex(s=>s===null);
          if (seat===-1) { send(p.ws,{type:'rejected',reason:'Table is full'}); broadcastAll(room,lobbySnapshot(room)); return; }
          room.seats[seat]={ws:p.ws,id:p.id,name:p.name,chips:START_CHIPS,seat,cards:[],bet:0,folded:false,disconnected:false};
          send(p.ws, {type:'joined',id:p.id,seat,isHost:false});
          if (room.gameActive) {
            room.seats[seat].sittingOut=true;
            send(p.ws, {type:'sittingOut',reason:'Hand in progress - you will join next hand.'});
            send(p.ws, tableSnapshot(room,p.id));
          }
        } else {
          send(p.ws, {type:'rejected',reason:'Host declined your request'});
        }
        broadcastAll(room, lobbySnapshot(room));
        break;
      }

      case 'startGame': {
        const room = rooms.get(myRoomId);
        if (!room||myId!==room.hostId) return;
        const active = room.seats.filter(s=>s!==null);
        if (active.length<2) { send(ws,{type:'error',msg:'Need at least 2 players'}); return; }
        room.gameActive=true;
        broadcastAll(room, {type:'gameStarting'});
        broadcastAll(room, lobbySnapshot(room));
        startNewHand(room);
        break;
      }

      case 'action': {
        const room = rooms.get(myRoomId);
        if (!room||!room.G||!room.gameActive) return;
        const actingSeat = room.seats.findIndex(s=>s&&s.id===myId);
        if (actingSeat===-1||room.G.toAct[0]!==actingSeat) return;
        clearActionTimer(room);
        handleAction(room, actingSeat, msg.action, msg.amount);
        break;
      }

      case 'chat': {
        const room = rooms.get(myRoomId);
        if (!room) return;
        const s = room.seats.find(s=>s&&s.id===myId);
        if (!s) return;
        broadcastAll(room, {type:'chat',name:s.name,text:(msg.text||'').slice(0,120)});
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!myId||!myRoomId) return;
    const room = rooms.get(myRoomId);
    if (!room) return;
    const pi = room.pendingJoins.findIndex(p=>p.id===myId);
    if (pi!==-1) room.pendingJoins.splice(pi,1);
    const s = room.seats.find(s=>s&&s.id===myId);
    if (s) {
      s.ws=null; s.disconnected=true;
      broadcastAll(room, {type:'chat',name:'System',text:`${s.name} disconnected`});
      if (room.G&&room.G.toAct[0]===s.seat) {
        setTimeout(() => {
          if (s.disconnected&&room.G&&room.G.toAct[0]===s.seat) {
            s.folded=true;
            broadcastAll(room, {type:'playerAction',seat:s.seat,action:'fold',name:s.name+' (disconnected)'});
            clearActionTimer(room);
            acted(room, s.seat, false);
          }
        }, 3000);
      }
    }
  });

  ws.on('error', err => console.error('WS error:', err));
});

function shuffle(d) {
  for (let i=d.length-1;i>0;i--) { const j=0|Math.random()*(i+1); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}

function buildDeck() {
  const d=[];
  for(const s of SUITS) for(const r of RANKS) d.push({s,r});
  return shuffle(d);
}

function activeSeatsFull(room) {
  // All seated players not sitting out (regardless of folded status - used for new hands)
  return room.seats.map((s,i)=>(s&&!s.sittingOut)?i:null).filter(i=>i!==null);
}

function nextSeat(from, active) {
  const sorted=[...active].sort((a,b)=>a-b);
  const nxt=sorted.find(i=>i>from);
  return nxt!==undefined?nxt:sorted[0];
}

function buildActOrder(room, startSeat, active) {
  const sorted=[...active].sort((a,b)=>a-b);
  const startIdx=Math.max(0,sorted.indexOf(startSeat));
  const reordered=[...sorted.slice(startIdx),...sorted.slice(0,startIdx)];
  return reordered.filter(i=>i!==undefined&&room.seats[i]&&!room.seats[i].folded&&room.seats[i].chips>0);
}

function startNewHand(room) {
  clearActionTimer(room);
  room.seats.forEach(s=>{if(s) s.sittingOut=false;});
  const active=activeSeatsFull(room);

  if (active.length<2) {
    broadcastAll(room, {type:'waitingForPlayers'});
    room.gameActive=false;
    broadcastAll(room, lobbySnapshot(room));
    return;
  }

  room.dealerSeat = room.dealerSeat<0 ? active[0] : nextSeat(room.dealerSeat, active);

  // HEADS-UP RULE (TDA Rule 34):
  // Dealer = Small Blind. Acts first preflop, last postflop.
  // Big Blind acts first postflop.
  const isHeadsUp = active.length === 2;
  const sbSeat = isHeadsUp ? room.dealerSeat : nextSeat(room.dealerSeat, active);
  const bbSeat = nextSeat(sbSeat, active);

  room.G = {
    deck:buildDeck(), phase:'preflop', pot:0, currentBet:BB,
    community:[], toAct:[], sbSeat, bbSeat, isHeadsUp
  };

  room.seats.forEach(s=>{if(s){s.cards=[];s.bet=0;s.folded=false;}});

  // Post blinds
  room.seats[sbSeat].chips -= SB; room.seats[sbSeat].bet = SB;
  room.seats[bbSeat].chips -= BB; room.seats[bbSeat].bet = BB;
  room.G.pot = SB + BB;

  // Deal 2 cards each
  for(let rd=0;rd<2;rd++)
    for(const si of active) room.seats[si].cards.push(room.G.deck.shift());

  // Preflop action order:
  // Heads-up: dealer/SB acts first
  // Normal: player left of BB acts first
  const preflopStart = isHeadsUp ? sbSeat : nextSeat(bbSeat, active);
  room.G.toAct = buildActOrder(room, preflopStart, active);

  broadcastAll(room, {
    type:'newHand', dealerSeat:room.dealerSeat, sbSeat, bbSeat,
    pot:room.G.pot, activeSeats:active
  });

  room.seats.forEach(s=>{
    if(s&&s.ws&&s.ws.readyState===1) send(s.ws, tableSnapshot(room,s.id));
  });

  promptToAct(room);
}

function promptToAct(room) {
  const G=room.G;
  if (!G) return;

  // Skip folded/out-of-chips players
  while(G.toAct.length) {
    const si=G.toAct[0];
    if(!room.seats[si]||room.seats[si].folded||room.seats[si].chips===0)
      G.toAct.shift();
    else break;
  }

  const alive=room.seats.filter(s=>s&&!s.folded);
  if(alive.length<=1){endRound(room);return;}
  if(!G.toAct.length){advPhase(room);return;}

  const seat=G.toAct[0];
  const p=room.seats[seat];
  const callAmt=Math.min(G.currentBet-p.bet, p.chips);

  broadcastAll(room, {type:'yourTurn', seat, callAmt, minRaise:BB*2, pot:G.pot, currentBet:G.currentBet});
  startActionTimer(room, seat);
}

function handleAction(room, seat, action, amount) {
  const p=room.seats[seat];
  const G=room.G;
  if(!p||!G) return;

  if(action==='fold') {
    p.folded=true;
    broadcastAll(room, {type:'playerAction',seat,action:'fold',name:p.name,amount:0});
    broadcastState(room);
    acted(room,seat,false);

  } else if(action==='check'||action==='call') {
    const ca=Math.min(G.currentBet-p.bet, p.chips);
    p.chips-=ca; p.bet+=ca; G.pot+=ca;
    broadcastAll(room, {type:'playerAction',seat,action:ca===0?'check':'call',amount:ca,name:p.name,pot:G.pot});
    broadcastState(room);
    acted(room,seat,false);

  } else if(action==='raise') {
    const minR=Math.max(BB*2, G.currentBet-p.bet+BB);
    const raise=Math.min(Math.max(amount||minR, minR), p.chips);
    p.chips-=raise; p.bet+=raise; G.pot+=raise;
    G.currentBet=Math.max(G.currentBet, p.bet);
    broadcastAll(room, {type:'playerAction',seat,action:'raise',amount:raise,name:p.name,pot:G.pot});
    broadcastState(room);
    acted(room,seat,true);
  }
}

function broadcastState(room) {
  room.seats.forEach(s=>{
    if(s&&s.ws&&s.ws.readyState===1) send(s.ws, tableSnapshot(room,s.id));
  });
}

function acted(room, seat, isRaise) {
  const G=room.G;
  G.toAct.shift();

  if(isRaise) {
    // After a raise, everyone else who hasn't matched gets to act again
    const active=activeSeatsFull(room).sort((a,b)=>a-b);
    const startIdx=(active.indexOf(seat)+1)%active.length;
    const ordered=[...active.slice(startIdx),...active.slice(0,startIdx)];
    G.toAct=ordered.filter(i=>
      room.seats[i]&&!room.seats[i].folded&&room.seats[i].chips>0&&room.seats[i].bet<G.currentBet);
  }

  setTimeout(()=>promptToAct(room), 200);
}

function advPhase(room) {
  const G=room.G;
  clearActionTimer(room);
  room.seats.forEach(s=>{if(s) s.bet=0;});
  G.currentBet=0;

  const nextPhase={preflop:'flop',flop:'turn',turn:'river'};

  if(G.phase in nextPhase) {
    G.phase=nextPhase[G.phase];
    const count=G.phase==='flop'?3:1;
    const newCards=[];
    for(let i=0;i<count;i++){ const c=G.deck.shift(); G.community.push(c); newCards.push(c); }
    broadcastAll(room, {type:'communityDealt',phase:G.phase,cards:G.community,newCards});
    broadcastState(room);

    const active=activeSeatsFull(room);
    // Post-flop action:
    // Heads-up: BB (non-dealer) acts first
    // Normal: first active player left of dealer
    const postStart = G.isHeadsUp ? G.bbSeat : nextSeat(room.dealerSeat, active);
    G.toAct=buildActOrder(room, postStart, active);
    setTimeout(()=>promptToAct(room), 600);

  } else {
    G.phase='showdown';
    showdown(room);
  }
}

function endRound(room) {
  clearActionTimer(room);
  const remaining=room.seats.filter(s=>s&&!s.folded);
  if(remaining.length===1) finish(room,remaining[0],'Last player standing');
}

function showdown(room) {
  clearActionTimer(room);
  const active=room.seats.filter(s=>s&&!s.folded);
  if(active.length===1){finish(room,active[0],'Last player standing');return;}

  broadcastAll(room, {type:'showdown',reveals:active.map(s=>({seat:s.seat,name:s.name,cards:s.cards}))});
  broadcastState(room);

  let best=null, bestScore=-1;
  for(const p of active) {
    const sc=evalBest([...p.cards,...room.G.community]);
    if(sc>bestScore){bestScore=sc;best=p;}
  }
  setTimeout(()=>finish(room, best, handName(bestScore)), 1200);
}

function finish(room, winner, label) {
  if(!winner) return;
  clearActionTimer(room);
  const won=room.G.pot;
  winner.chips+=won;
  room.G.pot=0;
  broadcastAll(room, {type:'winner',seat:winner.seat,name:winner.name,amount:won,label});
  broadcastState(room);

  setTimeout(()=>{
    room.seats.forEach((s,i)=>{
      if(s&&s.chips<=0){
        broadcastAll(room, {type:'playerLeft',id:s.id,name:s.name,seat:i,reason:'busted'});
        room.seats[i]=null;
      }
    });
    startNewHand(room);
  }, 5000);
}

function rv(r){return RVAL[r]||parseInt(r)||0;}

function evalBest(cards) {
  const cs=combs(cards,Math.min(cards.length,5));
  let best=0;
  for(const c of cs){const s=score5(c);if(s>best)best=s;}
  return best;
}

function combs(arr, k) {
  if(arr.length<=k) return [arr];
  if(k===1) return arr.map(x=>[x]);
  const out=[];
  for(let i=0;i<=arr.length-k;i++)
    for(const c of combs(arr.slice(i+1),k-1)) out.push([arr[i],...c]);
  return out;
}

function score5(cards) {
  const ranks=cards.map(c=>rv(c.r)).sort((a,b)=>b-a);
  const suits=cards.map(c=>c.s);
  const cnt={};
  for(const r of ranks) cnt[r]=(cnt[r]||0)+1;
  const freq=Object.values(cnt).sort((a,b)=>b-a);
  const flush=suits.every(s=>s===suits[0]);
  const uniq=[...new Set(ranks)].sort((a,b)=>b-a);
  let straight=uniq.length>=5&&(uniq[0]-uniq[4]===4);
  if(!straight&&uniq[0]===14){
    const low=uniq.slice(1);
    if(low.length>=4&&low[0]-low[3]===3&&low[3]===2) straight=true;
  }
  const base=ranks.reduce((a,r,i)=>a+r*Math.pow(15,4-i),0)/1e8;
  const hi=ranks[0];
  if(flush&&straight&&hi===14) return 9+base;
  if(flush&&straight) return 8+base;
  if(freq[0]===4) return 7+base;
  if(freq[0]===3&&freq[1]===2) return 6+base;
  if(flush) return 5+base;
  if(straight) return 4+base;
  if(freq[0]===3) return 3+base;
  if(freq[0]===2&&freq[1]===2) return 2+base;
  if(freq[0]===2) return 1+base;
  return base;
}

function handName(s) {
  if(s>=9) return 'Royal Flush';
  if(s>=8) return 'Straight Flush';
  if(s>=7) return 'Four of a Kind';
  if(s>=6) return 'Full House';
  if(s>=5) return 'Flush';
  if(s>=4) return 'Straight';
  if(s>=3) return 'Three of a Kind';
  if(s>=2) return 'Two Pair';
  if(s>=1) return 'One Pair';
  return 'High Card';
}

server.listen(PORT, ()=>{
  console.log('\n\u2663 SYFM Poker Server Running on port '+PORT+'\n');
});
