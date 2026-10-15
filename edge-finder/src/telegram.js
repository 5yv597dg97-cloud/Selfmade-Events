// Minimal Telegram Bot API client. The scheduled job polls for button taps and
// commands with getUpdates, so no webhook or always-on server is needed.
// Telegram keeps unread updates for 24 hours, longer than the gap between runs.

export function telegram({ token, chatId, fetchImpl = fetch }) {
  async function call(method, body) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  }

  return {
    chatId: String(chatId),
    send(text, { buttons, replyTo } = {}) {
      return call('sendMessage', {
        chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(buttons && { reply_markup: { inline_keyboard: buttons } }),
        ...(replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
      });
    },
    updates: (offset) => call('getUpdates', { offset, timeout: 0, allowed_updates: ['message', 'callback_query'] }),
    // Both of these fail harmlessly on old messages and expired taps, so errors are ignored.
    removeButtons: (messageId) => call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {}),
    answer: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {}),
  };
}

/** Escapes text for Telegram's HTML parse mode. */
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
