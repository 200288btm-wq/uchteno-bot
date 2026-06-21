import { createClient } from '@supabase/supabase-js'

console.log('SUPABASE_URL:', process.env.SUPABASE_URL?.slice(0, 30))
console.log('SUPABASE_KEY exists:', !!process.env.SUPABASE_KEY)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ── Прямой fetch к Supabase REST API ────────────────────────
export async function sbGet(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  })
  return res.json()
}

async function sbPost(table, body, upsert = false) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': upsert ? 'resolution=merge-duplicates' : 'return=minimal'
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${upsert ? '?on_conflict=' : ''}`, {
    method: upsert ? 'POST' : 'POST',
    headers,
    body: JSON.stringify(body)
  })
  return res
}

async function sbPatch(table, params, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  })
  return res
}

async function sbDelete(table, params) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  })
}

// ── Telegram API ─────────────────────────────────────────────
export async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

export async function sendMessage(token, chat_id, text, extra = {}) {
  return tg(token, 'sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra })
}

// ── Keyboards ────────────────────────────────────────────────
export const mainMenu = (bookingUrl) => ({
  reply_markup: {
    keyboard: [
      [{ text: '👤 Моя информация' }, { text: '💳 Оплаты и баланс' }],
      [{ text: '📅 Мои посещения' }, { text: '🔔 Настройки уведомлений' }],
      ...(bookingUrl ? [[{ text: '📝 Онлайн-запись' }]] : []),
    ],
    resize_keyboard: true,
  }
})

export const notifyMenu = (settings) => ({
  reply_markup: {
    inline_keyboard: [
      [{ text: settings.notify_low_balance ? '🔔 Мало занятий: ВКЛ' : '🔕 Мало занятий: ВЫКЛ', callback_data: 'toggle_low_balance' }],
      [
        { text: '⏰ За 1 час', callback_data: 'notify_1h' },
        { text: '⏰ За 2 часа', callback_data: 'notify_2h' },
        { text: '⏰ За 3 часа', callback_data: 'notify_3h' },
      ],
      [
        { text: '⏰ За 1 день', callback_data: 'notify_24h' },
        { text: '⏰ За 2 дня', callback_data: 'notify_48h' },
        { text: '❌ Не напоминать', callback_data: 'notify_0' },
      ],
    ]
  }
})

// ── Supabase helpers ─────────────────────────────────────────
export async function getStudioByToken(token) {
  const rows = await sbGet('studio_settings', `bot_token=eq.${encodeURIComponent(token)}&limit=1`)
  const settings = rows?.[0]
  if (!settings) return null
  console.log('studio_id from settings:', settings.studio_id)
  const studios = await sbGet('studios', `id=eq.${settings.studio_id}&limit=1`)
  console.log('studios result:', JSON.stringify(studios))
  settings.studios = studios?.[0] || null
  return settings
}

export async function getClientByTelegram(studioId, telegramId) {
  const rows = await sbGet('client_telegram', `studio_id=eq.${studioId}&telegram_id=eq.${telegramId}&limit=1`)
  const row = rows?.[0]
  if (!row) return null
  const clients = await sbGet('clients', `id=eq.${row.client_id}&limit=1`)
  row.clients = clients?.[0] || null
  return row
}

export async function findClientByPhone(studioId, phone) {
  const digits = phone.replace(/\D/g, '')
  const clients = await sbGet('clients', `studio_id=eq.${studioId}`)
  if (!clients) return null
  return clients.find(c => {
    const contacts = c.contacts || []
    return contacts.some(contact => {
      const cDigits = (contact.val || '').replace(/\D/g, '')
      return cDigits.endsWith(digits.slice(-9))
    })
  })
}

export async function getClientBalance(studioId, clientId) {
  const today = new Date().toISOString().slice(0, 10)
  const clientRows = await sbGet('clients', `id=eq.${clientId}&limit=1`)
  const client = clientRows?.[0]
  const payments = await sbGet('payments', `client_id=eq.${clientId}&studio_id=eq.${studioId}`)

  const paidFromPayments = (payments || [])
    .filter(p => !p.expires_at || p.expires_at >= today)
    .reduce((s, p) => s + (+p.lessons_count || 0), 0)

  const totalPaid = (client?.paid_lessons || 0) + paidFromPayments
  const totalVisited = client?.visited_lessons || 0
  const balance = totalPaid - totalVisited

  return { client, payments: payments || [], totalPaid, totalVisited, balance }
}

// ── Pending registration ─────────────────────────────────────
export async function getPendingReg(telegramId) {
  const rows = await sbGet('bot_pending_registration', `telegram_id=eq.${telegramId}&limit=1`)
  return rows?.[0] || null
}

export async function setPendingReg(telegramId, studioId) {
  await fetch(`${SUPABASE_URL}/rest/v1/bot_pending_registration`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ telegram_id: telegramId, studio_id: studioId, step: 'phone', created_at: new Date().toISOString() })
  })
}

export async function deletePendingReg(telegramId) {
  await sbDelete('bot_pending_registration', `telegram_id=eq.${telegramId}`)
}

// ── upsert client_telegram ───────────────────────────────────
export async function upsertClientTelegram(data) {
  await fetch(`${SUPABASE_URL}/rest/v1/client_telegram`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(data)
  })
}

export async function updateClientTelegram(studioId, telegramId, data) {
  await sbPatch('client_telegram', `studio_id=eq.${studioId}&telegram_id=eq.${telegramId}`, data)
}

export async function getClientTelegramSettings(studioId, telegramId) {
  const rows = await sbGet('client_telegram', `studio_id=eq.${studioId}&telegram_id=eq.${telegramId}&limit=1`)
  return rows?.[0] || null
}

export async function insertNotificationLog(data) {
  await fetch(`${SUPABASE_URL}/rest/v1/bot_notifications_log`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data)
  })
}
