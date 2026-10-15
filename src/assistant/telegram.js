/**
 * Minimal Telegram Bot API client. Messages are fetched by long polling (getUpdates),
 * so no webhook needs registering. Use a bot of its own: two programs polling the same
 * bot take each other's messages.
 */
const MAX_LENGTH = 4000; // Telegram allows 4096 characters per message

/** Split long text into messages, at line breaks where possible. */
export function chunks(text, max = MAX_LENGTH) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

export function createTelegram({ token, fetchImpl = fetch }) {
  async function call(method, body, timeoutMs = 30_000) {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  }

  return {
    /** Plain text, so nothing the model writes can break Telegram's formatting rules. */
    async send(chatId, text) {
      for (const part of chunks(text)) {
        await call('sendMessage', { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } });
      }
    },
    typing: (chatId) => call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}),
    /** Waits up to `waitSeconds` for new messages. */
    updates: (offset, waitSeconds = 50) => call(
      'getUpdates',
      { offset, timeout: waitSeconds, allowed_updates: ['message'] },
      (waitSeconds + 15) * 1000,
    ),
  };
}
