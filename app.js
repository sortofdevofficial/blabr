'use strict';
const $ = (id) => document.getElementById(id);
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const svg = (d) => `<svg class="ic" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const ICON = {
    hash: svg('M5 9h14M5 15h14M10 3 8 21M16 3l-2 18'),
    trash: svg('M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6'),
    plus: svg('M12 5v14M5 12h14'),
    chat: svg('M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z')
};

const S = {
    token: localStorage.getItem('token') || '',
    me: null, servers: [], friends: [], view: 'home',
    server: null, channels: [], channelId: null, dm: null, members: [],
    last: {}, chLoaded: false, sig: '', sending: false, membersOn: window.innerWidth > 860,
    login: true, t1: null, t2: null
};

/* ---------- helpers ---------- */
const color = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) % 360; return `hsl(${x} 55% 48%)`; };
function avatar(name, cls = '') { const a = h('div', 'ava ' + cls, (name || '?')[0].toUpperCase()); a.style.background = color(name); return a; }
const isOwner = () => !!(S.me && S.server && S.server.owner === S.me.id);
const curChannel = () => S.channels.find(c => c.id === S.channelId) || null;
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtDay(t) {
    const d = new Date(t * 1000), n = new Date();
    if (d.toDateString() === n.toDateString()) return 'Today';
    n.setDate(n.getDate() - 1);
    if (d.toDateString() === n.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}
function toast(text, err = false) {
    const el = h('div', 'toast' + (err ? ' err' : ''), text);
    $('toast-stack').append(el);
    setTimeout(() => el.remove(), 3500);
}
function chatKey() {
    if (S.view === 'server' && S.server) return `s${S.server.id}c${S.channelId}`;
    if (S.view === 'dm' && S.dm) return `d${S.dm.id}`;
    return '';
}

async function post(payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (S.token) headers.Authorization = `Bearer ${S.token}`;
    try {
        const res = await fetch('/api/auth', { method: 'POST', headers, body: JSON.stringify(payload) });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 && S.token && !['login', 'register', 'verify'].includes(payload.action)) clearSession();
        return { res, data };
    } catch {
        return { res: { ok: false, status: 0 }, data: { error: 'Network error.' } };
    }
}

/* ---------- auth ---------- */
function setAuthMode(login) {
    S.login = login;
    $('title').textContent = login ? 'Welcome back' : 'Create your account';
    $('subtitle').textContent = login ? 'Log in to pick up where you left off.' : 'Join pratr in a few seconds.';
    $('btn').textContent = login ? 'Log in' : 'Create account';
    $('toggle-text').textContent = login ? 'New here?' : 'Already have an account?';
    $('toggle').textContent = login ? 'Create an account' : 'Log in';
    $('username-wrap').classList.toggle('hidden', login);
    $('password').autocomplete = login ? 'current-password' : 'new-password';
    $('msg').textContent = '';
}
$('toggle').onclick = () => setAuthMode(!S.login);

$('form').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('email').value.trim(), password = $('password').value;
    if (!email || !password) { $('msg').textContent = 'Email and password required.'; return; }
    $('msg').textContent = '';
    $('btn').disabled = true;
    const out = await post({ action: S.login ? 'login' : 'register', email, password, username: S.login ? '' : $('username').value.trim() });
    $('btn').disabled = false;
    if (!out.res.ok) { $('msg').textContent = out.data.error || 'Request failed.'; return; }
    if (S.login) return finishLogin(out.data);
    $('form').classList.add('hidden');
    $('otp-form').classList.remove('hidden');
    $('otp-note').textContent = `We sent a 6-digit code to ${email}.`;
    $('otp').focus();
};
$('otp-form').onsubmit = async (e) => {
    e.preventDefault();
    const out = await post({ action: 'verify', email: $('email').value.trim(), otp: $('otp').value.trim() });
    if (out.res.ok) finishLogin(out.data); else $('msg').textContent = out.data.error || 'Invalid code.';
};
$('resend').onclick = async () => {
    const out = await post({ action: 'register', email: $('email').value.trim(), password: $('password').value, username: $('username').value.trim() });
    if (out.res.ok) toast('New code sent.'); else $('msg').textContent = out.data.error || 'Could not resend.';
};
$('otp-back').onclick = () => { $('otp-form').classList.add('hidden'); $('form').classList.remove('hidden'); $('msg').textContent = ''; };

function finishLogin(data) {
    S.token = data.token;
    localStorage.setItem('token', S.token);
    localStorage.setItem('email', data.email);
    $('form').classList.remove('hidden');
    $('otp-form').classList.add('hidden');
    $('password').value = ''; $('otp').value = '';
    boot();
}

function clearSession() {
    clearInterval(S.t1); clearInterval(S.t2);
    S.token = ''; S.me = null; S.servers = []; S.friends = []; S.view = 'home';
    S.server = null; S.dm = null; S.channels = []; S.channelId = null; S.sig = '';
    localStorage.removeItem('token'); localStorage.removeItem('email');
    closeModals(); closeNav(); $('server-menu').classList.add('hidden');
    $('app').classList.add('hidden');
    $('auth-screen').classList.remove('hidden');
}
$('logout-btn').onclick = async () => { await post({ action: 'logout' }); clearSession(); };

/* ---------- boot ---------- */
function setMe(u) {
    const name = u.username || 'user';
    $('me-name').textContent = name;
    $('me-email').textContent = u.email || '';
    $('me-initial').textContent = name[0].toUpperCase();
    $('me-ava').style.background = color(name);
}

async function boot() {
    $('auth-screen').classList.add('hidden');
    $('app').classList.remove('hidden');
    const email = localStorage.getItem('email') || '';
    setMe({ username: email.split('@')[0], email });
    renderAll();
    const me = await post({ action: 'me' });
    if (!me.res.ok) return;
    S.me = me.data;
    setMe(me.data);
    await Promise.all([loadServers(), loadFriends()]);
    renderAll();
    startTimers();
    handleInvite();
}

function startTimers() {
    clearInterval(S.t1); clearInterval(S.t2);
    S.t1 = setInterval(() => { if (!document.hidden && S.view !== 'home') loadMessages(false); }, 3000);
    S.t2 = setInterval(async () => {
        if (document.hidden) return;
        await loadServers(); await loadFriends();
        if (S.view === 'server' && S.server) {
            const before = S.channelId, n = S.channels.length;
            await loadChannels();
            loadMembers();
            if (before !== S.channelId || n !== S.channels.length) { renderAll(); loadMessages(true); } else renderSide();
        }
    }, 15000);
}

/* ---------- data ---------- */
async function loadServers() {
    const out = await post({ action: 'servers' });
    if (!out.res.ok) return;
    S.servers = out.data.servers || [];
    if (S.server) {
        const fresh = S.servers.find(s => s.id === S.server.id);
        if (fresh) S.server = fresh; else if (S.view === 'server') { goHome(); return; }
    }
    renderRail();
}
async function loadFriends() {
    const out = await post({ action: 'friends' });
    if (!out.res.ok) return;
    S.friends = out.data.friends || [];
    renderSide();
    if (S.view === 'home') renderFriends();
}
async function loadChannels(reset = false) {
    if (!S.server) return;
    const out = await post({ action: 'channels', id: S.server.id });
    if (!out.res.ok) return;
    S.channels = out.data.channels || [];
    S.chLoaded = true;
    if (reset || !S.channels.some(c => c.id === S.channelId)) {
        const rem = S.channels.find(c => c.id === S.last[S.server.id]);
        const pick = rem || S.channels[0];
        S.channelId = pick ? pick.id : null;
    }
}
async function loadMembers() {
    if (!S.server) return;
    const sid = S.server.id;
    const out = await post({ action: 'members', id: sid });
    if (!out.res.ok || !S.server || S.server.id !== sid) return;
    S.members = out.data.members || [];
    S.server.owner = out.data.owner;
    renderMembers();
}
async function loadMessages(force = false) {
    const key = chatKey();
    if (!key) return;
    const isServer = S.view === 'server';
    if (isServer && S.channelId == null) return;
    const out = await post({ action: 'messages', kind: isServer ? 'server' : 'dm', id: isServer ? S.server.id : S.dm.id, ...(isServer ? { channelId: S.channelId } : {}) });
    if (chatKey() !== key) return; // user navigated away
    if (out.res.status === 404 && isServer) { await loadChannels(); renderAll(); return; }
    if (!out.res.ok) return;
    renderMessages(out.data.messages || [], force);
}

/* ---------- navigation ---------- */
function closeNav() { document.body.classList.remove('nav-open'); }
document.querySelectorAll('[data-menu]').forEach(b => b.onclick = () => document.body.classList.toggle('nav-open'));
$('scrim').onclick = closeNav;
$('rail-home').onclick = () => { goHome(); closeNav(); };
$('nav-friends').onclick = () => { goHome(); closeNav(); };

function goHome() {
    S.view = 'home'; S.server = null; S.dm = null; S.channels = []; S.channelId = null; S.members = []; S.sig = '';
    renderAll();
}
async function openServer(id) {
    const s = S.servers.find(x => x.id === id);
    if (!s) return;
    S.view = 'server'; S.server = s; S.dm = null; S.chLoaded = false; S.channels = []; S.channelId = null; S.members = []; S.sig = '';
    $('messages').textContent = '';
    renderAll();
    await loadChannels(true);
    renderAll();
    loadMembers();
    loadMessages(true);
    closeNav();
}
function openDM(user) {
    S.view = 'dm'; S.dm = user; S.server = null; S.channels = []; S.channelId = null; S.sig = '';
    $('messages').textContent = '';
    renderAll();
    loadMessages(true);
    closeNav();
    $('chat-input').focus();
}
function selectChannel(id) {
    S.channelId = id; S.last[S.server.id] = id; S.sig = '';
    $('messages').textContent = '';
    renderSide(); renderMain();
    loadMessages(true);
    closeNav();
}

/* ---------- rendering ---------- */
function renderAll() { renderRail(); renderSide(); renderMain(); renderMembers(); }

function renderRail() {
    $('rail-home').classList.toggle('active', S.view !== 'server');
    const box = $('rail-servers');
    box.textContent = '';
    S.servers.forEach(s => {
        const b = h('button', 'rail-btn' + (S.server && S.server.id === s.id ? ' active' : ''), s.name[0].toUpperCase());
        b.title = s.name;
        b.onclick = () => openServer(s.id);
        box.append(b);
    });
}

function renderSide() {
    const server = S.view === 'server' && S.server;
    $('side-title').textContent = server ? S.server.name : 'Home';
    $('server-menu-btn').classList.toggle('hidden', !server);
    $('home-list').classList.toggle('hidden', !!server);
    $('server-list').classList.toggle('hidden', !server);
    $('nav-friends').classList.toggle('active', S.view === 'home');

    const dms = $('dm-list');
    dms.textContent = '';
    if (!S.friends.length) dms.append(h('div', 'side-empty', 'Add a friend to start chatting.'));
    S.friends.forEach(u => {
        const b = h('button', 'dm-item' + (S.view === 'dm' && S.dm && S.dm.id === u.id ? ' active' : ''));
        b.append(avatar(u.username || u.email, 'sm'), h('span', '', u.username || u.email));
        b.onclick = () => openDM(u);
        b._ctx = userItems(u);
        dms.append(b);
    });

    const list = $('channel-list');
    list.textContent = '';
    if (!server) return;
    if (!S.channels.length) list.append(h('div', 'side-empty', 'No text channels yet.'));
    const cats = {};
    S.channels.forEach(c => (cats[c.category || 'TEXT CHANNELS'] = cats[c.category || 'TEXT CHANNELS'] || []).push(c));
    Object.entries(cats).forEach(([cat, chans]) => {
        const t = h('div', 'sec-title');
        t.append(h('span', '', cat));
        if (isOwner()) {
            const add = h('button', 'icon-btn'); add.innerHTML = ICON.plus; add.title = 'Create channel';
            add.onclick = () => openChannelModal(cat);
            t.append(add);
        }
        list.append(t);
        chans.forEach(c => {
            const it = h('div', 'ch-item' + (c.id === S.channelId ? ' active' : ''));
            it.tabIndex = 0; it.setAttribute('role', 'button');
            it.innerHTML = ICON.hash;
            it.append(h('span', '', c.name));
            if (isOwner()) {
                const del = h('button', 'ch-del'); del.innerHTML = ICON.trash; del.title = 'Delete channel';
                del.onclick = (e) => { e.stopPropagation(); deleteChannel(c); };
                it.append(del);
            }
            it._ctx = [['Open channel', () => selectChannel(c.id)], ['Copy name', () => copy(c.name)], ...(isOwner() ? ['-', ['Delete channel', () => deleteChannel(c), true]] : [])];
            it.onclick = () => selectChannel(c.id);
            it.onkeydown = (e) => { if (e.key === 'Enter') selectChannel(c.id); };
            list.append(it);
        });
    });
}

function renderFriends() {
    $('friend-count').textContent = S.friends.length;
    const grid = $('friend-grid');
    grid.textContent = '';
    if (!S.friends.length) { grid.style.display = 'block'; grid.append(h('div', 'empty-note', 'No friends yet — add someone above to start a conversation.')); return; }
    grid.style.display = '';
    S.friends.forEach(u => {
        const c = h('div', 'friend-card');
        const meta = h('div', 'meta');
        meta.append(h('strong', '', u.username || u.email), h('small', '', u.email || ''));
        const btn = h('button', 'btn ghost', 'Message');
        btn.onclick = () => openDM(u);
        c._ctx = userItems(u);
        c.append(avatar(u.username || u.email), meta, btn);
        grid.append(c);
    });
}

function renderMain() {
    const home = S.view === 'home';
    $('view-home').classList.toggle('hidden', !home);
    $('view-chat').classList.toggle('hidden', home);
    if (home) { renderFriends(); return; }
    const isServer = S.view === 'server';
    const ch = isServer ? curChannel() : null;
    const icon = $('chat-icon');
    icon.textContent = '';
    if (isServer) {
        icon.innerHTML = ICON.hash;
        $('chat-name').textContent = ch ? ch.name : S.server.name;
        $('chat-sub').textContent = ch ? S.server.name : '';
    } else {
        const n = S.dm.username || S.dm.email;
        icon.append(avatar(n, 'sm'));
        $('chat-name').textContent = n;
        $('chat-sub').textContent = '';
    }
    $('invite-btn').classList.toggle('hidden', !isServer);
    $('members-btn').classList.toggle('hidden', !isServer);
    $('members-btn').classList.toggle('on', S.membersOn);
    $('chat-body').classList.toggle('members-on', isServer && S.membersOn);

    const none = isServer && S.chLoaded && !ch;
    $('messages').classList.toggle('hidden', none);
    $('composer-wrap').classList.toggle('hidden', isServer && !ch);
    $('chat-empty').classList.toggle('hidden', !none);
    if (none) renderEmpty();
    $('chat-input').placeholder = isServer ? (ch ? `Message #${ch.name}` : '') : `Message @${S.dm.username || S.dm.email}`;
}

