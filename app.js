let isLogin = true;
let pending = null;
let crop = null;
let drag = null;
const P = 320;
const $ = (id) => document.getElementById(id);
const SYNC_EVERY = 30 * 1000;
const PRESENCE_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline' };
const MY_STATUS = ['online', 'idle', 'dnd'];
let myStatus = localStorage.getItem('status') || 'online';
let friendsTimer = null;
let confirmResolve = null;
let confirmOpener = null;
let ctxUser = null;
let profileUser = null;
let msgCtxMsg = null;
let chat = null;

function presenceClass(s) {
    return s === 'online' ? 'on' : s === 'idle' ? 'idle' : s === 'dnd' ? 'dnd' : '';
}

function formatDuration(seconds) {
    if (!seconds || seconds < 60) return 'Active now';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hrs > 0) return `Active ${hrs}h ${mins}m`;
    return `Active ${mins}m`;
}

function setMyStatus(status, persist) {
    myStatus = MY_STATUS.includes(status) ? status : 'online';
    if (persist) localStorage.setItem('status', myStatus);
    const cls = presenceClass(myStatus);
    const self = $('self-presence');
    if (self) {
        self.className = 'pdot ' + cls;
        self.title = PRESENCE_LABEL[myStatus];
    }
    if ($('status-dot')) $('status-dot').className = 'pdot-mini ' + cls;
    if ($('status-label')) $('status-label').textContent = PRESENCE_LABEL[myStatus];
    document.querySelectorAll('#status-menu button').forEach((b) => {
        b.classList.toggle('on', b.dataset.st === myStatus);
    });
}

function startPresence() {
    setMyStatus(myStatus, true);
    clearInterval(friendsTimer);
    friendsTimer = setInterval(async () => {
        loadFriends(true);
        if (!summaryLoads) loadSummaries();
        await post({ action: 'ping' }, localStorage.getItem('token')).catch(() => {});
    }, SYNC_EVERY);
}

function loggedIn(token, email, id) {
    localStorage.setItem('token', token);
    if (email) localStorage.setItem('email', email);
    if (id) localStorage.setItem('userId', id);
    showDash();
}

function clearAuth() {
    ['token', 'email', 'username', 'avatar', 'bio', 'status', 'userId'].forEach((key) => localStorage.removeItem(key));
    location.reload();
}

function askConfirm(opts) {
    const o = opts || {};
    if (!$('confirm').classList.contains('hidden')) closeConfirm(false);
    confirmOpener = document.activeElement;
    $('confirm-title').textContent = o.title || 'Are you sure?';
    $('confirm-text').textContent = o.text || '';
    $('confirm-ok').textContent = o.ok || 'Confirm';
    $('confirm-ok').className = o.danger ? 'danger' : '';
    $('confirm').classList.remove('hidden');
    setTimeout(() => $('confirm-ok').focus(), 0);
    return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result) {
    if ($('confirm').classList.contains('hidden')) return;
    $('confirm').classList.add('hidden');
    const fn = confirmResolve;
    confirmResolve = null;
    if (confirmOpener && confirmOpener.isConnected) confirmOpener.focus();
    confirmOpener = null;
    if (fn) fn(result);
}

if ($('confirm-ok')) $('confirm-ok').onclick = () => closeConfirm(true);
if ($('confirm-cancel')) $('confirm-cancel').onclick = () => closeConfirm(false);
if ($('confirm')) $('confirm').onclick = (e) => { if (e.target === $('confirm')) closeConfirm(false); };

