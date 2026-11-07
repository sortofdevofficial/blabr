const $ = (id) => document.getElementById(id);
let isLogin = true;
let token = localStorage.getItem('token') || '';
let chat = null;
let currentChannels = [];
let currentChannelId = null;
let syncTimer = null;

async function post(payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const res = await fetch('/api/auth', { method: 'POST', headers, body: JSON.stringify(payload) });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 && token && !['login', 'register', 'verify'].includes(payload.action)) { clearSession(); }
        return { res, data };
    } catch {
        return { res: { ok: false, status: 500 }, data: { error: 'Network error.' } };
    }
}

function clearSession() {
    clearInterval(syncTimer);
    token = '';
    chat = null;
    localStorage.removeItem('token');
    localStorage.removeItem('email');
    document.body.classList.remove('has-dash');
    $('dash').classList.add('hidden');
    $('auth-card').classList.remove('hidden');
}

async function logout() {
    await post({ action: 'logout' });
    clearSession();
}

function notify(text) {
    const stack = $('toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    stack.append(el);
    setTimeout(() => el.remove(), 3500);
}

function finishLogin(data) {
    token = data.token;
    localStorage.setItem('token', token);
    localStorage.setItem('email', data.email);
    $('form').classList.remove('hidden');
    $('otp-form').classList.add('hidden');
    $('msg').textContent = '';
    showDash();
}

$('toggle').onclick = () => {
    isLogin = !isLogin;
    $('title').textContent = isLogin ? 'Login' : 'Register';
    $('btn').textContent = isLogin ? 'Login' : 'Register';
    $('toggle').textContent = isLogin ? 'Need an account? Register' : 'Have an account? Login';
    $('username').classList.toggle('hidden', isLogin);
    $('msg').textContent = '';
};

$('form').onsubmit = async (e) => {
    e.preventDefault();
    $('msg').textContent = '';
    const email = $('email').value;
    const password = $('password').value;
    const username = isLogin ? '' : $('username').value.trim();
    const out = await post({ action: isLogin ? 'login' : 'register', email, password, username });
    if (!out.res.ok) { $('msg').textContent = out.data.error || 'Request failed.'; return; }
    if (isLogin) return finishLogin(out.data);
    $('form').classList.add('hidden');
    $('otp-form').classList.remove('hidden');
    $('otp-note').textContent = `Code sent to ${email}`;
};

$('otp-form').onsubmit = async (e) => {
    e.preventDefault();
    const out = await post({ action: 'verify', email: $('email').value, otp: $('otp').value.trim() });
    if (out.res.ok) finishLogin(out.data);
    else $('msg').textContent = out.data.error || 'Invalid code.';
};

$('resend').onclick = async () => {
    const out = await post({ action: 'register', email: $('email').value, password: $('password').value, username: $('username').value.trim() });
    if (out.res.ok) notify('New code sent.');
    else $('msg').textContent = out.data.error || 'Could not resend.';
};

function showDash() {
    document.body.classList.add('has-dash');
    $('auth-card').classList.add('hidden');
    $('dash').classList.remove('hidden');
    const email = localStorage.getItem('email') || 'user';
    $('dash-me-name').textContent = '@' + email;
    $('dash-me-initial').textContent = email[0].toUpperCase();
    $('avatar-initial').textContent = email[0].toUpperCase();
    $('uname').textContent = '@' + email;
    post({ action: 'me' }).then(({ res, data }) => {
        if (!res.ok) return;
        $('dash-me-name').textContent = '@' + data.username;
        $('uname').textContent = '@' + data.username;
        $('who').textContent = data.email;
        $('dash-me-initial').textContent = (data.username || '?')[0].toUpperCase();
        $('avatar-initial').textContent = (data.username || '?')[0].toUpperCase();
    });
    renderFriendForm();
    loadServers();
    loadFriends();
    startSync();
    handleInvite();
}

function renderFriendForm() {
    const pane = $('f-pane-all');
    if (!pane || pane.dataset.ready) return;
    pane.dataset.ready = '1';
    pane.innerHTML = '<form id="friend-add-form"><input id="friend-add-input" placeholder="Add friend by username or email" autocomplete="off" required><button type="submit">Add</button></form>';
    $('friend-add-form').onsubmit = async (e) => {
        e.preventDefault();
        const out = await post({ action: 'friend-add', username: $('friend-add-input').value });
        if (out.res.ok) { $('friend-add-input').value = ''; notify('Friend added!'); loadFriends(); }
        else notify(out.data.error || 'Could not add friend.');
    };
}

async function handleInvite() {
    const m = location.hash.match(/^#invite=([a-f0-9]+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname);
    const out = await post({ action: 'server-join', code: m[1] });
    if (out.res.ok) { notify('Joined ' + out.data.server.name); await loadServers(); openServer(out.data.server); }
    else notify(out.data.error || 'Invalid invite.');
}

function startSync() {
    clearInterval(syncTimer);
    syncTimer = setInterval(() => {
        loadServers();
        loadFriends();
        if (chat) loadChat(false);
    }, 15000);
}

async function loadFriends() {
    const out = await post({ action: 'friends' });
    if (!out.res.ok) return;
    const box = $('dash-convos');
    box.textContent = '';
    (out.data.friends || []).forEach(u => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'conv' + (chat && chat.kind === 'dm' && chat.id === u.id ? ' on' : '');
        btn.textContent = '@' + (u.username || u.email);
        btn.onclick = () => { activateChat('dm', u); loadFriends(); };
        box.append(btn);
    });
}

async function loadServers() {
    const out = await post({ action: 'servers' });
    if (!out.res.ok) return;
    const box = $('dash-servers');
    box.textContent = '';
    (out.data.servers || []).forEach(s => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'conv' + (chat && chat.kind === 'server' && chat.id === s.id ? ' on' : '');
        btn.textContent = s.name;
        btn.onclick = () => openServer(s);
        box.append(btn);
    });
}