function renderEmpty() {
    const box = $('chat-empty');
    box.textContent = '';
    const big = h('div', 'big'); big.innerHTML = ICON.hash;
    box.append(big, h('h2', '', 'No text channels'));
    if (isOwner()) {
        box.append(h('p', '', 'This server has no text channels yet. Create one so people can start talking.'));
        const b = h('button', 'btn primary', 'Create channel');
        b.onclick = () => openChannelModal();
        box.append(b);
    } else {
        box.append(h('p', '', 'The owner hasn\'t created a text channel yet. Messaging is disabled until they do.'));
    }
}

function renderMembers() {
    $('members-count').textContent = S.members.length;
    const box = $('members-list');
    box.textContent = '';
    S.members.forEach(m => {
        const r = h('div', 'mem');
        r._ctx = userItems(m);
        r.append(avatar(m.username, 'sm'), h('span', '', m.username || 'Member'));
        if (S.server && m.id === S.server.owner) r.append(h('em', 'badge', 'OWNER'));
        box.append(r);
    });
}

function renderMessages(list, force) {
    const box = $('messages');
    const sig = list.map(m => m.id).join(',');
    if (sig === S.sig && !force) return;
    const stick = force || box.scrollTop + box.clientHeight >= box.scrollHeight - 100;
    box.textContent = '';

    const start = h('div', 'msg-start');
    const big = h('div', 'big');
    if (S.view === 'server') {
        big.innerHTML = ICON.hash;
        const ch = curChannel();
        start.append(big, h('h2', '', `Welcome to #${ch ? ch.name : ''}`), h('p', '', `This is the start of the #${ch ? ch.name : ''} channel.`));
    } else {
        const n = S.dm.username || S.dm.email;
        big.innerHTML = ICON.chat;
        start.append(big, h('h2', '', n), h('p', '', `This is the beginning of your conversation with ${n}.`));
    }
    box.append(start);

    let prev = null, prevDay = '';
    list.forEach(m => {
        const day = new Date(m.t * 1000).toDateString();
        if (day !== prevDay) { box.append(h('div', 'day-div', fmtDay(m.t))); prevDay = day; prev = null; }
        const same = prev && prev.author.id === m.author.id && m.t - prev.t < 300;
        const row = h('div', 'msg' + (same ? '' : ' first'));
        const gutter = h('div', 'gutter');
        if (same) gutter.textContent = fmtTime(m.t); else gutter.append(avatar(m.author.username));
        const body = h('div', 'body');
        if (!same) {
            const head = h('div', 'head');
            const name = h('strong', '', m.author.username);
            name.style.color = color(m.author.username).replace('48%', '70%');
            const time = h('time', '', fmtTime(m.t));
            head.append(name, time);
            body.append(head);
        }
        body.append(h('div', 'text', m.text));
        row._ctx = [...userItems(m.author), ['Copy message', () => copy(m.text)]];
        row.append(gutter, body);
        box.append(row);
        prev = m;
    });
    S.sig = sig;
    if (stick) box.scrollTop = box.scrollHeight;
}

