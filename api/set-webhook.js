// api/set-webhook.js — регистрирует вебхук для переданного токена бота
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'token required' })

  const botServiceUrl = process.env.BOT_SERVICE_URL || 'https://uchteno-bot.vercel.app'
  const webhookUrl = `${botServiceUrl}/api/webhook/${token}`

  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl }),
  })

  const data = await response.json()
  return res.json(data)
}
