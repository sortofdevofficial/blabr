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
const nowSeconds = () => Math.floor(Date.now() / 1000);

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
      .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
      .then((m) => { db.conn = m; return m; })
      .catch((err) => { db.promise = null; throw err; });
  }
  return db.promise;
}

const userSchema = new mongoose.Schema({
  _id: { type: Number, required: true },
  e: { type: String, required: true, unique: true, lowercase: true, trim: true },
  p: { type: String, required: true },
  c: { type: Number, default: nowSeconds },
  av: String
}, { versionKey: false });

const User = mongoose.models.User || mongoose.model('User', userSchema);

const pendingSchema = new mongoose.Schema({
  _id: { type: String, lowercase: true, trim: true },
  p: { type: String, required: true },
  o: { type: String, required: true },
  x: { type: Number, required: true },
  a: { type: Number, default: 0 }
}, { versionKey: false });

const Pending = mongoose.models.Pending || mongoose.model('Pending', pendingSchema, 'pending');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

async function migrateLegacyPending(email) {
  const raw = await User.collection.findOne({ e: email });
  if (!raw || !raw.o) return false;
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
  u: { type: Number, required: true, index: true },
  i: String,
  d: String,
  s: Number
}, { versionKey: false });

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

async function createUser(fields) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await User.findOne({ _id: { $type: 'number' } }).sort({ _id: -1 }).select('_id').lean();
    try {
      const user = await User.create({ _id: (last ? last._id : 0) + 1, ...fields });
      await Session.deleteMany({ u: user._id });
      return user;
    } catch (err) {
      if (err.code !== 11000) throw err;
      if (err.keyPattern && err.keyPattern.e) return null;
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
    _id: sid,
    u: userId,
    i: clientIp(req),
    d: deviceLabel((req.headers && req.headers['user-agent']) || ''),
    s: now
  });
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

async function handleRegister(res, email, password) {
  const key = normalizeEmail(email);
  await migrateLegacyPending(key);

  if (await User.exists({ e: key })) {
    return res.status(400).json({ error: 'Email already registered.' });
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
    { p, o, x: now + OTP_TTL_SECONDS, a: 0 },
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

  const user = await createUser({ e: key, p: pending.p });
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

  const sessions = await Session.find({ u: auth.userId }).sort({ s: -1 }).lean();
  const current = sessions.find((s) => s._id === auth.sid);
  if (!current) return res.status(401).json({ error: 'This device was logged out.', expired: true });

  await Session.updateOne({ _id: auth.sid }, { s: nowSeconds() });

  const user = await User.findById(auth.userId).select('e av').lean();
  if (!user) return res.status(401).json({ error: 'Account not found.', expired: true });

  return res.status(200).json({
    email: user.e,
    avatar: user.av || null,
    sessions: sessions.map((s) => ({
      id: s._id,
      ip: s.i,
      device: s.d,
      last: s._id === auth.sid ? nowSeconds() : s.s,
      current: s._id === auth.sid
    }))
  });
}

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

async function handleAvatar(req, res, image) {
  const auth = readAuth(req);
  if (!auth || !auth.sid) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const live = await Session.findOne({ _id: auth.sid, u: auth.userId }).select('_id').lean();
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

async function handleRevoke(req, res, id) {
  const auth = readAuth(req);
  if (!auth) return res.status(401).json({ error: 'Please log in again.', expired: true });

  const target = id || auth.sid;
  if (!target) return res.status(400).json({ error: 'Session id required.' });

  const result = await Session.deleteOne({ _id: target, u: auth.userId });
  if (!result.deletedCount) return res.status(404).json({ error: 'Session not found.' });

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
    const { action, email, password, otp, id, image } = body;

    if (action === 'register') {
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
      return await handleRegister(res, email, password);
    }

    if (action === 'verify') {
      if (!email || !otp) return res.status(400).json({ error: 'Email and code required.' });
      return await handleVerify(req, res, email, otp);
    }

    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
      const key = normalizeEmail(email);
      await migrateLegacyPending(key);

      const user = await User.findOne({ e: key });
      if (!user) {
        const pending = await Pending.findById(key).lean();
        if (pending && (await bcrypt.compare(password, pending.p))) {
          return res.status(403).json({ error: 'Email not verified. Enter the code we emailed you.', verify: true });
        }
        return res.status(401).json({ error: 'Invalid email or password.' });
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

    res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('[auth]', err);
    const hint = dbHint(err);
    res.status(500).json({ error: err.message, ...(hint ? { hint } : {}) });
  }
};