async function openServer(s) {
    await loadChannels(s.id, true);
    activateChat('server', s);
    loadServers();
}

async function loadChannels(serverId, resetSelection = false) {
    const out = await post({ action: 'channels', id: serverId });
    if (!out.res.ok) return;
    currentChannels = out.data.channels || [];
    if (resetSelection || !currentChannels.some(c => c.id === currentChannelId)) {
        currentChannelId = currentChannels.length ? currentChannels[0].id : null;
    }
    renderChannelsList();
}

function renderChannelsList() {
    const list = $('channels-list');
    list.textContent = '';
    const cats = {};
    currentChannels.forEach(c => {
        const cat = c.category || 'TEXT CHANNELS';
        (cats[cat] = cats[cat] || []).push(c);
    });
    for (const [catName, chans] of Object.entries(cats)) {
        const catDiv = document.createElement('div');
        catDiv.className = 'channel-cat';
        catDiv.textContent = catName;
        list.append(catDiv);
        chans.forEach(c => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'channel-item' + (currentChannelId === c.id ? ' active' : '');
            btn.textContent = '#' + c.name;
            btn.onclick = () => {
                currentChannelId = c.id;
                renderChannelsList();
                loadChat(true);
            };
            list.append(btn);
        });
    }
}

$('add-channel-btn').onclick = () => { $('channel-modal-msg').textContent = ''; $('channel-modal').classList.remove('hidden'); };
$('channel-modal-close').onclick = () => $('channel-modal').classList.add('hidden');
$('channel-modal-cancel').onclick = () => $('channel-modal').classList.add('hidden');
$('channel-create-form').onsubmit = async (e) => {
    e.preventDefault();
    if (!chat || chat.kind !== 'server') return;
    const name = $('new-channel-name').value.trim();
    const category = $('new-channel-cat').value.trim() || 'TEXT CHANNELS';
    const out = await post({ action: 'channel-create', id: chat.id, channelName: name, category });
    if (out.res.ok) {
        $('channel-modal').classList.add('hidden');
        $('new-channel-name').value = '';
        await loadChannels(chat.id);
        currentChannelId = out.data.channel.id;
        renderChannelsList();
        loadChat(true);
        notify('Channel created.');
    } else {
        $('channel-modal-msg').textContent = out.data.error || 'Could not create channel.';
    }
};