function notify(text, type) {
    const stack = $('toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    const span = document.createElement('span');
    span.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.onclick = () => removeToast(el);
    el.append(span, close);
    stack.append(el);
    const schedule = (ms) => { if (el.timer) clearTimeout(el.timer); el.timer = setTimeout(() => removeToast(el), ms); };
    schedule(type === 'error' ? 7000 : 4000);
}

function removeToast(el) {
    if (!el || el.classList.contains('out')) return;
    if (el.timer) clearTimeout(el.timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
}

function handleOf(u) {
    return u.username ? '@' + u.username : (u.email || 'this person');
}

function setBio(text) {
    const el = $('bio');
    if (!el) return;
    el.textContent = text || 'No bio yet';
    el.classList.toggle('empty', !text);
    el.title = text || '';
    $('bio-edit').textContent = text ? 'Edit' : 'Add bio';
}

function bioMsg(text, ok) {
    const el = $('bio-msg');
    if (el) {
        el.textContent = text || '';
        el.classList.toggle('ok', !!ok);
    }
}

function closeBio() {
    $('bio-form').classList.add('hidden');
    $('bio-input').value = '';
}

if ($('bio-edit')) {
    $('bio-edit').onclick = () => {
        $('bio-input').value = $('bio').classList.contains('empty') ? '' : $('bio').textContent;
        $('bio-form').classList.remove('hidden');
        bioMsg('');
        $('bio-input').focus();
    };
    $('bio-cancel').onclick = () => { closeBio(); bioMsg(''); };
    $('bio-form').onsubmit = async (e) => {
        e.preventDefault();
        const bio = $('bio-input').value.trim();
        let out;
        try { out = await post({ action: 'bio', bio }, localStorage.getItem('token')); } catch { return bioMsg('Network error — try again.'); }
        if (out.res.status === 401) return clearAuth();
        if (!out.res.ok) return bioMsg(out.data.error || 'Could not save your bio.');
        setBio(out.data.bio);
        localStorage.setItem('bio', out.data.bio || '');
        closeBio();
        notify('Bio saved.', 'success');
    };
}

function ago(t) {
    const d = Math.floor(Date.now() / 1000) - t;
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
}

function setIdent(email, username) {
    if (email) localStorage.setItem('email', email);
    if (username) localStorage.setItem('username', username);
    const e = email || localStorage.getItem('email') || '';
    const n = username || localStorage.getItem('username') || '';
    if ($('who')) $('who').textContent = e;
    if ($('uname')) $('uname').textContent = n ? '@' + n : '@';
    if ($('avatar-initial')) $('avatar-initial').textContent = ((n || e)[0] || '?').toUpperCase();
}

function unameMsg(text, ok) {
    const el = $('uname-msg');
    if (el) {
        el.textContent = text || '';
        el.classList.toggle('ok', !!ok);
    }
}

function closeUname() {
    $('uname-form').classList.add('hidden');
    $('uname-edit').classList.remove('hidden');
}

function setAvatar(url) {
    const img = $('avatar-img');
    if (!img) return;
    if (url) {
        img.onerror = () => setAvatar(null);
        img.src = url;
        img.classList.remove('hidden');
        $('avatar-initial').classList.add('hidden');
    } else {
        img.onerror = null;
        img.removeAttribute('src');
        img.classList.add('hidden');
        $('avatar-initial').classList.remove('hidden');
    }
}

async function showDash() {
    document.body.classList.add('has-dash');
    $('auth-card').classList.add('hidden');
    $('dash').classList.remove('hidden');
    setIdent();
    setAvatar(null);
    setBio(localStorage.getItem('bio') || '');
    setChatMe();
    await loadSessions();
    readAccount = localStorage.getItem('email') || '';
    chatLastSeen = {};
    const prefix = 'read:' + readAccount + ':';
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(prefix)) mergeReadCursor(key.slice(prefix.length), localStorage.getItem(key));
    }
    loadFriends();
    startPresence();
    renderConversations();
    renderServers();
    loadSummaries();
    checkInvite();
}

function renderSessions(list) {
    const box = $('sessions');
    if (!box) return;
    box.textContent = '';
    list.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'sess';
        const info = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = s.device + (s.current ? ' · this device' : '');
        const meta = document.createElement('div');
        meta.className = 'meta';
        const ip = document.createElement('span');
        ip.className = 'ip';
        ip.textContent = s.ip;
        const show = document.createElement('button');
        show.type = 'button';
        show.className = 'ghost';
        show.textContent = 'Show';
        show.onclick = () => {
            const on = ip.classList.toggle('revealed');
            show.textContent = on ? 'Hide' : 'Show';
        };
        const when = document.createElement('span');
        when.textContent = ago(s.last);
        meta.append(ip, show, when);
        info.append(name, meta);
        const btn = document.createElement('button');
        btn.textContent = 'Log out';
        btn.onclick = async () => {
            const ok = await askConfirm({
                title: 'Log out device?',
                text: `Log out ${s.device}${s.current ? ' (this device)' : ''}?`,
                ok: 'Log out',
                danger: true
            });
            if (ok) revokeSession(s.id);
        };
        row.append(info, btn);
        box.append(row);
    });
}

async function loadSessions() {
    let out;
    try { out = await post({ action: 'sessions' }, localStorage.getItem('token')); } catch { return; }
    if (out.res.status === 401) return clearAuth();
    if (!out.res.ok) return;
    if (out.data.email) setIdent(out.data.email, out.data.username);
    if (out.data.id) localStorage.setItem('userId', out.data.id);
    if (out.data.status) setMyStatus(out.data.status, true);
    if (typeof out.data.bio === 'string') {
        localStorage.setItem('bio', out.data.bio);
        setBio(out.data.bio);
    }
    if (out.data.avatar) localStorage.setItem('avatar', out.data.avatar);
    else localStorage.removeItem('avatar');
    setAvatar(out.data.avatar);
    renderSessions(out.data.sessions);
}

async function revokeSession(id) {
    let out;
    try { out = await post({ action: 'revoke', id }, localStorage.getItem('token')); } catch { return notify('Network error.', 'error'); }
    if (out.res.status === 401) return clearAuth();
    if (!out.res.ok) return notify(out.data.error || 'Could not log out device.', 'error');
    if (out.data.current) return clearAuth();
    loadSessions();
}

