require('dotenv').config();
const express = require('express');
const session = require('express-session');
const ConnectPgSimple = require('connect-pg-simple');
const path = require('path');
const { Pool } = require('pg');
const ejsLayouts = require('express-ejs-layouts');
const cookieParser = require('cookie-parser');
const { doubleCsrf } = require('csrf-csrf');

const app = express();
const PgStore = ConnectPgSimple(session);
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

// 1. view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(ejsLayouts);
app.set('layout', 'layout');

// 2. body + static
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 3. cookie parser
app.use(cookieParser(process.env.SESSION_SECRET));

// 4. session — must be before csrf
app.use(session({
  store: new PgStore({ pool: pgPool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true }
}));

// 5. csrf — session is now available
const { doubleCsrfProtection } = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET || process.env.SESSION_SECRET,
  getSessionIdentifier: (req) => req.session.id,
  cookieName: 'x-csrf-token',
  cookieOptions: {
    sameSite: 'strict',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  },
  getCsrfTokenFromRequest: (req) => {
    return req.headers['x-csrf-token']
      || req.body?._csrf
      || req.query?._csrf;
  },
});
app.use(doubleCsrfProtection);

// 6. globals for views — after session and csrf
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken();
  res.locals.user  = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

// 7. routes
app.use('/auth',      require('./src/routes/auth'));
app.use('/account',   require('./src/routes/account'));
app.use('/dashboard', require('./src/routes/dashboard'));
app.use('/email',     require('./src/routes/email'));
app.use('/studio',    require('./src/routes/studio'));
app.use('/form',      require('./src/routes/form'));

app.get('/', (req, res) => res.render('index'));





// 8. csrf error handler
app.use((err, req, res, next) => {
  res.locals.user = req.session?.user || null;
  res.locals.flash = null;
  res.locals.csrfToken = '';
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('error', {
      message: 'Form session expired. Please go back and try again.'
    });
  }
  console.error(err);
  return res.status(500).render('error', {
    message: 'Something went wrong.'
  });
});

// ! 404 Error
app.use((req, res) => {
  res.locals.user = req.session?.user || null;
  res.locals.flash = null;
  res.locals.csrfToken = '';
  res.status(404).render('404');
});

// ! File too big error handle
app.use((err, req, res, next) => {
  res.locals.user      = req.session?.user || null;
  res.locals.flash     = null;
  res.locals.csrfToken = '';

  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).render('error', { message: 'Form session expired. Please go back and try again.' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).render('error', { message: 'File too large. Maximum size is 10MB.' });
  }
  console.error(err);
  return res.status(500).render('error', { message: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));