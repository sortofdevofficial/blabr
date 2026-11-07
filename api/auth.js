const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

mongoose.set('bufferCommands', false);

const db = globalThis.__pratrDb || (globalThis.__pratrDb = { conn: null, promise: null });
let mailer = null;

const OTP_TTL_SECONDS = 600;
const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const SESSION_TTL_SECONDS = 7 * 24 * 3600;
const PRESENCE_TTL_SECONDS = 10 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);

const STATUSES = ['online', 'idle', 'dnd'];

function presenceOf(user) {
  if (!user.o || nowSeconds() - user.o > PRESENCE_TTL_SECONDS) return 'offline';
  return STATUSES[user.i] || 'online';
}

function dbHint(err) {
  const uri = process.env.MONGO_URI;
  if (!uri) return 'MONGO_URI is not set. Add it in Vercel → Project Settings → Environment Variables, then redeploy.';
  if (/@(localhost|127\.0\.0\.1)/.test(uri)) return 'MONGO_URI points to localhost. Use the MongoDB Atlas connection string instead.';
  if (/bad auth|Authentication failed/i.test(err.message)) return 'Atlas rejected the credentials. Check the user/password in MONGO_URI (URL-encode special characters).';
  if (/server selection|timed out|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(err.message)) return 'Could not reach the cluster. In MongoDB Atlas → Network Access, allow 0.0.0.0/0 so Vercel can connect. Also check the cluster is not paused.';
  return null;
}

async function connectDB() {
  if (db.conn) return db.conn;
  if (!db.promise) {
    db.promise = mongoose
      .connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: 8000,
        maxPoolSize: 1,
        minPoolSize: 0,
        maxIdleTimeMS: 60000
      })
      .then((m) => { db.conn = m; return m; })
      .catch((err) => { db.promise = null; throw err; });
  }
  return db.promise;
}

const userSchema = new mongoose.Schema({
  _id: { type: Number, required: true },
  e: { type: String, required: true, unique: true, lowercase: true, trim: true },
  p: { type: String, required: true },
  n: { type: String, unique: true, sparse: true, trim: true },
  c: { type: Number, default: nowSeconds },
  o: Number,
  i: Number,
  b: String,
  av: String
}, { versionKey: false });

const User = mongoose.models.User || mongoose.model('User', userSchema);

const pendingSchema = new mongoose.Schema({
  _id: { type: String, lowercase: true, trim: true },
  p: { type: String, required: true },
  o: { type: String, required: true },
  x: { type: Number, required: true },
  a: { type: Number, default: 0 },
  n: String
}, { versionKey: false });

const Pending = mongoose.models.Pending || mongoose.model('Pending', pendingSchema, 'pending');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

async function migrateLegacyPending(email) {
  const raw = await User.collection.findOne({ e: email });
  if (!raw || typeof raw.o !== 'string' || !raw.x) return false;
  await Pending.updateOne(
    { _id: email },
    { p: raw.p, o: raw.o, x: raw.x || 0, a: raw.a || 0 },
    { upsert: true }
  );
  await User.deleteOne({ _id: raw._id });
  return true;
}

const sessionSchema = new mongoose.Schema({
  _id: String,
  u: { type: Number, index: true },
  i: String,
  d: String,
  s: Number
}, { versionKey: false });

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

const sessionKey = (userId, sid) => `${userId}:${sid}`;
const sidOf = (id) => {
  const key = String(id || '');
  const at = key.indexOf(':');
  return at === -1 ? key : key.slice(at + 1);
};
const sessionRange = (userId) => ({ $gte: `${userId}:`, $lt: `${userId};` });

