import { supabase, sendMessage } from '../../lib/helpers.js'

async function checkLowBalance() {
  const today = new Date().toISOString().slice(0, 10)
  const { data: linked } = await supabase
    .from('client_telegram')
    .select('*, clients(*), studio_settings!inner(bot_token)')
    .eq('notify_low_balance', true)

  if (!linked) return

  for (const row of linked) {
    const client = row.clients
    const token = row.studio_settings?.bot_token
    if (!token || !client) continue

    const { data: payments } = await supabase.from('payments')
      .select('lessons_count, expires_at').eq('client_id', client.id)
    const paid = (payments || [])
      .filter(p => !p.expires_at || p.expires_at >= today)
      .reduce((s, p) => s + (+p.lessons_count || 0), 0)
    const balance = (client.paid_lessons || 0) + paid - (client.visited_lessons || 0)

    // Не уведомляем если абонемент изначально был на 1 занятие
    const maxLessons = (payments || []).filter(p => !p.expires_at || p.expires_at >= today)
      .reduce((max, p) => Math.max(max, +p.lessons_count || 0), 0)
    if (balance !== 1 || maxLessons <= 1) continue

    const { data: log } = await supabase.from('bot_notifications_log')
      .select('id').eq('client_id', client.id).eq('type', 'low_balance')
      .eq('reference_id', today).maybeSingle()
    if (log) continue

    await sendMessage(token, row.telegram_id,
      `⚠️ <b>Осталось последнее занятие!</b>\n\nУ ${client.child_name} остался <b>1 урок</b> в абонементе.\nНе забудьте пополнить баланс 😊`
    )

    await supabase.from('bot_notifications_log').insert({
      studio_id: row.studio_id, client_id: client.id,
      telegram_id: row.telegram_id, type: 'low_balance', reference_id: today,
    })
  }
}

async function checkLessonReminders() {
  const now = new Date()
  const DAYS_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
  const today = now.toISOString().slice(0, 10)
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const { data: linked } = await supabase
    .from('client_telegram')
    .select('*, clients(*), studio_settings!inner(bot_token, studios(id))')
    .eq('notify_low_balance', true)

  if (!linked) return

  for (const row of linked) {
    const client = row.clients
    const token = row.studio_settings?.bot_token
    const studioId = row.studio_settings?.studios?.id
    if (!token || !client || !studioId) continue

    const { data: directions } = await supabase
      .from('directions')
      .select('*, groups:direction_groups(*)')
      .eq('studio_id', studioId)
      .in('id', client.direction_ids || [])

    if (!directions?.length) continue

    for (const checkDate of [today, tomorrow]) {
      const dayRu = DAYS_RU[new Date(checkDate).getDay()]
      const label = checkDate === today ? 'Сегодня' : 'Завтра'

      for (const dir of directions) {
        for (const group of (dir.groups || [])) {
          const schedule = (group.schedule || '').toLowerCase()
          if (!schedule.includes(dayRu)) continue

          const timeMatch = schedule.match(/(\d{1,2}):(\d{2})/)
          const timeStr = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : ''
          const refId = `${checkDate}_${dir.id}_${group.id}_morning`

          const { data: log } = await supabase.from('bot_notifications_log')
            .select('id').eq('client_id', client.id).eq('type', 'lesson_reminder')
            .eq('reference_id', refId).maybeSingle()
          if (log) continue

          await sendMessage(token, row.telegram_id,
            `📚 <b>${label} занятие!</b>\n\n` +
            `${label} ${timeStr ? `в <b>${timeStr}</b> ` : ''}у <b>${client.child_name}</b>:\n` +
            `<b>${dir.name}</b>`
          )

          await supabase.from('bot_notifications_log').insert({
            studio_id: row.studio_id, client_id: client.id,
            telegram_id: row.telegram_id, type: 'lesson_reminder', reference_id: refId,
          })
        }
      }
    }
  }
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    await checkLowBalance()
    await checkLessonReminders()
    res.json({ ok: true })
  } catch (e) {
    console.error('Notifications error:', e)
    res.status(500).json({ error: e.message })
  }
}
