const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

module.exports = {
  async createUser(email, password) {
    const id = uuidv4();
    const hash = await bcrypt.hash(password, 10);
    return db.createUser(id, email.toLowerCase().trim(), hash);
  },

  async verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
  },

  generateToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
  },

  requireAuth(req, res, next) {
    const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = db.getUserById(decoded.userId);
      if (!user) return res.status(401).json({ error: 'User not found' });
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }
};
