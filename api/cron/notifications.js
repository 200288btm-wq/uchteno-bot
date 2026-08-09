// =====================================================================
// api/cron/notifications.js — ежедневные уведомления родителям
//
// Что чинит эта версия (баги 5–9 из STATE.md):
//   5. Напоминания о занятиях фильтровались по notify_low_balance,
//      а тумблер в боте пишет notify_before_hours. Тумблер не работал.
//   6. Уведомление о балансе уходило только при остатке ровно 1.
//      Теперь: 1, 0 и минус (занятия в долг) — с разными текстами.
//   7. Убран join studio_settings!inner. Внешнего ключа между
//      client_telegram и studio_settings нет, PostgREST на !inner
//      отдавал пусто — крон, скорее всего, не работал ни разу.
//      Настройки студий грузятся отдельным запросом и кладутся в Map.
//   8. Даты считаются в поясе студии, а не в UTC.
//   9. Ошибка по одному родителю больше не роняет всю рассылку.
// =====================================================================

import { sbGet, sendMessage, insertNotificationLog } from '../../lib/helpers.js'

const DAYS_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

// Местная дата студии. toISOString() отдал бы UTC — в UTC+5 это вчера.
function localToday(tz = 'Asia/Yekaterinburg') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

function shiftDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)   // дата собрана в UTC — сдвига нет
}