if ($('status-btn')) {
    $('status-btn').onclick = (e) => {
        e.stopPropagation();
        const menu = $('status-menu');
        menu.classList.toggle('hidden');
    };
    $('status-menu').querySelectorAll('button').forEach((b) => {
        b.onclick = async () => {
            $('status-menu').classList.add('hidden');
            const prev = myStatus;
            setMyStatus(b.dataset.st, true);
            let out = await post({ action: 'status', status: b.dataset.st }, localStorage.getItem('token')).catch(() => null);
            if (!out || !out.res.ok) setMyStatus(prev, true);
            else setMyStatus(out.data.status, true);
        };
    });
}

document.addEventListener('click', (e) => {
    if ($('status-menu') && !$('status-menu').classList.contains('hidden') && !e.target.closest('#status-menu') && !e.target.closest('#status-btn')) {
        $('status-menu').classList.add('hidden');
    }
});

if ($('uname-edit')) {
    $('uname-edit').onclick = () => {
        $('uname-input').value = ($('uname').textContent || '').replace(/^@/, '');
        $('uname-form').classList.remove('hidden');
        $('uname-edit').classList.add('hidden');
        unameMsg('');
        $('uname-input').focus();
    };
    $('uname-cancel').onclick = () => { closeUname(); unameMsg(''); };
    $('uname-form').onsubmit = async (e) => {
        e.preventDefault();
        const username = $('uname-input').value.trim();
        if (!username) return unameMsg('Enter a username.');
        let out = await post({ action: 'username', username }, localStorage.getItem('token')).catch(() => null);
        if (!out || out.res.status === 401) return clearAuth();
        if (!out.res.ok) return unameMsg(out.data.error || 'Could not update username.');
        setIdent(localStorage.getItem('email'), out.data.username);
        closeUname();
        notify('Username updated.', 'success');
        loadFriends();
    };
}

let friendData = { friends: [], incoming: [], outgoing: [] };
let friendTab = 'all';

async function loadFriends(quiet) {
    let out = await post({ action: 'friends' }, localStorage.getItem('token')).catch(() => null);
    if (!out) return;
    if (out.res.status === 401) return clearAuth();
    if (!out.res.ok) return;
    renderFriends(out.data);
}

function friendMsg(text, ok) {
    const el = $('friend-msg');
    if (el) {
        el.textContent = text || '';
        el.classList.toggle('ok', !!ok);
    }
}

function setFriendTab(tab) {
    friendTab = tab;
    document.querySelectorAll('.ftabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('f-pane-all').classList.toggle('hidden', tab !== 'all');
    $('f-pane-pending').classList.toggle('hidden', tab !== 'pending');
    $('f-pane-add').classList.toggle('hidden', tab !== 'add');
    friendMsg('');
    renderFriendTab();
}

function renderFriends(data) {
    friendData = { friends: data.friends || [], incoming: data.incoming || [], outgoing: data.outgoing || [] };
    if ($('f-c-all')) $('f-c-all').textContent = friendData.friends.length;
    if ($('f-c-pending')) $('f-c-pending').textContent = friendData.incoming.length + friendData.outgoing.length;
    renderConversations();
    renderFriendTab();
}

function renderFriendTab() {
    if (friendTab === 'all') renderAllFriends();
    else if (friendTab === 'pending') renderPending();
}

function groupLabel(text) {
    const p = document.createElement('p');
    p.className = 'fgroup';
    p.textContent = text;
    return p;
}

function emptyNote(box, text) {
    if (box.children.length) return;
    const p = document.createElement('p');
    p.className = 'fempty';
    p.textContent = text;
    box.append(p);
}

function friendRow(u, status, actions, opts) {
    const row = document.createElement('div');
    row.className = 'frow' + (chat && chat.kind === 'dm' && chat.id === u.id ? ' chatting' : '');
    row.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!(opts && opts.noContext)) openCtx(u, e.clientX, e.clientY);
    };
    const av = document.createElement('div');
    av.className = 'fava';
    const initial = document.createElement('span');
    initial.textContent = ((u.username || u.email)[0] || '?').toUpperCase();
    av.append(initial);
    if (u.avatar) {
        const img = document.createElement('img');
        img.alt = '';
        img.onerror = () => img.remove();
        img.src = u.avatar;
        av.append(img);
    }
    const dot = document.createElement('i');
    dot.className = 'dot ' + presenceClass(u.status);
    av.append(dot);

    const info = document.createElement('div');
    info.className = 'finfo';
    const name = document.createElement('strong');
    name.textContent = u.username ? '@' + u.username : u.email;
    const note = document.createElement('span');
    note.textContent = status || PRESENCE_LABEL[u.status] || 'Offline';
    note.className = presenceClass(u.status);
    info.append(name, note);

    const facts = document.createElement('div');
    facts.className = 'facts';
    (actions || []).forEach((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = a.label;
        if (a.title) b.title = a.title;
        if (a.cls) b.className = a.cls;
        b.onclick = a.onclick;
        facts.append(b);
    });
    row.append(av, info, facts);
    return row;
}

