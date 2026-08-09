// =====================================================================
// api/set-webhook.js — регистрирует вебхук для токена бота студии
//
// Было (баг 9): CORS '*', никакой проверки — эндпоинт работал открытым
// прокси к Telegram API для любого токена и с любого сайта.
//
// Стало:
//   • CORS только для наших доменов
//   • токен обязан существовать в studio_settings.bot_token,
//     то есть принадлежать зарегистрированной студии
//   • в ответ и в логи не попадает сам токен
//
// Секрет в браузер не положить: VITE_-переменные публичны (LEARNINGS).
// Поэтому опорой служит проверка по базе, а не общий пароль.
// =====================================================================

const ALLOWED_ORIGINS = [
  'https://uchteno.com',
  'https://www.uchteno.com',
  'https://panda-crm.vercel.app',
  'https://crm-panda-200288btm.amvera.io',
  'http://localhost:5173',
]

export default async function handler(req, res) {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, description: 'Method not allowed' })

  const { token } = req.body || {}
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ ok: false, description: 'Токен не передан' })
  }

  // Токен должен принадлежать студии из нашей базы
  try {
    const check = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/studio_settings` +
      `?bot_token=eq.${encodeURIComponent(token)}&select=studio_id&limit=1`,
      {
        headers: {
          'apikey': process.env.SUPABASE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        },
      }
    )
    const rows = await check.json()
    if (!Array.isArray(rows) || rows.length === 0) {
      // Сначала сохраните токен в настройках студии, потом жмите кнопку
      return res.status(403).json({ ok: false, description: 'Сначала сохраните токен в настройках студии, потом нажмите «Подключить»' })
    }
  } catch (e) {
    console.error('set-webhook: проверка токена не удалась:', e.message)
    return res.status(500).json({ ok: false, description: 'Не удалось проверить токен, попробуйте ещё раз' })
  }

  const botServiceUrl = process.env.BOT_SERVICE_URL || 'https://uchteno-bot.vercel.app'
  const webhookUrl = `${botServiceUrl}/api/webhook/${token}`

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    })
    const data = await response.json()
    return res.json({ ok: !!data.ok, description: data.description || null })
  } catch (e) {
    console.error('set-webhook: Telegram недоступен:', e.message)
    return res.status(502).json({ ok: false, description: 'Telegram недоступен, попробуйте позже' })
  }
}