/* ---------- composer ---------- */
const input = $('chat-input');
const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; };
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
});
$('chat-form').onsubmit = (e) => { e.preventDefault(); sendMessage(); };

async function sendMessage() {
    const text = input.value.trim();
    if (!text || S.sending) return;
    const isServer = S.view === 'server';
    if (isServer && S.channelId == null) return toast('This server has no text channel yet.', true);
    S.sending = true; $('chat-send').disabled = true;
    const out = await post({ action: 'send', kind: isServer ? 'server' : 'dm', id: isServer ? S.server.id : S.dm.id, text, ...(isServer ? { channelId: S.channelId } : {}) });
    S.sending = false; $('chat-send').disabled = false;
    if (out.res.ok) { input.value = ''; autosize(); await loadMessages(true); }
    else toast(out.data.error || 'Message failed.', true);
    input.focus();
}

/* ---------- friends ---------- */
async function addFriend(q) {
    const out = await post({ action: 'friend-add', username: q });
    if (out.res.ok) { toast('Friend added!'); loadFriends(); }
    else toast(out.data.error || 'Could not add friend.', true);
    return out.res.ok;
}
$('friend-add-form').onsubmit = async (e) => {
    e.preventDefault();
    if (await addFriend($('friend-add-input').value)) $('friend-add-input').value = '';
};

