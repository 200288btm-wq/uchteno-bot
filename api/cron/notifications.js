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
//
// Заход 12, 27.09.2026 — баги 54 и 59:
//  54. Кто на каком занятии, теперь решает функция базы schedule_lessons,
//      а не своя копия правил. Своя копия брала первое время в строке,
//      искала день подстрокой, не видела направлений без подгрупп
//      и слала ребёнку напоминания обо ВСЕХ подгруппах направления.
//  59. Напоминания о занятиях идут, только если студия включила их
//      общим выключателем (studio_settings.lesson_reminders). Тумблер
//      родителя действует внутри него.
//
// Заход 13 — баг 57: журнал пишется ДО отправки (deliver ниже).
// Ответ Телеграма проверяется: счётчик «отправлено» = «Телеграм принял».
// =====================================================================

import { sbGet, sbRpc, sendMessage, claimNotification, releaseNotification, confirmMenu, localToday } from '../../lib/helpers.js'

// Местная дата студии — localToday из lib/helpers.js, одна на весь бот.

function shiftDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)   // дата собрана в UTC — сдвига нет
}

// ── Статус клиента: что он разрешает ─────────────────────────────────
//
// ⚠️ Копия правил из CRM `src/lib/clientStatus.js`. Общий импорт
// недоступен — бот это отдельное приложение на Vercel. При изменении
// модели статусов править ОБА места (как с расчётом баланса).
//
// До 19.08.2026 фильтра по статусу здесь не было вовсе: бот писал всем,
// у кого есть привязка в client_telegram. Ушедший ребёнок продолжал
// получать «у вас закончились занятия» — при том, что в CRM его уже
// убрали в архив и из списка должников он пропал.
//
// Какая галочка что решает:
//   in_stats    — напоминания про остаток и долг (это денежная тема)
//   in_schedule — напоминания «сегодня/завтра занятие»
// «Временно отсутствует» остаётся в расчётах, поэтому про долг ему
// напомнят, а про занятие — нет: в расписании его нет.
const LEGACY_ACTIVE = 'Активен'

function statusAllows(ctx, row, client, flag) {
  const s = ctx.statuses.get(`${row.studio_id}|${client.status}`)
  // Статуса нет в справочнике (импорт, старые записи) — ведём себя так
  // же, как CRM: такой клиент не в расписании и не в расчётах.
  if (!s) return client.status === LEGACY_ACTIVE
  return s[flag] === true
}

