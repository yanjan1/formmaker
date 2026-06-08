const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const prisma = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, true)
});

async function queueEmail(toAddress, subject, body) {
  await prisma.email.create({ data: { toAddress, subject, body } });
}

// ── Verify submission — must be before /:id ───────────────
router.get('/verify', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.render('form/verify', { status: 'invalid', form: null });
  }

  let response;
  try {
    response = await prisma.response.findUnique({
      where: { verifyToken: token },
      include: { form: true }
    });
  } catch {
    return res.render('form/verify', { status: 'invalid', form: null });
  }

  if (!response) {
    return res.render('form/verify', { status: 'invalid', form: null });
  }

  if (response.isVerified) {
    return res.render('form/verify', { status: 'already', form: response.form });
  }

  if (response.verifyTokenExp < new Date()) {
    await prisma.response.delete({ where: { id: response.id } });
    return res.render('form/verify', { status: 'expired', form: response.form });
  }

  // ── EMAIL_RESTRICTED — re-check whitelist at verify time ──
  if (response.form.submitType === 'EMAIL_RESTRICTED') {
    const allowed = Array.isArray(response.form.allowedEmails)
      ? response.form.allowedEmails
      : [];
    if (
      allowed.length > 0 &&
      !allowed.includes(response.submitterEmail?.toLowerCase())
    ) {
      await prisma.response.delete({ where: { id: response.id } });
      return res.render('form/verify', { status: 'not_allowed', form: response.form });
    }
  }

  await prisma.response.update({
    where: { id: response.id },
    data: { isVerified: true, verifyToken: null, verifyTokenExp: null }
  });

  res.render('form/verify', { status: 'ok', form: response.form });
});

// ── Public form ───────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const form = await prisma.form.findFirst({
    where: { id: req.params.id, isPublished: true }
  });
  if (!form) return res.status(404).render('404');

  const fields = Array.isArray(form.fields) ? form.fields : [];
  const sorted = [...fields].sort((a, b) => a.order - b.order);

  res.render('form/show', {
    form: { ...form, fields: sorted },
    error: null,
    errors: {},
    values: {},
    hideNav: true
  });
});

// ── Submit form ───────────────────────────────────────────
router.post('/:id', (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) return next(err);
    next();
  });
}, async (req, res) => {
  const form = await prisma.form.findFirst({
    where: { id: req.params.id, isPublished: true }
  });
  if (!form) return res.status(404).render('404');

  const fields = Array.isArray(form.fields) ? form.fields : [];
  const sorted = [...fields].sort((a, b) => a.order - b.order);

  const errors = {};
  const values = {};

  // ── Validate each field ───────────────────────────────
  for (const field of sorted) {
    const raw = req.body[field.id];

    if (field.type === 'checkbox') {
      // ── checkbox ───────────────────────────────────────
      const checked = raw
        ? Array.isArray(raw) ? raw : [raw]
        : [];
      values[field.id] = checked;
      if (field.required && checked.length === 0)
        errors[field.id] = `${field.label} is required.`;

    } else if (field.type === 'file') {
      // ── file ───────────────────────────────────────────
      const uploaded = req.files?.find(f => f.fieldname === field.id);
      values[field.id] = uploaded
        ? {
          originalname: uploaded.originalname,
          filename: uploaded.filename,
          size: uploaded.size
        }
        : null;
      if (field.required && !uploaded)
        errors[field.id] = `${field.label} is required.`;

    } else {
      // ── all text-based types ───────────────────────────
      const val = (raw || '').toString().trim();
      values[field.id] = val;

      if (field.required && !val) {
        errors[field.id] = `${field.label} is required.`;
      } else if (val) {
        if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val))
          errors[field.id] = `${field.label} must be a valid email.`;
        if (field.type === 'number' && isNaN(Number(val)))
          errors[field.id] = `${field.label} must be a number.`;
        if (field.type === 'url' && !/^https?:\/\/.+/.test(val))
          errors[field.id] = `${field.label} must be a valid URL.`;
      }
    }
  }

  // ── Validate submitter email for non-open forms ───────
  const submitterEmail = (req.body.submitterEmail || '').trim().toLowerCase();
  if (form.submitType !== 'OPEN') {
    if (!submitterEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submitterEmail)) {
      errors.submitterEmail = 'A valid email address is required.';
    }
  }

  // ── Bail early if validation failed ──────────────────
  if (Object.keys(errors).length > 0) {
    return res.render('form/show', {
      form: { ...form, fields: sorted },
      error: 'Please fix the errors below.',
      errors,
      values,
      hideNav: true
    });
  }

  // ── EMAIL_RESTRICTED — check whitelist ────────────────
  if (form.submitType === 'EMAIL_RESTRICTED') {
    const allowed = Array.isArray(form.allowedEmails) ? form.allowedEmails : [];
    if (allowed.length > 0 && !allowed.includes(submitterEmail)) {
      return res.render('form/show', {
        form: { ...form, fields: sorted },
        error: 'Your email is not authorized to submit this form.',
        errors: { submitterEmail: 'This email is not on the allowed list.' },
        values,
        hideNav: true
      });
    }
  }

  // ── One response per email — handle verified and pending ──
  if (form.submitType !== 'OPEN' && submitterEmail) {
    const existing = await prisma.response.findFirst({
      where: { formId: form.id, submitterEmail }
    });

    if (existing) {
      if (existing.isVerified && !form.allowMultiple) {
        return res.render('form/show', {
          form: { ...form, fields: sorted },
          error: 'This email has already submitted a verified response for this form.',
          errors: { submitterEmail: 'Already submitted.' },
          values,
          hideNav: true
        });
      } else if (!existing.isVerified) {
        // delete pending — invalidates old token, fresh one created below
        await prisma.response.delete({ where: { id: existing.id } });
      }
      // isVerified && allowMultiple — fall through
    }
  }

  // ── Store response ────────────────────────────────────
  const needsVerification = form.submitType !== 'OPEN';
  const verifyToken = needsVerification ? uuidv4() : null;
  const verifyTokenExp = needsVerification
    ? new Date(Date.now() + 48 * 60 * 60 * 1000)
    : null;

  await prisma.response.create({
    data: {
      formId: form.id,
      data: values,
      submitterEmail: submitterEmail || null,
      isVerified: !needsVerification,
      verifyToken,
      verifyTokenExp,
    }
  });

  // ── Queue confirmation email ──────────────────────────
  if (needsVerification && submitterEmail) {
    const link = `${process.env.APP_URL}/form/verify?token=${verifyToken}`;
    await queueEmail(
      submitterEmail,
      `Confirm your submission — ${form.title}`,
      `Hi,\n\nPlease confirm your submission for "${form.title}":\n\n${link}\n\nThis link expires in 48 hours.\nUnconfirmed responses are removed automatically.`
    );
  }

  res.render('form/success', {
    form,
    needsVerification,
    submitterEmail,
    hideNav: true
  });
});

module.exports = router;