/* ---------- modals ---------- */
function openModal(id) { closeModals(); $(id).classList.remove('hidden'); const f = $(id).querySelector('input'); if (f) setTimeout(() => f.focus(), 30); }
function closeModals() { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); }
document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModals);
document.querySelectorAll('.modal').forEach(m => m.addEventListener('mousedown', (e) => { if (e.target === m) closeModals(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModals(); $('server-menu').classList.add('hidden'); closeNav(); } });

$('server-create').onclick = () => openModal('modal-server');
$('server-join-btn').onclick = () => openModal('modal-join');

$('server-create-form').onsubmit = async (e) => {
    e.preventDefault();
    const out = await post({ action: 'server-create', name: $('server-name').value.trim() });
    if (!out.res.ok) return toast(out.data.error || 'Could not create server.', true);
    closeModals(); $('server-name').value = '';
    await loadServers();
    openServer(out.data.server.id);
    toast('Server created!');
};

function parseInvite(v) { const m = String(v).match(/[a-f0-9]{48}/i); return m ? m[0].toLowerCase() : ''; }
async function joinWithCode(code) {
    const out = await post({ action: 'server-join', code });
    if (!out.res.ok) return toast(out.data.error || 'Invalid invite.', true);
    closeModals();
    await loadServers();
    openServer(out.data.server.id);
    toast(`Joined ${out.data.server.name}`);
}
$('server-join-form').onsubmit = (e) => {
    e.preventDefault();
    const code = parseInvite($('join-code').value);
    if (!code) return toast('That doesn\'t look like a valid invite.', true);
    $('join-code').value = '';
    joinWithCode(code);
};
function handleInvite() {
    const code = parseInvite(location.hash.startsWith('#invite=') ? location.hash : '');
    if (!code) return;
    history.replaceState(null, '', location.pathname);
    joinWithCode(code);
}

function openChannelModal(cat) {
    if (!isOwner()) return;
    $('channel-modal-msg').textContent = '';
    $('cat-options').textContent = '';
    [...new Set(S.channels.map(c => c.category))].forEach(c => { const o = document.createElement('option'); o.value = c; $('cat-options').append(o); });
    $('new-channel-cat').value = cat || 'TEXT CHANNELS';
    $('new-channel-name').value = '';
    openModal('modal-channel');
}
$('channel-create-form').onsubmit = async (e) => {
    e.preventDefault();
    if (!S.server) return;
    const out = await post({ action: 'channel-create', id: S.server.id, channelName: $('new-channel-name').value, category: $('new-channel-cat').value.trim() || 'TEXT CHANNELS' });
    if (!out.res.ok) { $('channel-modal-msg').textContent = out.data.error || 'Could not create channel.'; return; }
    closeModals();
    await loadChannels();
    S.channelId = out.data.channel.id; S.last[S.server.id] = S.channelId; S.sig = '';
    renderAll(); loadMessages(true);
    toast('Channel created.');
};
async function deleteChannel(c) {
    if (!confirm(`Delete #${c.name}? All its messages will be removed.`)) return;
    const out = await post({ action: 'channel-delete', channelId: c.id });
    if (!out.res.ok) return toast(out.data.error || 'Could not delete channel.', true);
    await loadChannels(c.id === S.channelId);
    S.sig = ''; renderAll(); loadMessages(true);
}

async function openInvite() {
    if (!S.server) return;
    const out = await post({ action: 'server-invite', id: S.server.id });
    if (!out.res.ok) return toast(out.data.error || 'Could not create invite.', true);
    $('invite-link').value = `${location.origin}/#invite=${out.data.code}`;
    openModal('modal-invite');
    $('invite-link').select();
}
$('invite-btn').onclick = openInvite;
$('invite-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('invite-link').value); toast('Invite link copied!'); }
    catch { $('invite-link').select(); toast('Press Ctrl+C to copy.'); }
};
$('members-btn').onclick = () => { S.membersOn = !S.membersOn; renderMain(); };

/* ---------- server menu ---------- */
$('server-menu-btn').onclick = (e) => {
    e.stopPropagation();
    const menu = $('server-menu');
    if (!menu.classList.contains('hidden')) return menu.classList.add('hidden');
    $('menu-channel').classList.toggle('hidden', !isOwner());
    $('menu-leave').classList.toggle('hidden', isOwner());
    const r = $('server-menu-btn').getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.right - 220, window.innerWidth - 228)) + 'px';
    menu.style.top = r.bottom + 6 + 'px';
    menu.classList.remove('hidden');
};
document.addEventListener('click', () => $('server-menu').classList.add('hidden'));
$('server-menu').onclick = async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'invite') openInvite();
    if (act === 'channel') openChannelModal();
    if (act === 'leave' && S.server && confirm(`Leave ${S.server.name}?`)) {
        const out = await post({ action: 'server-leave', id: S.server.id });
        if (!out.res.ok) return toast(out.data.error || 'Could not leave.', true);
        await loadServers(); goHome(); toast('You left the server.');
    }
};