function renderAllFriends() {
    const box = $('f-pane-all');
    if (!box) return;
    box.textContent = '';
    const rank = { online: 0, dnd: 1, idle: 2, offline: 3 };
    [...friendData.friends]
        .sort((a, b) => (rank[a.status || 'offline'] - rank[b.status || 'offline']) || (a.username || a.email).localeCompare(b.username || b.email))
        .forEach((u) => {
            box.append(friendRow(u, null, [{ label: '✕', title: 'Remove friend', onclick: () => removeFriend(u.id) }]));
        });
    emptyNote(box, 'No friends yet — add someone by email or @username.');
}

function renderPending() {
    const box = $('f-pane-pending');
    if (!box) return;
    box.textContent = '';
    if (friendData.incoming.length) {
        box.append(groupLabel(`Incoming — ${friendData.incoming.length}`));
        friendData.incoming.forEach((u) => {
            box.append(friendRow(u, 'Wants to be friends', [
                { label: '✓', cls: 'ok', title: 'Accept', onclick: () => respondFriend(u.id, true) },
                { label: '✕', cls: 'no', title: 'Deny', onclick: () => respondFriend(u.id, false) }
            ], { noContext: true }));
        });
    }
    if (friendData.outgoing.length) {
        box.append(groupLabel(`Outgoing — ${friendData.outgoing.length}`));
        friendData.outgoing.forEach((u) => {
            box.append(friendRow(u, `Requested ${ago(u.t)}`, [{ label: '✕', title: 'Cancel request', onclick: () => removeFriend(u.id) }]));
        });
    }
    emptyNote(box, 'No pending requests.');
}

async function respondFriend(id, accept) {
    let out = await post({ action: 'respond', id, accept }, localStorage.getItem('token')).catch(() => null);
    if (!out || out.res.status === 401) return clearAuth();
    loadFriends();
}

async function removeFriend(id) {
    const ok = await askConfirm({ title: 'Remove friend?', text: 'Remove this friend?', ok: 'Remove', danger: true });
    if (!ok) return;
    let out = await post({ action: 'remove', id }, localStorage.getItem('token')).catch(() => null);
    if (!out || out.res.status === 401) return clearAuth();
    if (chat && chat.kind === 'dm' && chat.id === id) backToList();
    loadFriends();
}

if ($('logout-btn')) {
    $('logout-btn').onclick = async () => {
        const ok = await askConfirm({ title: 'Log out?', text: 'Sign out this device?', ok: 'Log out', danger: true });
        if (ok) logout();
    };
}

async function logout() {
    await post({ action: 'revoke' }, localStorage.getItem('token')).catch(() => {});
    clearAuth();
}

function closeCtx() {
    $('ctx-menu').classList.add('hidden');
    ctxUser = null;
}

function openCtx(u, x, y) {
    ctxUser = u;
    const menu = $('ctx-menu');
    menu.classList.remove('hidden');
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 180)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 130)) + 'px';
}

document.addEventListener('click', (e) => {
    if ($('ctx-menu') && !$('ctx-menu').classList.contains('hidden') && !e.target.closest('#ctx-menu')) closeCtx();
    if ($('msg-ctx-menu') && !$('msg-ctx-menu').classList.contains('hidden') && !e.target.closest('#msg-ctx-menu')) closeMsgCtx();
});

if ($('ctx-menu')) {
    $('ctx-menu').querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
            const u = ctxUser;
            const act = b.dataset.ctx;
            closeCtx();
            if (!u) return;
            if (act === 'profile') openProfile(u);
            if (act === 'message') openChat(u);
            if (act === 'remove') removeFriend(u.id);
        };
    });
}

function paintProfile(u) {
    profileUser = u;
    $('profile-name').textContent = handleOf(u);
    $('profile-email').textContent = u.email || '';
    const ava = $('profile-ava');
    ava.textContent = '';
    const initial = document.createElement('span');
    initial.textContent = ((u.username || u.email || '?')[0] || '?').toUpperCase();
    ava.append(initial);
    if (u.avatar) {
        const img = document.createElement('img');
        img.alt = '';
        img.onerror = () => img.remove();
        img.src = u.avatar;
        ava.append(img);
    }
    const st = u.status || 'offline';
    $('profile-dot').className = 'pdot-mini ' + presenceClass(st);
    $('profile-status').textContent = PRESENCE_LABEL[st] || 'Offline';
    $('profile-bio').textContent = u.bio || 'No bio yet';
    $('profile-bio').classList.toggle('empty', !u.bio);
}

async function openProfile(u) {
    paintProfile(u);
    $('profile').classList.remove('hidden');
    let out = await post({ action: 'profile', id: u.id }, localStorage.getItem('token')).catch(() => null);
    if (out && out.res.ok && out.data.user) paintProfile(out.data.user);
}

if ($('profile-close')) {
    $('profile-close').onclick = () => $('profile').classList.add('hidden');
    $('profile').onclick = (e) => { if (e.target === $('profile')) $('profile').classList.add('hidden'); };
    $('profile-message').onclick = () => { if (profileUser) { $('profile').classList.add('hidden'); openChat(profileUser); } };
    $('profile-remove').onclick = () => { if (profileUser) removeFriend(profileUser.id); };
}

