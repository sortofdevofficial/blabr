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
  o: String,
  x: Number,
  a: { type: Number, default: 0 }
}, { versionKey: false });

const User = mongoose.models.User || mongoose.model('User', userSchema);

async function createUser(fields) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await User.findOne().sort({ _id: -1 }).select('_id').lean();
    try {
      return await User.create({ _id: (last ? last._id : 0) + 1, ...fields });
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

function issueToken(user) {
  if (!process.env.JWT_SECRET) return null;
  return jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

async function handleRegister(res, email, password) {
  const existing = await User.findOne({ e: email });
  if (existing && !existing.o) return res.status(400).json({ error: 'Email already registered.' });

  const now = nowSeconds();
  if (existing && existing.x && existing.x - now > OTP_TTL_SECONDS - RESEND_COOLDOWN_SECONDS) {
    return res.status(429).json({ error: 'Please wait a minute before requesting another code.' });
  }

  const code = makeOtp();
  const [p, o] = await Promise.all([bcrypt.hash(password, 10), bcrypt.hash(code, 8)]);

  try {
    await sendOtp(email, code);
  } catch (err) {
    console.error('[mail]', err);
    return res.status(502).json({
      error: 'Could not send the verification email.',
      hint: 'Check GMAIL_USER and GMAIL_APP_PASSWORD in Vercel. An App Password requires 2-Step Verification on that Google account.'
    });
  }

  if (existing) {
    await User.updateOne({ _id: existing._id }, { p, o, x: now + OTP_TTL_SECONDS, a: 0 });
  } else {
    const user = await createUser({ e: email, p, o, x: now + OTP_TTL_SECONDS });
    if (!user) return res.status(409).json({ error: 'Email already registered. Try again.' });
  }

  return res.status(200).json({ message: 'Code sent.', email });
}

async function handleVerify(res, email, otp) {
  const user = await User.findOne({ e: email });
  if (!user) return res.status(400).json({ error: 'No pending registration for that email.' });
  if (!user.o) return res.status(409).json({ error: 'Already verified — please log in.' });

  if (!user.x || user.x < nowSeconds()) {
    return res.status(400).json({ error: 'That code expired. Request a new one.' });
  }
  if ((user.a || 0) >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });
  }

  if (!(await bcrypt.compare(String(otp), user.o))) {
    await User.updateOne({ _id: user._id }, { $inc: { a: 1 } });
    return res.status(400).json({ error: 'Incorrect code.' });
  }

  await User.updateOne({ _id: user._id }, { $unset: { o: '', x: '', a: '' } });

  const token = issueToken(user);
  if (!token) {
    return res.status(500).json({ error: 'JWT_SECRET is not set. Add it in Vercel → Project Settings → Environment Variables, then redeploy.' });
  }
  return res.status(200).json({ token, email: user.e, id: user._id });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }
    }

    await connectDB();
    const { action, email, password, otp } = body;

    if (action === 'register') {
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
      return await handleRegister(res, email, password);
    }

    if (action === 'verify') {
      if (!email || !otp) return res.status(400).json({ error: 'Email and code required.' });
      return await handleVerify(res, email, otp);
    }

    if (action === 'login') {
      if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
      const user = await User.findOne({ e: email });
      if (!user || !(await bcrypt.compare(password, user.p))) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      if (user.o) {
        return res.status(403).json({ error: 'Email not verified. Enter the code we emailed you.', verify: true });
      }
      const token = issueToken(user);
      if (!token) {
        return res.status(500).json({ error: 'JWT_SECRET is not set. Add it in Vercel → Project Settings → Environment Variables, then redeploy.' });
      }
      return res.status(200).json({ token, email: user.e, id: user._id });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('[auth]', err);
    const hint = dbHint(err);
    res.status(500).json({ error: err.message, ...(hint ? { hint } : {}) });
  }
};