window.addEventListener('hashchange', () => { if (S.token && S.me) handleInvite(); });

/* ---------- profile ---------- */
function openProfile() {
    $('profile-msg').textContent = '';
    $('profile-name').value = S.me ? S.me.username : '';
    openModal('modal-profile');
}
$('profile-form').onsubmit = async (e) => {
    e.preventDefault();
    const out = await post({ action: 'profile-update', username: $('profile-name').value });
    if (!out.res.ok) { $('profile-msg').textContent = out.data.error || 'Could not save.'; return; }
    S.me.username = out.data.username; setMe(S.me);
    closeModals(); toast('Profile updated.');
    loadMessages(true); loadMembers();
};

/* ---------- context menu (replaces the browser's) ---------- */
const ctx = $('ctx-menu');
const copy = (t) => navigator.clipboard.writeText(t).then(() => toast('Copied.'), () => toast('Copy failed.', true));
function userItems(u) {
    if (!u || (S.me && u.id === S.me.id)) return [];
    const f = S.friends.find(x => x.id === u.id);
    return [f ? ['Message', () => openDM(f)] : ['Add friend', () => addFriend(u.username || u.email)], ['Copy username', () => copy(u.username || u.email)]];
}
document.querySelector('.user-panel')._ctx = () => [['Edit profile', openProfile], ['Copy username', () => copy(S.me.username)], '-', ['Log out', () => $('logout-btn').click(), true]];

