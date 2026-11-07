let isLogin = true;
let pending = null;
const PRESENCE_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline' };
const MY_STATUS = ['online', 'idle', 'dnd'];
let myStatus = localStorage.getItem('status') || 'online';
let friendsTimer = null;
let confirmResolve = null;
let confirmOpener = null;
let ctxUser = null;
let profileUser = null;

function presenceClass(s) {
    return s === 'online' ? 'on' : s === 'idle' ? 'idle' : s === 'dnd' ? 'dnd' : '';
}

function setMyStatus(status, persist) {
    myStatus = MY_STATUS.includes(status) ? status : 'online';
    if (persist) localStorage.setItem('status', myStatus);
    const cls = presenceClass(myStatus);
    if ($('self-presence')) {
        $('self-presence').className = 'pdot ' + cls;
        $('self-presence').title = PRESENCE_LABEL[myStatus];
    }
    if ($('status-dot')) $('status-dot').className = 'pdot-mini ' + cls;
    if ($('status-label')) $('status-label').textContent = PRESENCE_LABEL[myStatus];
}

function startPresence() {
    setMyStatus(myStatus, true);
    clearInterval(friendsTimer);
    friendsTimer = setInterval(async () => {
        loadFriends(true);
        if (typeof loadSummaries === 'function') loadSummaries();
        await post({ action: 'ping' }, localStorage.getItem('token')).catch(() => {});
    }, 30000);
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
    confirmOpener = document.activeElement;
    $('confirm-title').textContent = o.title || 'Are you sure?';
    $('confirm-text').textContent = o.text || '';
    $('confirm-ok').textContent = o.ok || 'Confirm';
    $('confirm-ok').className = o.danger ? 'danger' : '';
    $('confirm').classList.remove('hidden');
    return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result) {
    $('confirm').classList.add('hidden');
    const fn = confirmResolve;
    confirmResolve = null;
    if (confirmOpener && confirmOpener.isConnected) confirmOpener.focus();
    if (fn) fn(result);
}

if ($('confirm-ok')) $('confirm-ok').onclick = () => closeConfirm(true);
if ($('confirm-cancel')) $('confirm-cancel').onclick = () => closeConfirm(false);

function notify(text, type) {
    const stack = $('toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    const span = document.createElement('span');
    span.textContent = text;
    el.append(span);
    stack.append(el);
    setTimeout(() => el.remove(), 4000);
}

function setBio(text) {
    const el = $('bio');
    if (!el) return;
    el.textContent = text || 'No bio yet';
    el.classList.toggle('empty', !text);
    $('bio-edit').textContent = text ? 'Edit' : 'Add bio';
}

if ($('bio-edit')) {
    $('bio-edit').onclick = () => {
        $('bio-input').value = $('bio').classList.contains('empty') ? '' : $('bio').textContent;
        $('bio-form').classList.remove('hidden');
    };
    $('bio-cancel').onclick = () => $('bio-form').classList.add('hidden');
    $('bio-form').onsubmit = async (e) => {
        e.preventDefault();
        const bio = $('bio-input').value.trim();
        let out = await post({ action: 'bio', bio }, localStorage.getItem('token'));
        if (out.res.status === 401) return clearAuth();
        if (out.res.ok) {
            setBio(out.data.bio);
            localStorage.setItem('bio', out.data.bio || '');
            $('bio-form').classList.add('hidden');
            notify('Bio saved.', 'success');
        }
    };
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

function showDash() {
    document.body.classList.add('has-dash');
    $('auth-card').classList.add('hidden');
    $('dash').classList.remove('hidden');
    setIdent();
    setBio(localStorage.getItem('bio') || '');
    loadSessions();
    loadFriends();
    startPresence();
    if (typeof initChatSystem === 'function') initChatSystem();
}

async function loadSessions() {
    let out = await post({ action: 'sessions' }, localStorage.getItem('token'));
    if (out.res.status === 401) return clearAuth();
    if (!out.res.ok) return;
    setIdent(out.data.email, out.data.username);
    setBio(out.data.bio);
}

if ($('status-btn')) {
    $('status-btn').onclick = (e) => {
        e.stopPropagation();
        $('status-menu').classList.toggle('hidden');
    };
    $('status-menu').querySelectorAll('button').forEach((b) => {
        b.onclick = async () => {
            $('status-menu').classList.add('hidden');
            setMyStatus(b.dataset.st, true);
            await post({ action: 'status', status: b.dataset.st }, localStorage.getItem('token'));
        };
    });
}

let friendData = { friends: [], incoming: [], outgoing: [] };
let friendTab = 'all';

async function loadFriends(quiet) {
    let out = await post({ action: 'friends' }, localStorage.getItem('token'));
    if (!out || out.res.status === 401) return clearAuth();
    if (out.res.ok) {
        friendData = out.data;
        if (typeof renderConversations === 'function') renderConversations();
        renderFriendTab();
    }
}

function setFriendTab(tab) {
    friendTab = tab;
    document.querySelectorAll('.ftabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('f-pane-all').classList.toggle('hidden', tab !== 'all');
    $('f-pane-pending').classList.toggle('hidden', tab !== 'pending');
    $('f-pane-add').classList.toggle('hidden', tab !== 'add');
    renderFriendTab();
}

function renderFriendTab() {
    const box = $('f-pane-all');
    if (!box || friendTab !== 'all') return;
    box.textContent = '';
    friendData.friends.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'frow';
        row.textContent = u.username ? '@' + u.username : u.email;
        box.append(row);
    });
}

if ($('logout-btn')) {
    $('logout-btn').onclick = async () => {
        if (await askConfirm({ title: 'Log out?', text: 'Sign out this device?', ok: 'Log out', danger: true })) {
            clearAuth();
        }
    };
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