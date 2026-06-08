function requireAuth(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: 'danger', message: 'Please log in first.' };
    return res.redirect('/auth/login');
  }
  next();
}

function requireVerified(req, res, next) {
  if (!req.session.user.isVerified) {
    req.session.flash = { type: 'warning', message: 'Please verify your email first.' };
    return res.redirect('/auth/request-verify');
  }
  next();
}

function redirectIfAuth(req, res, next) {
  if (req.session.user) return res.redirect('/dashboard');
  next();
}

module.exports = { requireAuth, requireVerified, redirectIfAuth };