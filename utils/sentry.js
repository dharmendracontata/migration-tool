const Sentry = require("@sentry/node");

const isEnabled = !!process.env.SENTRY_DSN;

if (isEnabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
  });
  Sentry.configureScope((scope) => {
    scope.setTag("project", "migration-tool");
  });
  console.log("ℹ️ Sentry error logging initialized.");
}

module.exports = {
  Sentry,
  isEnabled,
  captureException(err, context = {}) {
    if (isEnabled) {
      Sentry.withScope((scope) => {
        if (context.tags) {
          Object.entries(context.tags).forEach(([k, v]) => {
            scope.setTag(k, String(v));
          });
        }
        if (context.extra) {
          Object.entries(context.extra).forEach(([k, v]) => {
            scope.setExtra(k, v);
          });
        }
        Sentry.captureException(err);
      });
    }
  },
  captureMessage(message, level = "info", context = {}) {
    if (isEnabled) {
      Sentry.withScope((scope) => {
        scope.setLevel(level);
        if (context.tags) {
          Object.entries(context.tags).forEach(([k, v]) => {
            scope.setTag(k, String(v));
          });
        }
        if (context.extra) {
          Object.entries(context.extra).forEach(([k, v]) => {
            scope.setExtra(k, v);
          });
        }
        Sentry.captureMessage(message);
      });
    }
  },
  addBreadcrumb(category, message, level = "info", data = {}) {
    if (isEnabled) {
      Sentry.addBreadcrumb({
        category,
        message,
        level,
        data
      });
    }
  }
};
