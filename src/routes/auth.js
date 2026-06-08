require('dotenv').config();
const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const prisma  = require('../db');
const { redirectIfAuth, requireAuth } = require('../middleware/auth');

async function queueEmail(toAddress, subject, body) {
  await prisma.email.create({ data: { toAddress, subject, body } });
}

// ── Login ────────────────────────────────────────────────
router.get('/login', redirectIfAuth, (req, res) =>
  res.render('auth/login', { error: null })
);


router.post('/login', redirectIfAuth, async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.render('auth/login', { error: 'Invalid email or password.' });

    // regenerate session to prevent session fixation
    req.session.regenerate((err) => {
      if (err) return res.render('auth/login', { error: 'Something went wrong.' });
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        isVerified: user.isVerified
      };
      req.session.save((err) => {
        if (err) return res.render('auth/login', { error: 'Something went wrong.' });
        res.redirect('/dashboard');
      });
    });
  } catch {
    res.render('auth/login', { error: 'Something went wrong.' });
  }
});

router.get('/register', redirectIfAuth, (req, res) =>
  res.render('auth/register', { error: null })
);

// ── Register ─────────────────────────────────────────────
router.post('/register', redirectIfAuth, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 8)
    return res.render('auth/register', { error: 'All fields required. Password min 8 chars.' });

  try {
    const hashed = await bcrypt.hash(password, 12);
    const token  = uuidv4();
    const exp    = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: { name, email, password: hashed, verifyToken: token, verifyTokenExp: exp }
    });

    const link = `${process.env.APP_URL}/auth/verify-email?token=${token}`;
    await queueEmail(email, 'Verify your email',
      `Hi ${name},\n\nClick to verify:\n${link}\n\nExpires in 24 hours.`
    );

    req.session.regenerate((err) => {
      if (err) return res.render('auth/register', { error: 'Something went wrong.' });
      req.session.user = { id: user.id, name: user.name, email: user.email, isVerified: false };
      req.session.flash = { type: 'info', message: 'Registered! Check /email to grab your verify link.' };
      req.session.save((err) => {
        if (err) return res.render('auth/register', { error: 'Something went wrong.' });
        res.redirect('/dashboard');
      });
    });
  } catch (e) {
    const msg = e.code === 'P2002' ? 'Email already in use.' : 'Something went wrong.';
    res.render('auth/register', { error: msg });
  }
});

// ── Verify email ─────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.render('auth/verify-email', { status: 'missing' });

  const user = await prisma.user.findUnique({ where: { verifyToken: token } });
  if (!user) return res.render('auth/verify-email', { status: 'invalid' });
  if (user.verifyTokenExp < new Date()) return res.render('auth/verify-email', { status: 'expired' });

  await prisma.user.update({
    where: { id: user.id },
    data: { isVerified: true, verifyToken: null, verifyTokenExp: null }
  });

  if (req.session.user) req.session.user.isVerified = true;
  res.render('auth/verify-email', { status: 'ok' });
});

// ── Request new verify email ──────────────────────────────
router.get('/request-verify', requireAuth, (req, res) =>
  res.render('auth/request-verify', { sent: false })
);

router.post('/request-verify', requireAuth, async (req, res) => {
  const token = uuidv4();
  const exp   = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: req.session.user.id },
    data: { verifyToken: token, verifyTokenExp: exp }
  });

  const link = `${process.env.APP_URL}/auth/verify-email?token=${token}`;
  await queueEmail(
    req.session.user.email,
    'Verify your email',
    `Click to verify:\n${link}\n\nExpires in 24 hours.`
  );
  res.render('auth/request-verify', { sent: true });
});

// ── Forgot password ───────────────────────────────────────
router.get('/forgot-password', redirectIfAuth, (req, res) =>
  res.render('auth/forgot-password', { sent: false, error: null })
);

router.post('/forgot-password', redirectIfAuth, async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });

  // Always show success to prevent email enumeration
  if (user) {
    const token = uuidv4();
    const exp   = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: token, resetTokenExp: exp }
    });
    const link = `${process.env.APP_URL}/auth/reset-password?token=${token}`;
    await queueEmail(email, 'Reset your password',
      `Click to reset:\n${link}\n\nExpires in 1 hour.`
    );
  }
  res.render('auth/forgot-password', { sent: true, error: null });
});

// ── Reset password ────────────────────────────────────────
router.get('/reset-password', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/auth/forgot-password');
  const user = await prisma.user.findUnique({ where: { resetToken: token } });
  if (!user || user.resetTokenExp < new Date())
    return res.render('auth/reset-password', { status: 'invalid', token: null });
  res.render('auth/reset-password', { status: 'form', token });
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8)
    return res.render('auth/reset-password', { status: 'invalid', token: null });

  const user = await prisma.user.findUnique({ where: { resetToken: token } });
  if (!user || user.resetTokenExp < new Date())
    return res.render('auth/reset-password', { status: 'invalid', token: null });

  const hashed = await bcrypt.hash(password, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashed, resetToken: null, resetTokenExp: null }
  });
  res.render('auth/reset-password', { status: 'done', token: null });
});

// ── Logout ────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Logout error:', err);
    res.clearCookie('connect.sid');
    res.clearCookie('x-csrf-token');
    res.redirect('/auth/login');
  });
});

module.exports = router;