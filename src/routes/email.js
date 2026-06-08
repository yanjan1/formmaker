const express = require('express');
const router  = express.Router();
const prisma  = require('../db');

// Public — shows last 10 emails for dev
router.get('/', async (req, res) => {
  const emails = await prisma.email.findMany({
    orderBy: { sentAt: 'desc' },
    take: 10
  });
  res.render('email/inbox', { emails });
});

module.exports = router;