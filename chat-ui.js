let chat = null;
let chatThreads = [];
let servers = [];
let currentChannels = [];
let currentChannelId = null;

function initChatSystem() {
    loadSummaries();
    if ($('dash-back')) $('dash-back').onclick = backToList;
    if ($('chat-form')) {
        $('chat-form').onsubmit = async (e) => {
            e.preventDefault();
            if (!chat || chat.sending) return;
            const text = $('chat-input').value.trim();
            if (!text) return;
            chat.sending = true;
            let out = await post({
                action: 'send',
                kind: chat.kind,
                id: chat.id,
                text,
                ...(chat.kind === 'server' ? { channelId: currentChannelId } : {})
            }, localStorage.getItem('token'));
            chat.sending = false;
            if (out.res.ok) {
                $('chat-input').value = '';
                loadChat(false, true);
                loadSummaries();
            }
        };
    }
    if ($('server-create')) {
        $('server-create').onclick = () => {
            $('server-dialog').classList.remove('hidden');
            $('server-create-form').classList.remove('hidden');
        };
        $('server-dialog-close').onclick = () => $('server-dialog').classList.add('hidden');
        $('server-create-form').onsubmit = async (e) => {
            e.preventDefault();
            const name = $('server-name').value.trim();
            let out = await post({ action: 'server-create', name }, localStorage.getItem('token'));
            if (out.res.ok) {
                $('server-dialog').classList.add('hidden');
                loadServers();
                activateChat('server', out.data.server);
            }
        };
    }
}

function setChatHeader(u) {
    if ($('server-actions')) $('server-actions').classList.add('hidden');
    if ($('channels-pane')) $('channels-pane').classList.add('hidden');
    if ($('members-sidebar')) $('members-sidebar').classList.add('hidden');
    $('chat-dot').classList.remove('hidden');
    $('chat-name').textContent = u.username ? '@' + u.username : (u.email || 'Chat');
    $('chat-initial').textContent = ((u.username || u.email || '?')[0] || '?').toUpperCase();
    $('chat-status').textContent = 'Online';
}

function setServerHeader(server) {
    $('chat-name').textContent = server.name;
    $('chat-initial').textContent = server.name[0].toUpperCase();
    $('chat-dot').classList.add('hidden');
    $('chat-status').textContent = `${server.count} members`;
    if ($('server-actions')) $('server-actions').classList.remove('hidden');
    if ($('channels-pane')) $('channels-pane').classList.remove('hidden');
    if ($('members-sidebar')) $('members-sidebar').classList.remove('hidden');
}

function renderMemberSidebar(members) {
    const box = $('members-sidebar-list');
    if (!box) return;
    box.textContent = '';
    $('members-count').textContent = members.length;
    members.forEach(m => {
        const card = document.createElement('div');
        card.className = 'mem-card';
        const info = document.createElement('div');
        info.className = 'finfo';
        const name = document.createElement('strong');
        name.textContent = m.username ? '@' + m.username : 'Member';
        info.append(name);
        card.append(info);
        box.append(card);
    });
}

async function loadChannels(serverId) {
    let out = await post({ action: 'channels', id: serverId }, localStorage.getItem('token'));
    if (!out.res.ok) return;
    currentChannels = out.data.channels || [];
    renderChannelsList();
    if (!currentChannelId || !currentChannels.some(c => c.id === currentChannelId)) {
        currentChannelId = currentChannels[0] ? currentChannels[0].id : `${serverId}:general`;
    }
}

function renderChannelsList() {
    const list = $('channels-list');
    if (!list) return;
    list.textContent = '';
    currentChannels.forEach(c => {
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

if ($('add-channel-btn')) {
    $('add-channel-btn').onclick = () => {
        if (!chat || chat.kind !== 'server') return;
        $('channel-modal').classList.remove('hidden');
    };
    $('channel-modal-close').onclick = () => $('channel-modal').classList.add('hidden');
    $('channel-modal-cancel').onclick = () => $('channel-modal').classList.add('hidden');
    $('channel-create-form').onsubmit = async (e) => {
        e.preventDefault();
        const name = $('new-channel-name').value.trim();
        const category = $('new-channel-cat').value.trim();
        let out = await post({ action: 'channel-create', id: chat.server.id, channelName: name, category }, localStorage.getItem('token'));
        if (out.res.ok) {
            $('channel-modal').classList.add('hidden');
            await loadChannels(chat.server.id);
            currentChannelId = out.data.channel.id;
            renderChannelsList();
            loadChat(false, true);
        }
    };
}

function renderChat(data, force) {
    if (!chat) return;
    if (chat.kind === 'server') {
        chat.server = data.server;
        setServerHeader(data.server);
        renderMemberSidebar(data.members || []);
    } else {
        chat.user = data.user || { username: 'Chat' };
        setChatHeader(chat.user);
    }
    const box = $('chat-log');
    box.textContent = '';
    (data.messages || []).forEach((m) => {
        const row = document.createElement('div');
        row.className = 'mrow';
        row.textContent = `${m.text}`;
        box.append(row);
    });
    box.scrollTop = box.scrollHeight;
}

async function loadChat(quiet, force) {
    if (!chat) return;
    let out = await post({
        action: 'messages',
        kind: chat.kind,
        id: chat.id,
        ...(chat.kind === 'server' ? { channelId: currentChannelId } : {})
    }, localStorage.getItem('token'));
    if (out.res.ok) renderChat(out.data, force);
}

function renderConversations() {
    const box = $('dash-convos');
    if (!box) return;
    box.textContent = '';
    friendData.friends.forEach((u) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'conv';
        btn.textContent = u.username ? '@' + u.username : u.email;
        btn.onclick = () => activateChat('dm', u);
        box.append(btn);
    });
}

function renderServers() {
    const box = $('dash-servers');
    if (!box) return;
    box.textContent = '';
    servers.forEach((server) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'conv';
        btn.textContent = server.name;
        btn.onclick = async () => {
            await loadChannels(server.id);
            activateChat('server', server);
        };
        box.append(btn);
    });
}

async function loadServers() {
    let out = await post({ action: 'servers' }, localStorage.getItem('token'));
    if (out.res.ok) {
        servers = out.data.servers;
        renderServers();
    }
}

async function loadSummaries() {
    loadServers();
}

function activateChat(kind, entry) {
    chat = { kind, id: entry.id, user: kind === 'dm' ? entry : null, server: kind === 'server' ? entry : null };
    if (kind === 'server') setServerHeader(entry);
    else setChatHeader(entry);
    $('dash-home').classList.add('hidden');
    $('dash-thread').classList.remove('hidden');
    $('dash').classList.add('open-thread');
    loadChat(false, true);
}

function backToList() {
    chat = null;
    $('dash-home').classList.remove('hidden');
    $('dash-thread').classList.add('hidden');
    $('dash').classList.remove('open-thread');
}