// Chat & Channels & Member Sidebar state
let chatThreads = [];
let servers = [];
let chatLastSeen = {};
let readAccount = '';
let threadsRequest = 0;
let serversRequest = 0;
let summaryLoads = 0;
let serverDialog = null;
let mentionChoice = null;
let currentChannels = [];
let currentChannelId = null;

const myId = () => Number(localStorage.getItem('userId'));
const conversationKey = (kind, id) => `${kind}:${id}`;
const seenId = (key) => Number.isSafeInteger(chatLastSeen[key]) ? chatLastSeen[key] : 0;

function mergeReadCursor(key, value) {
    const id = Number(value);
    if (/^(dm|server):[1-9]\d*$/.test(key) && Number.isSafeInteger(id) && id > seenId(key)) chatLastSeen[key] = id;
}

function markChatRead() {
    const box = $('chat-log');
    if (!chat || !chat.visibleMax || document.visibilityState !== 'visible' || !box.clientHeight) return;
    if (document.querySelector('.modal:not(.hidden)') || box.scrollHeight - box.scrollTop - box.clientHeight >= 60) return;
    if (chat.visibleMax <= seenId(chat.key)) return;
    const key = 'read:' + readAccount + ':' + chat.key;
    mergeReadCursor(chat.key, chat.visibleMax);
    try { localStorage.setItem(key, String(seenId(chat.key))); } catch {}
    renderConversations();
    renderServers();
}

window.addEventListener('storage', (e) => {
    const prefix = 'read:' + readAccount + ':';
    if (e.storageArea !== localStorage || !e.key?.startsWith(prefix)) return;
    mergeReadCursor(e.key.slice(prefix.length), e.newValue);
    renderConversations();
    renderServers();
});

if ($('chat-log')) $('chat-log').addEventListener('scroll', markChatRead);

function appendUnread(btn, thread, key) {
    if (!thread) return;
    const mentioned = thread.mentionId > seenId(key);
    if (!mentioned && thread.incomingId <= seenId(key)) return;
    const badge = document.createElement('span');
    badge.className = 'conv-badge' + (mentioned ? ' mention-badge' : '');
    badge.textContent = mentioned ? '@' : '1';
    btn.append(badge);
}

function appendMessageText(box, m) {
    let end = 0;
    for (const mention of (m.mentions || [])) {
        box.append(document.createTextNode(m.text.slice(end, mention.start)));
        const span = document.createElement('span');
        span.className = 'mention' + (mention.id === myId() ? ' self' : '');
        span.textContent = m.text.slice(mention.start, mention.end);
        box.append(span);
        end = mention.end;
    }
    box.append(document.createTextNode(m.text.slice(end)));
}

function fmtTime(t) {
    return new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDay(t) {
    const d = new Date(t * 1000);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function sameDay(a, b) {
    return new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
}

function setChatHeader(u) {
    if ($('server-actions')) $('server-actions').classList.add('hidden');
    if ($('channels-pane')) $('channels-pane').classList.add('hidden');
    if ($('members-sidebar')) $('members-sidebar').classList.add('hidden');
    $('chat-dot').classList.remove('hidden');
    $('chat-ava').className = 'fava';
    $('chat-name').textContent = u.username ? '@' + u.username : (u.email || 'Chat');
    $('chat-initial').textContent = ((u.username || u.email || '?')[0] || '?').toUpperCase();
    $('chat-dot').className = 'pdot-mini ' + presenceClass(u.status);
    $('chat-status').textContent = PRESENCE_LABEL[u.status] || 'Offline';
    const ava = $('chat-ava');
    ava.querySelectorAll('img').forEach((i) => i.remove());
    if (u.avatar) {
        const img = document.createElement('img');
        img.alt = '';
        img.onerror = () => img.remove();
        img.src = u.avatar;
        ava.insertBefore(img, $('chat-initial'));
    }
}

function setServerHeader(server) {
    $('chat-name').textContent = server.name;
    $('chat-initial').textContent = server.name[0].toUpperCase();
    $('chat-ava').className = 'fava server-icon';
    $('chat-ava').querySelectorAll('img').forEach((img) => img.remove());
    $('chat-dot').classList.add('hidden');
    $('chat-status').textContent = `${server.count} member${server.count === 1 ? '' : 's'}`;
    if ($('server-actions')) $('server-actions').classList.remove('hidden');
    if ($('channels-pane')) $('channels-pane').classList.remove('hidden');
    if ($('members-sidebar')) $('members-sidebar').classList.remove('hidden');
    if ($('server-invite')) $('server-invite').classList.toggle('hidden', server.owner !== myId());
}

function renderMemberSidebar(members, server) {
    const box = $('members-sidebar-list');
    if (!box) return;
    box.textContent = '';
    $('members-count').textContent = members.length;

    const owners = members.filter(m => m.id === server.owner);
    const others = members.filter(m => m.id !== server.owner);

    function addGroup(title, list) {
        if (!list.length) return;
        const g = document.createElement('div');
        g.className = 'mem-group';
        g.textContent = `${title} — ${list.length}`;
        box.append(g);
        list.forEach(m => {
            const card = document.createElement('div');
            card.className = 'mem-card';
            card.onclick = () => openProfile(m);

            const av = document.createElement('div');
            av.className = 'fava';
            av.textContent = (m.username || '?')[0].toUpperCase();
            if (m.avatar) {
                const img = document.createElement('img');
                img.src = m.avatar;
                av.append(img);
            }
            const dot = document.createElement('i');
            dot.className = 'dot ' + presenceClass(m.status);
            av.append(dot);

            const info = document.createElement('div');
            info.className = 'finfo';
            const name = document.createElement('strong');
            name.textContent = m.username ? '@' + m.username : 'Member';
            const timeTag = document.createElement('span');
            timeTag.className = 'mem-time';
            timeTag.textContent = formatDuration(m.duration);
            info.append(name, timeTag);

            card.append(av, info);
            box.append(card);
        });
    }

    addGroup('Owner', owners);
    addGroup('Members', others);
}

async function loadChannels(serverId) {
    let out = await post({ action: 'channels', id: serverId }, localStorage.getItem('token')).catch(() => null);
    if (!out || !out.res.ok) return;
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
            const hash = document.createElement('span');
            hash.className = 'ch-hash';
            hash.textContent = '#';
            const name = document.createElement('span');
            name.textContent = c.name;
            btn.append(hash, name);
            btn.onclick = () => {
                currentChannelId = c.id;
                renderChannelsList();
                loadChat(false, true);
            };
            list.append(btn);
        });
    }
}

