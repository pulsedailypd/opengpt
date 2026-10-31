(() => {
  const CFG = window.OPENGPT_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const AUTH_KEY = 'opengpt_auth';
  const THEME_KEY = 'opengpt_theme';
  const MAX_IMAGES = 3;

  let auth = null;          // { idToken, refreshToken }
  let user = null;          // decoded token claims
  let chats = [];
  let activeId = null;
  let streaming = false;
  let abortCtrl = null;
  let speakNext = false;    // set when a message came from voice
  let editingIndex = -1;    // index of the user message being edited
  let pendingImages = [];   // data URLs waiting to be sent
  let settings = { size: 'medium', speakMode: 'voice', voiceURI: '', instructions: '' };

  /* ====================== Theme ====================== */
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const getTheme = () => localStorage.getItem(THEME_KEY) || 'system';
  function applyTheme() {
    const t = getTheme();
    const dark = t === 'dark' || (t === 'system' && mq.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  mq.addEventListener('change', applyTheme);
  applyTheme();

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
  const goLogin = () => { location.href = `${CFG.authUrl}/?redirect=${encodeURIComponent(returnUrl())}`; };
  function logout() {
    stopWake(true);
    localStorage.removeItem(AUTH_KEY);
    location.href = `${CFG.authUrl}/?logout=1&redirect=${encodeURIComponent(returnUrl())}`;
  }

  /* ====================== Storage ====================== */
  const uid = () => user.user_id || user.sub;
  const chatsKey = () => `opengpt_chats_${uid()}`;
  const settingsKey = () => `opengpt_settings_${uid()}`;
  const activeChat = () => chats.find((c) => c.id === activeId);

  function saveChats() {
    try {
      localStorage.setItem(chatsKey(), JSON.stringify(chats));
    } catch {
      // Storage is full (images are big): keep the text, drop saved pictures.
      const slim = chats.map((c) => ({
        ...c,
        messages: c.messages.map((m) => {
          if (!m.images) return m;
          const { images, ...rest } = m;
          return { ...rest, imageCount: images.length };
        }),
      }));
      try { localStorage.setItem(chatsKey(), JSON.stringify(slim)); toast('Storage is full, so pictures are not kept in your history.', '', 5000); } catch { /* give up */ }
    }
  }
  function loadChats() { try { chats = JSON.parse(localStorage.getItem(chatsKey())) || []; } catch { chats = []; } }
  function loadSettings() {
    try { settings = { ...settings, ...(JSON.parse(localStorage.getItem(settingsKey())) || {}) }; } catch { /* defaults */ }
    document.documentElement.dataset.size = settings.size;
  }
  const saveSettings = () => localStorage.setItem(settingsKey(), JSON.stringify(settings));

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

  /* ====================== Rendering ====================== */
  const initials = () => (user.name || user.email || '?').trim().charAt(0).toUpperCase();
  const ICON = {
    edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    redo: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  };

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

  function startRename(chat, row) {
    const span = row.querySelector('span');
    const input = document.createElement('input');
    input.className = 'rename-input'; input.value = chat.title; input.maxLength = 80;
    input.setAttribute('aria-label', 'Chat name');
    span.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v) { chat.title = v; saveChats(); }
      renderAll();
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
    input.onblur = () => finish(true);
    input.onclick = (e) => e.stopPropagation();
  }

  function renderChatList() {
    const list = $('#chatList');
    list.innerHTML = '';
    if (!chats.length) { list.innerHTML = '<div class="empty-list">Your chats will show up here.</div>'; return; }
    for (const c of chats) {
      const row = document.createElement('div');
      row.className = 'chat-item' + (c.id === activeId ? ' active' : '');
      row.setAttribute('role', 'listitem');
      row.innerHTML = `<span>${esc(c.title)}</span><div class="row-actions"><button class="ren" aria-label="Rename chat" title="Rename">✎</button><button class="del" aria-label="Delete chat" title="Delete">✕</button></div>`;
      row.onclick = () => { if (!streaming) { activeId = c.id; editingIndex = -1; renderAll(); closeSidebar(); } };
      row.querySelector('span').ondblclick = (e) => { e.stopPropagation(); startRename(c, row); };
      row.querySelector('.ren').onclick = (e) => { e.stopPropagation(); startRename(c, row); };
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

  function actionBtn(action, index, icon, label) {
    return `<button class="act" data-action="${action}" data-index="${index}" title="${label}" aria-label="${label}">${icon}<span>${label}</span></button>`;
  }

  function renderMessages() {
    const box = $('#messages');
    const chat = activeChat();
    $('#topTitle').textContent = chat ? chat.title : 'New chat';
    if (!chat || !chat.messages.length) {
      const first = (user.name || '').split(' ')[0];
      box.innerHTML = `<div class="welcome"><h2>${first ? 'Hi ' + esc(first) + '. ' : ''}What can I help with?</h2><p>Type below, attach a picture, or say “Hey Open” after turning on voice.</p><div class="starters"></div></div>`;
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
    const lastIdx = chat.messages.length - 1;
    chat.messages.forEach((m, i) => {
      const el = document.createElement('div');
      el.className = 'msg ' + m.role;
      el.innerHTML = `<div class="who">${m.role === 'user' ? esc(initials()) : 'AI'}</div><div class="body"><div class="bubble"></div><div class="actions"></div></div>`;
      const bubble = el.querySelector('.bubble');
      const actions = el.querySelector('.actions');

      if (m.role === 'user') {
        if (editingIndex === i) {
          bubble.className = 'bubble editing';
          bubble.innerHTML = '<textarea class="edit-area" aria-label="Edit message"></textarea><div class="edit-actions"><button class="btn-sm primary" data-action="save-edit">Save and submit</button><button class="btn-sm" data-action="cancel-edit">Cancel</button></div>';
          bubble.querySelector('textarea').value = m.content;
          actions.remove();
        } else {
          let html = '';
          if (m.images && m.images.length) html += '<div class="thumbs">' + m.images.map((u) => `<img src="${u}" alt="Attached image">`).join('') + '</div>';
          else if (m.imageCount) html += `<div class="thumbs"><div class="gone">${m.imageCount} image${m.imageCount > 1 ? 's' : ''} (not saved)</div></div>`;
          bubble.innerHTML = html + (m.content ? `<span class="txt"></span>` : '');
          if (m.content) bubble.querySelector('.txt').textContent = m.content;
          if (!bubble.innerHTML) bubble.style.display = 'none';
          if (!streaming) actions.innerHTML = actionBtn('edit', i, ICON.edit, 'Edit');
        }
      } else {
        bubble.innerHTML = md(m.content || '');
        const live = streaming && i === lastIdx;
        if (live) bubble.classList.add('typing');
        else {
          let a = actionBtn('copy-msg', i, ICON.copy, 'Copy');
          if (i === lastIdx && !streaming) a += actionBtn('regen', i, ICON.redo, 'Regenerate');
          actions.innerHTML = a;
        }
      }
      thread.appendChild(el);
    });
    if (editingIndex >= 0) { const ta = box.querySelector('.edit-area'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
    else box.scrollTop = box.scrollHeight;
  }

  function updateLast(text) {
    const bubbles = document.querySelectorAll('.msg.assistant .bubble');
    const b = bubbles[bubbles.length - 1];
    if (!b) return;
    b.innerHTML = md(text);
    const box = $('#messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 140) box.scrollTop = box.scrollHeight;
  }

  function renderAttachments() {
    const box = $('#attachments');
    box.classList.toggle('hidden', !pendingImages.length);
    box.innerHTML = '';
    pendingImages.forEach((u, i) => {
      const d = document.createElement('div');
      d.className = 'attach';
      d.innerHTML = `<img src="${u}" alt="Attachment ${i + 1}"><button type="button" aria-label="Remove image">✕</button>`;
      d.querySelector('button').onclick = () => { pendingImages.splice(i, 1); renderAttachments(); setSendState(); };
      box.appendChild(d);
    });
  }

  function renderAll() { renderChatList(); renderMessages(); renderAttachments(); setSendState(); }

  function setSendState() {
    const btn = $('#sendBtn');
    if (streaming) {
      btn.disabled = false; btn.title = 'Stop'; btn.setAttribute('aria-label', 'Stop');
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    } else {
      btn.title = 'Send'; btn.setAttribute('aria-label', 'Send');
      btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
      btn.disabled = !$('#input').value.trim() && !pendingImages.length;
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
  const closeSidebar = () => $('#sidebar').classList.remove('open');

  /* ====================== Images ====================== */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }

  // Resize to max 1024px and re-encode as JPEG so uploads stay small and fast.
  async function toDataUrl(file) {
    const img = await loadImage(file);
    const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * scale));
    c.height = Math.max(1, Math.round(img.height * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  async function addFiles(files) {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) return;
    for (const f of imgs) {
      if (pendingImages.length >= MAX_IMAGES) { toast(`You can attach up to ${MAX_IMAGES} images.`); break; }
      try { pendingImages.push(await toDataUrl(f)); }
      catch { toast('That image could not be read. Try a JPG or PNG.'); }
    }
    renderAttachments(); setSendState();
  }

  /* ====================== Chat ====================== */
  function newChat() {
    const c = { id: crypto.randomUUID(), title: 'New chat', messages: [] };
    chats.unshift(c); activeId = c.id;
    return c;
  }

  const makeTitle = (t) => (t.length > 42 ? t.slice(0, 42) + '…' : t) || 'Image chat';

  // Only the newest picture is sent as an image; older ones are mentioned as text to keep requests small.
  function buildPayload(msgs) {
    const list = msgs.filter((m) => !m.error);
    let lastImg = -1;
    list.forEach((m, i) => { if (m.role === 'user' && m.images && m.images.length) lastImg = i; });
    return list.map((m, i) => {
      if (m.role === 'user' && m.images && m.images.length) {
        if (i === lastImg) {
          return { role: 'user', content: [
            { type: 'text', text: m.content || 'Describe this image.' },
            ...m.images.map((u) => ({ type: 'image_url', image_url: { url: u } })),
          ] };
        }
        return { role: 'user', content: `${m.content || ''} [${m.images.length} image(s) were attached earlier]`.trim() };
      }
      if (m.role === 'user' && m.imageCount) return { role: 'user', content: `${m.content || ''} [${m.imageCount} image(s) were attached earlier]`.trim() };
      return { role: m.role, content: m.content };
    });
  }

  async function send(text) {
    text = (text || '').trim();
    if ((!text && !pendingImages.length) || streaming) return;
    let chat = activeChat() || newChat();
    const msg = { role: 'user', content: text };
    if (pendingImages.length) msg.images = pendingImages.slice();
    pendingImages = [];
    chat.messages.push(msg);
    if (chat.messages.length === 1) chat.title = makeTitle(text);
    $('#input').value = ''; autosize();
    await generate(chat);
  }

  async function generate(chat) {
    const reply = { role: 'assistant', content: '' };
    chat.messages.push(reply);
    editingIndex = -1;
    streaming = true;
    abortCtrl = new AbortController();
    saveChats(); renderAll();

    try {
      const token = await getToken();
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ messages: buildPayload(chat.messages.slice(0, -1)), instructions: settings.instructions }),
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
      const say = settings.speakMode === 'always' || (settings.speakMode === 'voice' && speakNext);
      if (say && reply.content && !reply.error) speak(reply.content);
      speakNext = false;
    }
  }

  function regenerate() {
    const chat = activeChat();
    if (!chat || streaming) return;
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === 'assistant') chat.messages.pop();
    if (!chat.messages.length) return;
    generate(chat);
  }

  function saveEdit() {
    const chat = activeChat();
    const ta = $('.edit-area');
    if (!chat || !ta || streaming) return;
    const text = ta.value.trim();
    const m = chat.messages[editingIndex];
    if (!m || (!text && !(m.images && m.images.length))) return;
    m.content = text;
    chat.messages.length = editingIndex + 1; // everything after the edited message is discarded
    if (editingIndex === 0) chat.title = makeTitle(text);
    generate(chat);
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
  let wakeOn = false;
  let mode = 'wake';        // 'wake' | 'command'
  let oneShot = false;
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
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === settings.voiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
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
    cmdTimer = setTimeout(() => {
      if (mode === 'command') { mode = 'wake'; hideToast(); setWakeUI(); if (oneShot) { oneShot = false; if (!wakeOn) stopRec(); setWakeUI(); } }
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
    if (speaking) return;
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
    rec.onend = () => {
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

  /* ====================== Settings ====================== */
  function markSeg(sel, value) {
    document.querySelectorAll(`${sel} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
  }

  function populateVoices() {
    const sel = $('#voiceSel');
    const voices = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : [];
    sel.innerHTML = '<option value="">Browser default</option>' +
      voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
    sel.value = settings.voiceURI;
    if (sel.value !== settings.voiceURI) sel.value = '';
  }

  function openSettings() {
    markSeg('#themeSeg', getTheme());
    markSeg('#sizeSeg', settings.size);
    $('#speakMode').value = settings.speakMode;
    $('#instructions').value = settings.instructions;
    populateVoices();
    $('#settings').showModal();
  }

  function wireSettings() {
    $('#settingsBtn').onclick = openSettings;
    $('#closeSettings').onclick = () => $('#settings').close();
    $('#settings').addEventListener('click', (e) => { if (e.target === $('#settings')) $('#settings').close(); });
    $('#themeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      localStorage.setItem(THEME_KEY, b.dataset.v); applyTheme(); markSeg('#themeSeg', b.dataset.v);
    });
    $('#sizeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      settings.size = b.dataset.v; document.documentElement.dataset.size = b.dataset.v; saveSettings(); markSeg('#sizeSeg', b.dataset.v);
    });
    $('#speakMode').onchange = (e) => { settings.speakMode = e.target.value; saveSettings(); };
    $('#voiceSel').onchange = (e) => { settings.voiceURI = e.target.value; saveSettings(); if (e.target.value) speak('Hello, this is how I sound.'); };
    $('#instructions').oninput = (e) => { settings.instructions = e.target.value; saveSettings(); };
    $('#clearChats').onclick = () => {
      if (!confirm('Delete all chats on this device? This cannot be undone.')) return;
      chats = []; activeId = null; editingIndex = -1; saveChats(); renderAll(); $('#settings').close();
    };
    if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', () => { if ($('#settings').open) populateVoices(); });
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
    loadChats(); loadSettings();
    activeId = null;
    renderProfile();
    renderAll();
    wireSettings();

    $('#newChat').onclick = () => { if (!streaming) { activeId = null; editingIndex = -1; renderAll(); closeSidebar(); $('#input').focus(); } };
    $('#logoutBtn').onclick = logout;
    $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
    $('#wakeBtn').onclick = toggleWake;
    $('#micBtn').onclick = dictate;
    $('#sendBtn').onclick = () => { if (streaming) abortCtrl && abortCtrl.abort(); else send($('#input').value); };
    $('#attachBtn').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
    $('#input').addEventListener('input', () => { autosize(); setSendState(); });
    $('#input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#input').value); }
    });
    $('#input').addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files); }
    });

    // One delegated handler for every button inside the conversation.
    $('#messages').addEventListener('click', (e) => {
      const copyCode = e.target.closest('.copy');
      if (copyCode) {
        const code = copyCode.closest('.code').querySelector('code').textContent;
        navigator.clipboard.writeText(code).then(() => { copyCode.textContent = 'Copied'; setTimeout(() => (copyCode.textContent = 'Copy'), 1500); });
        return;
      }
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const idx = Number(btn.dataset.index);
      const chat = activeChat();
      switch (btn.dataset.action) {
        case 'edit': if (!streaming) { editingIndex = idx; renderMessages(); } break;
        case 'cancel-edit': editingIndex = -1; renderMessages(); break;
        case 'save-edit': saveEdit(); break;
        case 'regen': regenerate(); break;
        case 'copy-msg':
          if (chat && chat.messages[idx]) navigator.clipboard.writeText(chat.messages[idx].content).then(() => toast('Copied.', '', 1500));
          break;
      }
    });
    $('#messages').addEventListener('keydown', (e) => {
      if (!e.target.classList.contains('edit-area')) return;
      if (e.key === 'Escape') { editingIndex = -1; renderMessages(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });
  }

  boot();
})();
