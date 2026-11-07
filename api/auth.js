const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

mongoose.set('bufferCommands', false);

const db = globalThis.__pratrDb || (globalThis.__pratrDb = { conn: null, promise: null });
const nowSeconds = () => Math.floor(Date.now() / 1000);

async function connectDB() {
  if (db.conn) return db.conn;
  if (!db.promise) {
    db.promise = mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 1 })
      .then(m => { db.conn = m; return m; })
      .catch(err => { db.promise = null; throw err; });
  }
  return db.promise;
}

const userSchema = new mongoose.Schema({
  _id: Number,
  e: { type: String, unique: true, lowercase: true, trim: true },
  p: String,
  n: { type: String, unique: true, sparse: true },
  o: Number,
  i: Number,
  b: String,
  av: String
}, { versionKey: false });
const User = mongoose.models.User || mongoose.model('User', userSchema);

const pendingSchema = new mongoose.Schema({
  _id: String,
  p: String,
  o: String,
  un: String,
  x: Number
}, { versionKey: false });
const Pending = mongoose.models.Pending || mongoose.model('Pending', pendingSchema, 'pending');

const sessionSchema = new mongoose.Schema({
  _id: String,
  u: Number,
  i: String,
  d: String,
  s: Number
}, { versionKey: false });
const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

const msgSchema = new mongoose.Schema({
  _id: Number,
  a: Number,
  b: Number,
  s: Number,
  ch: Number,
  m: String,
  t: { type: Number, default: nowSeconds },
  d: { type: Number, default: 0 }
}, { versionKey: false });
const Msg = mongoose.models.Msg || mongoose.model('Msg', msgSchema, 'msgs');

const serverSchema = new mongoose.Schema({
  _id: Number,
  n: String,
  o: Number,
  m: [Number],
  ic: String,
  i: { type: String, unique: true }
}, { versionKey: false });
const Server = mongoose.models.Server || mongoose.model('Server', serverSchema, 'servers');

const channelSchema = new mongoose.Schema({
  _id: Number,
  s: Number,
  n: String,
  cat: { type: String, default: 'TEXT CHANNELS' }
}, { versionKey: false });
const Channel = mongoose.models.Channel || mongoose.model('Channel', channelSchema, 'channels');

const friendSchema = new mongoose.Schema({
  _id: String,
  a: Number,
  b: Number,
  s: { type: String, default: 'a' }
}, { versionKey: false });
const Friend = mongoose.models.Friend || mongoose.model('Friend', friendSchema, 'friends');

async function sendOtp(to, code) {
  if (!process.env.RESEND_API_KEY) { console.log(`[OTP] ${to}: ${code}`); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'pratr <onboarding@resend.dev>', to: [to], subject: 'Your pratr verification code', text: `Your code is ${code}. It expires in 10 minutes.` })
  });
  if (!r.ok) throw new Error('Could not send verification email.');
}

async function nextId(Model) {
  const last = await Model.findOne().sort({ _id: -1 }).select('_id').lean();
  return (last ? last._id : 0) + 1;
}

const areFriends = async (x, y) => !!(await Friend.exists({ $or: [{ a: x, b: y }, { a: y, b: x }], s: 'a' }));

const isMember = async (serverId, userId) => !!(await Server.exists({ _id: Number(serverId), m: userId }));