if ($('add-channel-btn')) {
    $('add-channel-btn').onclick = () => {
        if (!chat || chat.kind !== 'server') return;
        $('channels-server-name').textContent = chat.server.name;
        $('channel-modal').classList.remove('hidden');
        $('new-channel-name').value = '';
        $('new-channel-name').focus();
    };
    $('channel-modal-close').onclick = () => $('channel-modal').classList.add('hidden');
    $('channel-modal-cancel').onclick = () => $('channel-modal').classList.add('hidden');
    $('channel-create-form').onsubmit = async (e) => {
        e.preventDefault();
        if (!chat || chat.kind !== 'server') return;
        const name = $('new-channel-name').value.trim();
        const category = $('new-channel-cat').value.trim();
        let out = await post({ action: 'channel-create', id: chat.server.id, channelName: name, category }, localStorage.getItem('token')).catch(() => null);
        if (!out || !out.res.ok) {
            $('channel-modal-msg').textContent = out ? out.data.error : 'Could not create channel.';
            return;
        }
        $('channel-modal').classList.add('hidden');
        await loadChannels(chat.server.id);
        currentChannelId = out.data.channel.id;
        renderChannelsList();
        loadChat(false, true);
        notify('Channel created.', 'success');
    };
}

function renderMessage(m, prev) {
    const isMine = m.mine;
    const sender = m.sender;
    const startGroup = !prev || prev.sender.id !== sender.id || !sameDay(prev.t, m.t) || m.t - prev.t > 300;
    const row = document.createElement('div');
    row.dataset.messageId = m.id;
    row.className = 'mrow' + (isMine ? ' mine' : '') + (startGroup ? ' grp' : '') + (m.mentions.some((r) => r.id === myId()) ? ' mentioned' : '');
    row.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMsgCtx(m, e.clientX, e.clientY);
    };

    if (!isMine) {
        const ava = document.createElement('div');
        ava.className = 'fava' + (startGroup ? '' : ' ghost');
        if (startGroup) {
            const initial = document.createElement('span');
            initial.textContent = (sender.username || '?')[0].toUpperCase();
            ava.append(initial);
            if (sender.avatar) {
                const img = document.createElement('img');
                img.alt = '';
                img.onerror = () => img.remove();
                img.src = sender.avatar;
                ava.append(img);
            }
        }
        row.append(ava);
    }

    const body = document.createElement('div');
    body.className = 'mbody';
    if (startGroup) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        const name = document.createElement('strong');
        name.textContent = isMine ? 'You' : (sender.username ? '@' + sender.username : 'Member');
        const when = document.createElement('time');
        when.textContent = fmtTime(m.t);
        meta.append(name, when);
        body.append(meta);
    }
    const bub = document.createElement('div');
    bub.className = 'bub';
    appendMessageText(bub, m);
    body.append(bub);
    row.append(body);

    const tools = document.createElement('div');
    tools.className = 'mtools';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = () => copyMessageText(m);
    tools.append(copyBtn);
    if (isMine) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'danger';
        delBtn.textContent = 'Delete';
        delBtn.onclick = () => deleteMessage(m);
        tools.append(delBtn);
    }
    row.append(tools);
    return row;
}

function copyMessageText(m) {
    navigator.clipboard.writeText(m.text).then(() => notify('Copied.', 'success')).catch(() => {});
}

