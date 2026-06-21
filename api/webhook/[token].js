import {
  supabase, tg, sendMessage, mainMenu, notifyMenu,
  getStudioByToken, getClientByTelegram, findClientByPhone,
  getClientBalance, getPendingReg, setPendingReg, deletePendingReg
} from '../../lib/helpers.js'

// ── Message handler ──────────────────────────────────────────
async function handleMessage(token, studioSettings, msg) {
  const chatId = msg.chat.id
  const telegramId = msg.from.id
  const text = msg.text || ''
  const studioId = studioSettings.studios.id

  const linked = await getClientByTelegram(studioId, telegramId)

  // Если привязан — чистим pending мусор и идём дальше
  const pending = linked ? null : await getPendingReg(telegramId)
  if (linked) await deletePendingReg(telegramId)

  // Ожидаем ввод телефона
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
      studio_id: studioId, client_id: client.id, telegram_id: telegramId,
      telegram_username: msg.from.username, telegram_first_name: msg.from.first_name,
      phone, notify_before_hours: 2, notify_low_balance: true,
    }, { onConflict: 'studio_id,telegram_id' })

    await deletePendingReg(telegramId)

    await sendMessage(token, chatId,
      `✅ <b>Привязка выполнена!</b>\n\nДобро пожаловать, <b>${client.child_name}</b>!\n\nТеперь вы можете получать информацию о занятиях и уведомления.`,
      mainMenu(studioSettings.booking_url)
    )
    return
  }

  // Незарегистрированный
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

  // ── /start или главное меню ──
  if (text === '/start' || text === '🏠 Главное меню') {
    await sendMessage(token, chatId, `👋 Привет, ${client.child_name}! Выберите раздел:`, mainMenu(studioSettings.booking_url))
    return
  }

  // ── Моя информация ──
  if (text === '👤 Моя информация') {
    const { data: dirs } = await supabase.from('directions')
      .select('name').eq('studio_id', studioId).in('id', client.direction_ids || [])
    const dirNames = (dirs || []).map(d => d.name).join(', ') || 'не указано'
    const contacts = (client.contacts || []).map(c => `${c.type}: ${c.val}`).join('\n') || 'не указано'

    await sendMessage(token, chatId,
      `👤 <b>Информация</b>\n\n` +
      `🧒 Ребёнок: <b>${client.child_name}</b>\n` +
      `👩 Родитель: ${client.adult_name || '—'}\n` +
      `📚 Направление: ${dirNames}\n` +
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

  // ── Мои посещения ──
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
      return `${status} ${date} — ${a.directions?.name || '—'}`
    }).join('\n')

    await sendMessage(token, chatId, `📅 <b>Последние 10 посещений</b>\n\n${rows}`)
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

    const hoursText = settings.notify_before_hours === 0 ? 'не напоминать' : `за ${settings.notify_before_hours} ч.`

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
      `📝 <b>Онлайн-запись</b>\n\nПерейдите по ссылке:\n${studioSettings.booking_url}`
    )
    return
  }

  // Default
  await sendMessage(token, chatId, 'Выберите раздел из меню 👇', mainMenu(studioSettings.booking_url))
}

// ── Callback handler ─────────────────────────────────────────
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
    text: `🔔 <b>Настройки уведомлений</b>\n\n⏰ Напоминание: <b>${hoursText}</b>\n📊 Мало занятий: <b>${settings.notify_low_balance ? 'включено' : 'выключено'}</b>\n\nВыберите параметр:`,
    parse_mode: 'HTML',
    ...notifyMenu(settings),
  })
}

// ── Vercel handler ───────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true })

  const token = req.query.token
  const update = req.body
  console.log('Webhook received, token:', token?.slice(0, 10), 'update keys:', Object.keys(update || {}))

  try {
    console.log('Calling getStudioByToken...')
    const studioSettings = await getStudioByToken(token)
    console.log('studioSettings:', studioSettings ? 'found' : 'not found')

    if (!studioSettings) { console.log('Unknown token:', token); return res.status(200).json({ ok: true }) }

    if (update.message) await handleMessage(token, studioSettings, update.message)
    if (update.callback_query) await handleCallback(token, studioSettings, update.callback_query)
  } catch (e) {
    console.error('Webhook error:', e.message)
  }

  return res.status(200).json({ ok: true })
}
