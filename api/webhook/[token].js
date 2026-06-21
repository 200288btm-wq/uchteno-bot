import {
  tg, sendMessage, mainMenu, notifyMenu,
  getStudioByToken, getClientByTelegram, findClientByPhone,
  getClientBalance, getPendingReg, setPendingReg, deletePendingReg,
  upsertClientTelegram, updateClientTelegram, getClientTelegramSettings,
  sbGet
} from '../../lib/helpers.js'

// ── Message handler ──────────────────────────────────────────
async function handleMessage(token, studioSettings, msg) {
  const chatId = msg.chat.id
  const telegramId = msg.from.id
  const text = msg.text || ''
  const studioId = studioSettings.studios.id

  const linked = await getClientByTelegram(studioId, telegramId)
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
        { reply_markup: { keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
      )
      return
    }

    await upsertClientTelegram({
      studio_id: studioId, client_id: client.id, telegram_id: telegramId,
      telegram_username: msg.from.username, telegram_first_name: msg.from.first_name,
      phone, notify_before_hours: 2, notify_low_balance: true,
    })
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
        { reply_markup: { keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } }
      )
      return
    }
    if (msg.contact) {
      const phone = msg.contact.phone_number
      const client = await findClientByPhone(studioId, phone)
      if (!client) {
        await sendMessage(token, chatId, '❌ Клиент с таким номером не найден. Обратитесь к администратору студии.')
        return
      }
      await upsertClientTelegram({
        studio_id: studioId, client_id: client.id, telegram_id: telegramId,
        telegram_username: msg.from.username, telegram_first_name: msg.from.first_name,
        phone, notify_before_hours: 2, notify_low_balance: true,
      })
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

  if (text === '/start' || text === '🏠 Главное меню') {
    await sendMessage(token, chatId, `👋 Привет, ${client.child_name}! Выберите раздел:`, mainMenu(studioSettings.booking_url))
    return
  }

  if (text === '👤 Моя информация') {
    const dirIds = (client.direction_ids || []).join(',')
    const dirs = dirIds ? await sbGet('directions', `studio_id=eq.${studioId}&id=in.(${dirIds})`) : []
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

  if (text === '📅 Мои посещения') {
    const attendance = await sbGet('attendance', `client_id=eq.${client.id}&studio_id=eq.${studioId}&order=date.desc&limit=10`)
    if (!attendance?.length) {
      await sendMessage(token, chatId, '📅 Посещений пока нет.')
      return
    }
    const rows = attendance.map(a => {
      const date = new Date(a.date).toLocaleDateString('ru-RU')
      return `${a.present ? '✅' : '❌'} ${date}`
    }).join('\n')
    await sendMessage(token, chatId, `📅 <b>Последние посещения</b>\n\n${rows}`)
    return
  }

  if (text === '🔔 Настройки уведомлений') {
    const settings = await getClientTelegramSettings(studioId, telegramId)
    await sendMessage(token, chatId,
      `🔔 <b>Настройки уведомлений</b>\n\n` +
      `⚠️ Напоминание о балансе — всегда включено\n` +
      `📅 Напоминания о занятиях (утром): <b>${settings.notify_before_hours > 0 ? 'включено' : 'выключено'}</b>`,
      notifyMenu(settings)
    )
    return
  }

  if (text === '📝 Онлайн-запись' && studioSettings.booking_url) {
    await sendMessage(token, chatId, `📝 <b>Онлайн-запись</b>\n\nПерейдите по ссылке:\n${studioSettings.booking_url}`)
    return
  }

  await sendMessage(token, chatId, 'Выберите раздел из меню 👇', mainMenu(studioSettings.booking_url))
}

async function handleCallback(token, studioSettings, cbq) {
  const telegramId = cbq.from.id
  const chatId = cbq.message.chat.id
  const data = cbq.data
  const studioId = studioSettings.studios.id

  if (data === 'toggle_reminders') {
    const cur = await getClientTelegramSettings(studioId, telegramId)
    const newVal = cur.notify_before_hours > 0 ? 0 : 24
    await updateClientTelegram(studioId, telegramId, { notify_before_hours: newVal })
    await tg(token, 'answerCallbackQuery', { callback_query_id: cbq.id, text: '✅ Сохранено' })
  }

  const settings = await getClientTelegramSettings(studioId, telegramId)

  await tg(token, 'editMessageText', {
    chat_id: chatId,
    message_id: cbq.message.message_id,
    text: `🔔 <b>Настройки уведомлений</b>\n\n` +
      `⚠️ Напоминание о балансе — всегда включено\n` +
      `📅 Напоминания о занятиях (утром): <b>${settings.notify_before_hours > 0 ? 'включено' : 'выключено'}</b>`,
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
