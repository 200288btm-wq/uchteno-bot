// =====================================================================
// lib/helpers.js — работа с Supabase REST и Telegram API
//
// Изменения этой версии:
//   • убраны console.log с персональными данными (баг 8).
//     В логи Vercel уходили телефоны, имена детей и целые строки клиентов.
//     Осталось только то, что не идентифицирует человека.
//   • убран неиспользуемый клиент supabase-js: все запросы идут
//     прямым fetch к PostgREST. Один способ вместо двух.
//   • sbGet бросает ошибку на не-2xx вместо тихого возврата объекта
//     с полем error — иначе сбой выглядел как «просто нет данных».
// =====================================================================

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('helpers: SUPABASE_URL / SUPABASE_KEY не заданы')
}

const authHeaders = () => ({
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
})

// ── Прямой fetch к Supabase REST API ────────────────────────
export async function sbGet(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: authHeaders(),
  })
  if (!res.ok) {
    throw new Error(`sbGet ${table}: ${res.status}`)
  }
  return res.json()
}

async function sbPost(table, body, prefer = 'return=minimal', params = '') {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}${params ? `?${params}` : ''}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json', 'Prefer': prefer },
    body: JSON.stringify(body),
  })
}

async function sbPatch(table, params, body) {
  return fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function sbDelete(table, params) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'DELETE',
    headers: authHeaders(),
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

// Кнопки подтверждения под напоминанием о занятии.
//
// Занятие в базе не лежит — оно рисуется из расписания направления,
// поэтому id у него нет. Ключ составной: дата + направление +
// подгруппа, и в callback_data он едет целиком. Лимит Телеграма —
// 64 байта, здесь укладываемся примерно в двадцать.
//
// Обе кнопки остаются на месте и после ответа: ребёнок может заболеть
// уже после «придём», и переключить решение должно быть так же легко,
// как принять его. Выбранная помечается галочкой.
export const confirmMenu = (lessonDate, dirId, groupId, chosen = null) => ({
  reply_markup: {
    inline_keyboard: [[
      { text: chosen === 'confirmed' ? '✅ Придём ✓' : '✅ Придём',
        callback_data: `cf:${lessonDate}:${dirId}:${groupId || 0}` },
      { text: chosen === 'declined' ? '❌ Не сможем ✓' : '❌ Не сможем',
        callback_data: `cd:${lessonDate}:${dirId}:${groupId || 0}` },
    ]]
  }
})

export const notifyMenu = (settings) => ({
  reply_markup: {
    inline_keyboard: [
      [{
        text: settings.notify_before_hours > 0
          ? '📅 Напоминания о занятиях: ВКЛ'
          : '📅 Напоминания о занятиях: ВЫКЛ',
        callback_data: 'toggle_reminders',
      }],
    ]
  }
})

// ── Supabase helpers ─────────────────────────────────────────
export async function getStudioByToken(token) {
  const rows = await sbGet('studio_settings', `bot_token=eq.${encodeURIComponent(token)}&limit=1`)
  const settings = rows?.[0]
  if (!settings) return null
  const studios = await sbGet('studios', `id=eq.${settings.studio_id}&limit=1`)
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
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits || digits.length < 9) return null
  const tail = digits.slice(-9)
  const clients = await sbGet('clients', `studio_id=eq.${studioId}&select=id,child_name,contacts`)
  if (!clients) return null
  return clients.find(c =>
    (c.contacts || []).some(contact =>
      (contact.val || '').replace(/\D/g, '').endsWith(tail)
    )
  )
}

export async function getClientBalance(studioId, clientId) {
  const clientRows = await sbGet('clients', `id=eq.${clientId}&limit=1`)
  const client = clientRows?.[0]
  const payments = await sbGet('payments', `client_id=eq.${clientId}&studio_id=eq.${studioId}`)

  // Дата студии, а не UTC: в UTC+5 ночью toISOString() отдал бы вчера
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yekaterinburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())

  const paidFromPayments = (payments || [])
    .filter(p => !p.expires_at || p.expires_at >= today)
    .reduce((s, p) => s + (+p.lessons_count || 0), 0)

  const totalPaid = (client?.paid_lessons || 0) + paidFromPayments
  const totalVisited = client?.visited_lessons || 0

  return { client, payments: payments || [], totalPaid, totalVisited, balance: totalPaid - totalVisited }
}

// ── Pending registration ─────────────────────────────────────
export async function getPendingReg(telegramId) {
  const rows = await sbGet('bot_pending_registration', `telegram_id=eq.${telegramId}&limit=1`)
  return rows?.[0] || null
}

export async function setPendingReg(telegramId, studioId) {
  await sbPost('bot_pending_registration', {
    telegram_id: telegramId, studio_id: studioId, step: 'phone',
    created_at: new Date().toISOString(),   // timestamptz — UTC здесь правильный
  }, 'resolution=merge-duplicates')
}

export async function deletePendingReg(telegramId) {
  await sbDelete('bot_pending_registration', `telegram_id=eq.${telegramId}`)
}

// ── client_telegram ──────────────────────────────────────────
export async function upsertClientTelegram(data) {
  await sbPost('client_telegram', data, 'resolution=merge-duplicates')
}

export async function updateClientTelegram(studioId, telegramId, data) {
  await sbPatch('client_telegram', `studio_id=eq.${studioId}&telegram_id=eq.${telegramId}`, data)
}

export async function getClientTelegramSettings(studioId, telegramId) {
  const rows = await sbGet('client_telegram', `studio_id=eq.${studioId}&telegram_id=eq.${telegramId}&limit=1`)
  return rows?.[0] || null
}

export async function insertNotificationLog(data) {
  await sbPost('bot_notifications_log', data)
}

// ── Подтверждение занятия ────────────────────────────────────
// Пишем через upsert по уникальному ключу «клиент + дата +
// направление + подгруппа»: передумал — строка переписывается,
// а не заводится вторая.
//
// Ответ РАЗБИРАЕТСЯ. PostgREST на отказ возвращает не-2xx молча,
// и без проверки родитель увидел бы «записали» там, где ничего не
// сохранилось — худший вид поломки: обещание, которого нет в базе.
export async function saveConfirmation({ studioId, clientId, lessonDate, directionId, groupId, status, source = 'telegram' }) {
  const res = await sbPost('lesson_confirmations', {
    studio_id: studioId,
    client_id: clientId,
    lesson_date: lessonDate,
    direction_id: directionId,
    group_id: groupId || 0,
    status,
    source,
    updated_at: new Date().toISOString(),
  }, 'resolution=merge-duplicates', 'on_conflict=client_id,lesson_date,direction_id,group_id')

  if (!res.ok) {
    throw new Error(`saveConfirmation: ${res.status} ${await res.text()}`)
  }
}