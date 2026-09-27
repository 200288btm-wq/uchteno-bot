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

// Вызов функции базы (PostgREST /rpc). Бросает на не-2xx, как sbGet:
// молчаливая пустота на сбое читалась бы как «занятий нет».
//
// Supabase отдаёт не больше 1000 строк за запрос и молча обрезает
// остальное. Поэтому просим посчитать всё (count=exact) и сверяем:
// не сошлось — бросаем, а не шлём напоминания половине детей.
export async function sbRpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json', 'Prefer': 'count=exact' },
    body: JSON.stringify(args),
  })
  if (!res.ok) {
    throw new Error(`sbRpc ${fn}: ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  const total = Number(String(res.headers.get('content-range') || '').split('/')[1])
  if (Array.isArray(data) && Number.isFinite(total) && data.length < total) {
    throw new Error(`sbRpc ${fn}: пришло ${data.length} строк из ${total} — ответ обрезан`)
  }
  return data
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

// ── Дата в поясе студии ──────────────────────────────────────
// Одна на весь бот: раньше крон считал по поясу студии, а раздел
// «Оплаты и баланс» — по зашитому Екатеринбургу (баг 45), и родитель
// мог увидеть один остаток, а предупреждение получить по другому.
// toISOString() здесь не годится: он отдаёт UTC, в UTC+5 это вчера.
export const DEFAULT_TIMEZONE = 'Asia/Yekaterinburg'   // то же умолчание, что у колонки в базе

export function localToday(tz = DEFAULT_TIMEZONE) {
  let fmt
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch {
    // Кривой пояс в настройках не должен ронять бота
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
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

// Возвращает ответ Телеграма как есть: { ok: true, result } или
// { ok: false, error_code, description }. Не бросает — в диалоге с
// родителем упавший ответ не должен ронять весь вебхук. Крон ответ
// ПРОВЕРЯЕТ: «отправлено» там должно значить «Телеграм принял».
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

export async function getClientBalance(studioId, clientId, timezone) {
  const clientRows = await sbGet('clients', `id=eq.${clientId}&limit=1`)
  const client = clientRows?.[0]
  const payments = await sbGet('payments', `client_id=eq.${clientId}&studio_id=eq.${studioId}`)

  // Дата СТУДИИ: пояс из её настроек, а не зашитый (баг 45)
  const today = localToday(timezone)

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

// ── Журнал рассылки: СНАЧАЛА запись, потом отправка (баг 57) ──────
//
// Раньше было наоборот: сообщение уходило, потом писался журнал, и ответ
// журнала не проверялся. Упала запись (сеть, права) — следующий запуск
// крона слал родителю то же самое второй раз.
//
// Теперь строка журнала — это «занял слот». Уникальный индекс
// (client_id, type, reference_id) пускает её ровно один раз, даже если
// два запуска крона пересеклись. Кто не смог занять — не отправляет.
//
// Возвращает true, если слот наш; false — такое уже отправляли (или
// отправляет параллельный запуск). Сбой базы — исключение: без журнала
// не шлём, иначе вернулся бы тот же дубль.
export const LOG_CONFLICT = 'client_id,type,reference_id'

export async function claimNotification(data) {
  const res = await sbPost('bot_notifications_log', data,
    'return=representation,resolution=ignore-duplicates', `on_conflict=${LOG_CONFLICT}`)
  if (!res.ok) {
    throw new Error(`claimNotification: ${res.status} ${await res.text()}`)
  }
  const rows = await res.json()
  return Array.isArray(rows) && rows.length > 0
}

// Отдать слот обратно — только когда ТОЧНО известно, что сообщение
// не ушло (Телеграм ответил ok: false). Тогда следующий запуск попробует
// снова. Если неизвестно (оборвалась сеть посреди запроса), слот держим:
// лишний раз промолчать лучше, чем прислать дубль.
export async function releaseNotification({ client_id, type, reference_id }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bot_notifications_log?client_id=eq.${client_id}&type=eq.${encodeURIComponent(type)}&reference_id=eq.${encodeURIComponent(reference_id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) {
    throw new Error(`releaseNotification: ${res.status}`)
  }
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