// ── Общая подготовка: привязки + настройки студий ────────────────────
async function loadContext() {
  const links = await sbGet('client_telegram', 'select=*')
  if (!Array.isArray(links) || !links.length) {
    return { links: [], studios: new Map(), clients: new Map(), statuses: new Map() }
  }

  const studioIds = [...new Set(links.map(l => l.studio_id).filter(Boolean))]
  const clientIds = [...new Set(links.map(l => l.client_id).filter(Boolean))]

  const settings = studioIds.length
    ? await sbGet('studio_settings', `studio_id=in.(${studioIds.join(',')})&select=studio_id,bot_token,timezone,lesson_reminders`)
    : []
  const clients = clientIds.length
    ? await sbGet('clients', `id=in.(${clientIds.join(',')})&select=*`)
    : []
  const statuses = studioIds.length
    ? await sbGet('client_statuses', `studio_id=in.(${studioIds.join(',')})&select=studio_id,name,in_schedule,in_stats`)
    : []

  return {
    links,
    studios: new Map((settings || []).map(s => [s.studio_id, s])),
    clients: new Map((clients || []).map(c => [c.id, c])),
    // Ключ со studio_id: названия статусов у студий свои и совпадают
    statuses: new Map((statuses || []).map(s => [`${s.studio_id}|${s.name}`, s])),
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

// ── Отправка одного уведомления (баг 57) ─────────────────────────────
//
// 1. Занять строку журнала. Не заняли — уже отправляли: молчим.
// 2. Отправить.
// 3. Телеграм ответил ok: false (заблокировал бота, неверный чат) —
//    сообщение точно не ушло: слот отдаём, следующий запуск попробует снова.
//    Оборвалась сеть и ответа нет — неизвестно, дошло ли: слот держим.
//
// force (?force=1) — проверка на себе: шлём, даже если слот занят.
// Возвращает 'sent' | 'already' и бросает на сбое.
async function deliver(log, send, opts) {
  const mine = await claimNotification(log)
  if (!mine && !opts.force) return 'already'

  let r
  try {
    r = await send()
  } catch (e) {
    throw new Error(`не знаем, дошло ли (слот оставлен): ${e.message}`)
  }
  if (!r?.ok) {
    if (mine) await releaseNotification(log)
    throw new Error(`Телеграм не принял: ${r?.error_code || '?'} ${r?.description || ''}`.trim())
  }
  return 'sent'
}

// ── Остаток занятий ──────────────────────────────────────────────────
async function checkLowBalance(ctx, stats, opts) {
  for (const row of ctx.links) {
    if (opts.only && String(row.telegram_id) !== opts.only) continue
    if (row.notify_low_balance !== true) continue

    const studio = ctx.studios.get(row.studio_id)
    const client = ctx.clients.get(row.client_id)
    if (!studio?.bot_token || !client) continue

    // Архивный из списка должников в CRM пропал — значит и писать ему
    // про долг больше некому и незачем
    if (!statusAllows(ctx, row, client, 'in_stats')) { stats.skipped_status++; continue }

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
      if (!opts.force && await alreadySent(client.id, 'low_balance', refId)) continue

      const text = balance === 1
        ? `⚠️ <b>Осталось последнее занятие</b>\n\nУ ${client.child_name} в абонементе остался <b>1 урок</b>.\nСамое время продлить 😊`
        : balance === 0
          ? `⚠️ <b>Занятия закончились</b>\n\nУ ${client.child_name} в абонементе не осталось уроков.\nЧтобы не пропустить следующее занятие, продлите абонемент 😊`
          : `⚠️ <b>Занятия идут в минус</b>\n\nУ ${client.child_name} посещений больше, чем оплачено: <b>${Math.abs(balance)}</b>.\nПожалуйста, свяжитесь с администратором студии.`

      if (opts.dry) {
        stats.plan.push(`low_balance → ${client.child_name} (остаток ${balance})`)
        continue
      }
      const r = await deliver({
        studio_id: row.studio_id, client_id: client.id,
        telegram_id: row.telegram_id, type: 'low_balance', reference_id: refId,
      }, () => sendMessage(studio.bot_token, row.telegram_id, text), opts)
      if (r === 'sent') stats.low_balance++
    } catch (e) {
      // Один упавший родитель не должен обрывать рассылку остальным
      stats.errors.push(`low_balance/link ${row.id}: ${e.message}`)
    }
  }
}

// ── Напоминания о занятиях ───────────────────────────────────────────
//
// Кто на каком занятии, решает функция базы schedule_lessons — ОДНО
// место с правилами состава: три режима записи, подгруппы ребёнка,
// архив направлений и подгрупп по дате, разовые записи, статусы.
// Календарь CRM сверен с ней общим набором проверок.
//
// Здесь только «кому писать»: общий выключатель студии, тумблер
// родителя и пометка «занятия не было».
async function checkLessonReminders(ctx, stats, opts) {
  // Расписание грузится один раз на студию, а не на каждого родителя
  const byStudio = new Map()
  for (const row of ctx.links) {
    if (opts.only && String(row.telegram_id) !== opts.only) continue
    // Тумблер родителя (в боте) или администратора (в CRM)
    if (!(row.notify_before_hours > 0)) continue
    if (!byStudio.has(row.studio_id)) byStudio.set(row.studio_id, [])
    byStudio.get(row.studio_id).push(row)
  }

  for (const [studioId, rows] of byStudio) {
    const studio = ctx.studios.get(studioId)
    if (!studio?.bot_token) continue

    // Общий выключатель студии (баг 59). Выключен — не пишем никому,
    // что бы ни стояло у родителей. Счётчик, чтобы тишина была объяснимой
    if (studio.lesson_reminders !== true) { stats.skipped_studio_off += rows.length; continue }

    let lessons, dirName, noWork
    try {
      const today = localToday(studio.timezone)
      const tomorrow = shiftDays(today, 1)
      lessons = await sbRpc('schedule_lessons', { p_studio_id: studioId, p_from: today, p_to: tomorrow })
      if (!lessons?.length) continue

      const dirIds = [...new Set(lessons.map(l => l.direction_id))]
      const directions = await sbGet('directions', `studio_id=eq.${studioId}&id=in.(${dirIds.join(',')})&select=id,name`)
      dirName = new Map((directions || []).map(d => [d.id, d.name]))

      // «Занятия не было» — если пометку поставили заранее, звать некуда
      const nw = await sbGet('lesson_no_work', `studio_id=eq.${studioId}&date=gte.${today}&date=lte.${tomorrow}&select=date,direction_id,group_id`)
      noWork = new Set((nw || []).map(n => `${n.date}|${n.direction_id}|${n.group_id || 0}`))
      lessons.forEach(l => { l._label = l.lesson_date === today ? 'Сегодня' : 'Завтра' })
    } catch (e) {
      stats.errors.push(`lesson_reminder/studio ${studioId}: ${e.message}`)
      continue
    }

    for (const row of rows) {
      const client = ctx.clients.get(row.client_id)
      if (!client) continue
      try {
        const mine = lessons.filter(l => l.client_id === client.id)

        // Ребёнок сразу в нескольких подгруппах одного направления в один
        // день — так бывает, когда подгруппу ему не выбрали, и по правилу он
        // «во всех». Календарю это не страшно, а родителю пришло бы четыре
        // напоминания с четырьмя разными временами. Какое из них верное,
        // знает только студия — поэтому не пишем ничего и считаем, сколько
        // таких: пусть лучше промолчим, чем позовём не туда (баг 54).
        const perDay = new Map()
        for (const l of mine) {
          const k = `${l.lesson_date}|${l.direction_id}`
          perDay.set(k, (perDay.get(k) || 0) + 1)
        }

        for (const l of mine) {
          if (perDay.get(`${l.lesson_date}|${l.direction_id}`) > 1) {
            stats.skipped_ambiguous++
            if (opts.dry) stats.plan.push(`НЕ ОТПРАВЛЕНО → ${client.child_name}: ${l._label} ${dirName.get(l.direction_id) || ''} — несколько подгрупп сразу, выберите одну в карточке`)
            continue
          }
          const gid = l.group_id || 0
          if (noWork.has(`${l.lesson_date}|${l.direction_id}|${gid}`)) continue

          const name = dirName.get(l.direction_id) || 'Занятие'
          const refId = `${l.lesson_date}_${l.direction_id}_${gid}_morning`
          if (!opts.force && await alreadySent(client.id, 'lesson_reminder', refId)) continue

          if (opts.dry) {
            stats.plan.push(`lesson_reminder → ${client.child_name}: ${l._label} ${name} ${l.lesson_time}${l.one_off ? ' (разовая запись)' : ''}`)
            continue
          }
          // Кнопки «Придём / Не сможем». Ключ занятия едет в
          // callback_data — в базе занятия нет, привязаться не к чему.
          // Ошибка одного занятия не отменяет остальные занятия ребёнка
          try {
            const r = await deliver({
              studio_id: studioId, client_id: client.id,
              telegram_id: row.telegram_id, type: 'lesson_reminder', reference_id: refId,
            }, () => sendMessage(studio.bot_token, row.telegram_id,
              `📚 <b>${l._label} занятие</b>\n\n` +
              `${l._label} в <b>${l.lesson_time}</b> у <b>${client.child_name}</b>:\n` +
              `<b>${name}</b>\n\n` +
              `Подскажете, будете ли?`,
              confirmMenu(l.lesson_date, l.direction_id, gid)
            ), opts)
            if (r === 'sent') stats.lesson_reminder++
          } catch (e) {
            stats.errors.push(`lesson_reminder/link ${row.id} ${refId}: ${e.message}`)
          }
        }
      } catch (e) {
        stats.errors.push(`lesson_reminder/link ${row.id}: ${e.message}`)
      }
    }
  }
}

// ── Точка входа ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Секрет обязателен. Без него сравнение шло бы со строкой «Bearer undefined»,
  // и рассылку по всем студиям мог бы запустить кто угодно (баг 58).
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error('CRON_SECRET не задан — рассылка остановлена')
    return res.status(500).json({ error: 'CRON_SECRET is not configured' })
  }

  if (req.headers['authorization'] !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // Режимы для ручной проверки. Без них единственный способ проверить
  // рассылку — отправить её всем настоящим родителям и надеяться.
  //
  //   ?dry=1            показать, что ушло бы, и не отправлять
  //   ?only=<telegram>  работать только с одним получателем
  //   ?force=1          игнорировать журнал и слать повторно
  //
  // Проверка на себе: ?only=СВОЙ_ID&force=1
  const opts = {
    dry: req.query.dry === '1',
    force: req.query.force === '1',
    only: req.query.only ? String(req.query.only) : null,
  }

  // skipped_status — сколько раз уведомление не ушло из-за статуса.
  // Без счётчика фильтр работал бы молча, и «бот перестал писать»
  // пришлось бы искать вслепую.
  const stats = { low_balance: 0, lesson_reminder: 0, skipped_status: 0, skipped_studio_off: 0, skipped_ambiguous: 0, errors: [], plan: [] }
  try {
    const ctx = await loadContext()
    await checkLowBalance(ctx, stats, opts)
    await checkLessonReminders(ctx, stats, opts)
    // В логах Vercel только счётчики — ни имён, ни телефонов.
    // plan содержит имена детей, поэтому уходит только в ответ
    console.log('notifications:', JSON.stringify({
      low_balance: stats.low_balance, lesson_reminder: stats.lesson_reminder,
      skipped_status: stats.skipped_status, skipped_studio_off: stats.skipped_studio_off,
      skipped_ambiguous: stats.skipped_ambiguous,
      errors: stats.errors.length,
      planned: stats.plan.length, mode: opts,
    }))
    res.json({ ok: true, mode: opts, ...stats })
  } catch (e) {
    console.error('Notifications failed:', e.message)
    res.status(500).json({ error: 'internal' })
  }
}