async function deleteMessage(m) {
    if (!chat) return;
    let out = await post({ action: 'delete', id: m.id }, localStorage.getItem('token')).catch(() => null);
    if (out && out.res.ok) {
        loadChat(false, false);
        loadSummaries();
    }
}

function openMsgCtx(m, x, y) {
    msgCtxMsg = m;
    $('msg-ctx-delete').classList.toggle('hidden', !m.mine);
    const menu = $('msg-ctx-menu');
    menu.classList.remove('hidden');
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 180)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 100)) + 'px';
}

function closeMsgCtx() {
    $('msg-ctx-menu').classList.add('hidden');
    msgCtxMsg = null;
}

if ($('msg-ctx-menu')) {
    $('msg-ctx-menu').querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
            const m = msgCtxMsg;
            const act = b.dataset.mctx;
            closeMsgCtx();
            if (!m) return;
            if (act === 'copy') copyMessageText(m);
            if (act === 'delete') deleteMessage(m);
        };
    });
}

function renderChat(data, force) {
    if (!chat) return;
    if (chat.kind === 'server') {
        chat.server = data.server;
        setServerHeader(data.server);
        renderMemberSidebar(data.members || [], data.server);
    } else {
        chat.user = data.user;
        setChatHeader(data.user);
    }
    chat.members = data.members;
    const box = $('chat-log');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const previousTop = box.scrollTop;
    chat.visibleMax = Math.max(0, ...(data.messages || []).map((m) => m.id));
    box.textContent = '';
    if (!data.messages || !data.messages.length) {
        const p = document.createElement('p');
        p.className = 'chat-empty';
        p.textContent = 'No messages yet — say hi.';
        box.append(p);
    } else {
        let prev = null;
        let lastDay = null;
        data.messages.forEach((m) => {
            const day = fmtDay(m.t);
            if (day !== lastDay) {
                const sep = document.createElement('div');
                sep.className = 'daysep';
                sep.textContent = day;
                box.append(sep);
                lastDay = day;
            }
            box.append(renderMessage(m, prev));
            prev = m;
        });
    }
    box.scrollTop = force || atBottom ? box.scrollHeight : previousTop;
    markChatRead();
}

async function loadChat(quiet, force) {
    if (!chat) return;
    const target = chat;
    const request = ++target.request;
    const token = localStorage.getItem('token');
    target.loading = true;
    let out = await post({ action: 'messages', kind: target.kind, id: target.id, ...(target.kind === 'server' ? { channelId: currentChannelId } : {}) }, token).catch(() => null);
    if (request === target.request) target.loading = false;
    if (chat !== target || request !== target.request) return;
    if (!out || !out.res.ok) return;
    renderChat(out.data, force);
}

function convAvatar(u) {
    const ava = document.createElement('div');
    ava.className = 'fava';
    const initial = document.createElement('span');
    initial.textContent = (u.username || u.email || '?')[0].toUpperCase();
    ava.append(initial);
    if (u.avatar) {
        const img = document.createElement('img');
        img.src = u.avatar;
        ava.append(img);
    }
    const dot = document.createElement('i');
    dot.className = 'dot ' + presenceClass(u.status);
    ava.append(dot);
    return ava;
}

function renderConversations() {
    const box = $('dash-convos');
    if (!box) return;
    box.textContent = '';
    const byId = new Map(chatThreads.map((t) => [t.id, t]));
    const rank = { online: 0, dnd: 1, idle: 2, offline: 3 };
    const list = [...friendData.friends].map((u) => ({ ...u, thread: byId.get(u.id) }));
    list.sort((a, b) => (a.thread?.t || 0) !== (b.thread?.t || 0) ? (b.thread?.t || 0) - (a.thread?.t || 0) : (rank[a.status || 'offline'] - rank[b.status || 'offline']));
    list.forEach((u) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'conv' + (chat && chat.kind === 'dm' && chat.id === u.id ? ' on' : '');
        btn.append(convAvatar(u));
        const info = document.createElement('div');
        info.className = 'conv-info';
        const name = document.createElement('strong');
        name.textContent = u.username ? '@' + u.username : u.email;
        const preview = document.createElement('span');
        preview.textContent = u.thread ? u.thread.text : (PRESENCE_LABEL[u.status] || 'Offline');
        info.append(name, preview);
        btn.append(info);
        appendUnread(btn, u.thread, conversationKey('dm', u.id));
        btn.onclick = () => activateChat('dm', u);
        box.append(btn);
    });
}

function renderServers() {
    const box = $('dash-servers');
    if (!box) return;
    box.textContent = '';
    servers.forEach((server) => {
        const key = conversationKey('server', server.id);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'conv' + (chat && chat.key === key ? ' on' : '');
        const icon = document.createElement('div');
        icon.className = 'fava server-icon';
        icon.textContent = server.name[0].toUpperCase();
        const info = document.createElement('div');
        info.className = 'conv-info';
        const name = document.createElement('strong');
        name.textContent = server.name;
        const preview = document.createElement('span');
        preview.textContent = server.thread ? server.thread.text : `${server.count} members`;
        info.append(name, preview);
        btn.append(icon, info);
        appendUnread(btn, server.thread, key);
        btn.onclick = async () => {
            await loadChannels(server.id);
            activateChat('server', server);
        };
        box.append(btn);
    });
}

