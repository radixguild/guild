// Escape a value for Telegram's parse_mode "HTML".
// Telegram needs & < > escaped in text; " is escaped too so a value is also safe
// inside an attribute. null/undefined become "". Escape at the point of
// interpolation, once — never feed an already-escaped string back in.

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { escapeHtml };
