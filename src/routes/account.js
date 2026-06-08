const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const prisma  = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// ── Account page ──────────────────────────────────────────
router.get('/', (req, res) =>
  res.render('account', { error: null, success: null })
);

// ── Change password ───────────────────────────────────────
router.get('/change-password', (req, res) =>
  res.render('auth/change-password', { error: null, success: null })
);

router.post('/change-password', async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;

  if (!currentPassword || !newPassword || newPassword.length < 8)
    return res.render('auth/change-password', {
      error: 'New password must be at least 8 characters.', success: null
    });

  if (newPassword !== confirmPassword)
    return res.render('auth/change-password', {
      error: 'Passwords do not match.', success: null
    });

  const user = await prisma.user.findUnique({ where: { id: req.session.user.id } });
  if (!(await bcrypt.compare(currentPassword, user.password)))
    return res.render('auth/change-password', {
      error: 'Current password is incorrect.', success: null
    });

  const hashed = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });
  res.render('auth/change-password', { error: null, success: 'Password updated successfully.' });
});

// ── Delete account ────────────────────────────────────────
router.post('/delete', async (req, res) => {
  const { password } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.session.user.id } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.render('account', { error: 'Incorrect password. Account not deleted.', success: null });
  }
  await prisma.user.delete({ where: { id: user.id } });
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;