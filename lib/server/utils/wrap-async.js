// Express 4 does not catch async handler rejections: an unwrapped rejection
// leaves the request hanging forever AND surfaces as an unhandledRejection.
// Every async route handler must go through this.
const wrapAsync = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

module.exports = { wrapAsync };
