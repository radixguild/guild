// grammy API transformer: no link-preview cards unless a caller asks for one.
//
// Nearly every reply carries a radixguild.com link, and Telegram turned each into
// a large card under the message — a wall of identical previews in a chat that is
// meant to be quick to read (seen 2026-09-20: the card image did not even load).
function noLinkPreview(prev, method, payload, signal) {
  if ((method === "sendMessage" || method === "editMessageText") && payload && payload.link_preview_options === undefined) {
    payload.link_preview_options = { is_disabled: true };
  }
  return prev(method, payload, signal);
}

module.exports = { noLinkPreview };
