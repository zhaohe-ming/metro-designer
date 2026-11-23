const configured = require('../config/gallery-admins.json');

// A present environment variable overrides the reviewed server configuration;
// an explicitly empty value disables moderation access.
function resolveGalleryAdmins(environmentValue) {
  const emails = environmentValue === undefined ? configured.emails : environmentValue.split(',');
  return new Set(emails.map(email => email.trim().toLowerCase()).filter(Boolean));
}

module.exports = { resolveGalleryAdmins };