async function liveSession(userId, sid) {
  if (!sid) return null;
  const key = sessionKey(userId, sid);
  const own = await Session.findById(key).lean();
  if (own) return own;

  const legacy = await Session.findOne({ _id: sid, u: userId }).lean();
  if (!legacy) return null;
  try {
    await Session.create({ _id: key, i: legacy.i, d: legacy.d, s: legacy.s });
    await Session.deleteOne({ _id: sid, u: { $in: [userId, null] } });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  return { ...legacy, _id: key };
}

const msgSchema = new mongoose.Schema({
  _id: { type: Number, required: true },
  a: { type: Number, required: true },
  b: { type: Number, required: true },
  m: { type: String, required: true },
  t: { type: Number, default: nowSeconds }
}, { versionKey: false });

msgSchema.index({ a: 1, b: 1, t: -1 });

const Msg = mongoose.models.Msg || mongoose.model('Msg', msgSchema, 'msgs');

const friendSchema = new mongoose.Schema({
  _id: String,
  a: { type: Number, required: true, index: true },
  b: { type: Number, required: true, index: true },
  r: { type: Number, required: true },
  s: { type: String, default: 'p' },
  t: { type: Number, default: nowSeconds }
}, { versionKey: false });

const Friend = mongoose.models.Friend || mongoose.model('Friend', friendSchema, 'friends');

const USERNAME_RE = /^[a-z0-9._]{3,20}$/;

function baseUsername(email) {
  const base = String(email || '')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9._]/g, '')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 20);
  return base.length >= 3 ? base : `user${base}`.slice(0, 20);
}

async function freeUsername(base) {
  const root = base.slice(0, 20);
  for (let i = 0; i < 20; i++) {
    const suffix = i ? String(i) : '';
    const name = root.slice(0, 20 - suffix.length) + suffix;
    if (!(await User.exists({ n: name }))) return name;
  }
  return root.slice(0, 14) + crypto.randomBytes(3).toString('hex');
}

async function assignUsername(userId, email) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = await freeUsername(baseUsername(email));
    try {
      await User.updateOne({ _id: userId }, { n: name });
      return name;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  return null;
}

async function createUser(fields) {
  let username = fields.n || (await freeUsername(baseUsername(fields.e)));
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await User.findOne({ _id: { $type: 'number' } }).sort({ _id: -1 }).select('_id').lean();
    try {
      const user = await User.create({ _id: (last ? last._id : 0) + 1, ...fields, n: username });
      await Session.deleteMany({ $or: [{ u: user._id }, { _id: sessionRange(user._id) }] });
      return user;
    } catch (err) {
      if (err.code !== 11000) throw err;
      if (err.keyPattern && err.keyPattern.e) return null;
      if (err.keyPattern && err.keyPattern.n) {
        username = await freeUsername(baseUsername(fields.e));
        continue;
      }
    }
  }
  throw new Error('Could not allocate a user id. Please try again.');
}

function makeOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function sendOtp(email, code) {
  if (!mailer) {
    mailer = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 8000
    });
  }
  return mailer.sendMail({
    from: `pratr <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `pratr verification code: ${code}`,
    text: `Your pratr verification code is ${code}. It expires in 10 minutes.`
  });
}

function uploadToCloudinary(buffer, mime) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const key = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud || !key || !secret) {
    return Promise.reject(Object.assign(new Error('Cloudinary is not configured.'), { code: 'NO_CLOUDINARY' }));
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder: 'pratr/avatars',
    public_id: `${timestamp}-${crypto.randomBytes(4).toString('hex')}`,
    timestamp
  };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + secret).digest('hex');

  const form = new FormData();
  form.append('file', `data:${mime};base64,${buffer.toString('base64')}`);
  form.append('api_key', key);
  form.append('folder', params.folder);
  form.append('public_id', params.public_id);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);

  return fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body: form }).then(async (r) => {
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((json.error && json.error.message) || `Cloudinary upload failed (${r.status}).`);
    if (!json.secure_url && !json.url) throw new Error('Cloudinary returned no image URL.');
    return json.secure_url || json.url;
  });
}

function clientIp(req) {
  const headers = req.headers || {};
  const forwarded = headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded || '').split(',')[0].trim();
  return first || headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function deviceLabel(ua) {
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os =
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} · ${os}`;
}

async function createSession(req, userId) {
  const now = nowSeconds();
  const sid = crypto.randomBytes(12).toString('hex');
  await Session.create({
    _id: sessionKey(userId, sid),
    i: clientIp(req),
    d: deviceLabel((req.headers && req.headers['user-agent']) || ''),
    s: now
  });
  await User.updateOne({ _id: userId }, { o: now });
  return sid;
}

function issueToken(user, sid) {
  if (!process.env.JWT_SECRET) return null;
  return jwt.sign({ userId: user._id, sid }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function readAuth(req) {
  const header = (req.headers && req.headers.authorization) || '';
  if (!header.startsWith('Bearer ') || !process.env.JWT_SECRET) return null;
  try {
    return jwt.verify(header.slice(7), process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

async function handleRegister(res, email, password, username) {
  const key = normalizeEmail(email);
  await migrateLegacyPending(key);

  if (await User.exists({ e: key })) {
    return res.status(400).json({ error: 'Email already registered.' });
  }

  let name = null;
  if (username) {
    name = String(username).trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(name)) {
      return res.status(400).json({ error: 'Usernames are 3–20 characters: a–z, 0–9, dots and underscores.' });
    }
    if (await User.exists({ n: name })) {
      return res.status(409).json({ error: 'That username is taken.' });
    }
  }

  const now = nowSeconds();
  const existing = await Pending.findById(key).lean();
  if (existing && existing.x - now > OTP_TTL_SECONDS - RESEND_COOLDOWN_SECONDS) {
    return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });
  }

  const code = makeOtp();
  const [p, o] = await Promise.all([bcrypt.hash(password, 10), bcrypt.hash(code, 8)]);

  try {
    await sendOtp(key, code);
  } catch (err) {
    console.error('[mail]', err);
    return res.status(502).json({
      error: 'Could not send the verification email.',
      hint: 'Check GMAIL_USER and GMAIL_APP_PASSWORD in Vercel. An App Password requires 2-Step Verification on that Google account.'
    });
  }

  await Pending.deleteMany({ x: { $lt: now - 3600 } });
  await Pending.updateOne(
    { _id: key },
    { p, o, x: now + OTP_TTL_SECONDS, a: 0, ...(name ? { n: name } : {}) },
    { upsert: true }
  );

  return res.status(200).json({ message: 'Code sent.', email: key });
}

async function handleVerify(req, res, email, otp) {
  const key = normalizeEmail(email);
  let pending = await Pending.findById(key).lean();
  if (!pending && (await migrateLegacyPending(key))) {
    pending = await Pending.findById(key).lean();
  }
  if (!pending) return res.status(400).json({ error: 'No pending registration for that email.' });

  if (!pending.x || pending.x < nowSeconds()) {
    return res.status(400).json({ error: 'That code expired. Request a new one.' });
  }
  if ((pending.a || 0) >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });
  }

  if (!(await bcrypt.compare(String(otp), pending.o))) {
    await Pending.updateOne({ _id: key }, { $inc: { a: 1 } });
    return res.status(400).json({ error: 'Incorrect code.' });
  }

  const user = await createUser({ e: key, p: pending.p, ...(pending.n ? { n: pending.n } : {}) });
  if (!user) {
    await Pending.deleteOne({ _id: key });
    return res.status(409).json({ error: 'Email already registered — please log in.' });
  }
  await Pending.deleteOne({ _id: key });

  const sid = await createSession(req, user._id);
  const token = issueToken(user, sid);
  if (!token) {
    return res.status(500).json({ error: 'JWT_SECRET is not set. Add it in Vercel → Project Settings → Environment Variables, then redeploy.' });
  }
  return res.status(200).json({ token, email: user.e, id: user._id });
}

async function handleSessions(req, res) {
  const auth = readAuth(req);
  if (!auth || !auth.sid) return res.status(401).json({ error: 'Please log in again.', expired: true });

  await Session.deleteMany({ s: { $lt: nowSeconds() - SESSION_TTL_SECONDS } });
  await Session.collection.updateMany({ c: { $exists: true } }, { $unset: { c: '' } });

  const live = await liveSession(auth.userId, auth.sid);
  if (!live) return res.status(401).json({ error: 'This device was logged out.', expired: true });

  const sessions = await Session.find({
    $or: [{ _id: sessionRange(auth.userId) }, { u: auth.userId }]
  }).sort({ s: -1 }).lean();
  const current = sessions.find((s) => sidOf(s._id) === auth.sid);
  if (!current) return res.status(401).json({ error: 'This device was logged out.', expired: true });

  await Session.updateOne({ _id: current._id }, { s: nowSeconds() });

  const user = await User.findById(auth.userId).select('e n b av i').lean();
  if (!user) return res.status(401).json({ error: 'Account not found.', expired: true });

  let username = user.n;
  if (!username) {
    username = await assignUsername(user._id, user.e);
    if (!username) username = baseUsername(user.e);
  }

  return res.status(200).json({
    email: user.e,
    username,
    bio: user.b || '',
    status: STATUSES[user.i] || 'online',
    avatar: user.av || null,
    sessions: sessions.map((s) => ({
      id: sidOf(s._id),
      ip: s.i,
      device: s.d,
      last: sidOf(s._id) === auth.sid ? nowSeconds() : s.s,
      current: sidOf(s._id) === auth.sid
    }))
  });
}

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

async function handleAvatar(req, res, image) {
  const auth = readAuth(req);
  if (!auth || !auth.sid) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const live = await liveSession(auth.userId, auth.sid);
  if (!live) return res.status(401).json({ error: 'This device was logged out.', expired: true });

  const match = typeof image === 'string' && image.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return res.status(400).json({ error: 'Send the image as a base64 data URL (png, jpeg or webp).' });

  const mime = AVATAR_TYPES[match[1].toLowerCase()];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > AVATAR_MAX_BYTES) {
    return res.status(413).json({ error: 'Image is too large. Keep it under 2 MB.' });
  }

  let url;
  try {
    url = await uploadToCloudinary(buffer, mime);
  } catch (err) {
    if (err.code === 'NO_CLOUDINARY') {
      return res.status(500).json({
        error: 'Cloudinary is not configured.',
        hint: 'Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET in Vercel → Project Settings → Environment Variables, then redeploy.'
      });
    }
    console.error('[cloudinary]', err);
    return res.status(502).json({ error: err.message || 'Cloudinary upload failed.' });
  }

  await User.updateOne({ _id: auth.userId }, { av: url });
  return res.status(200).json({ url });
}

