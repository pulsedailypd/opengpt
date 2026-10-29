(() => {
  const CFG = window.OPENGPT_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const AUTH_KEY = 'opengpt_auth';

  let auth = null;          // { idToken, refreshToken }
  let user = null;          // decoded token claims
  let chats = [];
  let activeId = null;
  let streaming = false;
  let abortCtrl = null;
  let speakNext = false;    // read the next reply aloud (set when a message came from voice)

  /* ====================== Auth ====================== */
  function decodeClaims(jwt) {
    try {
      const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p), (c) => c.charCodeAt(0))));
    } catch { return null; }
  }

  function captureAuth() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('token')) {
      auth = { idToken: h.get('token'), refreshToken: h.get('refresh') || null };
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
      history.replaceState(null, '', location.pathname + location.search); // remove token from the address bar
    } else {
      try { auth = JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { auth = null; }
    }
  }

  async function getToken() {
    if (!auth) throw new Error('Please log in to continue.');
    const c = decodeClaims(auth.idToken);
    if (c && c.exp * 1000 - Date.now() > 60_000) return auth.idToken;
    if (!auth.refreshToken) { clearAuth(); throw new Error('Your session expired. Please log in again.'); }
    const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(CFG.firebaseApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refreshToken }),
    });
    if (!r.ok) { clearAuth(); throw new Error('Your session expired. Please log in again.'); }
    const d = await r.json();
    auth = { idToken: d.id_token, refreshToken: d.refresh_token };
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    return auth.idToken;
  }

  function clearAuth() {
    localStorage.removeItem(AUTH_KEY);
    auth = null;
    setTimeout(() => location.reload(), 1200);
  }

  const returnUrl = () => location.origin + location.pathname;

  function goLogin() {
    location.href = `${CFG.authUrl}/?redirect=${encodeURIComponent(returnUrl())}`;
  }
  function logout() {
    stopWake(true);
    localStorage.removeItem(AUTH_KEY);
    // Also sign the user out of the Firebase login website, then return to the app's login screen.
    location.href = `${CFG.authUrl}/?logout=1&redirect=${encodeURIComponent(returnUrl())}`;
  }

  /* ====================== Storage ====================== */
  const storeKey = () => `opengpt_chats_${user.user_id || user.sub}`;
  const saveChats = () => localStorage.setItem(storeKey(), JSON.stringify(chats));
  const loadChats = () => { try { chats = JSON.parse(localStorage.getItem(storeKey())) || []; } catch { chats = []; } };
  const activeChat = () => chats.find((c) => c.id === activeId);

  /* ====================== Markdown (safe: escapes first) ====================== */
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function md(src) {
    const blocks = [];
    let s = src.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
      blocks.push(`<div class="code"><div class="code-head"><span>${esc(lang || 'code')}</span><button class="copy">Copy</button></div><pre><code>${esc(code.replace(/\n$/, ''))}</code></pre></div>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    s = esc(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    let out = '', list = null, para = [];
    const flushP = () => { if (para.length) { out += '<p>' + para.join('<br>') + '</p>'; para = []; } };
    const flushL = () => { if (list) { out += `</${list}>`; list = null; } };
    for (const ln of s.split('\n')) {
      let m;
      if (/^\u0000\d+\u0000$/.test(ln.trim())) { flushP(); flushL(); out += ln.trim(); }
      else if ((m = ln.match(/^(#{1,4})\s+(.*)/))) { flushP(); flushL(); const n = m[1].length + 1; out += `<h${n}>${m[2]}</h${n}>`; }
      else if ((m = ln.match(/^\s*[-*]\s+(.*)/))) { flushP(); if (list !== 'ul') { flushL(); out += '<ul>'; list = 'ul'; } out += `<li>${m[1]}</li>`; }
      else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)/))) { flushP(); if (list !== 'ol') { flushL(); out += '<ol>'; list = 'ol'; } out += `<li>${m[1]}</li>`; }
      else if (!ln.trim()) { flushP(); flushL(); }
      else { flushL(); para.push(ln); }
    }
    flushP(); flushL();
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
  }

  /* ====================== UI rendering ====================== */
  const initials = () => (user.name || user.email || '?').trim().charAt(0).toUpperCase();

  function renderProfile() {
    $('#userName').textContent = user.name || 'Signed in';
    $('#userEmail').textContent = user.email || '';
    const box = $('#avatar');
    box.innerHTML = '';
    if (user.picture) {
      const img = document.createElement('img');
      img.className = 'avatar-img'; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.src = user.picture;
      img.onerror = () => { box.innerHTML = `<div class="avatar-fallback">${esc(initials())}</div>`; };
      box.appendChild(img);
    } else {
      box.innerHTML = `<div class="avatar-fallback">${esc(initials())}</div>`;
    }
  }

  function renderChatList() {
    const list = $('#chatList');
    list.innerHTML = '';
    if (!chats.length) { list.innerHTML = '<div class="empty-list">Your chats will show up here.</div>'; return; }
    for (const c of chats) {
      const row = document.createElement('div');
      row.className = 'chat-item' + (c.id === activeId ? ' active' : '');
      row.setAttribute('role', 'listitem');
      row.innerHTML = `<span>${esc(c.title)}</span><button class="del" aria-label="Delete chat" title="Delete chat">✕</button>`;
      row.onclick = () => { if (!streaming) { activeId = c.id; renderAll(); closeSidebar(); } };
      row.querySelector('.del').onclick = (e) => {
        e.stopPropagation();
        if (streaming) return;
        chats = chats.filter((x) => x.id !== c.id);
        if (activeId === c.id) activeId = null;
        saveChats(); renderAll();
      };
      list.appendChild(row);
    }
  }

  const STARTERS = [
    'Explain how a neural network learns, simply',
    'Write a Python script that renames files by date',
    'Plan a 3-day trip itinerary for Kyoto',
    'Help me write a polite email asking for a deadline extension',
  ];

  function renderMessages() {
    const box = $('#messages');
    const chat = activeChat();
    $('#topTitle').textContent = chat ? chat.title : 'New chat';
    if (!chat || !chat.messages.length) {
      const first = (user.name || '').split(' ')[0];
      box.innerHTML = `<div class="welcome"><h2>${first ? 'Hi ' + esc(first) + '. ' : ''}What can I help with?</h2><p>Type below, or say “Hey Open” after turning on voice.</p><div class="starters"></div></div>`;
      const st = box.querySelector('.starters');
      STARTERS.forEach((t) => {
        const b = document.createElement('button');
        b.className = 'starter'; b.textContent = t; b.onclick = () => send(t);
        st.appendChild(b);
      });
      return;
    }
    box.innerHTML = '<div class="thread"></div>';
    const thread = box.firstChild;
    chat.messages.forEach((m, i) => {
      const isLast = i === chat.messages.length - 1;
      const el = document.createElement('div');
      el.className = 'msg ' + m.role;
      el.innerHTML = `<div class="who">${m.role === 'user' ? esc(initials()) : 'AI'}</div><div class="bubble"></div>`;
      const b = el.querySelector('.bubble');
      if (m.role === 'user') b.textContent = m.content;
      else {
        b.innerHTML = md(m.content || '');
        if (streaming && isLast) b.classList.add('typing');
      }
      thread.appendChild(el);
    });
    box.scrollTop = box.scrollHeight;
  }

  function updateLast(text) {
    const bubbles = document.querySelectorAll('.msg.assistant .bubble');
    const b = bubbles[bubbles.length - 1];
    if (!b) return;
    b.innerHTML = md(text);
    const box = $('#messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  function renderAll() { renderChatList(); renderMessages(); setSendState(); }

  function setSendState() {
    const btn = $('#sendBtn');
    if (streaming) {
      btn.disabled = false; btn.title = 'Stop'; btn.setAttribute('aria-label', 'Stop');
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    } else {
      btn.title = 'Send'; btn.setAttribute('aria-label', 'Send');
      btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
      btn.disabled = !$('#input').value.trim();
    }
  }

  let toastTimer;
  function toast(msg, cls = '', ms = 3500) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast ' + cls;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  const hideToast = () => $('#toast').classList.add('hidden');

  function closeSidebar() { $('#sidebar').classList.remove('open'); }

  /* ====================== Chat ====================== */
  function newChat() {
    if (streaming) return null;
    const c = { id: crypto.randomUUID(), title: 'New chat', messages: [] };
    chats.unshift(c); activeId = c.id;
    return c;
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || streaming) return;
    let chat = activeChat();
    if (!chat) chat = newChat();
    chat.messages.push({ role: 'user', content: text });
    if (chat.messages.length === 1) chat.title = text.length > 42 ? text.slice(0, 42) + '…' : text;
    const reply = { role: 'assistant', content: '' };
    chat.messages.push(reply);
    streaming = true;
    abortCtrl = new AbortController();
    saveChats(); renderAll();
    $('#input').value = ''; autosize();

    try {
      const token = await getToken();
      const payload = chat.messages.slice(0, -1).filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ messages: payload }),
        signal: abortCtrl.signal,
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `Request failed (${r.status})`);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          try {
            const piece = JSON.parse(d).choices?.[0]?.delta?.content;
            if (piece) { reply.content += piece; updateLast(reply.content); }
          } catch { /* ignore partial JSON */ }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        reply.error = true;
        reply.content += (reply.content ? '\n\n' : '') + '⚠️ ' + e.message;
      }
    } finally {
      streaming = false; abortCtrl = null;
      if (!reply.content) chat.messages.pop(); // stopped before any output
      saveChats(); renderAll();
      if (speakNext && reply.content && !reply.error) speak(reply.content);
      speakNext = false;
    }
  }

  function autosize() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 200) + 'px';
  }

  /* ====================== Voice ====================== */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const WAKE_RE = /\bhey[,.!]?\s+open(?:\s*g\s*p\s*t)?\b[,.!?]?/i;
  let rec = null;
  let wakeOn = false;       // continuously listening for "Hey Open"
  let mode = 'wake';        // 'wake' | 'command'
  let oneShot = false;      // mic-button dictation
  let speaking = false;
  let cmdTimer = null;
  let audioCtx = null;

  function chime(freqs = [660, 880]) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      freqs.forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = f; o.type = 'sine';
        const t0 = audioCtx.currentTime + i * 0.11;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + 0.2);
      });
    } catch { /* audio not available */ }
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const plain = text.replace(/```[\s\S]*?```/g, ' code block omitted. ').replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 1200);
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(plain);
    speaking = true;
    u.onend = u.onerror = () => { speaking = false; };
    speechSynthesis.speak(u);
  }

  function setWakeUI() {
    const b = $('#wakeBtn');
    b.classList.toggle('on', wakeOn);
    b.classList.toggle('hearing', wakeOn && mode === 'command');
    b.setAttribute('aria-pressed', String(wakeOn));
    $('#wakeLabel').textContent = !wakeOn ? 'Hey Open: off' : mode === 'command' ? 'Listening…' : 'Say “Hey Open”';
    $('#micBtn').classList.toggle('rec', oneShot);
  }

  function enterCommandMode() {
    mode = 'command';
    chime();
    toast('Listening… go ahead', 'listening', 0);
    setWakeUI();
    clearTimeout(cmdTimer);
    cmdTimer = setTimeout(() => { // nothing heard: back to waiting
      if (mode === 'command') { mode = 'wake'; hideToast(); setWakeUI(); if (oneShot) { oneShot = false; stopRec(); setWakeUI(); } }
    }, 9000);
  }

  function handleCommand(text) {
    clearTimeout(cmdTimer);
    hideToast();
    mode = 'wake';
    const wasOneShot = oneShot;
    oneShot = false;
    if (wasOneShot && !wakeOn) stopRec();
    setWakeUI();
    if (text) { speakNext = true; send(text); }
  }

  function onResult(e) {
    if (speaking) return; // don't listen to our own voice
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (!res.isFinal) continue;
      const text = res[0].transcript.trim();
      if (mode === 'wake') {
        const m = text.match(WAKE_RE);
        if (!m) continue;
        const after = text.slice(m.index + m[0].length).trim();
        if (after.length > 1) { chime([880]); handleCommand(after); }
        else enterCommandMode();
      } else {
        handleCommand(text);
      }
    }
  }

  function startRec() {
    if (!SR) { toast('Voice needs Chrome, Edge or Safari.'); return false; }
    if (rec) return true;
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = onResult;
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('Microphone blocked. Allow microphone access in your browser and try again.', '', 6000);
        wakeOn = false; oneShot = false; stopRec(); setWakeUI();
      }
    };
    rec.onend = () => { // browsers end sessions on silence; restart while voice is on
      const keep = wakeOn || oneShot;
      rec = null;
      if (keep) setTimeout(startRec, 250);
    };
    try { rec.start(); } catch { /* already started */ }
    return true;
  }

  function stopRec() {
    if (!rec) return;
    const r = rec; rec = null;
    r.onend = null;
    try { r.abort(); } catch { /* ignore */ }
  }

  function stopWake(silent) {
    wakeOn = false; oneShot = false; mode = 'wake';
    clearTimeout(cmdTimer); stopRec(); setWakeUI();
    if (!silent) hideToast();
  }

  function toggleWake() {
    if (wakeOn) { stopWake(); toast('Hey Open is off.'); return; }
    if (!startRec()) return;
    wakeOn = true; mode = 'wake'; setWakeUI();
    toast('Say “Hey Open” and then your question. Keep this tab open.', '', 4500);
  }

  function dictate() {
    if (oneShot) { oneShot = false; if (!wakeOn) stopRec(); hideToast(); mode = 'wake'; setWakeUI(); return; }
    if (!startRec()) return;
    oneShot = true;
    enterCommandMode();
  }

  /* ====================== Boot ====================== */
  function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }

  function boot() {
    captureAuth();
    $('#loginBtn').onclick = goLogin;
    const claims = auth && decodeClaims(auth.idToken);
    const valid = claims && (auth.refreshToken || claims.exp * 1000 > Date.now());
    if (!valid) { showLogin(); return; }

    user = claims;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    loadChats();
    activeId = null;
    renderProfile();
    renderAll();

    $('#newChat').onclick = () => { if (!streaming) { activeId = null; renderAll(); closeSidebar(); $('#input').focus(); } };
    $('#logoutBtn').onclick = logout;
    $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
    $('#wakeBtn').onclick = toggleWake;
    $('#micBtn').onclick = dictate;
    $('#sendBtn').onclick = () => { if (streaming) abortCtrl && abortCtrl.abort(); else send($('#input').value); };
    $('#input').addEventListener('input', () => { autosize(); setSendState(); });
    $('#input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#input').value); }
    });
    $('#messages').addEventListener('click', (e) => {
      const btn = e.target.closest('.copy');
      if (!btn) return;
      const code = btn.closest('.code').querySelector('code').textContent;
      navigator.clipboard.writeText(code).then(() => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1500); });
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });
  }

  boot();
})();