document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    let items = null;
    for (let n = e.target; n && !items; n = n.parentElement) if (n._ctx) items = typeof n._ctx === 'function' ? n._ctx() : n._ctx;
    if (!items || !items.length || $('app').classList.contains('hidden')) return ctx.classList.add('hidden');
    ctx.textContent = '';
    items.forEach(it => {
        if (it === '-') return ctx.append(document.createElement('hr'));
        const b = h('button', it[2] ? 'danger' : '', it[0]);
        b.onclick = it[1];
        ctx.append(b);
    });
    ctx.classList.remove('hidden');
    ctx.style.left = Math.min(e.clientX, innerWidth - 228) + 'px';
    ctx.style.top = Math.min(e.clientY, innerHeight - ctx.offsetHeight - 8) + 'px';
});
document.addEventListener('click', () => ctx.classList.add('hidden'));
['scroll', 'resize', 'blur'].forEach(ev => addEventListener(ev, () => ctx.classList.add('hidden'), true));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ctx.classList.add('hidden');
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (e.key === 'F12' || (mod && ((e.shiftKey || e.altKey) && 'ijc'.includes(k) || k === 'u'))) e.preventDefault();
}, true);

/* ---------- login background: gravity dots ---------- */
(() => {
    const cv = $('gravity'), c = cv.getContext('2d'), m = { x: -999, y: -999 }, R = 170, GAP = 32;
    let dots = [], w, ht, dpr;
    const seed = () => {
        dpr = devicePixelRatio || 1; w = innerWidth; ht = innerHeight;
        cv.width = w * dpr; cv.height = ht * dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0);
        dots = [];
        for (let x = GAP / 2; x < w; x += GAP) for (let y = GAP / 2; y < ht; y += GAP) dots.push({ hx: x, hy: y, x, y, vx: 0, vy: 0 });
    };
    addEventListener('resize', seed); seed();
    addEventListener('pointermove', (e) => { m.x = e.clientX; m.y = e.clientY; });
    document.addEventListener('pointerleave', () => { m.x = m.y = -999; });
    (function tick() {
        requestAnimationFrame(tick);
        if ($('auth-screen').classList.contains('hidden')) return;
        c.clearRect(0, 0, w, ht);
        for (const d of dots) {
            const dx = m.x - d.x, dy = m.y - d.y, dist = Math.hypot(dx, dy) || 1, near = Math.max(0, 1 - dist / R);
            d.vx += near * near * 2.2 * dx / dist + (d.hx - d.x) * 0.04;
            d.vy += near * near * 2.2 * dy / dist + (d.hy - d.y) * 0.04;
            d.vx *= 0.84; d.vy *= 0.84; d.x += d.vx; d.y += d.vy;
            c.fillStyle = `rgba(239,232,218,${0.18 + near * 0.7})`;
            c.beginPath(); c.arc(d.x, d.y, 1.2 + near * 1.6, 0, 6.283); c.fill();
        }
    })();
})();

/* ---------- start ---------- */
setAuthMode(true);
if (S.token) boot();
