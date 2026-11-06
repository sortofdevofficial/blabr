const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

let cachedDb = null;
async function connectDB() {
  if (cachedDb) return cachedDb;
  cachedDb = await mongoose.connect(process.env.MONGO_URI);
  return cachedDb;
}

const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true }
}));

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await connectDB();
    const { action, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    if (action === 'register') {
      if (await User.findOne({ email })) return res.status(400).json({ error: 'Email already registered.' });
      const hashedPassword = await bcrypt.hash(password, 10);
      await User.create({ email, password: hashedPassword });
      return res.status(201).json({ message: 'Account created!' });
    }

    if (action === 'login') {
      const user = await User.findOne({ email });
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });
      return res.status(200).json({ token, email: user.email });
    }
    res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};