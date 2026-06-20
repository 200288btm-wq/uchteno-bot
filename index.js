import express from 'express'
import cron from 'node-cron'
import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

const app = express()
app.use(express.json())

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dmvqiuminxrtcaylfcwg.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
})

const BOT_SERVICE_URL = process.env.BOT_SERVICE_URL || 'https://uchteno-bot-200288btm.amvera.io'

// ── Telegram API helper ──────────────────────────────────────
async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function sendMessage(token, chat_id, text, extra = {}) {
  return tg(token, 'sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra })
}

// ── Keyboards ────────────────────────────────────────────────
const mainMenu = (bookingUrl) => ({
  reply_markup: {
    keyboard: [
      [{ text: '👤 Моя информация' }, { text: '💳 Оплаты и баланс' }],
      [{ text: '📅 Мои посещения' }, { text: '🔔 Настройки уведомлений' }],
      bookingUrl ? [{ text: '📝 Онлайн-запись' }] : [],
    ].filter(r => r.length > 0),
    resize_keyboard: true,
  }
})

const notifyMenu = (settings) => ({
  reply_markup: {
    inline_keyboard: [
      [
        { text: settings.notify_low_balance ? '🔔 Мало занятий: ВКЛ' : '🔕 Мало занятий: ВЫКЛ', callback_data: 'toggle_low_balance' }
      ],
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
async function getStudioByToken(token) {
  const { data } = await supabase
    .from('studio_settings')
    .select('*, studios(id, name)')
    .eq('bot_token', token)
    .maybeSingle()
  return data
}

async function getClientByTelegram(studioId, telegramId) {
  const { data } = await supabase
    .from('client_telegram')
    .select('*, clients(*)')
    .eq('studio_id', studioId)
    .eq('telegram_id', telegramId)
    .maybeSingle()
  return data
}

async function findClientByPhone(studioId, phone) {
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

async function getClientBalance(studioId, clientId) {
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

// ── Pending registration — хранится в Supabase, а не в памяти ──
// Это важно: при cold start Map сбрасывается, поэтому используем БД

async function getPendingReg(telegramId) {
  const { data } = await supabase
    .from('bot_pending_registration')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle()
  return data
}

async function setPendingReg(telegramId, studioId) {
  await supabase.from('bot_pending_registration').upsert({
    telegram_id: telegramId,
    studio_id: studioId,
    step: 'phone',
    created_at: new Date().toISOString(),
  }, { onConflict: 'telegram_id' })
}

async function deletePendingReg(telegramId) {
  await supabase.from('bot_pending_registration').delete().eq('telegram_id', telegramId)
}

// ── Message handlers ─────────────────────────────────────────
async function handleMessage(token, studioSettings, msg) {
  const chatId = msg.chat.id
  const telegramId = msg.from.id
  const text = msg.text || ''
  const studioId = studioSettings.studios.id

  const linked = await getClientByTelegram(studioId, telegramId)

  // Ожидание ввода телефона при регистрации
  const pending = await getPendingReg(telegramId)
  if (pending && pending.step === 'phone') {
    let phone = text.trim()
    if (msg.contact) phone = msg.contact.phone_number

    const client = await findClientByPhone(studioId, phone)
    if (!client) {
      await sendMessage(token, chatId,
        '❌ Клиент с таким номером не найден.\n\nПроверьте номер и попробуйте снова, или обратитесь к администратору студии.',
        {
          reply_markup: {
            keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          }
        }
      )
      return
    }

    await supabase.from('client_telegram').upsert({
      studio_id: studioId,
      client_id: client.id,
      telegram_id: telegramId,
      telegram_username: msg.from.username,
      telegram_first_name: msg.from.first_name,
      phone,
      notify_before_hours: 2,
      notify_low_balance: true,
    }, { onConflict: 'studio_id,telegram_id' })

    await deletePendingReg(telegramId)

    await sendMessage(token, chatId,
      `✅ <b>Привязка выполнена!</b>\n\nДобро пожаловать, <b>${client.child_name}</b>!\n\nТеперь вы можете получать информацию о занятиях и уведомления.`,
      mainMenu(studioSettings.booking_url)
    )
    return
  }

  // Незарегистрированный пользователь
  if (!linked) {
    if (text === '/start') {
      await setPendingReg(telegramId, studioId)
      await sendMessage(token, chatId,
        `👋 Добро пожаловать в <b>${studioSettings.studios.name}</b>!\n\nДля начала работы нам нужно вас идентифицировать.\n\n📱 Введите номер телефона, который вы указывали при записи в студию, или нажмите кнопку ниже:`,
        {
          reply_markup: {
            keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          }
        }
      )
      return
    }
    if (msg.contact) {
      await setPendingReg(telegramId, studioId)
      const phone = msg.contact.phone_number
      const client = await findClientByPhone(studioId, phone)
      if (!client) {
        await sendMessage(token, chatId, '❌ Клиент с таким номером не найден. Обратитесь к администратору студии.')
        return
      }
      await supabase.from('client_telegram').upsert({
        studio_id: studioId, client_id: client.id, telegram_id: telegramId,
        telegram_username: msg.from.username, telegram_first_name: msg.from.first_name,
        phone, notify_before_hours: 2, notify_low_balance: true,
      }, { onConflict: 'studio_id,telegram_id' })
      await deletePendingReg(telegramId)
      await sendMessage(token, chatId,
        `✅ <b>Привязка выполнена!</b>\n\nДобро пожаловать, <b>${client.child_name}</b>!`,
        mainMenu(studioSettings.booking_url)
      )
      return
    }
    await sendMessage(token, chatId, 'Напишите /start чтобы начать.')
    return
  }

  const client = linked.clients

  // ── Главное меню ──
  if (text === '/start' || text === '🏠 Главное меню') {
    await sendMessage(token, chatId,
      `👋 Привет! Выберите раздел:`,
      mainMenu(studioSettings.booking_url)
    )
    return
  }

  // ── Моя информация ──
  if (text === '👤 Моя информация') {
    const directions = await supabase.from('directions')
      .select('name').eq('studio_id', studioId)
      .in('id', client.direction_ids || [])
    const dirs = (directions.data || []).map(d => d.name).join(', ') || 'не указано'
    const contacts = (client.contacts || []).map(c => `${c.type}: ${c.val}`).join('\n') || 'не указано'
    
    await sendMessage(token, chatId,
      `👤 <b>Информация</b>\n\n` +
      `🧒 Ребёнок: <b>${client.child_name}</b>\n` +
      `👩 Родитель: ${client.adult_name || '—'}\n` +
      `📚 Направление: ${dirs}\n` +
      `📞 Контакты:\n${contacts}\n` +
      `📊 Статус: ${client.status || '—'}`
    )
    return
  }

  // ── Оплаты и баланс ──
  if (text === '💳 Оплаты и баланс') {
    const { totalPaid, totalVisited, balance, payments } = await getClientBalance(studioId, client.id)
    
    const lastPayments = payments
      .sort((a, b) => new Date(b.payment_date) - new Date(a.payment_date))
      .slice(0, 5)
      .map(p => {
        const date = new Date(p.payment_date).toLocaleDateString('ru-RU')
        const exp = p.expires_at ? ` (до ${new Date(p.expires_at).toLocaleDateString('ru-RU')})` : ''
        return `• ${date}: ${p.payment_type} ${p.amount ? `— ${p.amount}₽` : ''}${exp}`
      }).join('\n')

    const balanceEmoji = balance > 0 ? '✅' : balance === 0 ? '⚠️' : '❌'
    
    await sendMessage(token, chatId,
      `💳 <b>Оплаты и баланс</b>\n\n` +
      `${balanceEmoji} Баланс: <b>${balance} зан.</b>\n` +
      `📊 Оплачено всего: ${totalPaid} зан.\n` +
      `✅ Посещено: ${totalVisited} зан.\n\n` +
      `<b>Последние оплаты:</b>\n${lastPayments || 'Оплат пока нет'}`
    )
    return
  }

  // ── Посещения ──
  if (text === '📅 Мои посещения') {
    const { data: attendance } = await supabase
      .from('attendance')
      .select('*, directions(name)')
      .eq('client_id', client.id)
      .eq('studio_id', studioId)
      .order('date', { ascending: false })
      .limit(10)

    if (!attendance?.length) {
      await sendMessage(token, chatId, '📅 Посещений пока нет.')
      return
    }

    const rows = attendance.map(a => {
      const date = new Date(a.date).toLocaleDateString('ru-RU')
      const status = a.present ? '✅' : '❌'
      const dir = a.directions?.name || '—'
      return `${status} ${date} — ${dir}`
    }).join('\n')

    await sendMessage(token, chatId,
      `📅 <b>Последние 10 посещений</b>\n\n${rows}`
    )
    return
  }

  // ── Настройки уведомлений ──
  if (text === '🔔 Настройки уведомлений') {
    const { data: settings } = await supabase
      .from('client_telegram')
      .select('notify_before_hours, notify_low_balance')
      .eq('telegram_id', telegramId)
      .eq('studio_id', studioId)
      .single()

    const hoursText = settings.notify_before_hours === 0
      ? 'не напоминать'
      : `за ${settings.notify_before_hours} ч.`

    await sendMessage(token, chatId,
      `🔔 <b>Настройки уведомлений</b>\n\n` +
      `⏰ Напоминание о занятии: <b>${hoursText}</b>\n` +
      `📊 Мало занятий (1 осталось): <b>${settings.notify_low_balance ? 'включено' : 'выключено'}</b>\n\n` +
      `Выберите параметр для изменения:`,
      notifyMenu(settings)
    )
    return
  }

  // ── Онлайн-запись ──
  if (text === '📝 Онлайн-запись' && studioSettings.booking_url) {
    await sendMessage(token, chatId,
      `📝 <b>Онлайн-запись</b>\n\nПерейдите по ссылке для записи на занятие:\n${studioSettings.booking_url}`
    )
    return
  }

  // Default
  await sendMessage(token, chatId, 'Выберите раздел из меню 👇', mainMenu(studioSettings.booking_url))
}

// ── Callback query handler ───────────────────────────────────
async function handleCallback(token, studioSettings, cbq) {
  const telegramId = cbq.from.id
  const chatId = cbq.message.chat.id
  const data = cbq.data
  const studioId = studioSettings.studios.id

  const hoursMap = { notify_1h: 1, notify_2h: 2, notify_3h: 3, notify_24h: 24, notify_48h: 48, notify_0: 0 }

  if (data in hoursMap) {
    await supabase.from('client_telegram')
      .update({ notify_before_hours: hoursMap[data] })
      .eq('telegram_id', telegramId).eq('studio_id', studioId)
    await tg(token, 'answerCallbackQuery', { callback_query_id: cbq.id, text: '✅ Сохранено' })
  }

  if (data === 'toggle_low_balance') {
    const { data: cur } = await supabase.from('client_telegram')
      .select('notify_low_balance').eq('telegram_id', telegramId).eq('studio_id', studioId).single()
    await supabase.from('client_telegram')
      .update({ notify_low_balance: !cur.notify_low_balance })
      .eq('telegram_id', telegramId).eq('studio_id', studioId)
    await tg(token, 'answerCallbackQuery', { callback_query_id: cbq.id, text: '✅ Сохранено' })
  }

  const { data: settings } = await supabase.from('client_telegram')
    .select('notify_before_hours, notify_low_balance')
    .eq('telegram_id', telegramId).eq('studio_id', studioId).single()
  const hoursText = settings.notify_before_hours === 0 ? 'не напоминать' : `за ${settings.notify_before_hours} ч.`

  await tg(token, 'editMessageText', {
    chat_id: chatId,
    message_id: cbq.message.message_id,
    text: `🔔 <b>Настройки уведомлений</b>\n\n⏰ Напоминание о занятии: <b>${hoursText}</b>\n📊 Мало занятий: <b>${settings.notify_low_balance ? 'включено' : 'выключено'}</b>\n\nВыберите параметр:`,
    parse_mode: 'HTML',
    ...notifyMenu(settings),
  })
}

// ── Webhook endpoint ─────────────────────────────────────────
app.post('/webhook/:token', async (req, res) => {
  res.sendStatus(200)
  const token = req.params.token
  const update = req.body

  try {
    const studioSettings = await getStudioByToken(token)
    if (!studioSettings) { console.log('Unknown token:', token); return }

    if (update.message) {
      await handleMessage(token, studioSettings, update.message)
    }
    if (update.callback_query) {
      await handleCallback(token, studioSettings, update.callback_query)
    }
  } catch (e) {
    console.error('Webhook error:', e)
  }
})

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'uchteno-bot' }))

// ── Keep-alive: пингуем себя каждые 4 минуты чтобы не засыпать ──
cron.schedule('*/4 * * * *', async () => {
  try {
    await fetch(`${BOT_SERVICE_URL}/`)
    console.log('Keep-alive ping sent')
  } catch (e) {
    console.log('Keep-alive ping failed:', e.message)
  }
})

// ── Notifications cron ───────────────────────────────────────
cron.schedule('*/15 * * * *', async () => {
  console.log('Running notifications check...')
  await checkLowBalance()
  await checkLessonReminders()
})

// Уведомление о низком балансе
async function checkLowBalance() {
  const { data: linked } = await supabase
    .from('client_telegram')
    .select('*, clients(*), studio_settings!inner(bot_token)')
    .eq('notify_low_balance', true)

  if (!linked) return
  const today = new Date().toISOString().slice(0, 10)

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

    if (balance !== 1) continue

    const { data: log } = await supabase.from('bot_notifications_log')
      .select('id').eq('client_id', client.id).eq('type', 'low_balance')
      .gte('sent_at', today + 'T00:00:00Z').maybeSingle()
    if (log) continue

    await sendMessage(token, row.telegram_id,
      `⚠️ <b>Осталось последнее занятие!</b>\n\n` +
      `У ${client.child_name} остался <b>1 урок</b> в абонементе.\n` +
      `Не забудьте пополнить баланс 😊`
    )

    await supabase.from('bot_notifications_log').insert({
      studio_id: row.studio_id, client_id: client.id,
      telegram_id: row.telegram_id, type: 'low_balance',
      reference_id: today,
    })
  }
}

// Уведомление о предстоящем занятии
async function checkLessonReminders() {
  const now = new Date()
  const { data: linked } = await supabase
    .from('client_telegram')
    .select('*, clients(*), studio_settings!inner(bot_token, studios(id))')
    .gt('notify_before_hours', 0)

  if (!linked) return

  for (const row of linked) {
    const client = row.clients
    const token = row.studio_settings?.bot_token
    const studioId = row.studio_settings?.studios?.id
    if (!token || !client || !studioId) continue

    const hoursAhead = row.notify_before_hours
    const targetTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000)
    const targetDate = targetTime.toISOString().slice(0, 10)
    const targetHour = targetTime.getHours()

    const { data: directions } = await supabase
      .from('directions')
      .select('*, groups:direction_groups(*)')
      .eq('studio_id', studioId)
      .in('id', client.direction_ids || [])

    if (!directions?.length) continue

    const DAYS_RU = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
    const targetDayRu = DAYS_RU[targetTime.getDay()]

    for (const dir of directions) {
      for (const group of (dir.groups || [])) {
        const schedule = (group.schedule || '').toLowerCase()
        if (!schedule.includes(targetDayRu)) continue

        const timeMatch = schedule.match(/(\d{1,2}):(\d{2})/)
        if (!timeMatch) continue
        const schedHour = parseInt(timeMatch[1])
        if (Math.abs(schedHour - targetHour) > 0) continue

        const refId = `${targetDate}_${dir.id}_${group.id}`
        const { data: log } = await supabase.from('bot_notifications_log')
          .select('id').eq('client_id', client.id).eq('type', 'lesson_reminder')
          .eq('reference_id', refId).maybeSingle()
        if (log) continue

        const timeStr = `${schedHour}:${timeMatch[2]}`
        await sendMessage(token, row.telegram_id,
          `📚 <b>Напоминание о занятии</b>\n\n` +
          `Сегодня в <b>${timeStr}</b> у ${client.child_name} занятие:\n` +
          `<b>${dir.name}</b>${group.name !== 'Основная' ? ` (${group.name})` : ''}\n\n` +
          `Адрес: ${group.address_id ? 'уточните у администратора' : 'по расписанию'} 🏫`
        )

        await supabase.from('bot_notifications_log').insert({
          studio_id: row.studio_id, client_id: client.id,
          telegram_id: row.telegram_id, type: 'lesson_reminder',
          reference_id: refId,
        })
      }
    }
  }
}

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Bot service running on port ${PORT}`)
})
