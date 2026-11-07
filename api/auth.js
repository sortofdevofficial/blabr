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

async function connectDB() {
  if (db.conn) return db.conn;
  if (!db.promise) {
    db.promise = mongoose
      .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 1 })
      .then(async (m) => {
        await Promise.all([Server.createIndexes(), Msg.createIndexes(), Invite.createIndexes(), Join.createIndexes(), Channel.createIndexes()]);
        db.conn = m;
        return m;
      })
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

const sessionSchema = new mongoose.Schema({
  _id: String,
  u: { type: Number, index: true },
  i: String,
  d: String,
  s: Number
}, { versionKey: false });

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

const mentionSchema = new mongoose.Schema({
  u: { type: Number, required: true },
  p: { type: Number, required: true },
  l: { type: Number, required: true }
}, { _id: false });

const msgSchema = new mongoose.Schema({
  _id: { type: Number, required: true },
  a: { type: Number, required: true },
  b: { type: Number, required: function () { return this.s == null; } },
  s: Number,
  m: { type: String, required: true },
  ch: { type: String, default: null },
  t: { type: Number, default: nowSeconds },
  d: { type: Number, default: 0 },
  r: { type: [mentionSchema], default: undefined }
}, { versionKey: false });

const Msg = mongoose.models.Msg || mongoose.model('Msg', msgSchema, 'msgs');

const serverSchema = new mongoose.Schema({
  _id: { type: Number, required: true },
  n: { type: String, required: true, trim: true },
  o: { type: Number, required: true },
  m: { type: [Number], index: true },
  i: { type: String, required: true, unique: true },
  c: { type: Number, default: nowSeconds }
}, { versionKey: false });

const Server = mongoose.models.Server || mongoose.model('Server', serverSchema, 'servers');

const channelSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  s: { type: Number, required: true, index: true },
  n: { type: String, required: true, trim: true },
  cat: { type: String, trim: true, default: 'TEXT CHANNELS' },
  c: { type: Number, default: nowSeconds }
}, { versionKey: false });

const Channel = mongoose.models.Channel || mongoose.model('Channel', channelSchema, 'channels');

const joinSchema = new mongoose.Schema({
  s: { type: Number, required: true },
  u: { type: Number, required: true },
  t: { type: Number, default: nowSeconds },
  duration: { type: Number, default: 0 },
  lastActive: { type: Number, default: nowSeconds }
}, { versionKey: false });

joinSchema.index({ s: 1, u: 1 }, { unique: true });
const Join = mongoose.models.Join || mongoose.model('Join', joinSchema, 'joins');

const friendSchema = new mongoose.Schema({
  _id: String,
  a: { type: Number, required: true },
  b: { type: Number, required: true },
  r: { type: Number, required: true },
  s: { type: String, default: 'p' },
  t: { type: Number, default: nowSeconds }
}, { versionKey: false });

const Friend = mongoose.models.Friend || mongoose.model('Friend', friendSchema, 'friends');

