const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../db');
const { requireAuth, requireVerified } = require('../middleware/auth');

router.use(requireAuth, requireVerified);

// ── List forms ────────────────────────────────────────────
router.get('/', async (req, res) => {
  const forms = await prisma.form.findMany({
    where: { userId: req.session.user.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { responses: true } } }
  });
  res.render('studio/index', { forms });
});

// ── New form ──────────────────────────────────────────────
router.get('/new', (req, res) => {
  res.render('studio/new', { error: null });
});

router.post('/new', async (req, res) => {
  const { title, description, submitType } = req.body;
  if (!title || !title.trim())
    return res.render('studio/new', { error: 'Title is required.' });

  const form = await prisma.form.create({
    data: {
      userId: req.session.user.id,
      title: title.trim(),
      description: description?.trim() || null,
      submitType: submitType || 'OPEN',
      fields: [],
    }
  });
  res.redirect(`/studio/${form.id}/edit`);
});

// ── Edit form ─────────────────────────────────────────────
router.get('/:id/edit', async (req, res) => {
  const form = await prisma.form.findFirst({
    where: { id: req.params.id, userId: req.session.user.id }
  });
  if (!form) return res.status(404).render('404');
  res.render('studio/edit', { form, error: null });
});

// ── Save fields (AJAX) ────────────────────────────────────
router.post('/:id/fields', async (req, res) => {
  const form = await prisma.form.findFirst({
    where: { id: req.params.id, userId: req.session.user.id }
  });
  if (!form) return res.status(404).json({ error: 'Not found' });

  const { fields } = req.body;
  if (!Array.isArray(fields))
    return res.status(400).json({ error: 'fields must be an array' });

  // validate each field
  for (const f of fields) {
    if (!f.id || !f.type || !f.label)
      return res.status(400).json({ error: `Field missing id, type or label` });
    if (['select','radio','checkbox'].includes(f.type)) {
      if (!Array.isArray(f.options) || f.options.length < 1)
        return res.status(400).json({ error: `Field "${f.label}" needs at least one option` });
    }
  }

  await prisma.form.update({
    where: { id: form.id },
    data: { fields }
  });
  res.json({ ok: true });
});

// ── Update meta (title, description, submitType) ──────────
router.post('/:id/meta', async (req, res) => {
  const form = await prisma.form.findFirst({
    where: { id: req.params.id, userId: req.session.user.id }
  });
  if (!form) return res.status(404).render('404');

  const { title, description, submitType, allowedEmails, allowMultiple } = req.body;
  if (!title?.trim())
    return res.redirect(`/studio/${form.id}/edit?error=Title+is+required`);

  const parsedEmails = submitType === 'EMAIL_RESTRICTED'
    ? (allowedEmails || '')
        .split('\n')
        .map(e => e.trim().toLowerCase())
        .filter(e => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    : null;

  await prisma.form.update({
    where: { id: form.id },
    data: {
      title:         title.trim(),
      description:   description?.trim() || null,
      submitType:    submitType || 'OPEN',
      allowedEmails: parsedEmails,
      allowMultiple: allowMultiple === 'on',
    }
  });
  res.redirect(`/studio/${form.id}/edit`);
});


// ── Publish / unpublish ───────────────────────────────────
router.post('/:id/publish', async (req, res) => {
  const form = await prisma.form.findFirst({
    where: { id: req.params.id, userId: req.session.user.id }
  });
  if (!form) return res.status(404).render('404');

  const fields = Array.isArray(form.fields) ? form.fields : [];
  if (fields.length === 0 && !form.isPublished)
    return res.redirect(`/studio/${form.id}/edit?error=Add+at+least+one+field+before+publishing`);

  await prisma.form.update({
    where: { id: form.id },
    data: { isPublished: !form.isPublished }
  });
  res.redirect(`/studio/${form.id}/edit`);
});

// ── Delete form ───────────────────────────────────────────
router.post('/:id/delete', async (req, res) => {
  await prisma.form.deleteMany({
    where: { id: req.params.id, userId: req.session.user.id }
  });
  res.redirect('/studio');
});

// ── Responses ─────────────────────────────────────────────
router.get('/:id/responses', async (req, res) => {
  const form = await prisma.form.findFirst({
    where: { id: req.params.id, userId: req.session.user.id },
    include: { responses: { orderBy: { submittedAt: 'desc' } } }
  });
  if (!form) return res.status(404).render('404');
  res.render('studio/responses', { form });
});

// ── Delete single response ────────────────────────────────
router.post('/:id/responses/:rid/delete', async (req, res) => {
  await prisma.response.deleteMany({
    where: { id: req.params.rid, formId: req.params.id }
  });
  res.redirect(`/studio/${req.params.id}/responses`);
});


// ── Export responses to Excel ─────────────────────────────
router.get('/:id/responses/export', async (req, res) => {
  const form = await prisma.form.findFirst({
    where: { id: req.params.id, userId: req.session.user.id },
    include: { responses: { orderBy: { submittedAt: 'desc' } } }
  });
  if (!form) return res.status(404).render('404');

  const fields = Array.isArray(form.fields) ? form.fields : [];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Formaker';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Responses');

  // ── Build columns ────────────────────────────────────────
  const columns = [
    { header: 'Submitted At',    key: 'submittedAt',    width: 22 },
    { header: 'Submitter Email', key: 'submitterEmail', width: 28 },
    { header: 'Verified',        key: 'isVerified',     width: 10 },
  ];

  fields.forEach(f => {
    columns.push({ header: f.label, key: f.id, width: 24 });
  });

  sheet.columns = columns;

  // ── Style header row ─────────────────────────────────────
  const headerRow = sheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border    = {
      bottom: { style: 'thin', color: { argb: 'FF4f46e5' } }
    };
  });
  headerRow.height = 20;

  // ── Add data rows ────────────────────────────────────────
  form.responses.forEach((r, i) => {
    const row = {
      submittedAt:    new Date(r.submittedAt).toLocaleString(),
      submitterEmail: r.submitterEmail || '—',
      isVerified:     r.isVerified ? 'Yes' : 'No',
    };

    fields.forEach(f => {
      const val = r.data[f.id];
      row[f.id] = Array.isArray(val) ? val.join(', ') : (val || '—');
    });

    const dataRow = sheet.addRow(row);

    // alternate row shading
    if (i % 2 === 0) {
      dataRow.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
      });
    }

    // color verified column
    const verifiedCell = dataRow.getCell('isVerified');
    verifiedCell.font = {
      bold: true,
      color: { argb: r.isVerified ? 'FF198754' : 'FFDC3545' }
    };
  });

  // ── Freeze header row ────────────────────────────────────
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Send file ────────────────────────────────────────────
  const filename = `${form.title.replace(/[^a-z0-9]/gi, '_')}_responses.xlsx`;

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;