async function requireLiveSession(req) {
  const auth = readAuth(req);
  if (!auth || !auth.sid) return null;
  const live = await liveSession(auth.userId, auth.sid);
  return live ? auth : null;
}

const pairKey = (x, y) => (x < y ? `${x}:${y}` : `${y}:${x}`);

async function handleFriends(req, res) {
  const auth = await requireLiveSession(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  await User.updateOne({ _id: auth.userId }, { o: nowSeconds() });

  const docs = await Friend.find({ $or: [{ a: auth.userId }, { b: auth.userId }] }).lean();
  const otherIds = docs.map((f) => (f.a === auth.userId ? f.b : f.a));
  const users = otherIds.length ? await User.find({ _id: { $in: otherIds } }).select('e n av o i').lean() : [];
  const byId = new Map(users.map((u) => [u._id, u]));

  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const f of docs) {
    const other = f.a === auth.userId ? f.b : f.a;
    const u = byId.get(other);
    if (!u) continue;
    const item = { id: other, email: u.e, username: u.n || null, avatar: u.av || null, status: presenceOf(u) };
    if (f.s === 'a') friends.push(item);
    else if (f.s === 'p') (f.r === auth.userId ? outgoing : incoming).push({ ...item, t: f.t });
  }
  friends.sort((x, y) => (x.username || x.email).localeCompare(y.username || y.email));
  incoming.sort((x, y) => y.t - x.t);
  outgoing.sort((x, y) => y.t - x.t);

  return res.status(200).json({ friends, incoming, outgoing });
}