const srv = (s) => ({ id: s._id, name: s.n, owner: s.o, count: s.m.length, icon: s.ic || '' });
const okImg = (u) => u === '' || (typeof u === 'string' && u.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`));

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }

    await connectDB();
    const { action, email, password, otp, id, username, text, kind, name, channelId, category, channelName, code, avatar, icon } = body;

    if (action === 'register') {
      const key = String(email || '').trim().toLowerCase();
      if (!key || !password) return res.status(400).json({ error: 'Email and password required.' });
      if (await User.exists({ e: key })) return res.status(400).json({ error: 'Email already registered.' });
      const uname = String(username || '').trim().slice(0, 20);
      if (uname && await User.exists({ n: uname })) return res.status(400).json({ error: 'Username taken.' });
      const codeStr = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      await Pending.updateOne({ _id: key }, { p: await bcrypt.hash(password, 10), o: await bcrypt.hash(codeStr, 8), un: uname, x: nowSeconds() + 600 }, { upsert: true });
      await sendOtp(key, codeStr);
      return res.status(200).json({ message: 'Code sent.', email: key });
    }

    if (action === 'verify') {
      const key = String(email || '').trim().toLowerCase();
      const pending = await Pending.findById(key).lean();
      if (!pending || pending.x < nowSeconds() || !(await bcrypt.compare(String(otp || ''), pending.o))) return res.status(400).json({ error: 'Invalid code.' });
      const userId = await nextId(User);
      const user = await User.create({ _id: userId, e: key, p: pending.p, n: pending.un || `user${userId}` });
      await Pending.deleteOne({ _id: key });
      const sid = crypto.randomBytes(12).toString('hex');
      await Session.create({ _id: `${user._id}:${sid}`, u: user._id, s: nowSeconds() });
      const token = jwt.sign({ userId: user._id, sid }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.status(200).json({ token, email: user.e, id: user._id });
    }

    if (action === 'login') {
      const key = String(email || '').trim().toLowerCase();
      const user = await User.findOne({ e: key });
      if (!user || !(await bcrypt.compare(String(password || ''), user.p))) return res.status(401).json({ error: 'Invalid credentials.' });
      const sid = crypto.randomBytes(12).toString('hex');
      await Session.create({ _id: `${user._id}:${sid}`, u: user._id, s: nowSeconds() });
      const token = jwt.sign({ userId: user._id, sid }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.status(200).json({ token, email: user.e, id: user._id });
    }

    const authHeader = (req.headers && req.headers.authorization) || '';
    let auth = null;
    try { auth = authHeader.startsWith('Bearer ') ? jwt.verify(authHeader.slice(7), process.env.JWT_SECRET) : null; } catch { auth = null; }
    if (!auth || !(await Session.exists({ _id: `${auth.userId}:${auth.sid}` }))) return res.status(401).json({ error: 'Please log in again.' });

    if (action === 'logout') {
      await Session.deleteOne({ _id: `${auth.userId}:${auth.sid}` });
      return res.status(200).json({ ok: true });
    }

    if (action === 'me') {
      const me = await User.findById(auth.userId).select('e n av').lean();
      return res.status(200).json({ id: me._id, email: me.e, username: me.n, avatar: me.av || '' });
    }

    if (action === 'profile-update') {
      const uname = String(username || '').trim().slice(0, 20);
      if (!uname) return res.status(400).json({ error: 'Username required.' });
      if (await User.exists({ n: uname, _id: { $ne: auth.userId } })) return res.status(400).json({ error: 'Username taken.' });
      if (!okImg(avatar ?? '')) return res.status(400).json({ error: 'Invalid image.' });
      await User.updateOne({ _id: auth.userId }, { n: uname, av: avatar || '' });
      return res.status(200).json({ username: uname, avatar: avatar || '' });
    }

    if (action === 'upload-sign') {
      const { CLOUDINARY_CLOUD_NAME: cloud, CLOUDINARY_API_KEY: key, CLOUDINARY_API_SECRET: secret } = process.env;
      if (!cloud || !key || !secret) return res.status(500).json({ error: 'Image uploads are not configured.' });
      const folder = kind === 'servers' ? 'pratr/servers' : 'pratr/avatars', timestamp = nowSeconds();
      const signature = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${secret}`).digest('hex');
      return res.status(200).json({ cloud, key, timestamp, signature, folder });
    }

    if (action === 'server-update') {
      const cleanName = String(name || '').trim().slice(0, 60);
      if (!cleanName) return res.status(400).json({ error: 'Server name required.' });
      if (!okImg(icon ?? '')) return res.status(400).json({ error: 'Invalid image.' });
      const server = await Server.findOneAndUpdate({ _id: Number(id), o: auth.userId }, { n: cleanName, ic: icon || '' }, { new: true }).lean();
      if (!server) return res.status(403).json({ error: 'Only the owner can edit the server.' });
      return res.status(200).json({ server: srv(server) });
    }

    if (action === 'friend-add') {
      const q = String(username || '').trim();
      const other = await User.findOne({ $or: [{ n: q }, { e: q.toLowerCase() }] }).lean();
      if (!other) return res.status(404).json({ error: 'User not found.' });
      if (other._id === auth.userId) return res.status(400).json({ error: "You can't add yourself." });
      const [x, y] = [auth.userId, other._id].sort((p, q2) => p - q2);
      await Friend.updateOne({ _id: `${x}:${y}` }, { $setOnInsert: { a: x, b: y, s: 'a' } }, { upsert: true });
      return res.status(200).json({ friend: { id: other._id, username: other.n, email: other.e, avatar: other.av } });
    }

    if (action === 'server-join') {
      const server = await Server.findOne({ i: String(code || '') });
      if (!server) return res.status(404).json({ error: 'Invalid invite.' });
      if (!server.m.includes(auth.userId)) { server.m.push(auth.userId); await server.save(); }
      return res.status(200).json({ server: srv(server) });
    }

    if (action === 'friends') {
      const docs = await Friend.find({ $or: [{ a: auth.userId }, { b: auth.userId }], s: 'a' }).lean();
      const users = await User.find({ _id: { $in: docs.map(f => f.a === auth.userId ? f.b : f.a) } }).select('e n av').lean();
      return res.status(200).json({ friends: users.map(u => ({ id: u._id, email: u.e, username: u.n, avatar: u.av })) });
    }

    if (action === 'servers') {
      const servers = await Server.find({ m: auth.userId }).lean();
      return res.status(200).json({ servers: servers.map(srv) });
    }

    if (action === 'server-create') {
      const cleanName = String(name || '').trim().slice(0, 60);
      if (!cleanName) return res.status(400).json({ error: 'Server name required.' });
      const serverId = await nextId(Server);
      const server = await Server.create({ _id: serverId, n: cleanName, o: auth.userId, m: [auth.userId], i: crypto.randomBytes(24).toString('hex') });
      await Channel.create({ _id: await nextId(Channel), s: serverId, n: 'general', cat: 'TEXT CHANNELS' });
      return res.status(200).json({ server: srv(server) });
    }

    if (action === 'channels') {
      if (!(await isMember(id, auth.userId))) return res.status(403).json({ error: 'Not a member.' });
      const chans = await Channel.find({ s: Number(id) }).sort({ _id: 1 }).lean();
      return res.status(200).json({ channels: chans.map(c => ({ id: c._id, name: c.n, category: c.cat })) });
    }

    if (action === 'channel-create') {
      const serverId = Number(id);
      if (!(await Server.exists({ _id: serverId, o: auth.userId }))) return res.status(403).json({ error: 'Only owner can create channels.' });
      const chId = await nextId(Channel);
      const chName = String(channelName || '').trim().toLowerCase().replace(/\s+/g, '-');
      if (!chName) return res.status(400).json({ error: 'Channel name required.' });
      await Channel.create({ _id: chId, s: serverId, n: chName, cat: category || 'TEXT CHANNELS' });
      return res.status(200).json({ channel: { id: chId, name: chName, category: category || 'TEXT CHANNELS' } });
    }

    if (action === 'server-invite') {
      const server = await Server.findOne({ _id: Number(id), m: auth.userId }).lean();
      if (!server) return res.status(403).json({ error: 'You are not a member of this server.' });
      return res.status(200).json({ code: server.i });
    }

    if (action === 'members') {
      const server = await Server.findOne({ _id: Number(id), m: auth.userId }).lean();
      if (!server) return res.status(403).json({ error: 'Not a member.' });
      const users = await User.find({ _id: { $in: server.m } }).select('n av').lean();
      return res.status(200).json({ owner: server.o, members: users.map(u => ({ id: u._id, username: u.n, avatar: u.av })) });
    }

    if (action === 'channel-delete') {
      const ch = await Channel.findById(Number(channelId)).lean();
      if (!ch || !(await Server.exists({ _id: ch.s, o: auth.userId }))) return res.status(403).json({ error: 'Only the owner can delete channels.' });
      await Channel.deleteOne({ _id: ch._id });
      await Msg.deleteMany({ s: ch.s, ch: ch._id });
      return res.status(200).json({ ok: true });
    }

    if (action === 'server-leave') {
      const server = await Server.findOne({ _id: Number(id), m: auth.userId }).lean();
      if (!server) return res.status(404).json({ error: 'Not a member.' });
      if (server.o === auth.userId) return res.status(400).json({ error: 'Owners cannot leave their own server.' });
      await Server.updateOne({ _id: server._id }, { $pull: { m: auth.userId } });
      return res.status(200).json({ ok: true });
    }

    if (action === 'messages') {
      const isServer = kind === 'server';
      let match;
      if (isServer) {
        if (!(await isMember(id, auth.userId))) return res.status(403).json({ error: 'Not a member.' });
        if (!(await Channel.exists({ _id: Number(channelId), s: Number(id) }))) return res.status(404).json({ error: 'Channel not found.' });
        match = { s: Number(id), ch: Number(channelId) };
      } else {
        if (!(await areFriends(auth.userId, Number(id)))) return res.status(403).json({ error: 'You can only message friends.' });
        match = { $or: [{ a: auth.userId, b: Number(id) }, { a: Number(id), b: auth.userId }] };
      }
      const msgs = await Msg.find({ ...match, d: { $ne: 1 } }).sort({ _id: -1 }).limit(100).lean();
      const authors = await User.find({ _id: { $in: [...new Set(msgs.map(m => m.a))] } }).select('n av').lean();
      const people = Object.fromEntries(authors.map(u => [u._id, u]));
      return res.status(200).json({
        messages: msgs.reverse().map(m => ({ id: m._id, mine: m.a === auth.userId, text: m.m, t: m.t, author: { id: m.a, username: people[m.a]?.n || 'Unknown', avatar: people[m.a]?.av } }))
      });
    }

    if (action === 'send') {
      const clean = String(text || '').trim().slice(0, 2000);
      if (!clean) return res.status(400).json({ error: 'Empty message.' });
      let target;
      if (kind === 'server') {
        if (!(await isMember(id, auth.userId))) return res.status(403).json({ error: 'Not a member.' });
        if (!(await Channel.exists({ _id: Number(channelId), s: Number(id) }))) return res.status(400).json({ error: 'This server has no such text channel.' });
        target = { s: Number(id), ch: Number(channelId) };
      } else {
        if (!(await areFriends(auth.userId, Number(id)))) return res.status(403).json({ error: 'You can only message friends.' });
        target = { b: Number(id) };
      }
      const msg = await Msg.create({ _id: await nextId(Msg), a: auth.userId, ...target, m: clean });
      return res.status(200).json({ message: { id: msg._id, mine: true, text: msg.m, t: msg.t } });
    }

    return res.status(400).json({ error: 'Invalid action.' });
  } catch (err) {
    console.error('[auth error]', err);
    return res.status(500).json({ error: err.message || 'Server error.' });
  }
};