function clientIp(req) {
  return (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'unknown';
}

function deviceLabel(ua) {
  return /Mobile/.test(ua) ? 'Mobile' : 'Desktop';
}

async function updateMemberActivity(userId) {
  try {
    const now = nowSeconds();
    const joins = await Join.find({ u: userId }).lean();
    for (const j of joins) {
      const last = j.lastActive || j.t || now;
      const diff = now - last;
      if (diff > 0 && diff < 300) {
        await Join.updateOne({ _id: j._id }, { $inc: { duration: diff }, $set: { lastActive: now } });
      } else {
        await Join.updateOne({ _id: j._id }, { $set: { lastActive: now } });
      }
    }
  } catch (e) {}
}

function readAuth(req) {
  const header = (req.headers && req.headers.authorization) || '';
  if (!header.startsWith('Bearer ') || !process.env.JWT_SECRET) return null;
  try { return jwt.verify(header.slice(7), process.env.JWT_SECRET); } catch { return null; }
}

async function requireLiveSession(req) {
  const auth = readAuth(req);
  if (!auth || !auth.sid) return null;
  return auth;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }

    await connectDB();
    const { action, email, password, otp, id, username, status, bio, text, kind, name, channelId, category, channelName } = body;

    if (action === 'register') {
      const key = String(email).trim().toLowerCase();
      if (await User.exists({ e: key })) return res.status(400).json({ error: 'Email already registered.' });
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const p = await bcrypt.hash(password, 10);
      await Pending.updateOne({ _id: key }, { p, o: await bcrypt.hash(code, 8), x: nowSeconds() + 600 }, { upsert: true });
      return res.status(200).json({ message: 'Code sent.', email: key });
    }

    if (action === 'verify') {
      const key = String(email).trim().toLowerCase();
      const pending = await Pending.findById(key).lean();
      if (!pending || !(await bcrypt.compare(String(otp), pending.o))) return res.status(400).json({ error: 'Invalid code.' });
      const last = await User.findOne().sort({ _id: -1 }).select('_id').lean();
      const user = await User.create({ _id: (last ? last._id : 0) + 1, e: key, p: pending.p, n: username || `user${Date.now().toString().slice(-4)}` });
      await Pending.deleteOne({ _id: key });
      const sid = crypto.randomBytes(12).toString('hex');
      await Session.create({ _id: `${user._id}:${sid}`, u: user._id, i: clientIp(req), d: deviceLabel(req.headers['user-agent'] || ''), s: nowSeconds() });
      const token = jwt.sign({ userId: user._id, sid }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.status(200).json({ token, email: user.e, id: user._id });
    }

    if (action === 'login') {
      const key = String(email).trim().toLowerCase();
      const user = await User.findOne({ e: key });
      if (!user || !(await bcrypt.compare(password, user.p))) return res.status(401).json({ error: 'Invalid credentials.' });
      const sid = crypto.randomBytes(12).toString('hex');
      await Session.create({ _id: `${user._id}:${sid}`, u: user._id, i: clientIp(req), d: deviceLabel(req.headers['user-agent'] || ''), s: nowSeconds() });
      const token = jwt.sign({ userId: user._id, sid }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.status(200).json({ token, email: user.e, id: user._id });
    }

    const auth = await requireLiveSession(req);
    if (!auth) return res.status(401).json({ error: 'Please log in again.' });

    if (action === 'sessions') {
      const user = await User.findById(auth.userId).lean();
      const sessions = await Session.find({ u: auth.userId }).lean();
      return res.status(200).json({ id: user._id, email: user.e, username: user.n, bio: user.b || '', status: STATUSES[user.i || 0], avatar: user.av || null, sessions: sessions.map(s => ({ id: s._id.split(':')[1], ip: s.i, device: s.d, last: s.s, current: s._id.endsWith(auth.sid) })) });
    }

    if (action === 'ping') {
      await updateMemberActivity(auth.userId);
      return res.status(200).json({ ok: true });
    }

    if (action === 'friends') {
      await updateMemberActivity(auth.userId);
      const docs = await Friend.find({ $or: [{ a: auth.userId }, { b: auth.userId }] }).lean();
      const users = await User.find({ _id: { $in: docs.map(f => f.a === auth.userId ? f.b : f.a) } }).select('e n av o i').lean();
      return res.status(200).json({ friends: users.map(u => ({ id: u._id, email: u.e, username: u.n, avatar: u.av, status: presenceOf(u) })), incoming: [], outgoing: [] });
    }

    if (action === 'servers') {
      const servers = await Server.find({ m: auth.userId }).lean();
      return res.status(200).json({ servers: servers.map(s => ({ id: s._id, name: s.n, owner: s.o, count: s.m.length })) });
    }

    if (action === 'server-create') {
      const last = await Server.findOne().sort({ _id: -1 }).select('_id').lean();
      const server = await Server.create({ _id: (last ? last._id : 0) + 1, n: name, o: auth.userId, m: [auth.userId], i: crypto.randomBytes(24).toString('hex') });
      await Channel.create({ _id: `${server._id}:general`, s: server._id, n: 'general', cat: 'TEXT CHANNELS' });
      await Join.create({ s: server._id, u: auth.userId, t: nowSeconds(), duration: 0 });
      return res.status(200).json({ server: { id: server._id, name: server.n, owner: server.o, count: server.m.length } });
    }

    if (action === 'channels') {
      const chans = await Channel.find({ s: Number(id) }).lean();
      return res.status(200).json({ channels: chans.map(c => ({ id: c._id, name: c.n, category: c.cat })) });
    }

    if (action === 'channel-create') {
      const chId = `${id}:${channelName.toLowerCase().replace(/\s+/g, '-')}`;
      await Channel.create({ _id: chId, s: Number(id), n: channelName, cat: category || 'TEXT CHANNELS' });
      return res.status(200).json({ channel: { id: chId, name: channelName, category: category || 'TEXT CHANNELS' } });
    }

    if (action === 'server-members') {
      const server = await Server.findById(Number(id)).lean();
      const members = await User.find({ _id: { $in: server.m } }).select('n av o i').lean();
      const joins = await Join.find({ s: server._id }).lean();
      const byUser = new Map(joins.map(j => [j.u, j]));
      return res.status(200).json({
        server: { id: server._id, name: server.n, owner: server.o, count: server.m.length },
        members: members.map(m => {
          const j = byUser.get(m._id);
          return { id: m._id, username: m.n, avatar: m.av, status: presenceOf(m), duration: (j ? j.duration : 0) + (presenceOf(m) !== 'offline' ? 10 : 0) };
        })
      });
    }

    if (action === 'messages') {
      const match = kind === 'server' ? { s: Number(id), ch: channelId || `${id}:general` } : { $or: [{ a: auth.userId, b: Number(id) }, { a: Number(id), b: auth.userId }] };
      const msgs = await Msg.find({ ...match, d: { $ne: 1 } }).sort({ t: -1 }).limit(50).lean();
      const server = kind === 'server' ? await Server.findById(Number(id)).lean() : null;
      const members = server ? await User.find({ _id: { $in: server.m } }).select('n av o i').lean() : [];
      const joins = server ? await Join.find({ s: server._id }).lean() : [];
      const byUser = new Map(joins.map(j => [j.u, j]));

      return res.status(200).json({
        ...(server ? { server: { id: server._id, name: server.n, owner: server.o, count: server.m.length }, members: members.map(m => ({ id: m._id, username: m.n, avatar: m.av, status: presenceOf(m), duration: (byUser.get(m._id)?.duration || 0) })) } : {}),
        messages: msgs.reverse().map(m => ({ id: m._id, mine: m.a === auth.userId, text: m.m, t: m.t, sender: { id: m.a, username: 'Member' }, mentions: [] }))
      });
    }

    if (action === 'send') {
      const last = await Msg.findOne().sort({ _id: -1 }).select('_id').lean();
      const msg = await Msg.create({
        _id: (last ? last._id : 0) + 1,
        a: auth.userId,
        ...(kind === 'server' ? { s: Number(id), ch: channelId || `${id}:general` } : { b: Number(id) }),
        m: text,
        t: nowSeconds()
      });
      return res.status(200).json({ message: { id: msg._id, mine: true, text: msg.m, t: msg.t } });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};