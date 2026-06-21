import { createClient } from '@supabase/supabase-js'

console.log('SUPABASE_URL:', process.env.SUPABASE_URL?.slice(0, 30))
console.log('SUPABASE_KEY exists:', !!process.env.SUPABASE_KEY)

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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
  const { data, error } = await supabase
    .from('studio_settings')
    .select('*, studios(id, name)')
    .eq('bot_token', token)
    .maybeSingle()
  console.log('getStudioByToken result:', JSON.stringify({ data, error }))
  return data
}

export async function getClientByTelegram(studioId, telegramId) {
  const { data } = await supabase
    .from('client_telegram')
    .select('*, clients(*)')
    .eq('studio_id', studioId)
    .eq('telegram_id', telegramId)
    .maybeSingle()
  return data
}

export async function findClientByPhone(studioId, phone) {
  const digits = phone.replace(/\D/g, '')
  const { data: clients } = await supabase
    .from('clients')
    .select('*')
    .eq('studio_id', studioId)
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
  const { data: client } = await supabase.from('clients').select('*').eq('id', clientId).single()
  const { data: payments } = await supabase.from('payments')
    .select('*').eq('client_id', clientId).eq('studio_id', studioId)

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
  const { data } = await supabase
    .from('bot_pending_registration')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle()
  return data
}

export async function setPendingReg(telegramId, studioId) {
  await supabase.from('bot_pending_registration').upsert({
    telegram_id: telegramId,
    studio_id: studioId,
    step: 'phone',
    created_at: new Date().toISOString(),
  }, { onConflict: 'telegram_id' })
}

export async function deletePendingReg(telegramId) {
  await supabase.from('bot_pending_registration').delete().eq('telegram_id', telegramId)
}
