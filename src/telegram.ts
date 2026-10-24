import { sleep } from "./http.ts";

interface TelegramResponse {
  ok: boolean;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TelegramTarget {
  token: string;
  chatId: string;
}

export async function sendMessage(
  target: TelegramTarget,
  text: string,
  html: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(`https://api.telegram.org/bot${target.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: target.chatId,
        text,
        ...(html && { parse_mode: "HTML" }),
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = (await res.json()) as TelegramResponse;
    if (body.ok) return;
    if (res.status === 429 && attempt < 3) {
      await sleep((body.parameters?.retry_after ?? 1) * 1000);
      continue;
    }
    throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body.description ?? ""}`.trim());
  }
}

export function telegramTarget(): TelegramTarget | undefined {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  return token && chatId ? { token, chatId } : undefined;
}
