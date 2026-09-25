const { isValidEmail } = require('../utils/email');
function passengerSupport(env = process.env) {
  const phone = env.SUPPORT_PHONE?.trim() || null;
  const email = env.SUPPORT_EMAIL?.trim() || null;
  const url = env.CHATBOT_URL?.trim() || null;
  if (phone && !/^\+?[0-9 ()-]{5,30}$/.test(phone)) throw new Error('Invalid SUPPORT_PHONE');
  if (email && !isValidEmail(email)) throw new Error('Invalid SUPPORT_EMAIL');
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Invalid CHATBOT_URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('CHATBOT_URL must be an HTTPS URL without credentials');
  }
  return {
    contactUs: { available: Boolean(phone || email), phone, email },
    chatbot: { enabled: Boolean(url), label: 'Chat with us', icon: 'chat', url },
  };
}
module.exports = { passengerSupport };
