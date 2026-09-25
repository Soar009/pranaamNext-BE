function isValidEmail(value) {
  return typeof value === 'string' && value.trim().length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
module.exports = { isValidEmail };
