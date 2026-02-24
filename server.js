<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="SYFM Poker">
<meta name="mobile-web-app-capable" content="yes">
<title>SYFM Poker</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#1a0d05;font-family:'Segoe UI',Arial,sans-serif}
#gameUI{--sat:env(safe-area-inset-top,0px);--sar:env(safe-area-inset-right,0px);--sab:env(safe-area-inset-bottom,0px);--sal:env(safe-area-inset-left,0px)}
#c{width:100%;height:100%;display:block;touch-action:none}
.overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,5,2,0.88);z-index:200}
.panel{background:linear-gradient(160deg,#1c0e06 0%,#2a1408 100%);border:2px solid #c8a020;border-radius:16px;padding:36px 44px;min-width:340px;max-width:480px;width:90%;text-align:center;box-shadow:0 0 60px rgba(200,160,32,0.20)}
.panel h1{color:#ffd700;font-size:2.2rem;margin-bottom:8px;letter-spacing:2px}
.panel h2{color:#ffd700;font-size:1.5rem;margin-bottom:18px}
.panel h3{color:#c8a020;font-size:1rem;margin:14px 0 8px}
.panel p{color:#c8a060;margin-bottom:14px;line-height:1.5}
.panel input[type=text],.panel input[type=number]{width:100%;padding:12px 16px;margin:8px 0;border-radius:8px;background:#0d0704;border:1px solid #6a5010;color:#ffd700;font-size:1.1rem;outline:none;text-align:center}
.panel input:focus{border-color:#c8a020}
.btn-gold{width:100%;padding:14px;margin-top:14px;border-radius:8px;border:none;background:linear-gradient(135deg,#c8a020,#8a6a08);color:#000;font-size:1.1rem;font-weight:bold;cursor:pointer;letter-spacing:1px;transition:opacity .2s}
.btn-gold:hover{opacity:.85}
.btn-gold:disabled{opacity:.4;cursor:not-allowed}
.btn-sm{padding:8px 18px;border-radius:6px;border:none;font-size:.9rem;font-weight:bold;cursor:pointer;color:#fff;margin:4px}
.btn-approve{background:#1a6a1a}
.btn-reject{background:#6a1a1a}
.player-row{display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.05);border-radius:8px;padding:10px 14px;margin:6px 0;color:#e0c060;font-size:.95rem}
.player-row .chips{color:#ffd700;font-weight:bold}
.host-badge{font-size:.7rem;background:#c8a020;color:#000;padding:2px 7px;border-radius:4px;font-weight:bold;margin-left:8px}
.pending-row{display:flex;justify-content:space-between;align-items:center;background:rgba(200,160,32,0.1);border-radius:8px;padding:8px 12px;margin:4px 0;color:#e0c060}
#cookieOverlay{z-index:500}
#cookieOverlay .panel{max-width:560px;text-align:left;padding:32px 36px;overflow-y:auto;max-height:92vh}
#cookieOverlay h2{text-align:center;margin-bottom:4px;font-size:1.35rem}
.cookie-subtitle{color:#e09020;font-size:.82rem;letter-spacing:1px;text-transform:uppercase;text-align:center;margin-bottom:18px;display:block}
.cookie-table{width:100%;border-collapse:collapse;margin:14px 0 6px;font-size:.85rem}
.cookie-table th{background:rgba(200,160,32,0.18);color:#ffd700;padding:7px 10px;text-align:left;border:1px solid #4a3a10;font-size:.8rem;letter-spacing:.5px}
.cookie-table td{padding:7px 10px;border:1px solid #3a2a08;color:#d0b860;vertical-align:top;line-height:1.45}
.cookie-table tr:nth-child(even) td{background:rgba(255,255,255,0.03)}
.cookie-table td:first-child{color:#ffd700;font-weight:bold;white-space:nowrap;width:36%}
.cookie-uat{margin-top:16px;padding:10px 14px;background:rgba(180,40,40,0.18);border:1px solid #8a2020;border-radius:8px;color:#e08080;font-size:.85rem;line-height:1.5;text-align:center}
.cookie-uat strong{color:#ff9090}
.cookie-btns{display:flex;gap:10px;margin-top:20px}
.cookie-btns .btn-gold{flex:1;margin-top:0;font-size:1rem;padding:12px}
.btn-deny{flex:1;padding:12px;border-radius:8px;border:1px solid #6a2020;background:linear-gradient(135deg,#4a1a1a,#2a0a0a);color:#c06060;font-size:1rem;font-weight:bold;cursor:pointer;letter-spacing:1px;transition:opacity .2s}
.btn-deny:hover{opacity:.8}
#gameUI{display:none;position:fixed;inset:0;pointer-events:none;z-index:100}
#gameUI > *{pointer-events:auto}
#topBar{position:absolute;top:calc(10px + env(safe-area-inset-top,0px));left:calc(10px + env(safe-area-inset-left,0px));right:calc(10px + env(safe-area-inset-right,0px));background:rgba(0,0,0,0.80);padding:8px 14px;border-radius:8px;color:#ffd700;display:flex;justify-content:space-between;align-items:center;gap:6px}
#phase{font-size:14px;font-weight:bold;white-space:nowrap}
#pot{font-size:17px;font-weight:bold;white-space:nowrap}
#roomBadge{font-size:12px;color:#c8a060;padding:3px 8px;background:rgba(200,160,32,0.15);border-radius:6px;white-space:nowrap}
#actionPanel{position:fixed;left:0;top:50%;transform:translateY(-50%);display:none;flex-direction:column;gap:8px;z-index:110;width:200px;padding:10px;background:rgba(0,0,0,0.92);border-radius:0 16px 16px 0;border-right:2px solid #c8a020;border-top:1px solid #6a5010;border-bottom:1px solid #6a5010}
.abtn{padding:12px 8px;border-radius:8px;border:none;font-size:15px;font-weight:bold;cursor:pointer;color:#fff;width:100%;text-align:center;-webkit-tap-highlight-color:transparent;letter-spacing:0.5px}
.abtn-call{background:#1a7a1a;border-bottom:3px solid #0a4a0a}
.abtn-raise{background:#7a5800;border-bottom:3px solid #4a3000}
.abtn-allin{background:#8a7a00;border-bottom:3px solid #5a4a00;color:#ffe040}
.abtn-fold{background:#7a1a1a;border-bottom:3px solid #4a0a0a}
#drumWidget{width:100%;display:none;flex-direction:column;gap:3px;align-items:center}
/* ── Top-Down Dial Styling ── */
.dial-row{display:flex;gap:4px;justify-content:center;align-items:flex-end;width:100%;padding:2px 0}
.dial-wrap{display:flex;flex-direction:column;align-items:center;gap:2px;flex:1}
.dial-label{font-size:9px;color:#c8a060;text-align:center;letter-spacing:1px;text-transform:uppercase}
.dial-cog{width:80px;height:80px;cursor:grab;user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent;display:block;}
.dial-cog:active{cursor:grabbing}
.dial-hint{font-size:8px;color:rgba(200,160,32,0.5);text-align:center;letter-spacing:0.5px;margin-top:1px;}
.dial-sep{font-size:20px;font-weight:bold;color:#c8a060;line-height:1;padding-bottom:28px}
#tableSlider{position:absolute;right:calc(8px + env(safe-area-inset-right,0px));top:50%;transform:translateY(-50%);z-index:110;display:flex;flex-direction:column;align-items:center;gap:4px;background:rgba(0,0,0,0.6);border-radius:20px;padding:10px 7px;border:1px solid rgba(200,160,32,0.35)}
#tableSlider label{font-size:11px;color:#c8a060}
#tablePan{writing-mode:vertical-lr;direction:rtl;-webkit-appearance:slider-vertical;appearance:slider-vertical;width:36px;height:130px;cursor:pointer;accent-color:#c8a020}
#tablePan::-webkit-slider-thumb{-webkit-appearance:none;width:32px;height:32px;border-radius:50%;background:#c8a020;border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,0.6);cursor:pointer}
#tablePan::-moz-range-thumb{width:32px;height:32px;border-radius:50%;background:#c8a020;border:3px solid #fff;box-shadow:0 0 6px rgba(0,0,0,0.6);cursor:pointer}
#bottomBar{position:absolute;bottom:calc(52px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.88);padding:6px 20px;border-radius:10px;border:1px solid #6a5010;color:#c8a820;text-align:center;z-index:111;white-space:nowrap;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,0.6)}
#myInfo{font-size:14px;font-weight:bold;color:#ffd700;line-height:1.5;letter-spacing:0.5px}
#controlBar{position:absolute;bottom:calc(10px + env(safe-area-inset-bottom,0px));right:calc(10px + env(safe-area-inset-right,0px));display:flex;flex-direction:row;gap:5px;align-items:center;z-index:112}
.cbtn-pause{padding:9px 13px;border-radius:6px;border:none;font-size:18px;line-height:1;cursor:pointer;color:#fff;background:#1a4a7a}
.cbtn-pause.active{background:#c87020;box-shadow:0 0 8px rgba(200,120,32,0.7)}
.cbtn-cashout{padding:9px 11px;border-radius:6px;border:1px solid #c8a020;font-size:12px;font-weight:bold;cursor:pointer;color:#fff;background:#4a2a00;white-space:nowrap}
.cbtn-cashout.pending{background:#6a1a00;border-color:#ff6040;animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.65}}
.cbtn-autofold{padding:9px 11px;border-radius:6px;border:none;font-size:12px;font-weight:bold;cursor:pointer;color:#fff;background:#3a1a5a;white-space:nowrap;-webkit-tap-highlight-color:transparent}
.cbtn-autofold.active{background:#8a10cc;box-shadow:0 0 10px rgba(180,60,255,0.7)}
#stackEditor{position:absolute;bottom:calc(50px + env(safe-area-inset-bottom,0px));right:calc(10px + env(safe-area-inset-right,0px));background:rgba(0,0,0,0.93);border:1px solid #c8a020;border-radius:10px;padding:10px 12px;z-index:115;display:none;min-width:210px;max-height:60vh;overflow-y:auto}
#stackEditor h4{color:#ffd700;font-size:12px;margin:0 0 8px 0;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid #4a3a10;padding-bottom:5px}
.se-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.se-name{flex:1;color:#e0d0a0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.se-input{width:68px;background:#1a1000;border:1px solid #6a5010;border-radius:5px;color:#ffd700;font-size:13px;font-weight:bold;padding:4px 6px;text-align:right}
.se-input:focus{outline:none;border-color:#c8a020}
.se-btn{padding:4px 8px;border-radius:5px;border:none;background:#4a6a00;color:#fff;font-size:11px;font-weight:bold;cursor:pointer;white-space:nowrap}
.se-btn:active{background:#6a9a00}
.cbtn-fs{padding:9px 11px;border-radius:6px;border:none;font-size:14px;cursor:pointer;color:#c8a060;background:rgba(0,0,0,0.65);-webkit-tap-highlight-color:transparent;display:block}
@supports (-webkit-touch-callout:none) and (not (display:-webkit-box)){
  .cbtn-fs{display:none!important}
}
#msg{position:absolute;top:70px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.92);padding:14px 28px;border-radius:12px;color:#fff;font-size:18px;font-weight:bold;text-align:center;display:none;border:1px solid #c8a020;max-width:80%;white-space:pre-line;pointer-events:none}
#sideBoxes{position:absolute;top:58px;right:10px;display:flex;flex-direction:column;gap:6px;width:220px}
#chatBox{background:rgba(0,0,0,0.82);border-radius:8px;border:1px solid #3a2a10;overflow:hidden}
#chatBox.flash #chatHeader{animation:chatFlash 0.6s ease 3}
@keyframes chatFlash{0%{background:transparent}50%{background:rgba(200,160,32,0.35)}100%{background:transparent}}
#chatHeader{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;cursor:pointer;color:#c8a060;font-size:11px;font-weight:bold;user-select:none}
#chatHeader span{color:#a09060;font-size:10px}
#chatInner{padding:0 8px 8px;border-top:1px solid #3a2a10;display:none}
#chatLog{height:90px;overflow-y:auto;font-size:11px;color:#c8c8a0;margin-bottom:5px;display:flex;flex-direction:column;gap:2px}
#chatInput{width:100%;padding:5px 8px;border-radius:4px;border:1px solid #4a3a15;background:rgba(0,0,0,0.7);color:#ffd700;font-size:11px}
#activityBox{background:rgba(0,0,0,0.82);border-radius:8px;border:1px solid #2a3a1a;overflow:hidden}
#activityHeader{display:flex;justify-content:space-between;align-items:center;padding:7px 10px;cursor:pointer;color:#60c840;font-size:11px;font-weight:bold;user-select:none}
#activityHeader span{color:#a0d070;font-size:10px}
#activityLog{height:160px;overflow-y:auto;font-size:10px;color:#b0d890;padding:4px 8px 6px;display:none;flex-direction:column;gap:2px;border-top:1px solid #1a2a10}
#activityLog .log-hand{color:#ffd700;font-weight:bold;margin-top:3px}
#activityLog .log-action{color:#90c870}
#activityLog .log-win{color:#40e870;font-weight:bold}
#activityLog .log-community{color:#a0b8ff}
#activityLog .log-fold{color:#e07050}
#activityLog .log-system{color:#c8a060;font-style:italic}
#waitingMsg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.88);padding:20px 32px;border-radius:14px;color:#c8a020;font-size:16px;text-align:center;display:none;border:1px solid #6a5010;pointer-events:none}
#joinRequestNotif{position:absolute;top:58px;right:240px;background:rgba(10,40,10,0.95);padding:12px 14px;border-radius:10px;color:#e0e0e0;font-size:13px;display:none;border:1px solid #20a040;min-width:200px;z-index:10}
#joinRequestNotif h4{color:#40e060;margin-bottom:6px;font-size:14px}
#joinReqList{display:flex;flex-direction:column;gap:5px}
.jr-row{display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.07);padding:5px 8px;border-radius:6px}
.jr-name{color:#ffd700;font-weight:bold;font-size:12px}
.jr-btns{display:flex;gap:4px}
.jr-admit{background:#1a6a1a;border:none;color:#fff;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold}
.jr-reject{background:#6a1a1a;border:none;color:#fff;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:bold}
#turnIndicator{position:absolute;bottom:52px;left:120px;color:#ffd700;font-size:13px;font-weight:bold;pointer-events:none;text-shadow:0 0 8px rgba(0,0,0,0.9);display:none;background:rgba(0,0,0,0.80);padding:6px 14px;border-radius:8px;border:1px solid #6a5010;max-width:240px;word-wrap:break-word}
#spectatorBanner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.88);padding:16px 32px;border-radius:14px;color:#c8a020;font-size:16px;text-align:center;display:none;border:1px solid #6a5010;pointer-events:none;z-index:50}
#pauseBanner{position:absolute;top:0;left:0;right:0;bottom:0;display:none;pointer-events:none;z-index:50}
#toggleViewBtn{
  position:fixed;top:12px;right:12px;z-index:9999;
  height:44px;padding:0 14px;border-radius:22px;
  border:2px solid #c8a020;
  background:rgba(10,5,2,0.94);
  color:#ffd700;font-size:13px;font-weight:bold;letter-spacing:1px;
  cursor:pointer;display:none;
  box-shadow:0 0 0 3px rgba(200,160,32,0.25),0 4px 18px rgba(0,0,0,0.7);
  -webkit-tap-highlight-color:transparent;
  transition:background 0.2s,box-shadow 0.2s;
  display:none;align-items:center;gap:7px;white-space:nowrap;
}
#toggleViewBtn:active{background:rgba(200,160,32,0.3);box-shadow:0 0 0 5px rgba(200,160,32,0.4)}
#toggleViewBtn.mode2d{background:rgba(200,160,32,0.18);border-color:#ffd700;box-shadow:0 0 0 3px rgba(200,160,32,0.5),0 4px 18px rgba(0,0,0,0.7)}
#view2d{
  display:none;position:fixed;inset:0;
  background:#1a0d05;overflow:hidden;
  z-index:90;
}
#table2d{
  position:absolute;top:50%;left:50%;
  transform:translate(-50%,-50%);
  width:min(92vw,560px);height:min(58vw,360px);
  background:radial-gradient(ellipse at center,#0d3a18 0%,#072010 60%,#041408 100%);
  border-radius:50%;
  border:4px solid #1a5a28;
  box-shadow:0 0 0 6px #0a2a10,0 0 60px rgba(0,0,0,0.8),inset 0 0 40px rgba(0,0,0,0.5);
}
#table2dInner{position:relative;width:100%;height:100%;}
#table2dCenter{
  position:absolute;top:50%;left:50%;
  transform:translate(-50%,-52%);
  display:flex;flex-direction:column;align-items:center;gap:5px;
  pointer-events:none;
}
#pot2d{text-align:center;}
#pot2d .pot-label{color:#c8a060;font-size:9px;letter-spacing:2px;text-transform:uppercase}
#pot2d .pot-val{color:#ffd700;font-size:17px;font-weight:bold;text-shadow:0 0 10px rgba(200,160,32,0.7)}
#community2d{display:flex;gap:4px;overflow:visible;}
.c2d-card{
  position:relative;
  width:72px;height:102px;border-radius:7px;
  background:#fff;border:1px solid #ccc;
  box-shadow:0 2px 10px rgba(0,0,0,0.5);
  flex-shrink:0;
}
.c2d-card.back{background:#1a3a8a;border-color:#2a4aaa;}
.c2d-card.red{color:#cc2020;}
.c2d-card.black{color:#111;}
.p2d-seat{
  position:absolute;transform:translate(-50%,-50%);
  display:flex;flex-direction:row;align-items:center;gap:5px;
  pointer-events:none;
}
.p2d-info{display:flex;flex-direction:column;align-items:flex-start;gap:2px;max-width:74px;}
.p2d-name{
  font-size:10px;font-weight:bold;color:#e0d0a0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  max-width:74px;
  background:rgba(0,0,0,0.78);border-radius:4px;padding:2px 5px;
}
.p2d-name.me{color:#ffd700;background:rgba(200,160,32,0.22)}
.p2d-name.folded{color:#555;text-decoration:line-through}
.p2d-stack{font-size:9px;color:#80cfff;background:rgba(0,0,0,0.65);border-radius:3px;padding:1px 4px;}
.p2d-bet{font-size:9px;color:#40e860;background:rgba(0,0,0,0.65);border-radius:3px;padding:1px 4px;}
.p2d-cards{display:flex;gap:4px;}
.p2d-card{
  position:relative;
  width:70px;height:99px;border-radius:7px;
  background:#fff;border:1px solid #aaa;
  box-shadow:0 2px 8px rgba(0,0,0,0.5);
  flex-shrink:0;
}
.p2d-seat.me .p2d-card{width:90px;height:126px;border-radius:9px;box-shadow:0 3px 14px rgba(0,0,0,0.6);}
.p2d-card.back,.c2d-card.back{background:#1a3a8a;border-color:#2a4aaa;}
.p2d-card.red,.c2d-card.red{color:#cc2020;}
.p2d-card.black,.c2d-card.black{color:#111;}
.p2d-card.folded{background:#3a3a3a;border-color:#222;opacity:0.5;}
.p2dc-tl{position:absolute;top:3px;left:4px;font-size:11px;font-weight:bold;line-height:1.15;text-align:left;}
.p2dc-br{position:absolute;bottom:3px;right:4px;font-size:11px;font-weight:bold;line-height:1.15;text-align:left;transform:rotate(180deg);}
.c2d-card .p2dc-tl,.c2d-card .p2dc-br{font-size:13px;}
.p2d-seat.me .p2d-card .p2dc-tl,.p2d-seat.me .p2d-card .p2dc-br{font-size:14px;}
.p2dc-center{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  display:flex;align-items:center;gap:3px;
  font-weight:bold;line-height:1;white-space:nowrap;
}
.p2dc-center .p2dc-rank{font-size:28px;font-weight:900;}
.p2dc-center .p2dc-suit{font-size:28px;}
.c2d-card .p2dc-center .p2dc-rank{font-size:36px;}
.c2d-card .p2dc-center .p2dc-suit{font-size:36px;}
.p2d-seat.me .p2d-card .p2dc-center .p2dc-rank{font-size:36px;}
.p2d-seat.me .p2d-card .p2dc-center .p2dc-suit{font-size:36px;}
#stackInfo2d{
  position:fixed;
  bottom:calc(56px + env(safe-area-inset-bottom,0px));
  right:calc(10px + env(safe-area-inset-right,0px));
  background:rgba(0,0,0,0.88);
  border:1px solid #6a5010;border-radius:8px;
  padding:5px 12px;color:#ffd700;
  font-size:13px;font-weight:bold;
  text-align:right;white-space:nowrap;
  display:none;z-index:112;pointer-events:none;
  box-shadow:0 2px 10px rgba(0,0,0,0.6);
}
.p2d-token{
  display:inline-block;font-size:8px;font-weight:bold;
  border-radius:3px;padding:1px 3px;margin-right:2px;
}
.p2d-token.dealer{background:#c8a020;color:#000}
.p2d-token.sb{background:#1a6a1a;color:#fff}
.p2d-token.bb{background:#1a1a8a;color:#fff}
.p2d-token.toact{background:#cc2020;color:#fff;animation:p2dPulse 0.8s ease-in-out infinite}
@keyframes p2dPulse{0%,100%{opacity:1}50%{opacity:0.5}}
.p2d-waiting{color:#888;font-size:9px;font-style:italic}
</style>
</head>
<body>
<canvas id="c"></canvas>

<button id="toggleViewBtn" onclick="toggle2D()" title="Switch to 2D view">
  <svg width="18" height="18" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
    <circle cx="18" cy="18" r="16" fill="#2a1a00" stroke="#c8a020" stroke-width="3"/>
    <circle cx="18" cy="18" r="10" fill="none" stroke="#c8a020" stroke-width="2"/>
    <line x1="18" y1="2" x2="18" y2="8" stroke="#c8a020" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="18" y1="28" x2="18" y2="34" stroke="#c8a020" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="2" y1="18" x2="8" y2="18" stroke="#c8a020" stroke-width="2.5" stroke-linecap="round"/>
    <line x1="28" y1="18" x2="34" y2="18" stroke="#c8a020" stroke-width="2.5" stroke-linecap="round"/>
  </svg>
  <span id="toggleViewLabel">→2D</span>
</button>

<div id="view2d">
  <div id="table2d">
    <div id="table2dInner">
      <div id="table2dCenter">
        <div id="msg2d" style="display:none;background:rgba(0,0,0,0.92);border:1px solid #c8a020;border-radius:10px;padding:8px 18px;color:#fff;font-size:15px;font-weight:bold;text-align:center;white-space:pre-line;max-width:260px;pointer-events:none;"></div>
        <div id="pot2d">
          <div class="pot-label">POT</div>
          <div class="pot-val" id="pot2dVal">£0.00</div>
        </div>
        <div id="community2d"></div>
      </div>
    </div>
  </div>
</div>
<div id="cookieOverlay" class="overlay">
  <div class="panel">
    <h2>🍪 Cookie Notice</h2>
    <span class="cookie-subtitle">Please read before continuing</span>
    <p style="color:#c8a060;font-size:.9rem;line-height:1.6;margin-bottom:4px">
      Whilst no cookies are deliberately created to track you or your behaviour,
      the following data is stored locally and on our server for the purposes of
      playing this game online:
    </p>
    <table class="cookie-table">
      <thead>
        <tr><th>Feature</th><th>How it's handled</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>User Identity</td>
          <td>Generated as a random string and saved in Local Storage.</td>
        </tr>
        <tr>
          <td>Session Tracking</td>
          <td>Handled by a persistent WebSocket connection (ws).</td>
        </tr>
        <tr>
          <td>Game History</td>
          <td>Written to text files on the server disk and uploaded via FTP. This is used during development for debug purposes.</td>
        </tr>
        <tr>
          <td>Reconnection</td>
          <td>The client reads the ID from Local Storage and sends it to the server to &ldquo;resume&rdquo; their seat.</td>
        </tr>
      </tbody>
    </table>
    <div class="cookie-uat">
      ⚠️ <strong>Development &amp; UAT Notice</strong><br>
      This game is in development and UAT.<br>
      You should <strong>never</strong> bet any real money using this game.
    </div>
    <div class="cookie-btns">
      <button class="btn-gold" onclick="cookieAccept()">✅ Accept &amp; Continue</button>
      <button class="btn-deny" onclick="cookieDeny()">✖ Deny</button>
    </div>
  </div>
</div>

<div id="loginOverlay" class="overlay" style="display:none">
  <div class="panel">
    <svg width="72" height="72" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg" style="margin-bottom:8px">
      <circle cx="36" cy="36" r="34" fill="#1a1a1a" stroke="#c8a020" stroke-width="4"/>
      <g opacity="0.9">
        <path d="M36 2 A34 34 0 0 1 62.4 19" stroke="#c8a020" stroke-width="8" fill="none" stroke-linecap="butt"/>
        <path d="M62.4 19 A34 34 0 0 1 68.8 47" stroke="#2a1408" stroke-width="8" fill="none" stroke-linecap="butt"/>
        <path d="M68.8 47 A34 34 0 0 1 50 66.5" stroke="#c8a020" stroke-width="8" fill="none" stroke-linecap="butt"/>
        <path d="M50 66.5 A34 34 0 0 1 22 66.5" stroke="#2a1408" stroke-width="8" fill="none" stroke-linecap="butt"/>
        <path d="M22 66.5 A34 34 0 0 1 3.2 47" stroke="#c8a020" stroke-width="8" fill="none" stroke-linecap="butt"/>
        <path d="M3.2 47 A34 34 0 0 1 9.6 19" stroke="#2a1408" stroke-width="8" fill="none" stroke-linecap="butt"/>
        <path d="M9.6 19 A34 34 0 0 1 36 2" stroke="#c8a020" stroke-width="8" fill="none" stroke-linecap="butt"/>
      </g>
      <circle cx="36" cy="36" r="24" fill="#1c0e06" stroke="#c8a020" stroke-width="2.5"/>
      <circle cx="36" cy="36" r="20" fill="none" stroke="rgba(200,160,32,0.3)" stroke-width="1"/>
      <text x="36" y="40" font-family="Arial" font-weight="bold" font-size="9" fill="#ffd700" text-anchor="middle">SYFM</text>
    </svg>
    <h1 style="font-size:2.4rem;letter-spacing:4px;margin-bottom:4px">SYFM</h1>
    <div style="color:#c8a060;font-size:0.95rem;letter-spacing:6px;margin-bottom:18px;text-transform:uppercase">Poker</div>
    <p>Enter your name and a room number to play</p>
    <input type="text" id="nameInput" placeholder="Your name" maxlength="18" autocomplete="off">
    <input type="number" id="roomInput" placeholder="Room number (e.g. 1234)" min="1" max="999999">
    <button class="btn-gold" id="joinBtn">JOIN ROOM</button>
    <p id="loginErr" style="color:#e05050;margin-top:10px;font-size:.9rem"></p>
  </div>
</div>

<div id="buyBackOverlay" class="overlay" style="display:none">
  <div class="panel">
    <h2>💸 Out of Chips!</h2>
    <p id="buyBackMsg">You've run out of chips. Buy back in for <strong>£10.00</strong>?</p>
    <p style="color:#e09020;font-size:22px;font-weight:bold;margin:4px 0">⏱ <span id="buyBackTimer">15</span>s</p>
    <button class="btn-gold" onclick="respondBuyBack(true)">✅ BUY BACK IN — £10.00</button>
    <button class="btn-gold" style="background:linear-gradient(135deg,#6a1a1a,#3a0a0a);margin-top:8px" onclick="respondBuyBack(false)">👀 Watch as Spectator</button>
  </div>
</div>

<div id="waitingOverlay" class="overlay" style="display:none">
  <div class="panel">
    <h2>&#9203; Waiting for host&hellip;</h2>
    <p id="waitingTxt">The host will approve your entry shortly.</p>
    <button class="btn-gold" onclick="location.reload()" style="margin-top:10px">Cancel</button>
  </div>
</div>
<div id="lobbyOverlay" class="overlay" style="display:none">
  <div class="panel">
    <h2>&#127920; Room <span id="lobbyRoomId"></span></h2>
    <div id="playerList"></div>
    <div id="pendingSection" style="display:none">
      <h3>&#9203; Requesting to join:</h3>
      <div id="pendingItems"></div>
    </div>
    <p id="lobbyStatus" style="color:#c8a060;margin-top:14px;font-size:.9rem"></p>
    <button class="btn-gold" id="startBtn" style="display:none;margin-top:18px">&#9654; START GAME</button>
  </div>
</div>
<div id="gameUI">
  <div id="topBar">
    <div id="phase">PRE-FLOP</div>
    <div id="pot">POT: &pound;0.00</div>
    <div id="myNameBadge" style="font-size:12px;color:#80cfff;padding:3px 8px;background:rgba(0,80,160,0.25);border-radius:6px;white-space:nowrap"></div>
    <div id="roomBadge">ROOM &mdash;</div>
  </div>
  <div id="actionPanel">
    <button class="abtn abtn-call" id="callBtn" style="display:none">CHECK</button>
    <div id="drumWidget">
      <div class="dial-row">
        <div class="dial-wrap">
          <div class="dial-label">£ pounds</div>
          <canvas class="dial-cog" id="dialPounds" width="80" height="80"></canvas>
          <div class="dial-hint">◄ roll ►</div>
        </div>
        <div class="dial-sep">.</div>
        <div class="dial-wrap">
          <div class="dial-label">20p steps</div>
          <canvas class="dial-cog" id="dialPence" width="80" height="80"></canvas>
          <div class="dial-hint">◄ roll ►</div>
        </div>
      </div>
    </div>
    <button class="abtn abtn-raise" id="raiseBtn" style="display:none">BET £0.40</button>
    <button class="abtn abtn-allin" id="allInBtn" style="display:none">ALL IN</button>
    <button class="abtn abtn-fold" id="foldBtn" style="display:none">FOLD</button>
  </div>
  <div id="drumOverlay" style="display:none"></div>
  <div id="bottomBar">
    <div id="myInfo">Stack £10.00</div>
  </div>
  <div id="tableSlider">
    <label>▲</label>
    <input type="range" id="tablePan" min="-3" max="3" step="0.1" value="0.5">
    <label>▼</label>
  </div>
  <div id="stackEditor">
    <h4>🔧 Host Controls</h4>
    <div class="se-row" style="margin-bottom:10px;border-bottom:1px solid #4a3a10;padding-bottom:10px">
      <span class="se-name" style="color:#ffd700">Buy-in £</span>
      <input class="se-input" id="buyInInput" type="number" min="1" step="1" value="10.00" style="width:72px">
      <button class="se-btn" id="buyInBtn" onclick="applyBuyIn()" style="background:#1a3a6a">SET</button>
    </div>
    <div style="color:#888;font-size:10px;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">Player stacks</div>
    <div id="stackEditorRows"></div>
  </div>
  <div id="stackInfo2d"></div>
  <div id="controlBar">
    <button class="cbtn-pause" id="pauseBtn" onclick="togglePause()">⏸</button>
    <button class="cbtn-cashout" id="cashOutBtn" onclick="doCashOut()">CASH OUT</button>
    <button class="cbtn-autofold" id="autoFoldBtn" onclick="toggleAutoFold()">AUTO-FOLD</button>
    <button class="cbtn-autofold" id="stackEditorBtn" onclick="toggleStackEditor()" style="display:none;background:#2a4a1a">🔧</button>
    <button class="cbtn-fs" id="fsBtn" onclick="toggleFullscreen()" title="Fullscreen">⛶</button>
  </div>
  <div id="pauseBanner"></div>
  <div id="spectatorBanner">👀 You are spectating — no cards will be dealt to you</div>
  <div id="msg"></div>
  <div id="waitingMsg"></div>
  <div id="joinRequestNotif">
    <h4>&#9203; Players want to join</h4>
    <div id="joinReqList"></div>
  </div>
  <div id="turnIndicator"></div>
  <div id="sideBoxes">
    <div id="chatBox">
      <div id="chatHeader" onclick="toggleChat()">&#128172; CHAT <span id="chatToggle">&#9654; expand</span></div>
      <div id="chatInner">
        <div id="chatLog"></div>
        <input type="text" id="chatInput" placeholder="Type and press Enter&hellip;" maxlength="100">
      </div>
    </div>
    <div id="activityBox">
      <div id="activityHeader" onclick="toggleActivityLog()">&#128203; LOG <span id="activityToggle">&#9654; expand</span></div>
      <div id="activityLog"></div>
    </div>
  </div>
</div>
<script src="https://cdn.babylonjs.com/babylon.js"></script>
<script>
'use strict';
let audioCtx;
function ensureAudio(){if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();}
function snd_deal(){ensureAudio();const t=audioCtx.currentTime,len=Math.floor(audioCtx.sampleRate*0.12),buf=audioCtx.createBuffer(1,len,audioCtx.sampleRate),d=buf.getChannelData(0);for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*Math.pow(Math.sin(Math.PI*i/len),0.6);const src=audioCtx.createBufferSource(),bp=audioCtx.createBiquadFilter();bp.type='bandpass';bp.Q.value=0.6;bp.frequency.setValueAtTime(4200,t);bp.frequency.exponentialRampToValueAtTime(1600,t+0.12);const g=audioCtx.createGain();g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(0.28,t+0.015);g.gain.exponentialRampToValueAtTime(0.001,t+0.12);src.buffer=buf;src.connect(bp);bp.connect(g);g.connect(audioCtx.destination);src.start(t);}
function snd_flip(){ensureAudio();const t=audioCtx.currentTime,b=audioCtx.createBuffer(1,Math.floor(audioCtx.sampleRate*0.055),audioCtx.sampleRate),d=b.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/d.length,1.6);const src=audioCtx.createBufferSource(),g=audioCtx.createGain(),hp=audioCtx.createBiquadFilter();hp.type='highpass';hp.frequency.value=2200;g.gain.setValueAtTime(0.32,t);g.gain.exponentialRampToValueAtTime(0.001,t+0.055);src.buffer=b;src.connect(hp);hp.connect(g);g.connect(audioCtx.destination);src.start(t);}
function snd_chip(){ensureAudio();const t=audioCtx.currentTime,base=1600+Math.random()*500;[[1.0,0.16],[1.52,0.09],[2.51,0.05],[3.97,0.025]].forEach(([r,v])=>{const osc=audioCtx.createOscillator(),g=audioCtx.createGain();osc.type='sine';osc.frequency.value=base*r*(0.97+Math.random()*0.06);g.gain.setValueAtTime(v,t);g.gain.exponentialRampToValueAtTime(0.0001,t+0.09+r*0.022);osc.connect(g);g.connect(audioCtx.destination);osc.start(t);osc.stop(t+0.14);});}
function snd_win(){ensureAudio();const t=audioCtx.currentTime;[523,659,784,1047,1319].forEach((f,i)=>{const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='triangle';o.frequency.value=f;g.gain.setValueAtTime(0,t+i*0.10);g.gain.linearRampToValueAtTime(0.12,t+i*0.10+0.04);g.gain.exponentialRampToValueAtTime(0.001,t+i*0.10+0.55);o.connect(g);o.connect(audioCtx.destination);o.start(t+i*0.10);o.stop(t+i*0.10+0.6);});}

/* --- Wheel Dials Implementation --- */
class WheelDial {
    constructor(canvasId, onChange) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        this.onChange = onChange;
        this.angle = 0; 
        this.isDragging = false;
        this.lastY = 0;
        this.size = 80;
        this.initEvents();
        this.draw();
    }
    initEvents() {
        const start = (e) => {
            this.isDragging = true;
            this.lastY = e.touches ? e.touches[0].clientY : e.clientY;
        };
        const move = (e) => {
            if (!this.isDragging) return;
            const currentY = e.touches ? e.touches[0].clientY : e.clientY;
            const dy = currentY - this.lastY;
            if (Math.abs(dy) > 1) {
                const direction = dy > 0 ? -1 : 1;
                this.angle += direction * 0.15;
                this.lastY = currentY;
                this.onChange(direction);
                this.draw();
            }
        };
        const end = () => this.isDragging = false;
        this.canvas.addEventListener('mousedown', start);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', end);
        this.canvas.addEventListener('touchstart', start, {passive:false});
        window.addEventListener('touchmove', move, {passive:false});
        window.addEventListener('touchend', end);
    }
    draw() {
        const ctx = this.ctx;
        const center = this.size / 2;
        const radius = this.size / 2 - 5;
        ctx.clearRect(0, 0, this.size, this.size);

        // Rim Shadow
        ctx.beginPath();
        ctx.arc(center, center, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#0a0502';
        ctx.fill();

        // Main Wheel Gradient (Metallic look)
        const grad = ctx.createRadialGradient(center, center, radius * 0.5, center, center, radius);
        grad.addColorStop(0, '#3a2a10');
        grad.addColorStop(0.8, '#6a5010');
        grad.addColorStop(1, '#2a1a08');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(center, center, radius, 0, Math.PI * 2);
        ctx.fill();

        // Outer Gold Border
        ctx.strokeStyle = '#c8a020';
        ctx.lineWidth = 3;
        ctx.stroke();

        // Notches (to visualize rotation)
        ctx.save();
        ctx.translate(center, center);
        ctx.rotate(this.angle);
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.4)';
        ctx.lineWidth = 4;
        for (let i = 0; i < 12; i++) {
            ctx.beginPath();
            ctx.moveTo(0, -radius + 4);
            ctx.lineTo(0, -radius + 12);
            ctx.stroke();
            ctx.rotate(Math.PI / 6);
        }
        ctx.restore();

        // Center Cap
        ctx.beginPath();
        ctx.arc(center, center, radius * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = '#1a0d05';
        ctx.fill();
        ctx.strokeStyle = '#c8a020';
        ctx.lineWidth = 1;
        ctx.stroke();
    }
}

let dialP, dialC;
window.addEventListener('DOMContentLoaded', () => {
    dialP = new WheelDial('dialPounds', (dir) => adjustBet(dir, 1));
    dialC = new WheelDial('dialPence', (dir) => adjustBet(dir, 0.2));
});

function adjustBet(dir, amt) {
    if (dir > 0) currentBetAmount += amt;
    else currentBetAmount -= amt;
    updateRaiseUI();
    snd_chip();
}

// ... rest of game logic continues here ...
</script>
</body>
</html>
