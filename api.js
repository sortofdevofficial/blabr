const $ = (id) => document.getElementById(id);

async function post(payload, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        const res = await fetch('/api/auth', { method: 'POST', headers, body: JSON.stringify(payload) });
        const data = await res.json().catch(() => ({}));
        return { res, data };
    } catch (err) {
        return { res: { ok: false, status: 500 }, data: { error: 'Network error.' } };
    }
}