async function loadThreads() {
    let out = await post({ action: 'threads' }, localStorage.getItem('token')).catch(() => null);
    if (out && out.res.ok) {
        chatThreads = out.data.threads;
        renderConversations();
    }
}

async function loadServers() {
    let out = await post({ action: 'servers' }, localStorage.getItem('token')).catch(() => null);
    if (out && out.res.ok) {
        servers = out.data.servers;
        renderServers();
    }
}

async function loadSummaries() {
    if (!localStorage.getItem('token')) return;
    summaryLoads++;
    try { await Promise.all([loadThreads(), loadServers()]); } finally { summaryLoads--; }
}

function activateChat(kind, entry) {
    if (chat && chat.timer) clearInterval(chat.timer);
    chat = { kind, key: conversationKey(kind, entry.id), id: entry.id, user: kind === 'dm' ? entry : null, server: kind === 'server' ? entry : null, members: [], timer: null, request: 0, loading: false, sending: false, visibleMax: 0 };
    if (kind === 'server') setServerHeader(entry);
    else setChatHeader(entry);
    $('dash-home').classList.add('hidden');
    $('dash-thread').classList.remove('hidden');
    $('dash').classList.add('open-thread');
    loadChat(false, true);
    chat.timer = setInterval(() => { if (chat && !chat.loading) loadChat(true, false); }, 10000);
}

function backToList() {
    if (chat && chat.timer) clearInterval(chat.timer);
    chat = null;
    $('dash-home').classList.remove('hidden');
    $('dash-thread').classList.add('hidden');
    $('dash').classList.remove('open-thread');
    renderConversations();
    renderServers();
}

if ($('dash-back')) $('dash-back').onclick = backToList;

if ($('chat-form')) {
    $('chat-form').onsubmit = async (e) => {
        e.preventDefault();
        if (!chat || chat.sending) return;
        const text = $('chat-input').value.trim();
        if (!text) return;
        chat.sending = true;
        let out = await post({ action: 'send', kind: chat.kind, id: chat.id, text, ...(chat.kind === 'server' ? { channelId: currentChannelId } : {}) }, localStorage.getItem('token')).catch(() => null);
        chat.sending = false;
        if (out && out.res.ok) {
            $('chat-input').value = '';
            loadChat(false, true);
            loadSummaries();
        }
    };
}

function openServerDialog(mode, target, code) {
    serverDialog = { mode, target, code };
    $('server-dialog').classList.remove('hidden');
    $('server-create-form').classList.toggle('hidden', mode !== 'create');
    $('server-discover-panel').classList.toggle('hidden', mode !== 'discover');
}

if ($('server-create')) {
    $('server-create').onclick = () => openServerDialog('create');
    $('server-dialog-close').onclick = () => $('server-dialog').classList.add('hidden');
    $('server-create-form').onsubmit = async (e) => {
        e.preventDefault();
        const name = $('server-name').value.trim();
        let out = await post({ action: 'server-create', name }, localStorage.getItem('token')).catch(() => null);
        if (out && out.res.ok) {
            $('server-dialog').classList.add('hidden');
            loadServers();
            activateChat('server', out.data.server);
            notify('Server created!', 'success');
        }
    };
}

async function checkInvite() {
    const code = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (!code || !localStorage.getItem('token')) return;
    let out = await post({ action: 'invite-join', code }, localStorage.getItem('token')).catch(() => null);
    if (out && out.res.ok) {
        history.replaceState(null, '', location.pathname);
        loadServers();
        activateChat('server', out.data.server);
        notify('Joined server!', 'success');
    }
}

function setChatMe() {
    const email = localStorage.getItem('email') || '';
    const username = localStorage.getItem('username') || '';
    if ($('dash-me-name')) $('dash-me-name').textContent = username ? '@' + username : (email || '@');
}

async function post(payload, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch('/api/auth', { method: 'POST', headers, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    return { res, data };
}

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
        pending = { email, password, username };
        let out = await post({ action: isLogin ? 'login' : 'register', email, password, username });
        if (out.res.ok) {
            if (isLogin) loggedIn(out.data.token, out.data.email, out.data.id);
            else {
                $('form').classList.add('hidden');
                $('otp-form').classList.remove('hidden');
                $('otp-note').textContent = `Code sent to ${email}`;
            }
        } else {
            $('msg').textContent = out.data.error || 'Failed.';
        }
    };
    $('otp-form').onsubmit = async (e) => {
        e.preventDefault();
        let out = await post({ action: 'verify', email: pending.email, otp: $('otp').value.trim() });
        if (out.res.ok) loggedIn(out.data.token, out.data.email, out.data.id);
        else $('msg').textContent = out.data.error || 'Invalid code.';
    };
}

if (localStorage.getItem('token')) showDash();
else checkInvite();