const weekdayRu = (isoDate) => {
  const [y, m, d] = isoDate.split('-').map(Number)
  return DAYS_RU[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

// ── Общая подготовка: привязки + настройки студий ────────────────────
async function loadContext() {
  const links = await sbGet('client_telegram', 'select=*')
  if (!Array.isArray(links) || !links.length) return { links: [], studios: new Map(), clients: new Map() }

  const studioIds = [...new Set(links.map(l => l.studio_id).filter(Boolean))]
  const clientIds = [...new Set(links.map(l => l.client_id).filter(Boolean))]

  const settings = studioIds.length
    ? await sbGet('studio_settings', `studio_id=in.(${studioIds.join(',')})&select=studio_id,bot_token,timezone`)
    : []
  const clients = clientIds.length
    ? await sbGet('clients', `id=in.(${clientIds.join(',')})&select=*`)
    : []

  return {
    links,
    studios: new Map((settings || []).map(s => [s.studio_id, s])),
    clients: new Map((clients || []).map(c => [c.id, c])),
  }
}

// Уже отправляли такое? Журнал общий на все типы.
async function alreadySent(clientId, type, referenceId) {
  const rows = await sbGet(
    'bot_notifications_log',
    `client_id=eq.${clientId}&type=eq.${type}&reference_id=eq.${encodeURIComponent(referenceId)}&limit=1`
  )
  return Array.isArray(rows) && rows.length > 0
}

// ── Остаток занятий ──────────────────────────────────────────────────
async function checkLowBalance(ctx, stats) {
  for (const row of ctx.links) {
    if (row.notify_low_balance !== true) continue

    const studio = ctx.studios.get(row.studio_id)
    const client = ctx.clients.get(row.client_id)
    if (!studio?.bot_token || !client) continue

    try {
      const today = localToday(studio.timezone)

      const payments = await sbGet(
        'payments',
        `client_id=eq.${client.id}&studio_id=eq.${row.studio_id}&select=lessons_count,expires_at`
      )
      const active = (payments || []).filter(p => !p.expires_at || p.expires_at >= today)
      const paid = active.reduce((s, p) => s + (+p.lessons_count || 0), 0)
      const balance = (client.paid_lessons || 0) + paid - (client.visited_lessons || 0)

      if (balance > 1) continue

      // Абонемент изначально на одно занятие — предупреждать не о чем
      const maxLessons = active.reduce((max, p) => Math.max(max, +p.lessons_count || 0), 0)
      if (balance === 1 && maxLessons <= 1) continue

      const refId = today
      if (await alreadySent(client.id, 'low_balance', refId)) continue

      const text = balance === 1
        ? `⚠️ <b>Осталось последнее занятие</b>\n\nУ ${client.child_name} в абонементе остался <b>1 урок</b>.\nСамое время продлить 😊`
        : balance === 0
          ? `⚠️ <b>Занятия закончились</b>\n\nУ ${client.child_name} в абонементе не осталось уроков.\nЧтобы не пропустить следующее занятие, продлите абонемент 😊`
          : `⚠️ <b>Занятия идут в минус</b>\n\nУ ${client.child_name} посещений больше, чем оплачено: <b>${Math.abs(balance)}</b>.\nПожалуйста, свяжитесь с администратором студии.`

      await sendMessage(studio.bot_token, row.telegram_id, text)
      await insertNotificationLog({
        studio_id: row.studio_id, client_id: client.id,
        telegram_id: row.telegram_id, type: 'low_balance', reference_id: refId,
      })
      stats.low_balance++
    } catch (e) {
      // Один упавший родитель не должен обрывать рассылку остальным
      stats.errors.push(`low_balance/link ${row.id}: ${e.message}`)
    }
  }
}

// ── Напоминания о занятиях ───────────────────────────────────────────
async function checkLessonReminders(ctx, stats) {
  for (const row of ctx.links) {
    // Тумблер в боте пишет именно сюда. Раньше фильтр смотрел не в то поле.
    if (!(row.notify_before_hours > 0)) continue

    const studio = ctx.studios.get(row.studio_id)
    const client = ctx.clients.get(row.client_id)
    if (!studio?.bot_token || !client) continue

    try {
      const dirIds = client.direction_ids || []
      if (!dirIds.length) continue

      const today = localToday(studio.timezone)
      const tomorrow = shiftDays(today, 1)

      const directions = await sbGet(
        'directions',
        `studio_id=eq.${row.studio_id}&id=in.(${dirIds.join(',')})&select=id,name,groups:direction_groups(id,schedule)`
      )
      if (!directions?.length) continue

      for (const checkDate of [today, tomorrow]) {
        const dayRu = weekdayRu(checkDate)
        const label = checkDate === today ? 'Сегодня' : 'Завтра'

        for (const dir of directions) {
          for (const group of (dir.groups || [])) {
            const schedule = (group.schedule || '').toLowerCase()
            if (!schedule.includes(dayRu)) continue

            const timeMatch = schedule.match(/(\d{1,2}):(\d{2})/)
            const timeStr = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : ''
            const refId = `${checkDate}_${dir.id}_${group.id}_morning`

            if (await alreadySent(client.id, 'lesson_reminder', refId)) continue

            await sendMessage(studio.bot_token, row.telegram_id,
              `📚 <b>${label} занятие</b>\n\n` +
              `${label}${timeStr ? ` в <b>${timeStr}</b>` : ''} у <b>${client.child_name}</b>:\n` +
              `<b>${dir.name}</b>`
            )
            await insertNotificationLog({
              studio_id: row.studio_id, client_id: client.id,
              telegram_id: row.telegram_id, type: 'lesson_reminder', reference_id: refId,
            })
            stats.lesson_reminder++
          }
        }
      }
    } catch (e) {
      stats.errors.push(`lesson_reminder/link ${row.id}: ${e.message}`)
    }
  }
}

// ── Точка входа ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const stats = { low_balance: 0, lesson_reminder: 0, errors: [] }
  try {
    const ctx = await loadContext()
    await checkLowBalance(ctx, stats)
    await checkLessonReminders(ctx, stats)
    // В логах Vercel только счётчики — ни имён, ни телефонов
    console.log('notifications:', JSON.stringify({ ...stats, errors: stats.errors.length }))
    res.json({ ok: true, ...stats })
  } catch (e) {
    console.error('Notifications failed:', e.message)
    res.status(500).json({ error: 'internal' })
  }
}