function activateChat(kind, entry) {
    chat = { kind, id: entry.id, user: kind === 'dm' ? entry : null, server: kind === 'server' ? entry : null };
    const isServer = kind === 'server';
    const label = isServer ? entry.name : '@' + (entry.username || entry.email);
    $('chat-name').textContent = label;
    $('chat-initial').textContent = (isServer ? entry.name[0] : label[1] || '?').toUpperCase();
    $('chat-status').textContent = isServer ? `${entry.count || 1} members` : 'Online';
    $('channels-server-name').textContent = isServer ? entry.name.toUpperCase() : 'CHANNELS';
    $('channels-pane').classList.toggle('hidden', !isServer);
    $('members-sidebar').classList.toggle('hidden', !isServer);
    $('members-sidebar').classList.remove('show');
    $('server-actions').classList.toggle('hidden', !isServer);
    $('server-invite').classList.toggle('hidden', !isServer);
    $('dash-home').classList.add('hidden');
    $('dash-thread').classList.remove('hidden');
    $('chat-log').textContent = '';
    loadChat(true);
}

$('dash-back').onclick = () => {
    chat = null;
    $('dash-home').classList.remove('hidden');
    $('dash-thread').classList.add('hidden');
    loadServers();
    loadFriends();
};

$('server-members-btn').onclick = () => {
    const sb = $('members-sidebar');
    sb.classList.remove('hidden');
    sb.classList.toggle('show');
};

$('chat-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text || !chat) return;
    if (chat.kind === 'server' && currentChannelId == null) return notify('No channel selected.');
    const out = await post({
        action: 'send', kind: chat.kind, id: chat.id, text,
        ...(chat.kind === 'server' ? { channelId: currentChannelId } : {})
    });
    if (out.res.ok) { $('chat-input').value = ''; loadChat(true); }
    else notify(out.data.error || 'Message failed.');
};

async function loadChat(forceScroll = false) {
    if (!chat) return;
    const snapshot = chat;
    const channel = currentChannelId;
    const out = await post({
        action: 'messages', kind: chat.kind, id: chat.id,
        ...(chat.kind === 'server' ? { channelId: channel } : {})
    });
    if (!out.res.ok || chat !== snapshot || channel !== currentChannelId) return; // stale response

    const box = $('chat-log');
    const nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 80;
    box.textContent = '';
    (out.data.messages || []).forEach(m => {
        const row = document.createElement('div');
        row.className = 'mrow ' + (m.mine ? 'mine' : 'theirs');
        row.textContent = m.text;
        box.append(row);
    });

    if (chat.kind === 'server' && out.data.members) {
        const memBox = $('members-sidebar-list');
        memBox.textContent = '';
        $('members-count').textContent = out.data.members.length;
        out.data.members.forEach(m => {
            const card = document.createElement('div');
            card.className = 'mem-card';
            card.textContent = '@' + (m.username || 'Member');
            memBox.append(card);
        });
        $('chat-status').textContent = `${out.data.members.length} members`;
    }

    if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
}

$('server-create').onclick = () => {
    $('server-dialog-title').textContent = 'Create Server';
    $('server-invite-panel').classList.add('hidden');
    $('server-create-form').classList.remove('hidden');
    $('server-dialog').classList.remove('hidden');
};
$('server-dialog-close').onclick = () => $('server-dialog').classList.add('hidden');
$('server-create-form').onsubmit = async (e) => {
    e.preventDefault();
    const out = await post({ action: 'server-create', name: $('server-name').value.trim() });
    if (out.res.ok) {
        $('server-dialog').classList.add('hidden');
        $('server-name').value = '';
        await loadServers();
        await openServer(out.data.server);
        notify('Server created!');
    } else {
        notify(out.data.error || 'Could not create server.');
    }
};

$('server-invite').onclick = async () => {
    if (!chat || chat.kind !== 'server') return;
    const out = await post({ action: 'server-invite', id: chat.id });
    if (out.res.ok) {
        $('server-invite-link').value = `${location.origin}/#invite=${out.data.code}`;
        $('server-dialog-title').textContent = 'Invite Link';
        $('server-create-form').classList.add('hidden');
        $('server-invite-panel').classList.remove('hidden');
        $('server-dialog').classList.remove('hidden');
    } else {
        notify(out.data.error || 'Only the owner can invite.');
    }
};

$('server-invite-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('server-invite-link').value); notify('Invite link copied!'); }
    catch { $('server-invite-link').select(); notify('Press Ctrl+C to copy.'); }
};

$('dash-me-logout').onclick = logout;
$('logout-btn').onclick = logout;

if (token) showDash();
