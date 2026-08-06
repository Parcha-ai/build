import { createHash } from 'crypto';
import { CachedStore } from '../cached-store';
import { getSessionStoreName } from '../store-names';
import type {
  RemoteVoiceDeploymentStatus,
  Session,
  SSHConfig,
} from '../../shared/types';
import { OPENAI_REALTIME_MODEL } from '../../shared/types/audio';
import { AudioService } from './audio.service';
import { REMOTE_BUILD_CLI_SOURCE } from './remote-build-cli-source';
import { sshService } from './ssh.service';
import { getVoiceMemoryService } from './voice-memory.service';

const REMOTE_SERVER_PORT = 42_780;
const REMOTE_VOICE_SERVE_PORT = 8_443;
const REMOTE_RUNTIME_VERSION = 4;

interface ActiveRemoteVoiceDeployment {
  status: RemoteVoiceDeploymentStatus;
  dnsName: string;
  remoteDirectory: string;
  servePort: number;
  session: Session;
  sshConfig: SSHConfig;
}

interface PersistedRemoteVoiceDeployment {
  sessionId: string;
  dnsName: string;
  remoteDirectory: string;
  servePort: number;
  url: string;
  startedAt: number;
}

// This is deliberately dependency-free so Build can deploy it to any SSH host
// with Node installed. The browser, Realtime bootstrap, harness process, state,
// and transcript all stay on that host after the desktop app exits.
const REMOTE_VOICE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#090a0e">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Build Remote Agent</title>
  <style>
    :root { color-scheme:dark; --app-height:100dvh; --bg:#090a0e; --panel:#111218; --panel-2:#17181f; --line:#292a33; --text:#f3f0eb; --muted:#8b8d98; --faint:#62646f; --amber:#d97757; --violet:#b979ff; --mint:#49d69a; }
    * { box-sizing:border-box; }
    html,body { height:100%; overscroll-behavior:none; }
    body { margin:0; height:var(--app-height); overflow:hidden; background:var(--bg); color:var(--text); font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
    button,textarea { font:inherit; }
    button { -webkit-tap-highlight-color:transparent; }
    .ambient { position:fixed; inset:-35%; pointer-events:none; background:radial-gradient(circle at 28% 18%,rgba(185,121,255,.09),transparent 28%),radial-gradient(circle at 78% 82%,rgba(217,119,87,.08),transparent 30%); filter:blur(28px); }
    .app { position:relative; z-index:1; width:min(900px,100%); height:var(--app-height); margin:auto; display:grid; grid-template-rows:auto minmax(0,1fr) auto; background:rgba(9,10,14,.94); border-inline:1px solid rgba(255,255,255,.035); }
    .topbar { min-height:68px; padding:max(12px,env(safe-area-inset-top)) clamp(14px,3vw,24px) 11px; display:flex; align-items:center; justify-content:space-between; gap:14px; border-bottom:1px solid rgba(255,255,255,.065); background:rgba(9,10,14,.84); backdrop-filter:blur(22px); }
    .identity { min-width:0; display:flex; align-items:center; gap:11px; }
    .mark { flex:none; width:36px; height:36px; display:grid; place-items:center; border:1px solid #343640; border-radius:11px; color:#f5eee8; background:linear-gradient(145deg,rgba(185,121,255,.18),rgba(217,119,87,.12)),#121319; box-shadow:0 8px 28px rgba(0,0,0,.32),inset 0 1px rgba(255,255,255,.08); font:700 16px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .identity-copy { min-width:0; }
    .product { color:#8d8f9a; font:700 9px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.13em; text-transform:uppercase; }
    #session { margin-top:4px; overflow:hidden; color:#f3f0eb; font-size:14px; font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
    #host { color:#747681; font:10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .connection { flex:none; max-width:42%; display:flex; align-items:center; gap:7px; border:1px solid #292b34; border-radius:999px; padding:7px 10px; color:#9b9da7; background:rgba(20,21,27,.8); font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:nowrap; }
    .connection-dot { width:6px; height:6px; flex:none; border-radius:50%; background:#70727c; box-shadow:0 0 0 3px rgba(112,114,124,.1); }
    body.connected .connection-dot { background:var(--mint); box-shadow:0 0 10px rgba(73,214,154,.75); }
    body.speaking .connection-dot { background:var(--violet); box-shadow:0 0 10px rgba(185,121,255,.75); }
    body.listening .connection-dot { background:var(--amber); box-shadow:0 0 10px rgba(217,119,87,.75); }
    #status { overflow:hidden; text-overflow:ellipsis; }
    .conversation { min-height:0; overflow-y:auto; overscroll-behavior:contain; scroll-behavior:smooth; scrollbar-gutter:stable; padding:clamp(18px,4vw,34px) clamp(14px,4vw,30px) 32px; }
    .welcome { min-height:100%; display:grid; align-content:center; justify-items:center; padding:26px 0 44px; text-align:center; }
    .welcome[hidden] { display:none; }
    .welcome-orb { position:relative; width:82px; height:82px; display:grid; place-items:center; border:1px solid rgba(255,255,255,.13); border-radius:50%; color:#eee8e4; background:radial-gradient(circle at 34% 25%,rgba(255,255,255,.17),rgba(217,119,87,.14) 37%,rgba(23,20,29,.96) 73%); box-shadow:inset 0 0 24px rgba(185,121,255,.13),0 18px 58px rgba(0,0,0,.48),0 0 40px rgba(185,121,255,.09); }
    .welcome-orb:before,.welcome-orb:after { content:""; position:absolute; border:1px solid rgba(185,121,255,.16); border-radius:50%; }
    .welcome-orb:before { inset:-12px; }
    .welcome-orb:after { inset:-23px; opacity:.45; }
    .welcome-orb svg { width:29px; height:29px; }
    .welcome h1 { max-width:620px; margin:34px 0 9px; font-size:clamp(24px,6vw,38px); font-weight:580; letter-spacing:-.035em; line-height:1.12; }
    .welcome p { max-width:520px; margin:0; color:#92949e; font-size:14px; }
    .suggestions { width:min(620px,100%); margin-top:28px; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; }
    .suggestion { min-height:64px; border:1px solid #292b34; border-radius:14px; padding:11px 12px; color:#c4c2bf; background:rgba(19,20,26,.78); text-align:left; cursor:pointer; transition:border-color .16s,background .16s,transform .16s; }
    .suggestion:hover { border-color:#42444f; background:#171820; transform:translateY(-1px); }
    .suggestion strong { display:block; margin-bottom:3px; color:#efebe6; font-size:12px; font-weight:620; }
    .suggestion span { display:block; color:#777984; font-size:10px; line-height:1.35; }
    .messages { width:min(760px,100%); margin:auto; }
    .message { display:grid; grid-template-columns:31px minmax(0,1fr); gap:11px; margin:0 0 25px; animation:message-in .2s ease-out both; }
    .message[data-who="You"] { grid-template-columns:minmax(0,1fr); justify-items:end; margin-top:6px; }
    .avatar { width:30px; height:30px; display:grid; place-items:center; border:1px solid #343640; border-radius:9px; color:#ece7e2; background:linear-gradient(145deg,rgba(185,121,255,.14),rgba(217,119,87,.09)),#14151b; font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .message[data-who="You"] .avatar,.message[data-who="You"] .message-label { display:none; }
    .message-main { min-width:0; max-width:100%; }
    .message[data-who="You"] .message-main { max-width:min(84%,620px); }
    .message-label { margin:1px 0 6px; color:#8b8d98; font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.06em; text-transform:uppercase; }
    .message-card { position:relative; min-width:0; color:#dedbd7; font-size:15px; line-height:1.65; overflow-wrap:anywhere; }
    .message[data-who="You"] .message-card { border:1px solid #353640; border-radius:18px 18px 5px 18px; padding:10px 14px; color:#f0ede9; background:#202128; box-shadow:0 7px 24px rgba(0,0,0,.16); }
    .rich-text > :first-child { margin-top:0; }
    .rich-text > :last-child { margin-bottom:0; }
    .rich-text p { margin:0 0 11px; white-space:pre-wrap; }
    .rich-text h1,.rich-text h2,.rich-text h3 { margin:19px 0 8px; color:#f4f1ec; line-height:1.25; letter-spacing:-.02em; }
    .rich-text h1 { font-size:21px; } .rich-text h2 { font-size:18px; } .rich-text h3 { font-size:16px; }
    .rich-text ul,.rich-text ol { margin:7px 0 13px; padding-left:22px; }
    .rich-text li { margin:4px 0; }
    .rich-text blockquote { margin:9px 0 13px; border-left:2px solid rgba(185,121,255,.48); padding-left:12px; color:#b7b4ba; }
    .rich-text pre { max-width:100%; margin:12px 0; overflow:auto; border:1px solid #2e3038; border-radius:11px; padding:13px; color:#dedce5; background:#0d0e12; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; -webkit-overflow-scrolling:touch; }
    .rich-text code.inline { border:1px solid rgba(255,255,255,.07); border-radius:5px; padding:1px 5px; color:#d9b8fb; background:#18161d; font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .rich-text strong { color:#f4f1ec; font-weight:680; }
    .rich-text a { color:#b993e4; text-decoration-color:rgba(185,121,255,.42); text-underline-offset:3px; }
    .typing { display:flex; align-items:center; gap:4px; height:25px; }
    .typing i { width:5px; height:5px; border-radius:50%; background:#8f729f; animation:typing 1.15s ease-in-out infinite; }
    .typing i:nth-child(2) { animation-delay:-.86s; } .typing i:nth-child(3) { animation-delay:-.58s; }
    .activity { display:flex; align-items:flex-start; gap:10px; margin:2px 0 20px 42px; border:1px solid #272932; border-radius:12px; padding:10px 12px; color:#92949e; background:rgba(17,18,24,.72); font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; animation:message-in .18s ease-out both; }
    .activity-icon { width:18px; height:18px; flex:none; display:grid; place-items:center; border:1px solid #393b46; border-radius:50%; color:#888a95; font-size:10px; }
    .activity[data-state="running"] .activity-icon { border-top-color:var(--violet); animation:activity-spin .8s linear infinite; }
    .activity[data-state="done"] .activity-icon { border-color:rgba(73,214,154,.34); color:var(--mint); }
    .activity[data-state="error"] .activity-icon { border-color:rgba(240,138,120,.4); color:#f08a78; }
    .activity-copy { min-width:0; }
    .activity-copy strong { display:block; overflow:hidden; color:#b9b7b5; font-weight:620; text-overflow:ellipsis; white-space:nowrap; }
    .activity-copy span { display:block; margin-top:2px; overflow:hidden; color:#686a74; text-overflow:ellipsis; white-space:nowrap; }
    .message-actions { height:24px; margin-top:5px; display:flex; align-items:center; gap:5px; opacity:0; transition:opacity .14s; }
    .message:hover .message-actions,.message:focus-within .message-actions { opacity:1; }
    .copy-message { min-height:26px; border:0; border-radius:7px; padding:4px 7px; color:#747680; background:transparent; font:600 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace; cursor:pointer; }
    .copy-message:hover { color:#d4d1cd; background:#17181e; }
    .composer-dock { position:relative; padding:14px clamp(12px,4vw,30px) max(10px,env(safe-area-inset-bottom)); background:linear-gradient(to bottom,rgba(9,10,14,0),rgba(9,10,14,.96) 14%,#090a0e 38%); }
    .composer-inner { width:min(760px,100%); margin:auto; }
    #error { display:none; margin:0 7px 8px; border:1px solid rgba(240,138,120,.25); border-radius:10px; padding:8px 10px; color:#f1a091; background:rgba(240,138,120,.07); font-size:11px; }
    #error:not(:empty) { display:block; }
    .composer-meta { min-height:28px; padding:0 7px 6px; display:flex; align-items:center; justify-content:space-between; gap:10px; }
    #hint { min-width:0; overflow:hidden; color:#6f717b; font:10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; text-overflow:ellipsis; white-space:nowrap; }
    .session-controls { flex:none; display:flex; align-items:center; gap:4px; }
    .session-controls button { min-height:28px; border:0; border-radius:7px; padding:4px 8px; color:#8d8f99; background:transparent; font:600 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace; cursor:pointer; }
    .session-controls button:hover { color:#dedbd7; background:#1a1b22; }
    .session-controls button:disabled { display:none; }
    .composer { border:1px solid #30313a; border-radius:22px; padding:11px 10px 9px 14px; background:rgba(24,25,31,.96); box-shadow:0 15px 48px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.035); transition:border-color .16s,box-shadow .16s; }
    .composer:focus-within { border-color:#484a55; box-shadow:0 15px 48px rgba(0,0,0,.38),0 0 0 3px rgba(185,121,255,.045); }
    .composer textarea { display:block; width:100%; height:28px; min-height:28px; max-height:156px; resize:none; overflow-y:auto; border:0; outline:0; padding:2px 2px 4px; color:#f0ede9; background:transparent; font-size:15px; line-height:1.48; }
    .composer textarea::placeholder { color:#777983; }
    .composer-actions { min-height:38px; margin-top:2px; display:flex; align-items:center; gap:8px; }
    .voice-button { position:relative; width:38px; height:38px; flex:none; display:grid; place-items:center; border:1px solid #393a44; border-radius:50%; color:#a6a7b0; background:#1d1e25; cursor:pointer; transition:color .16s,border-color .16s,box-shadow .16s,transform .16s; }
    .voice-button:active { transform:scale(.94); }
    .voice-button:disabled { cursor:wait; opacity:.5; }
    .voice-button svg { width:18px; height:18px; }
    .voice-button:after { content:""; position:absolute; inset:-1px; border:1px solid transparent; border-radius:50%; pointer-events:none; }
    body.listening .voice-button { border-color:rgba(73,214,154,.55); color:#76e3b3; box-shadow:0 0 22px rgba(73,214,154,.18); }
    body.listening .voice-button:after { border-color:rgba(73,214,154,.35); animation:voice-ring 1.8s ease-out infinite; }
    body.speaking .voice-button { border-color:rgba(185,121,255,.6); color:#d6a9ff; box-shadow:0 0 24px rgba(185,121,255,.2); }
    .voice-label { min-width:0; color:#73757f; font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .composer-spacer { flex:1; }
    .send-button { width:38px; height:38px; flex:none; display:grid; place-items:center; border:0; border-radius:50%; color:#151218; background:#f0ebe5; cursor:pointer; transition:transform .14s,opacity .14s,background .14s; }
    .send-button:hover { background:white; transform:translateY(-1px); }
    .send-button:disabled { cursor:wait; opacity:.36; transform:none; }
    .send-button svg { width:18px; height:18px; }
    .stop-icon { display:none; width:10px; height:10px; border-radius:2px; background:currentColor; }
    body.generating:not(.has-draft) .send-icon { display:none; }
    body.generating:not(.has-draft) .stop-icon { display:block; }
    .privacy { margin-top:8px; color:#50525c; font:9px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; text-align:center; }
    @keyframes message-in { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:none; } }
    @keyframes typing { 0%,70%,100% { transform:translateY(0); opacity:.35; } 35% { transform:translateY(-3px); opacity:1; } }
    @keyframes voice-ring { from { transform:scale(.82); opacity:.8; } to { transform:scale(1.35); opacity:0; } }
    @keyframes activity-spin { to { transform:rotate(360deg); } }
    @media (max-width:620px) {
      .app { border:0; }
      .topbar { min-height:62px; padding-left:12px; padding-right:12px; }
      .mark { width:34px; height:34px; border-radius:10px; }
      .connection { max-width:38%; padding:7px 9px; }
      .conversation { padding:18px 12px 24px; }
      .welcome { justify-items:stretch; text-align:left; padding:24px 2px 36px; }
      .welcome-orb { justify-self:center; width:72px; height:72px; }
      .welcome h1 { margin-top:31px; font-size:28px; }
      .suggestions { grid-template-columns:1fr; gap:7px; margin-top:24px; }
      .suggestion { min-height:54px; border-radius:13px; }
      .message { grid-template-columns:27px minmax(0,1fr); gap:9px; margin-bottom:22px; }
      .avatar { width:27px; height:27px; border-radius:8px; }
      .message-card { font-size:15px; line-height:1.6; }
      .message[data-who="You"] .message-main { max-width:90%; }
      .message-actions { opacity:1; }
      .activity { margin-left:36px; }
      .composer-dock { padding-left:9px; padding-right:9px; }
      .composer { border-radius:20px; padding-left:13px; }
      .privacy { font-size:8px; }
    }
    @media (max-height:580px) { .welcome-orb { display:none; } .welcome h1 { margin-top:8px; } .welcome { padding-top:8px; } }
    @media (prefers-reduced-motion:reduce) { *,*:before,*:after { scroll-behavior:auto!important; animation-duration:.01ms!important; animation-iteration-count:1!important; } }
  </style>
</head>
<body>
  <div class="ambient"></div>
  <div class="app">
    <header class="topbar">
      <div class="identity"><div class="mark">B</div><div class="identity-copy"><div class="product">Build Remote Agent</div><div id="session">Connecting to Build…</div><div id="host"></div></div></div>
      <div class="connection" aria-live="polite"><span class="connection-dot"></span><span id="status">Ready</span></div>
    </header>
    <main class="conversation" id="conversation">
      <section class="welcome" id="welcome">
        <div class="welcome-orb" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg></div>
        <h1>Your Build session, wherever you are.</h1>
        <p>Type or talk naturally. I have this session's context and can inspect status, answer questions, navigate tabs, and continue the work.</p>
        <div class="suggestions">
          <button class="suggestion" type="button" data-prompt="What is the latest status in this session?"><strong>Catch me up</strong><span>Get the latest work and blockers</span></button>
          <button class="suggestion" type="button" data-prompt="What needs my attention right now?"><strong>Needs attention</strong><span>Surface questions, errors, and approvals</span></button>
          <button class="suggestion" type="button" data-prompt="Summarize what changed most recently and what you recommend next."><strong>What changed?</strong><span>Review recent progress and next steps</span></button>
        </div>
      </section>
      <section class="messages" id="messages" role="log" aria-label="Conversation with Build"></section>
    </main>
    <footer class="composer-dock">
      <div class="composer-inner">
        <div id="error" role="alert"></div>
        <div class="composer-meta"><span id="hint">Chat is ready · tap the microphone for voice</span><div class="session-controls"><button id="mute" type="button" disabled>Mute</button><button id="end" type="button" disabled>Disconnect</button></div></div>
        <form class="composer" id="chat-form">
          <textarea id="chat-input" aria-label="Message Build" autocomplete="off" enterkeyhint="send" maxlength="12000" rows="1" placeholder="Message Build…"></textarea>
          <div class="composer-actions">
            <button id="orb" class="voice-button" type="button" aria-label="Start voice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"/></svg></button>
            <span class="voice-label">Voice</span><span class="composer-spacer"></span>
            <button id="chat-send" class="send-button" type="submit" aria-label="Send message"><svg class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/></svg><span class="stop-icon"></span></button>
          </div>
        </form>
        <div class="privacy">Tailnet only · voice and chat share one secure Realtime conversation</div>
      </div>
    </footer>
  </div>
  <script>
  (function () {
    var pc,dc,stream,audio,audioTransceiver,connected=false,connecting=false,microphoneActive=false,muted=false,responseActive=false,responsePending=false,boundSessionId='';
    var userText='',agentText='',userMessageStarted=false,agentMessageStarted=false,handled=new Set(),toolRows=new Map();
    var orb=document.getElementById('orb'),status=document.getElementById('status'),hint=document.getElementById('hint'),error=document.getElementById('error');
    var convo=document.getElementById('conversation'),messages=document.getElementById('messages'),welcome=document.getElementById('welcome');
    var chatForm=document.getElementById('chat-form'),chatInput=document.getElementById('chat-input'),chatSend=document.getElementById('chat-send');
    var mute=document.getElementById('mute'),end=document.getElementById('end');
    function setViewportHeight(){document.documentElement.style.setProperty('--app-height',(window.visualViewport?window.visualViewport.height:window.innerHeight)+'px');}
    function setState(name,detail){document.body.classList.remove('listening','speaking');if(name)document.body.classList.add(name);status.textContent=detail;orb.setAttribute('aria-label',name==='listening'?'Voice is listening':name==='speaking'?'Build is speaking':'Start voice');}
    function readyLabel(){return microphoneActive?(muted?'Muted':'Listening'):'Chat ready';}
    function setGenerating(value){responseActive=value;document.body.classList.toggle('generating',value);syncDraftState();}
    function syncDraftState(){var hasDraft=Boolean(chatInput.value.trim());document.body.classList.toggle('has-draft',hasDraft);chatSend.setAttribute('aria-label',responseActive&&!hasDraft?'Stop response':'Send message');}
    function resizeInput(){chatInput.style.height='auto';chatInput.style.height=Math.min(chatInput.scrollHeight,156)+'px';syncDraftState();}
    function appendInline(target,text){
      var tick=String.fromCharCode(96),pattern=new RegExp('(\\*\\*[^*]+\\*\\*|'+tick+'[^'+tick+']+'+tick+'|https?:\\/\\/[^\\s]+)','g'),last=0,match;
      while((match=pattern.exec(text))){if(match.index>last)target.append(document.createTextNode(text.slice(last,match.index)));var token=match[0],node;if(token.slice(0,2)==='**'){node=document.createElement('strong');node.textContent=token.slice(2,-2);}else if(token.charAt(0)===tick){node=document.createElement('code');node.className='inline';node.textContent=token.slice(1,-1);}else{node=document.createElement('a');node.href=token.replace(/[),.;]+$/,'');node.target='_blank';node.rel='noreferrer';node.textContent=token;}target.append(node);last=match.index+token.length;}if(last<text.length)target.append(document.createTextNode(text.slice(last)));
    }
    function renderRichText(target,text){
      target.replaceChildren();target.setAttribute('data-raw',text||'');
      if(!text){var typing=document.createElement('div');typing.className='typing';typing.setAttribute('aria-label','Build is thinking');for(var d=0;d<3;d++)typing.append(document.createElement('i'));target.append(typing);return;}
      var lines=text.split('\n'),i=0,tick3=String.fromCharCode(96).repeat(3);
      while(i<lines.length){var current=lines[i];if(!current.trim()){i++;continue;}
        if(current.slice(0,3)===tick3){var code=[],language=current.slice(3).trim();i++;while(i<lines.length&&lines[i].slice(0,3)!==tick3){code.push(lines[i]);i++;}if(i<lines.length)i++;var pre=document.createElement('pre'),codeNode=document.createElement('code');if(language)codeNode.setAttribute('data-language',language);codeNode.textContent=code.join('\n');pre.append(codeNode);target.append(pre);continue;}
        var heading=current.match(/^(#{1,3})\s+(.+)$/);if(heading){var headingNode=document.createElement('h'+heading[1].length);appendInline(headingNode,heading[2]);target.append(headingNode);i++;continue;}
        if(/^[-*]\s+/.test(current)){var ul=document.createElement('ul');while(i<lines.length&&/^[-*]\s+/.test(lines[i])){var li=document.createElement('li');appendInline(li,lines[i].replace(/^[-*]\s+/,''));ul.append(li);i++;}target.append(ul);continue;}
        if(/^\d+\.\s+/.test(current)){var ol=document.createElement('ol');while(i<lines.length&&/^\d+\.\s+/.test(lines[i])){var oli=document.createElement('li');appendInline(oli,lines[i].replace(/^\d+\.\s+/,''));ol.append(oli);i++;}target.append(ol);continue;}
        if(/^>\s?/.test(current)){var quote=document.createElement('blockquote'),quoted=[];while(i<lines.length&&/^>\s?/.test(lines[i])){quoted.push(lines[i].replace(/^>\s?/,''));i++;}appendInline(quote,quoted.join('\n'));target.append(quote);continue;}
        var paragraph=[],probe=i;while(probe<lines.length&&lines[probe].trim()&&lines[probe].slice(0,3)!==tick3&&!/^(#{1,3})\s+/.test(lines[probe])&&!/^[-*]\s+/.test(lines[probe])&&!/^\d+\.\s+/.test(lines[probe])&&!/^>\s?/.test(lines[probe])){paragraph.push(lines[probe]);probe++;}var p=document.createElement('p');appendInline(p,paragraph.join('\n'));target.append(p);i=probe;
      }
    }
    function scrollToLatest(){requestAnimationFrame(function(){convo.scrollTop=convo.scrollHeight;});}
    function line(who,words,forceNew){
      var rows=messages.querySelectorAll('.message'),last=rows[rows.length-1],row,content;
      if(!forceNew&&last&&last.getAttribute('data-who')===who){row=last;content=row.querySelector('.rich-text');}
      else{row=document.createElement('article');row.className='message';row.setAttribute('data-who',who);var avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=who==='You'?'Y':'B';var main=document.createElement('div');main.className='message-main';var label=document.createElement('div');label.className='message-label';label.textContent=who;var card=document.createElement('div');card.className='message-card';content=document.createElement('div');content.className='rich-text';card.append(content);main.append(label,card);if(who==='Build'){var actions=document.createElement('div');actions.className='message-actions';var copy=document.createElement('button');copy.type='button';copy.className='copy-message';copy.textContent='Copy';copy.onclick=function(){navigator.clipboard.writeText(content.getAttribute('data-raw')||'').then(function(){copy.textContent='Copied';setTimeout(function(){copy.textContent='Copy';},1200);}).catch(function(){});};actions.append(copy);main.append(actions);}row.append(avatar,main);messages.append(row);}
      renderRichText(content,words||'');welcome.hidden=true;scrollToLatest();return row;
    }
    function send(outgoing){if(dc&&dc.readyState==='open')dc.send(JSON.stringify(outgoing));}
    function remember(role,content){if(!content||!content.trim())return;fetch('/api/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entry:{role:role,content:content}})}).catch(function(){});}
    function createResponse(){if(responseActive){responsePending=true;return;}setGenerating(true);send({type:'response.create'});}
    function cancelResponse(){if(!responseActive)return;responsePending=false;send({type:'response.cancel'});setGenerating(false);setState('',readyLabel());}
    function toolLabel(name){var labels={steer_build:'Sending work to Build',DesignMode:'Starting DesignMode',get_build_status:'Reading session status',respond_to_build_question:'Responding to Build question',review_build_plan:'Reviewing Build plan',list_build_sessions:'Finding active sessions',switch_build_session:'Switching Build session',switch_build_tab:'Switching Build tab',rename_build_tab:'Renaming Build tab',fork_build_session:'Starting parallel work',start_new_build_tab:'Starting a new Build tab',inspect_build_screen:'Inspecting the Build screen',control_build_ui:'Controlling the Build interface'};return labels[name]||('Using '+String(name||'Build tool').replaceAll('_',' '));}
    function toolActivity(item,state,detail){var callId=item.call_id||item.id||item.item_id;if(!callId)return;var row=toolRows.get(callId);if(!row){row=document.createElement('div');row.className='activity';row.setAttribute('data-call-id',callId);var icon=document.createElement('span');icon.className='activity-icon';var copy=document.createElement('div');copy.className='activity-copy';var title=document.createElement('strong');title.textContent=toolLabel(item.name);var sub=document.createElement('span');copy.append(title,sub);row.append(icon,copy);messages.append(row);toolRows.set(callId,row);welcome.hidden=true;}row.setAttribute('data-state',state);row.querySelector('.activity-icon').textContent=state==='done'?'✓':state==='error'?'!':'';row.querySelector('.activity-copy span').textContent=detail||(state==='running'?'Working…':state==='done'?'Complete':'Could not complete');scrollToLatest();}
    function removeEmptyBuildMessage(){var empty=messages.querySelectorAll('.message[data-who="Build"] .rich-text[data-raw=""]');var last=empty[empty.length-1];if(last&&last.closest('.message'))last.closest('.message').remove();}
    async function runTool(item){
      if(!item.call_id||handled.has(item.call_id))return;handled.add(item.call_id);var params={};try{params=JSON.parse(item.arguments||'{}');}catch(_){}var ok=true,result;
      try{var response=await fetch('/api/tool',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({toolCallId:item.call_id,toolName:item.name,parameters:params})});var payload=await response.json();if(!response.ok||!payload.success)throw new Error(payload.error||'Build tool failed');result=payload.result;}catch(e){ok=false;result=e.message||'Build tool failed';}
      toolActivity(item,ok?'done':'error',ok?'Complete':String(result||'Build tool failed'));var output=typeof result==='string'?result:result.output;send({type:'conversation.item.create',item:{type:'function_call_output',call_id:item.call_id,output:JSON.stringify({ok:ok,result:output})}});if(ok&&result&&typeof result!=='string'&&result.inputImageDataUrl)send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_image',image_url:result.inputImageDataUrl}]}});createResponse();
    }
    async function submitChat(text){
      if(!text)return;chatSend.disabled=true;error.textContent='';if(!connected)await connect(false);chatSend.disabled=false;if(!connected){chatInput.value=text;resizeInput();chatInput.focus();return;}if(responseActive)cancelResponse();line('You',text,true);remember('user',text);send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:text}]}});setState('','Thinking…');createResponse();
    }
    function event(e){
      if(e.type==='input_audio_buffer.speech_started'){userText='';userMessageStarted=false;setState('listening','Listening…');}
      else if(e.type==='input_audio_buffer.speech_stopped'){setGenerating(true);setState('','Thinking…');}
      else if(e.type==='conversation.item.input_audio_transcription.delta'){userText+=e.delta||'';line('You',userText,!userMessageStarted);userMessageStarted=true;}
      else if(e.type==='conversation.item.input_audio_transcription.completed'){userText=e.transcript||userText;line('You',userText,!userMessageStarted);userMessageStarted=true;remember('user',userText);}
      else if(e.type==='response.created'){setGenerating(true);agentText='';agentMessageStarted=true;line('Build','',true);setState('speaking','Build is responding');}
      else if(e.type==='response.output_audio_transcript.delta'||e.type==='response.output_text.delta'){agentText+=e.delta||'';line('Build',agentText,!agentMessageStarted);agentMessageStarted=true;}
      else if(e.type==='response.output_audio_transcript.done'||e.type==='response.output_text.done'){agentText=e.transcript||agentText;line('Build',agentText,!agentMessageStarted);agentMessageStarted=true;}
      else if(e.type==='response.output_item.added'&&e.item&&e.item.type==='function_call')toolActivity(e.item,'running','Working…');
      else if(e.type==='response.output_item.done'&&e.item&&e.item.type==='function_call')runTool(e.item);
      else if(e.type==='output_audio_buffer.stopped'||e.type==='output_audio_buffer.cleared')setState('',readyLabel());
      else if(e.type==='response.done'){if(!agentText)removeEmptyBuildMessage();else remember('assistant',agentText);setGenerating(false);setState('',readyLabel());if(responsePending){responsePending=false;setTimeout(createResponse,0);}}
      else if(e.type==='error'&&(!e.error||e.error.code!=='response_cancel_not_active')){if(e.error&&e.error.code==='conversation_already_has_active_response'){responsePending=true;}else fail((e.error&&e.error.message)||'Realtime error');}
    }
    function fail(message){error.textContent=message;setState('','Connection problem');}
    function applyRuntimeStatus(runtimeStatus){
      if(!runtimeStatus||!runtimeStatus.sessionId)return;
      if(boundSessionId&&boundSessionId!==runtimeStatus.sessionId){window.location.reload();return;}
      boundSessionId=runtimeStatus.sessionId;
      if(runtimeStatus.sessionName)document.getElementById('session').textContent=runtimeStatus.sessionName;
      if(runtimeStatus.host)document.getElementById('host').textContent=runtimeStatus.host;
    }
    function pollRuntimeIdentity(){fetch('/api/status',{cache:'no-store'}).then(function(r){return r.json();}).then(applyRuntimeStatus).catch(function(){});}
    async function disconnect(){connected=false;connecting=false;microphoneActive=false;setGenerating(false);document.body.classList.remove('connected','listening','speaking');if(stream)stream.getTracks().forEach(function(t){t.stop();});if(pc)pc.close();if(audio)audio.remove();pc=dc=stream=audio=audioTransceiver=null;mute.disabled=end.disabled=true;orb.disabled=false;muted=false;mute.textContent='Mute';setState('','Ready');hint.textContent='Chat is ready · tap the microphone for voice';}
    async function enableMicrophone(){
      if(microphoneActive||!connected||!audioTransceiver)return;error.textContent='';orb.disabled=true;setState('','Enabling microphone…');
      try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});var track=stream.getAudioTracks()[0];if(!track)throw new Error('No microphone was available');await audioTransceiver.sender.replaceTrack(track);microphoneActive=true;mute.disabled=false;orb.disabled=false;setState('listening','Listening');hint.textContent='Speak or type · interrupt anytime';}catch(e){if(stream)stream.getTracks().forEach(function(t){t.stop();});stream=null;orb.disabled=false;fail(e.message||'Could not enable the microphone');}
    }
    async function connect(withMicrophone){
      if(connected){if(withMicrophone&&!microphoneActive)await enableMicrophone();return;}if(connecting)return;connecting=true;error.textContent='';orb.disabled=true;setState('','Connecting…');
      try{var bootResponse=await fetch('/api/bootstrap',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});var boot=await bootResponse.json();if(!bootResponse.ok||!boot.success||!boot.clientSecret)throw new Error(boot.error||'Build did not provide a Realtime session');applyRuntimeStatus(boot);pc=new RTCPeerConnection();audioTransceiver=pc.addTransceiver('audio',{direction:'sendrecv'});if(withMicrophone){stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});var inputTrack=stream.getAudioTracks()[0];if(!inputTrack)throw new Error('No microphone was available');await audioTransceiver.sender.replaceTrack(inputTrack);microphoneActive=true;}audio=document.createElement('audio');audio.autoplay=true;audio.style.display='none';document.body.appendChild(audio);pc.ontrack=function(x){audio.srcObject=x.streams[0];audio.play().catch(function(){});};dc=pc.createDataChannel('oai-events');dc.onmessage=function(x){try{event(JSON.parse(String(x.data)));}catch(_){}};var opened=new Promise(function(resolve,reject){var timer=setTimeout(function(){reject(new Error('Realtime connection timed out'));},15000);dc.onopen=function(){clearTimeout(timer);resolve();};dc.onerror=function(){clearTimeout(timer);reject(new Error('Realtime data channel failed'));};});var offer=await pc.createOffer();await pc.setLocalDescription(offer);var answer=await fetch('https://api.openai.com/v1/realtime/calls',{method:'POST',headers:{Authorization:'Bearer '+boot.clientSecret,'Content-Type':'application/sdp'},body:offer.sdp});if(!answer.ok)throw new Error('OpenAI Realtime handshake failed ('+answer.status+')');await pc.setRemoteDescription({type:'answer',sdp:await answer.text()});await opened;connected=true;connecting=false;document.body.classList.add('connected');mute.disabled=!microphoneActive;end.disabled=false;orb.disabled=false;setState(microphoneActive?'listening':'',readyLabel());hint.textContent=microphoneActive?'Speak or type · interrupt anytime':'Connected for chat · tap the microphone for voice';pc.onconnectionstatechange=function(){if(pc&&['failed','disconnected','closed'].indexOf(pc.connectionState)>=0&&connected){void disconnect().then(function(){fail('Remote Agent connection was lost');});}};}catch(e){await disconnect();fail(e.message||'Could not start Remote Agent');}
    }
    orb.onclick=function(){void connect(true);};end.onclick=disconnect;mute.onclick=function(){if(!stream)return;muted=!muted;stream.getAudioTracks().forEach(function(t){t.enabled=!muted;});mute.textContent=muted?'Unmute':'Mute';setState('',muted?'Muted':'Listening');};
    chatInput.addEventListener('input',resizeInput);chatInput.addEventListener('keydown',function(keyEvent){if(keyEvent.key==='Enter'&&!keyEvent.shiftKey&&!keyEvent.isComposing){keyEvent.preventDefault();chatForm.requestSubmit();}});
    chatForm.onsubmit=function(submitEvent){submitEvent.preventDefault();if(chatSend.disabled)return;var text=chatInput.value.trim();if(!text){cancelResponse();return;}chatInput.value='';resizeInput();void submitChat(text);};
    document.querySelectorAll('[data-prompt]').forEach(function(button){button.addEventListener('click',function(){chatInput.value=button.getAttribute('data-prompt')||'';resizeInput();chatForm.requestSubmit();});});
    if(window.visualViewport){window.visualViewport.addEventListener('resize',setViewportHeight);window.visualViewport.addEventListener('scroll',setViewportHeight);}window.addEventListener('resize',setViewportHeight);setViewportHeight();resizeInput();
    pollRuntimeIdentity();setInterval(pollRuntimeIdentity,3000);
  })();
  </script>
</body>
</html>`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class RemoteVoiceService {
  private readonly sessionStore = new CachedStore({ name: getSessionStoreName() });
  private readonly audioService = new AudioService();
  private active: ActiveRemoteVoiceDeployment | null = null;
  private deployingStatus: RemoteVoiceDeploymentStatus | null = null;
  private routeMonitor: NodeJS.Timeout | null = null;
  private routeRepair: Promise<boolean> | null = null;
  private memorySync: Promise<void> | null = null;
  private memorySyncDirty = false;

  private async restorePersistedDeployment(): Promise<ActiveRemoteVoiceDeployment | null> {
    const persisted = this.sessionStore.get('remoteVoice.activeDeployment') as PersistedRemoteVoiceDeployment | undefined;
    if (!persisted?.sessionId || !persisted.url || !persisted.remoteDirectory) return null;
    if (persisted.servePort !== REMOTE_VOICE_SERVE_PORT) {
      // Port 443 belongs to the host's normal HTTPS ingress (Traefik/slots).
      // Never resurrect a legacy Remote Voice publication on that port.
      this.sessionStore.delete('remoteVoice.activeDeployment');
      return null;
    }
    const session = (this.sessionStore.get(`sessions.${persisted.sessionId}`)
      || this.sessionStore.get(`discoveredSessions.${persisted.sessionId}`)) as Session | undefined;
    if (!session?.sshConfig) {
      this.sessionStore.delete('remoteVoice.activeDeployment');
      return null;
    }
    try {
      const client = await sshService.getConnectionForCodex(session.id, session.sshConfig);
      const health = JSON.parse(await this.execRemote(
        client,
        'curl -fsS --max-time 3 http://127.0.0.1:42780/healthz',
        8_000,
      )) as { ok?: boolean; sessionId?: string; runtimeVersion?: number; serverIndependent?: boolean };
      if (
        !health.ok
        || !health.serverIndependent
        || health.sessionId !== session.id
        || health.runtimeVersion !== REMOTE_RUNTIME_VERSION
      ) throw new Error('Remote runtime is stale.');
      const deployment: ActiveRemoteVoiceDeployment = {
        status: {
          active: true,
          sessionId: session.id,
          sessionName: session.name,
          host: `${session.sshConfig.username}@${session.sshConfig.host}`,
          url: persisted.url,
          startedAt: persisted.startedAt,
        },
        dnsName: persisted.dnsName,
        remoteDirectory: persisted.remoteDirectory,
        servePort: persisted.servePort,
        session,
        sshConfig: session.sshConfig,
      };
      this.active = deployment;
      await this.syncRuntimeResumeState(deployment, client);
      await this.syncDeploymentVoiceMemory(deployment, client);
      this.startRouteMonitor();
      return deployment;
    } catch (error) {
      console.warn('[RemoteVoice] Could not reattach to persisted SSH runtime:', error);
      this.sessionStore.delete('remoteVoice.activeDeployment');
      return null;
    }
  }

  private async readRuntimeStatus(
    deployment: ActiveRemoteVoiceDeployment,
    existingClient?: import('ssh2').Client,
  ): Promise<{ sessionId?: string; harness?: string; resumeId?: string; runtimeVersion?: number } | null> {
    try {
      const client = existingClient || await sshService.getConnectionForCodex(deployment.session.id, deployment.sshConfig);
      return JSON.parse(await this.execRemote(
        client,
        'curl -fsS --max-time 3 http://127.0.0.1:42780/api/status',
        8_000,
      )) as { sessionId?: string; harness?: string; resumeId?: string; runtimeVersion?: number };
    } catch (error) {
      console.warn('[RemoteVoice] Could not read the server-side runtime status:', error);
      return null;
    }
  }

  private async syncRuntimeResumeState(
    deployment: ActiveRemoteVoiceDeployment,
    existingClient?: import('ssh2').Client,
  ): Promise<boolean> {
    const runtimeStatus = await this.readRuntimeStatus(deployment, existingClient);
    if (
      !runtimeStatus
      || runtimeStatus.sessionId !== deployment.session.id
      || runtimeStatus.runtimeVersion !== REMOTE_RUNTIME_VERSION
    ) return false;
    if (!runtimeStatus.resumeId) return true;
    try {
      if (runtimeStatus.harness === 'codex') {
        this.sessionStore.set(`harnessState.${deployment.session.id}.codexThreadId`, runtimeStatus.resumeId);
      } else if (runtimeStatus.harness === 'claude') {
        this.sessionStore.set(`sdkSessionMappings.${deployment.session.id}`, runtimeStatus.resumeId);
      }
      return true;
    } catch (error) {
      console.warn('[RemoteVoice] Could not sync the server-side harness resume ID:', error);
      return true;
    }
  }

  private retireLocalDeployment(deployment: ActiveRemoteVoiceDeployment): void {
    if (this.active === deployment) this.active = null;
    if (this.routeMonitor) clearInterval(this.routeMonitor);
    this.routeMonitor = null;
    this.sessionStore.delete('remoteVoice.activeDeployment');
  }

  private async syncDeploymentVoiceMemory(
    deployment: ActiveRemoteVoiceDeployment,
    existingClient?: import('ssh2').Client,
  ): Promise<void> {
    const client = existingClient || await sshService.getConnectionForCodex(deployment.session.id, deployment.sshConfig);
    const syncPath = `${deployment.remoteDirectory}/voice-memory-sync.json`;
    await sshService.writeRemoteFile(
      deployment.session.id,
      deployment.sshConfig,
      syncPath,
      JSON.stringify(getVoiceMemoryService().snapshot()),
    );
    const quotedSyncPath = shellQuote(syncPath);
    const raw = await this.execRemote(client, [
      `memory_payload="$(curl -fsS --max-time 8 -H 'content-type: application/json' --data-binary @${quotedSyncPath} http://127.0.0.1:${REMOTE_SERVER_PORT}/api/memory)"`,
      'memory_status=$?',
      `rm -f ${quotedSyncPath}`,
      '[ "$memory_status" -eq 0 ] || exit "$memory_status"',
      'printf %s "$memory_payload"',
    ].join('; '), 15_000);
    const payload = JSON.parse(raw) as { entries?: unknown[] };
    getVoiceMemoryService().merge(payload.entries);
  }

  async syncVoiceMemory(): Promise<void> {
    if (!this.active && !this.deployingStatus) await this.restorePersistedDeployment();
    if (!this.active) return;
    if (this.memorySync) {
      this.memorySyncDirty = true;
      return this.memorySync;
    }
    this.memorySync = (async () => {
      do {
        this.memorySyncDirty = false;
        const deployment = this.active;
        if (!deployment) return;
        await this.syncDeploymentVoiceMemory(deployment);
      } while (this.memorySyncDirty);
    })().finally(() => {
      this.memorySync = null;
    });
    return this.memorySync;
  }

  async getStatus(): Promise<RemoteVoiceDeploymentStatus> {
    if (!this.active && !this.deployingStatus) await this.restorePersistedDeployment();
    if (!this.active) return this.deployingStatus || { active: false };
    const deployment = this.active;
    if (await this.ensureActiveRoute(deployment)) {
      if (await this.syncRuntimeResumeState(deployment)) {
        await this.syncVoiceMemory().catch((error) => {
          console.warn('[RemoteVoice] Could not synchronize durable voice memory:', error);
        });
        return deployment.status;
      }
      this.retireLocalDeployment(deployment);
      return {
        active: false,
        sessionId: deployment.status.sessionId,
        sessionName: deployment.status.sessionName,
        host: deployment.status.host,
        error: 'This SSH host is serving a different Build session. Deploy Remote Agent again from this tab.',
      };
    }
    if (this.active !== deployment) return this.active?.status || this.deployingStatus || { active: false };
    const staleStatus = deployment.status;
    await this.stop();
    return {
      active: false,
      sessionId: staleStatus.sessionId,
      sessionName: staleStatus.sessionName,
      host: staleStatus.host,
      error: 'The Remote Agent URL was lost and could not be restored. Deploy it again.',
    };
  }

  private async execRemote(
    client: import('ssh2').Client,
    command: string,
    timeoutMs = 30_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          channel.close();
          reject(new Error(`Remote command timed out after ${Math.round(timeoutMs / 1_000)} seconds.`));
        }, timeoutMs);
        channel.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        channel.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        channel.on('close', (code: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr.trim() || stdout.trim() || `Remote command exited with code ${code}.`));
        });
      });
    });
  }

  private async readServeStatus(client: import('ssh2').Client): Promise<{
    TCP?: Record<string, { HTTPS?: boolean }>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  }> {
    const raw = (await this.execRemote(
      client,
      'tailscale serve status --json 2>/dev/null || printf %s "{}"',
    )).trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw) as {
        TCP?: Record<string, { HTTPS?: boolean }>;
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
      };
    } catch {
      return {};
    }
  }

  private hasServeRoute(
    serveStatus: {
      TCP?: Record<string, { HTTPS?: boolean }>;
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    },
    dnsName: string,
    servePort: number,
  ): boolean {
    const port = String(servePort);
    return serveStatus.TCP?.[port]?.HTTPS === true
      && serveStatus.Web?.[`${dnsName}:${port}`]?.Handlers?.['/']?.Proxy === `http://127.0.0.1:${REMOTE_SERVER_PORT}`;
  }

  private isServePortOccupied(
    serveStatus: {
      TCP?: Record<string, { HTTPS?: boolean }>;
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    },
    dnsName: string,
    servePort: number,
  ): boolean {
    const port = String(servePort);
    return Boolean(serveStatus.TCP?.[port] || serveStatus.Web?.[`${dnsName}:${port}`]);
  }

  private async configureServeRoute(
    client: import('ssh2').Client,
    dnsName: string,
    servePort: number,
  ): Promise<boolean> {
    if (servePort !== REMOTE_VOICE_SERVE_PORT) {
      throw new Error(`Remote Voice may only publish on Tailnet port ${REMOTE_VOICE_SERVE_PORT}.`);
    }
    await this.execRemote(
      client,
      `tailscale serve --bg --yes --https=${servePort} http://127.0.0.1:${REMOTE_SERVER_PORT} || sudo -n tailscale serve --bg --yes --https=${servePort} http://127.0.0.1:${REMOTE_SERVER_PORT}`,
    );
    return this.hasServeRoute(await this.readServeStatus(client), dnsName, servePort);
  }

  private async repairActiveRoute(deployment: ActiveRemoteVoiceDeployment): Promise<boolean> {
    if (deployment.servePort !== REMOTE_VOICE_SERVE_PORT) {
      console.warn('[RemoteVoice] Refusing to repair a legacy route on the host HTTPS port:', {
        sessionId: deployment.session.id,
        servePort: deployment.servePort,
      });
      return false;
    }
    try {
      const client = await sshService.getConnectionForCodex(deployment.session.id, deployment.sshConfig);
      const serveStatus = await this.readServeStatus(client);
      if (this.hasServeRoute(serveStatus, deployment.dnsName, deployment.servePort)) return true;
      if (this.isServePortOccupied(serveStatus, deployment.dnsName, deployment.servePort)) {
        console.warn('[RemoteVoice] Expected Serve port is occupied by a different handler:', {
          sessionId: deployment.session.id,
          servePort: deployment.servePort,
        });
        return false;
      }
      console.warn('[RemoteVoice] Serve route disappeared; restoring it:', {
        sessionId: deployment.session.id,
        servePort: deployment.servePort,
      });
      return await this.configureServeRoute(client, deployment.dnsName, deployment.servePort);
    } catch (error) {
      console.warn('[RemoteVoice] Could not validate or restore the Serve route:', error);
      return false;
    }
  }

  private ensureActiveRoute(deployment: ActiveRemoteVoiceDeployment): Promise<boolean> {
    if (this.routeRepair) return this.routeRepair;
    this.routeRepair = this.repairActiveRoute(deployment).finally(() => {
      this.routeRepair = null;
    });
    return this.routeRepair;
  }

  private startRouteMonitor(): void {
    if (this.routeMonitor) clearInterval(this.routeMonitor);
    this.routeMonitor = setInterval(() => {
      const deployment = this.active;
      if (!deployment) return;
      void this.ensureActiveRoute(deployment).then((healthy) => {
        if (!healthy && this.active === deployment) {
          console.warn('[RemoteVoice] Serve route health check failed; the next status read will retire the stale URL.');
        }
      });
    }, 30_000);
    this.routeMonitor.unref();
  }

  async deploy(sessionId: string): Promise<RemoteVoiceDeploymentStatus> {
    if (!this.active && !this.deployingStatus) await this.restorePersistedDeployment();
    if (this.active?.status.sessionId === sessionId) {
      const deployment = this.active;
      const routeHealthy = await this.ensureActiveRoute(deployment);
      if (routeHealthy && await this.syncRuntimeResumeState(deployment)) return deployment.status;
      if (routeHealthy) this.retireLocalDeployment(deployment);
      else await this.stop();
    }
    if (this.deployingStatus) return this.deployingStatus;

    const session = (this.sessionStore.get(`sessions.${sessionId}`)
      || this.sessionStore.get(`discoveredSessions.${sessionId}`)) as Session | undefined;
    if (!session) throw new Error('The selected Build session no longer exists.');
    if (!session.sshConfig) throw new Error('Remote Voice currently supports SSH sessions. Open an SSH tab and try again.');

    if (this.active) await this.stop();
    this.deployingStatus = {
      active: false,
      deploying: true,
      sessionId,
      sessionName: session.name,
      host: `${session.sshConfig.username}@${session.sshConfig.host}`,
    };

    let client: import('ssh2').Client | null = null;
    let remoteDirectory = '';
    const servePort = REMOTE_VOICE_SERVE_PORT;
    let serveConfigured = false;
    try {
      client = await sshService.getConnectionForCodex(sessionId, session.sshConfig);
      const remotePath = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:$PATH"';
      const commandPaths = (await this.execRemote(client, [
        remotePath,
        'for command_name in node tailscale claude codex; do command_path="$(command -v "$command_name" 2>/dev/null || true)"; printf "%s\\n" "${command_path:-__missing__}"; done',
      ].join('; '))).trim().split('\n');
      const [rawNodeCommand, rawTailscaleCommand, rawClaudeCommand, rawCodexCommand] = commandPaths;
      const nodeCommand = rawNodeCommand === '__missing__' ? '' : rawNodeCommand;
      const tailscaleCommand = rawTailscaleCommand === '__missing__' ? '' : rawTailscaleCommand;
      const claudeCommand = rawClaudeCommand === '__missing__' ? '' : rawClaudeCommand;
      const codexCommand = rawCodexCommand === '__missing__' ? '' : rawCodexCommand;
      if (!nodeCommand) throw new Error('Remote Voice requires Node.js on the SSH host.');
      if (!tailscaleCommand) throw new Error('Remote Voice requires Tailscale on the SSH host.');
      const nodeVersion = (await this.execRemote(client, `${shellQuote(nodeCommand)} --version 2>/dev/null || true`)).trim();
      if (!/^v\d+/.test(nodeVersion)) throw new Error('Remote Voice requires Node.js on the SSH host.');
      const tailscaleState = await this.execRemote(client, `${shellQuote(tailscaleCommand)} status --json 2>/dev/null`);
      const tailscale = JSON.parse(tailscaleState) as { BackendState?: string; Self?: { DNSName?: string } };
      if (tailscale.BackendState !== 'Running') throw new Error('Tailscale is not connected on the SSH host.');
      const dnsName = tailscale.Self?.DNSName?.replace(/\.$/, '');
      if (!dnsName) throw new Error('Tailscale did not report a MagicDNS name for the SSH host.');

      const existingServe = await this.readServeStatus(client);
      if (!this.hasServeRoute(existingServe, dnsName, servePort)
        && this.isServePortOccupied(existingServe, dnsName, servePort)) {
        throw new Error('Tailscale Serve port 8443 is already in use on this SSH host.');
      }

      const remoteHome = (await this.execRemote(client, 'printf %s "$HOME"')).trim();
      if (!remoteHome.startsWith('/')) throw new Error('Could not resolve the remote home directory.');
      const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-');
      remoteDirectory = `${remoteHome}/.build/remote-voice/${safeSessionId}`;
      const existingRemoteMemory = JSON.parse(await this.execRemote(
        client,
        `if [ -f ${shellQuote(`${remoteDirectory}/voice-memory.json`)} ]; then cat ${shellQuote(`${remoteDirectory}/voice-memory.json`)}; else printf %s '{"version":1,"entries":[]}'; fi`,
      ).catch(() => '{"version":1,"entries":[]}')) as { entries?: unknown[] };
      getVoiceMemoryService().merge(existingRemoteMemory.entries);
      const openAiApiKey = this.audioService.getOpenAiApiKey();
      if (!openAiApiKey) {
        throw new Error('Remote Voice needs an OpenAI API key. Add it in Settings > API Keys and deploy again.');
      }
      const audioSettings = this.audioService.getAudioSettings();
      const existingIdentityScript = [
        "const fs=require('fs'),path=require('path'),directory=process.argv[1]",
        "try{const config=JSON.parse(fs.readFileSync(path.join(directory,'config.json'),'utf8'))",
        "let state={};try{state=JSON.parse(fs.readFileSync(path.join(directory,'state.json'),'utf8'))}catch(_){}",
        "const compatible=state.version===2&&state.sessionId===config.sessionId&&state.harness===config.harness",
        "process.stdout.write(JSON.stringify({sessionId:config.sessionId,harness:config.harness,resumeId:compatible?(state.resumeId||config.resumeId):config.resumeId,model:config.model}))}catch(_){process.stdout.write('{}')}",
      ].join(';');
      const existingIdentity = JSON.parse(await this.execRemote(
        client,
        `${shellQuote(nodeCommand)} -e ${shellQuote(existingIdentityScript)} ${shellQuote(remoteDirectory)}`,
      ).catch(() => '{}')) as { sessionId?: string; harness?: string; resumeId?: string; model?: string };
      const existingHarness = existingIdentity.sessionId === sessionId
        && (existingIdentity.harness === 'claude' || existingIdentity.harness === 'codex')
        ? existingIdentity.harness
        : undefined;
      const storedClaudeResumeId = this.sessionStore.get(`sdkSessionMappings.${sessionId}`) as string | undefined;
      const claudeResumeId = session.sdkSessionId || storedClaudeResumeId;
      const codexResumeId = this.sessionStore.get(`harnessState.${sessionId}.codexThreadId`) as string | undefined;
      const codexTranscriptId = this.sessionStore.get(
        `harnessState.${sessionId}.codexDeveloperInstructions.threadId`,
      ) as string | undefined;
      const lastHarness = this.sessionStore.get(`harnessState.${sessionId}.lastAssistantHarness`) as string | undefined;
      const lastModel = this.sessionStore.get(`harnessState.${sessionId}.lastAssistantModel`) as string | undefined;
      const desktopHarness = lastHarness === 'codex' && codexResumeId
        ? 'codex'
        : lastHarness === 'claude' && claudeResumeId && claudeResumeId !== 'new'
          ? 'claude'
          : undefined;
      // The currently active desktop harness is authoritative. Preserve the
      // server-side harness only when this desktop profile has no newer native
      // identity for the session (for example after a cross-profile reconnect).
      const harness = desktopHarness || existingHarness || (claudeResumeId && claudeResumeId !== 'new'
        ? 'claude'
        : codexResumeId
          ? 'codex'
          : 'claude');
      const harnessCommand = harness === 'codex' ? codexCommand : claudeCommand;
      if (!harnessCommand) {
        throw new Error(`Remote Voice could not find the ${harness === 'codex' ? 'Codex' : 'Claude'} CLI on the SSH host.`);
      }
      const existingResumeId = existingHarness === harness ? existingIdentity.resumeId : undefined;
      const desktopResumeId = harness === 'codex'
        ? codexResumeId
        : claudeResumeId && claudeResumeId !== 'new'
          ? claudeResumeId
          : undefined;
      const resumeId = desktopHarness === harness
        ? desktopResumeId || existingResumeId
        : existingResumeId || desktopResumeId;
      const selectedModel = existingHarness === harness ? existingIdentity.model : lastModel || session.model;
      const model = resumeId
        ? undefined
        : harness === 'codex'
          ? selectedModel?.startsWith('codex:') ? selectedModel.slice('codex:'.length) : undefined
          : selectedModel?.startsWith('claude-') ? selectedModel : undefined;
      const permissionMode = (session as Session & { permissionMode?: string }).permissionMode || 'acceptEdits';
      const config = JSON.stringify({
        version: 1,
        serverPort: REMOTE_SERVER_PORT,
        sessionId,
        sessionName: session.name,
        host: `${session.sshConfig.username}@${session.sshConfig.host}`,
        branch: session.branch,
        workingDirectory: session.worktreePath || session.repoPath,
        harness,
        harnessCommand,
        resumeId,
        transcriptId: harness === 'codex' ? codexTranscriptId || resumeId : resumeId,
        model,
        permissionMode,
        openAiApiKey,
        realtimeModel: OPENAI_REALTIME_MODEL,
        voice: audioSettings.realtimeVoice,
        reasoningEffort: audioSettings.realtimeReasoningEffort,
        language: audioSettings.transcriptionLanguage,
        safetyIdentifier: createHash('sha256').update(`remote-voice:${sessionId}`).digest('hex'),
        voiceMemory: getVoiceMemoryService().snapshot(),
        tailscaleCommand,
        dnsName,
        servePort,
      }, null, 2);
      const cliWrapper = `#!/bin/sh\nexec ${shellQuote(nodeCommand)} ${shellQuote(`${remoteDirectory}/server.js`)} "$@"\n`;
      await sshService.writeRemoteFile(sessionId, session.sshConfig, `${remoteDirectory}/server.js`, REMOTE_BUILD_CLI_SOURCE);
      await sshService.writeRemoteFile(sessionId, session.sshConfig, `${remoteDirectory}/build-cli`, cliWrapper);
      await sshService.writeRemoteFile(sessionId, session.sshConfig, `${remoteDirectory}/index.html`, REMOTE_VOICE_HTML);
      await sshService.writeRemoteFile(sessionId, session.sshConfig, `${remoteDirectory}/config.json`, config);

      const quotedDirectory = shellQuote(remoteDirectory);
      const managedRuntimeRoot = `${remoteHome}/.build/remote-voice`;
      const expectedHealthSession = shellQuote(`"sessionId":"${sessionId}"`);
      await this.execRemote(client, [
        `cd ${quotedDirectory}`,
        'chmod 700 .',
        'chmod 600 config.json server.js index.html',
        'chmod 700 build-cli',
        `for managed_pid_file in ${shellQuote(managedRuntimeRoot)}/*/server.pid ${shellQuote(managedRuntimeRoot)}/server.pid; do [ -f "$managed_pid_file" ] || continue; kill "$(cat "$managed_pid_file")" 2>/dev/null || true; done`,
        'for wait_index in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --max-time 1 http://127.0.0.1:42780/healthz >/dev/null 2>&1 || break; sleep 0.1; done',
        '{ nohup ./build-cli serve > server.log 2>&1 < /dev/null & echo $! > server.pid; }',
        `for i in 1 2 3 4 5; do health_payload="$(curl -fsS http://127.0.0.1:42780/healthz 2>/dev/null || true)"; if kill -0 "$(cat server.pid)" 2>/dev/null && printf %s "$health_payload" | grep -Fq ${expectedHealthSession}; then exit 0; fi; sleep 1; done`,
        'cat server.log >&2',
        'exit 1',
      ].join(' && '));
      if (!await this.configureServeRoute(client, dnsName, servePort)) {
        throw new Error('Tailscale Serve accepted the route but did not publish the expected Remote Agent URL.');
      }
      serveConfigured = true;

      const url = `https://${dnsName}:${servePort}/`;
      const status: RemoteVoiceDeploymentStatus = {
        active: true,
        sessionId,
        sessionName: session.name,
        host: `${session.sshConfig.username}@${session.sshConfig.host}`,
        url,
        startedAt: Date.now(),
      };
      this.active = {
        status,
        dnsName,
        remoteDirectory,
        servePort,
        session,
        sshConfig: session.sshConfig,
      };
      this.startRouteMonitor();
      this.deployingStatus = null;
      this.sessionStore.set('remoteVoice.activeDeployment', {
        sessionId,
        dnsName,
        remoteDirectory,
        servePort,
        url,
        startedAt: status.startedAt,
      });
      console.log('[RemoteVoice] Deployed standalone SSH runtime:', {
        sessionId,
        url,
        harness,
        resumed: Boolean(resumeId),
      });
      return status;
    } catch (error) {
      if (client && remoteDirectory) {
        const cleanupCommands = [
          serveConfigured
            ? `(tailscale serve --https=${servePort} off || sudo -n tailscale serve --https=${servePort} off) >/dev/null 2>&1 || true`
            : 'true',
          `if [ -f ${shellQuote(`${remoteDirectory}/server.pid`)} ]; then kill "$(cat ${shellQuote(`${remoteDirectory}/server.pid`)})" 2>/dev/null || true; fi`,
        ];
        await this.execRemote(client, cleanupCommands.join(' && '), 10_000).catch((cleanupError) => {
          console.warn('[RemoteVoice] Partial remote deployment cleanup failed:', cleanupError);
        });
      }
      this.deployingStatus = null;
      const message = error instanceof Error ? error.message : 'Remote Voice deployment failed.';
      console.error('[RemoteVoice] Deployment failed:', error);
      return {
        active: false,
        sessionId,
        sessionName: session.name,
        host: `${session.sshConfig.username}@${session.sshConfig.host}`,
        error: message,
      };
    }
  }

  async stop(): Promise<RemoteVoiceDeploymentStatus> {
    const deployment = this.active;
    this.active = null;
    this.deployingStatus = null;
    if (this.routeMonitor) clearInterval(this.routeMonitor);
    this.routeMonitor = null;
    if (!deployment) {
      this.sessionStore.delete('remoteVoice.activeDeployment');
      return { active: false };
    }

    try {
      const client = await sshService.getConnectionForCodex(deployment.session.id, deployment.sshConfig);
      const runtimeStatus = await this.readRuntimeStatus(deployment, client);
      if (!runtimeStatus || runtimeStatus.sessionId === deployment.session.id) {
        await this.execRemote(client, [
          `(tailscale serve --https=${deployment.servePort} off || sudo -n tailscale serve --https=${deployment.servePort} off) >/dev/null 2>&1 || true`,
          `if [ -f ${shellQuote(`${deployment.remoteDirectory}/server.pid`)} ]; then kill "$(cat ${shellQuote(`${deployment.remoteDirectory}/server.pid`)})" 2>/dev/null || true; fi`,
          `rm -f ${shellQuote(`${deployment.remoteDirectory}/config.json`)} ${shellQuote(`${deployment.remoteDirectory}/server.pid`)}`,
        ].join(' && '));
      } else {
        console.warn('[RemoteVoice] Stop skipped remote cleanup because another Build session owns the SSH runtime:', {
          expectedSessionId: deployment.session.id,
          actualSessionId: runtimeStatus.sessionId,
        });
      }
    } catch (error) {
      console.warn('[RemoteVoice] Remote cleanup was incomplete:', error);
    }
    this.sessionStore.delete('remoteVoice.activeDeployment');
    console.log('[RemoteVoice] Stopped:', deployment.status.sessionId);
    return { active: false };
  }
}

export const remoteVoiceService = new RemoteVoiceService();
