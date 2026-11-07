const $ = (id) => document.getElementById(id);
let isLogin = true;
let token = localStorage.getItem('token') || '';
let chat = null;
let currentChannels = [];
let currentChannelId = 1;
let currentCategory = 'TEXT CHANNELS';
let syncTimer = null;

async function post(payload) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const res = await fetch('/api/auth', { method: 'POST', headers, body: JSON.stringify(payload) });
        const data = await res.json().catch(() => ({}));
        return { res, data };
    } catch {
        return { res: { ok: false, status: 500 }, data: { error: 'Network error.' } };
    }
}

function notify(text, type = 'success') {
    const stack = $('toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = text;
    stack.append(el);
    setTimeout(() => el.remove(), 3500);
}

// Authentication & Session
if ($('form')) {
    $('toggle').onclick = () => {
        isLogin = !isLogin;
        $('title').textContent = isLogin ? 'Login' : 'Register';
        $('btn').textContent = isLogin ? 'Login' : 'Register';
        $('username').classList.toggle('hidden', isLogin);
    };
    $('form').onsubmit = async (e) => {
        e.preventDefault();
        const email = $('email').value;
        const password = $('password').value;
        const username = isLogin ? '' : $('username').value.trim();
        let out = await post({ action: isLogin ? 'login' : 'register', email, password, username });
        if (out.res.ok) {
            if (isLogin) {
                token = out.data.token;
                localStorage.setItem('token', token);
                localStorage.setItem('email', out.data.email);
                localStorage.setItem('userId', out.data.id);
                showDash();
            } else {
                $('form').classList.add('hidden');
                $('otp-form').classList.remove('hidden');
                $('otp-note').textContent = `Code sent to ${email}`;
            }
        } else {
            $('msg').textContent = out.data.error || 'Request failed.';
        }
    };
    $('otp-form').onsubmit = async (e) => {
        e.preventDefault();
        let out = await post({ action: 'verify', email: $('email').value, otp: $('otp').value.trim() });
        if (out.res.ok) {
            token = out.data.token;
            localStorage.setItem('token', token);
            localStorage.setItem('email', out.data.email);
            localStorage.setItem('userId', out.data.id);
            showDash();
        } else {
            $('msg').textContent = out.data.error || 'Invalid code.';
        }
    };
}

function showDash() {
    document.body.classList.add('has-dash');
    $('auth-card').classList.add('hidden');
    $('dash').classList.remove('hidden');
    if ($('dash-me-name')) $('dash-me-name').textContent = '@' + (localStorage.getItem('email') || 'user');
    loadServers();
    loadFriends();
    startSync();
}

function startSync() {
    clearInterval(syncTimer);
    syncTimer = setInterval(() => {
        loadServers();
        loadFriends();
        if (chat) loadChat(true);
    }, 15000);
}

// Friends & Conversations
async function loadFriends() {
    let out = await post({ action: 'friends' });
    if (!out.res.ok) return;
    const box = $('dash-convos');
    if (!box) return;
    box.textContent = '';
    (out.data.friends || []).forEach(u => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'conv' + (chat && chat.kind === 'dm' && chat.id === u.id ? ' on' : '');
        btn.textContent = '@' + (u.username || u.email);
        btn.onclick = () => activateChat('dm', u);
        box.append(btn);
    });
}

// Servers & Channels
async function loadServers() {
    let out = await post({ action: 'servers' });
    if (!out.res.ok) return;
    const box = $('dash-servers');
    if (!box) return;
    box.textContent = '';
    (out.data.servers || []).forEach(s => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'conv' + (chat && chat.kind === 'server' && chat.id === s.id ? ' on' : '');
        btn.textContent = s.name;
        btn.onclick = async () => {
            await loadChannels(s.id);
            activateChat('server', s);
        };
        box.append(btn);
    });
}

async function loadChannels(serverId) {
    let out = await post({ action: 'channels', id: serverId });
    if (!out.res.ok) return;
    currentChannels = out.data.channels || [];
    renderChannelsList();
    if (!currentChannelId && currentChannels.length) {
        currentChannelId = currentChannels[0].id;
    }
}

function renderChannelsList() {
    const list = $('channels-list');
    if (!list) return;
    list.textContent = '';
    
    // Group by category
    const cats = {};
    currentChannels.forEach(c => {
        const cat = c.category || 'TEXT CHANNELS';
        if (!cats[cat]) cats[cat] = [];
        cats[cat].push(c);
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
                loadChat(false, true);
            };
            list.append(btn);
        });
    }
}

// Right-click Context Menu for Channels & Categories
document.addEventListener('contextmenu', (e) => {
    const pane = e.target.closest('.channels-pane');
    if (pane && chat && chat.kind === 'server') {
        e.preventDefault();
        const menu = $('channel-ctx-menu');
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.classList.remove('hidden');
    }
});

document.addEventListener('click', () => {
    if ($('channel-ctx-menu')) $('channel-ctx-menu').classList.add('hidden');
});

if ($('ctx-create-channel')) {
    $('ctx-create-channel').onclick = () => {
        $('channel-modal').classList.remove('hidden');
    };
    $('ctx-create-category').onclick = () => {
        const catName = prompt('Enter category name:', 'VOICE CHANNELS');
        if (catName) {
            currentCategory = catName.toUpperCase();
            $('channel-modal').classList.remove('hidden');
            $('new-channel-cat').value = currentCategory;
        }
    };
}

