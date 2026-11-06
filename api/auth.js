const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

mongoose.set('bufferCommands', false);

const db = globalThis.__pratrDb || (globalThis.__pratrDb = { conn: null, promise: null });

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

const Counter = mongoose.models.Counter || mongoose.model('Counter', new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 }
}, { versionKey: false }));

const userSchema = new mongoose.Schema({
  _id: { type: Number, required: true },
  e: { type: String, required: true, unique: true, lowercase: true, trim: true },
  p: { type: String, required: true },
  c: { type: Number, default: () => Math.floor(Date.now() / 1000) }
}, { versionKey: false });

const User = mongoose.models.User || mongoose.model('User', userSchema);

async function nextUserId() {
  const counter = await Counter.findByIdAndUpdate('user', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return counter.seq;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }
    }

    await connectDB();
    const { action, email, password } = body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    if (action === 'register') {
      if (await User.findOne({ e: email })) return res.status(400).json({ error: 'Email already registered.' });
      const p = await bcrypt.hash(password, 10);
      await User.create({ i: await nextUserId(), e: email, p });
      return res.status(201).json({ message: 'Account created!' });
    }

    if (action === 'login') {
      const user = await User.findOne({ e: email });
      if (!user || !(await bcrypt.compare(password, user.p))) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      if (!process.env.JWT_SECRET) {
        return res.status(500).json({ error: 'JWT_SECRET is not set. Add it in Vercel → Project Settings → Environment Variables, then redeploy.' });
      }
      const token = jwt.sign({ userId: user.i }, process.env.JWT_SECRET, { expiresIn: '7d' });
      return res.status(200).json({ token, email: user.e, id: user.i });
    }
    res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    console.error('[auth]', err);
    const hint = dbHint(err);
    res.status(500).json({ error: err.message, ...(hint ? { hint } : {}) });
  }
};