async function handleFriendRequest(req, res, email) {
  const auth = await requireLiveSession(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const raw = String(email || '').trim();
  if (!raw) return res.status(400).json({ error: 'Enter their email or username.' });

  let target;
  if (!raw.startsWith('@') && raw.includes('@')) {
    target = await User.findOne({ e: normalizeEmail(raw) }).select('_id').lean();
  } else {
    const name = raw.replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(name)) {
      return res.status(400).json({ error: 'Enter a valid email or username.' });
    }
    target = await User.findOne({ n: name }).select('_id').lean();
  }
  if (!target) return res.status(404).json({ error: 'No account found.' });
  if (target._id === auth.userId) return res.status(400).json({ error: 'That is your own account.' });

  const id = pairKey(auth.userId, target._id);
  const now = nowSeconds();
  const existing = await Friend.findById(id).lean();

  if (existing) {
    if (existing.s === 'a') return res.status(409).json({ error: 'You are already friends.' });
    if (existing.s === 'p') {
      if (existing.r === auth.userId) return res.status(409).json({ error: 'Request already pending.' });
      await Friend.updateOne({ _id: id }, { s: 'a', t: now });
      return res.status(200).json({ status: 'a' });
    }
    await Friend.updateOne({ _id: id }, { s: 'p', r: auth.userId, t: now });
    return res.status(200).json({ status: 'p' });
  }

  try {
    await Friend.create({
      _id: id,
      a: Math.min(auth.userId, target._id),
      b: Math.max(auth.userId, target._id),
      r: auth.userId,
      s: 'p',
      t: now
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Request already pending.' });
    throw err;
  }
  return res.status(200).json({ status: 'p' });
}

async function handleFriendRespond(req, res, id, accept) {
  const auth = await requireLiveSession(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const other = Number(id);
  if (!Number.isInteger(other)) return res.status(400).json({ error: 'Friend id required.' });

  const key = pairKey(auth.userId, other);
  const f = await Friend.findById(key).lean();
  if (!f || f.s !== 'p') return res.status(404).json({ error: 'No pending request from them.' });
  if (f.r === auth.userId) return res.status(400).json({ error: 'That request came from you.' });

  const status = accept ? 'a' : 'd';
  await Friend.updateOne({ _id: key }, { s: status, t: nowSeconds() });
  return res.status(200).json({ status });
}

async function handleFriendRemove(req, res, id) {
  const auth = await requireLiveSession(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const other = Number(id);
  if (!Number.isInteger(other)) return res.status(400).json({ error: 'Friend id required.' });

  const result = await Friend.deleteOne({ _id: pairKey(auth.userId, other) });
  if (!result.deletedCount) return res.status(404).json({ error: 'Nothing to remove.' });
  return res.status(200).json({ ok: true });
}

async function areFriends(x, y) {
  const doc = await Friend.findOne({ _id: pairKey(x, y), s: 'a' }).select('_id').lean();
  return !!doc;
}

const BIO_MAX = 160;
const MSG_MAX = 2000;

async function handleBio(req, res, raw) {
  const auth = await requireLiveSession(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const bio = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, BIO_MAX);
  if (bio) await User.updateOne({ _id: auth.userId }, { b: bio });
  else await User.updateOne({ _id: auth.userId }, { $unset: { b: '' } });
  return res.status(200).json({ bio });
}

async function targetUser(req, res, id) {
  const auth = await requireLiveSession(req);
  if (!auth) {
    res.status(401).json({ error: 'Please log in again.', expired: true });
    return null;
  }

  const other = Number(id);
  if (!Number.isInteger(other) || other < 1) {
    res.status(400).json({ error: 'User id required.' });
    return null;
  }

  if (other !== auth.userId && !(await areFriends(auth.userId, other))) {
    res.status(403).json({ error: 'You can only do that with friends.' });
    return null;
  }

  const user = await User.findById(other).select('e n b av o i').lean();
  if (!user) {
    res.status(404).json({ error: 'Account not found.' });
    return null;
  }
  return { auth, other, user };
}

function publicUser(user) {
  return {
    id: user._id,
    email: user.e,
    username: user.n || null,
    bio: user.b || '',
    avatar: user.av || null,
    status: presenceOf(user)
  };
}

async function handleProfile(req, res, id) {
  const found = await targetUser(req, res, id);
  if (!found) return;
  return res.status(200).json({ user: publicUser(found.user) });
}

async function handleMessages(req, res, id) {
  const found = await targetUser(req, res, id);
  if (!found) return;
  const me = found.auth.userId;
  const other = found.other;

  const docs = await Msg.find({
    $or: [{ a: me, b: other }, { a: other, b: me }]
  }).sort({ t: -1 }).limit(50).lean();

  return res.status(200).json({
    user: publicUser(found.user),
    messages: docs.reverse().map((m) => ({ id: m._id, mine: m.a === me, text: m.m, t: m.t }))
  });
}

async function handleThreads(req, res) {
  const auth = await requireLiveSession(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const me = auth.userId;
  const docs = await Friend.find({ $or: [{ a: me }, { b: me }], s: 'a' }).select('a b').lean();
  const allowed = new Set(docs.map((f) => (f.a === me ? f.b : f.a)));
  if (!allowed.size) return res.status(200).json({ threads: [] });

  const rows = await Msg.aggregate([
    { $match: { $or: [{ a: me }, { b: me }] } },
    { $sort: { t: -1, _id: -1 } },
    { $group: {
      _id: { $cond: [{ $eq: ['$a', me] }, '$b', '$a'] },
      m: { $first: '$m' },
      t: { $first: '$t' },
      a: { $first: '$a' }
    } }
  ]);

  return res.status(200).json({
    threads: rows
      .filter((r) => allowed.has(r._id))
      .map((r) => ({ id: r._id, text: r.m, t: r.t, mine: r.a === me }))
  });
}

async function handleSend(req, res, id, raw) {
  const found = await targetUser(req, res, id);
  if (!found) return;

  const text = String(raw == null ? '' : raw).trim();
  if (!text) return res.status(400).json({ error: 'Message is empty.' });
  if (text.length > MSG_MAX) return res.status(413).json({ error: 'Messages are limited to 2000 characters.' });

  const me = found.auth.userId;
  const other = found.other;

  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await Msg.findOne({ _id: { $type: 'number' } }).sort({ _id: -1 }).select('_id').lean();
    const t = nowSeconds();
    try {
      const doc = await Msg.create({ _id: (last ? last._id : 0) + 1, a: me, b: other, m: text, t });
      return res.status(200).json({ message: { id: doc._id, mine: true, text, t } });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  return res.status(500).json({ error: 'Could not save the message. Try again.' });
}

async function handleUsername(req, res, raw) {
  const auth = await requireLiveSession(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const name = String(raw || '').trim().replace(/^@/, '').toLowerCase();
  if (!USERNAME_RE.test(name)) {
    return res.status(400).json({ error: 'Usernames are 3–20 characters: a–z, 0–9, dots and underscores.' });
  }

  const taken = await User.exists({ n: name, _id: { $ne: auth.userId } });
  if (taken) return res.status(409).json({ error: 'That username is taken.' });

  try {
    await User.updateOne({ _id: auth.userId }, { n: name });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'That username is taken.' });
    throw err;
  }
  return res.status(200).json({ username: name });
}

async function handlePing(req, res) {
  const auth = await requireLiveSession(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  await User.updateOne({ _id: auth.userId }, { o: nowSeconds() });
  return res.status(200).json({ ok: true });
}

async function handleStatus(req, res, status) {
  const auth = await requireLiveSession(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const index = STATUSES.indexOf(status);
  if (index < 0) return res.status(400).json({ error: 'Pick online, idle or dnd.' });

  await User.updateOne({ _id: auth.userId }, { o: nowSeconds(), i: index });
  return res.status(200).json({ status });
}

async function handleRevoke(req, res, id) {
  const auth = readAuth(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const target = id || auth.sid;
  if (!target) return res.status(400).json({ error: 'Session id required.' });

  const own = await liveSession(auth.userId, target);
  if (!own) return res.status(404).json({ error: 'Session not found.' });
  await Session.deleteOne({ _id: own._id });

  const left = await Session.countDocuments({
    $or: [{ _id: sessionRange(auth.userId) }, { u: auth.userId }]
  });
  if (!left) await User.updateOne({ _id: auth.userId }, { o: 0 });

  return res.status(200).json({ message: 'Logged out.', current: target === auth.sid });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }
    }

    await connectDB();
    const { action, email, password, otp, id, image, accept, username, status, bio, text } = body;

    if (action === 'register') {
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
      return await handleRegister(res, email, password, username);
    }

    if (action === 'verify') {
      if (!email || !otp) return res.status(400).json({ error: 'Email and code required.' });
      return await handleVerify(req, res, email, otp);
    }

    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
      const key = normalizeEmail(email);
      await migrateLegacyPending(key);

      let user = await User.findOne({ e: key });
      if (!user) {
        let pending = await Pending.findById(key).lean();

        // Older code copied presence heartbeats into `pending` and deleted the account.
        // A real pending row holds a bcrypt hash in `o` and expires within minutes.
        if (pending && typeof pending.o !== 'string' && pending.x > nowSeconds() + 86400) {
          user = await createUser({ e: key, p: pending.p, ...(pending.n ? { n: pending.n } : {}) });
          if (user) {
            await Pending.deleteOne({ _id: key });
            pending = null;
          }
        }

        if (!user) {
          if (pending && (await bcrypt.compare(password, pending.p))) {
            return res.status(403).json({ error: 'Email not verified. Enter the code we emailed you.', verify: true });
          }
          return res.status(401).json({ error: 'Invalid email or password.' });
        }
      }

      if (!(await bcrypt.compare(password, user.p))) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      const sid = await createSession(req, user._id);
      const token = issueToken(user, sid);
      if (!token) {
        return res.status(500).json({ error: 'JWT_SECRET is not set. Add it in Vercel → Project Settings → Environment Variables, then redeploy.' });
      }
      return res.status(200).json({ token, email: user.e, id: user._id });
    }

    if (action === 'sessions') return await handleSessions(req, res);
    if (action === 'revoke') return await handleRevoke(req, res, id);
    if (action === 'avatar') return await handleAvatar(req, res, image);
    if (action === 'friends') return await handleFriends(req, res);
    if (action === 'request') return await handleFriendRequest(req, res, email);
    if (action === 'respond') return await handleFriendRespond(req, res, id, !!accept);
    if (action === 'remove') return await handleFriendRemove(req, res, id);
    if (action === 'username') return await handleUsername(req, res, username);
    if (action === 'bio') return await handleBio(req, res, bio);
    if (action === 'profile') return await handleProfile(req, res, id);
    if (action === 'messages') return await handleMessages(req, res, id);
    if (action === 'threads') return await handleThreads(req, res);
    if (action === 'send') return await handleSend(req, res, id, text);
    if (action === 'ping') return await handlePing(req, res);
    if (action === 'status') return await handleStatus(req, res, status);

    res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('[auth]', err);
    const hint = dbHint(err);
    res.status(500).json({ error: err.message, ...(hint ? { hint } : {}) });
  }
};
