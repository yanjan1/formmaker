const express = require('express');
const router  = express.Router();
const prisma  = require('../db');
const { requireAuth, requireVerified } = require('../middleware/auth');

router.get('/', requireAuth, requireVerified, async (req, res) => {
  const forms = await prisma.form.findMany({
    where: { userId: req.session.user.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { responses: true } } }
  });
  res.render('dashboard', { forms });
});

module.exports = router;