// Channel creation modal handler
if ($('add-channel-btn')) {
    $('add-channel-btn').onclick = () => { $('channel-modal').classList.remove('hidden'); };
    $('channel-modal-close').onclick = () => { $('channel-modal').classList.add('hidden'); };
    $('channel-modal-cancel').onclick = () => { $('channel-modal').classList.add('hidden'); };
    $('channel-create-form').onsubmit = async (e) => {
        e.preventDefault();
        const name = $('new-channel-name').value.trim();
        const category = $('new-channel-cat').value.trim() || 'TEXT CHANNELS';
        let out = await post({ action: 'channel-create', id: chat.server.id, channelName: name, category });
        if (out.res.ok) {
            $('channel-modal').classList.add('hidden');
            await loadChannels(chat.server.id);
            currentChannelId = out.data.channel.id;
            renderChannelsList();
            loadChat(false, true);
            notify('Channel created successfully.');
        } else {
            $('channel-modal-msg').textContent = out.data.error || 'Could not create channel.';
        }
    };
}

// Chat Activation & Messaging
function activateChat(kind, entry) {
    chat = { kind, id: entry.id, user: kind === 'dm' ? entry : null, server: kind === 'server' ? entry : null };
    if (kind === 'server') {
        $('chat-name').textContent = entry.name;
        $('chat-initial').textContent = entry.name[0].toUpperCase();
        $('chat-status').textContent = `${entry.count || 1} members`;
        $('channels-pane').classList.remove('hidden');
        $('members-sidebar').classList.remove('hidden');
        $('server-invite').classList.remove('hidden');
    } else {
        $('chat-name').textContent = '@' + (entry.username || entry.email);
        $('chat-initial').textContent = ((entry.username || entry.email)[0] || '?').toUpperCase();
        $('chat-status').textContent = 'Online';
        $('channels-pane').classList.add('hidden');
        $('members-sidebar').classList.add('hidden');
        $('server-invite').classList.add('hidden');
    }
    $('dash-home').classList.add('hidden');
    $('dash-thread').classList.remove('hidden');
    loadChat(false, true);
}

if ($('dash-back')) {
    $('dash-back').onclick = () => {
        chat = null;
        $('dash-home').classList.remove('hidden');
        $('dash-thread').classList.add('hidden');
    };
}

if ($('chat-form')) {
    $('chat-form').onsubmit = async (e) => {
        e.preventDefault();
        const text = $('chat-input').value.trim();
        if (!text || !chat) return;
        let out = await post({
            action: 'send',
            kind: chat.kind,
            id: chat.id,
            text,
            ...(chat.kind === 'server' ? { channelId: currentChannelId } : {})
        });
        if (out.res.ok) {
            $('chat-input').value = '';
            loadChat(false, false);
        }
    };
}

async function loadChat(quiet = false, forceScroll = false) {
    if (!chat) return;
    let out = await post({
        action: 'messages',
        kind: chat.kind,
        id: chat.id,
        ...(chat.kind === 'server' ? { channelId: currentChannelId } : {})
    });
    if (!out.res.ok) return;

    const box = $('chat-log');
    box.textContent = '';
    (out.data.messages || []).forEach(m => {
        const row = document.createElement('div');
        row.className = 'mrow';
        row.textContent = `${m.text}`;
        box.append(row);
    });

    if (chat.kind === 'server' && out.data.members) {
        const memBox = $('members-sidebar-list');
        if (memBox) {
            memBox.textContent = '';
            $('members-count').textContent = out.data.members.length;
            out.data.members.forEach(m => {
                const card = document.createElement('div');
                card.className = 'mem-card';
                card.textContent = '@' + (m.username || 'Member');
                memBox.append(card);
            });
        }
    }

    if (forceScroll || box.scrollTop + box.clientHeight >= box.scrollHeight - 80) {
        box.scrollTop = box.scrollHeight;
    }
}

// Server Details & Actions
if ($('server-create')) {
    $('server-create').onclick = () => {
        $('server-dialog').classList.remove('hidden');
        $('server-create-form').classList.remove('hidden');
    };
    $('server-dialog-close').onclick = () => { $('server-dialog').classList.add('hidden'); };
    $('server-create-form').onsubmit = async (e) => {
        e.preventDefault();
        const name = $('server-name').value.trim();
        let out = await post({ action: 'server-create', name });
        if (out.res.ok) {
            $('server-dialog').classList.add('hidden');
            loadServers();
            activateChat('server', out.data.server);
            notify('Server created!');
        }
    };
}

if ($('server-invite')) {
    $('server-invite').onclick = async () => {
        if (!chat || chat.kind !== 'server') return;
        let out = await post({ action: 'server-invite', id: chat.server.id });
        if (out.res.ok) {
            $('server-invite-link').value = `${location.origin}/#invite=${out.data.code}`;
            $('server-dialog').classList.remove('hidden');
            $('server-invite-panel').classList.remove('hidden');
        }
    };
}

if ($('server-invite-copy')) {
    $('server-invite-copy').onclick = () => {
        navigator.clipboard.writeText($('server-invite-link').value);
        notify('Invite link copied!');
    };
}

if (localStorage.getItem('token')) showDash();