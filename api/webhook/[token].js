import {
  tg, sendMessage, mainMenu, notifyMenu,
  getStudioByToken, getClientByTelegram, findClientByPhone,
  getClientBalance, poolLabel, ruDate, getPendingReg, setPendingReg, deletePendingReg,
  upsertClientTelegram, updateClientTelegram, getClientTelegramSettings,
  confirmMenu, saveConfirmation,
  sbGet
} from '../../lib/helpers.js'

// Тумблер родителя «напоминания о занятиях». Крон смотрит только на > 0:
// число часов нигде не применяется, напоминание всегда утреннее.
// Одно значение «включено» на весь бот — раньше их было два, 2 и 24 (баг 59).
const REMINDERS_ON = 24
const REMINDERS_OFF = 0

// Новая привязка приходит ВКЛЮЧЁННОЙ (баг 59). Рассылкой управляет
// общий выключатель студии в CRM (studio_settings.lesson_reminders):
// пока он выключен, не уходит никому, какой бы тумблер ни стоял здесь.
// Раньше здесь стоял 0 как временная мера от бага 54 — и новые родители
// оставались без напоминаний навсегда, даже после починки.
const DEFAULT_NOTIFY_BEFORE_HOURS = REMINDERS_ON

// Текст экрана «Настройки уведомлений». Один на два места: открытие
// меню и нажатие тумблера. Если студия напоминания ещё не включила,
// честно говорим, что включённый тумблер пока ничего не даст.
function notifySettingsText(link, studioSettings) {
  const on = link?.notify_before_hours > 0
  const studioOff = studioSettings?.lesson_reminders !== true
  return `🔔 <b>Настройки уведомлений</b>\n\n` +
    `⚠️ Напоминание о балансе — всегда включено\n` +
    `📅 Напоминания о занятиях (утром): <b>${on ? 'включено' : 'выключено'}</b>` +
    (on && studioOff ? `\n\n<i>Студия пока не рассылает напоминания. Как только включит — они начнут приходить.</i>` : '')
}

// ── Message handler ──────────────────────────────────────────
async function handleMessage(token, studioSettings, msg) {
  const chatId = msg.chat.id
  const telegramId = msg.from.id
  const text = msg.text || ''
  const studioId = studioSettings.studios.id
  // Ссылка на онлайн-запись строится из слага студии (как в CRM); откат на старое поле booking_url
  const bookingUrl = studioSettings.slug
    ? `https://panda-crm.vercel.app/zapis/${studioSettings.slug}`
    : (studioSettings.booking_url || null)

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
      phone, notify_before_hours: DEFAULT_NOTIFY_BEFORE_HOURS, notify_low_balance: true,
    })
    await deletePendingReg(telegramId)
    await sendMessage(token, chatId,
      `✅ <b>Привязка выполнена!</b>\n\nДобро пожаловать, <b>${client.child_name}</b>!\n\nТеперь вы можете получать информацию о занятиях и уведомления.`,
      mainMenu(bookingUrl)
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
        phone, notify_before_hours: DEFAULT_NOTIFY_BEFORE_HOURS, notify_low_balance: true,
      })
      await deletePendingReg(telegramId)
      await sendMessage(token, chatId,
        `✅ <b>Привязка выполнена!</b>\n\nДобро пожаловать, <b>${client.child_name}</b>!`,
        mainMenu(bookingUrl)
      )
      return
    }
    await sendMessage(token, chatId, 'Напишите /start чтобы начать.')
    return
  }

  const client = linked.clients

  if (text === '/start' || text === '🏠 Главное меню') {
    await sendMessage(token, chatId, `👋 Привет, ${client.child_name}! Выберите раздел:`, mainMenu(bookingUrl))
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
    const { totalPaid, totalVisited, summary, refs, payments } =
      await getClientBalance(studioId, client.id, studioSettings.balance_mode)
    const lastPayments = payments
      .sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)))
      .slice(0, 5)
      .map(p => {
        const date = ruDate(p.payment_date)
        const exp = p.expires_at ? ` (до ${ruDate(p.expires_at)})` : ''
        return `• ${date}: ${p.payment_type} ${p.amount ? `— ${p.amount}₽` : ''}${exp}`
      }).join('\n')

    // Остаток — по функции базы, как в CRM. Несколько кошельков —
    // строка на каждый: занятия одного не покрывают другой
    const sign = (n) => (n > 0 ? `${n}` : n < 0 ? `−${-n}` : '0')
    const emoji = (n) => (n > 0 ? '✅' : n === 0 ? '⚠️' : '❌')
    let balanceText
    if (summary.unlimitedUntil) {
      balanceText = `♾ Безлимит${summary.unlimitedUntil === 'infinity' ? '' : ` до <b>${ruDate(summary.unlimitedUntil)}</b>`}\n`
      for (const p of summary.pools.filter(p => p.left < 0)) {
        const label = poolLabel(p.poolId, refs, client)
        balanceText += `❌ ${label ? `${label}: ` : ''}<b>${sign(p.left)} зан.</b> (до безлимита)\n`
      }
    } else if (summary.pools.length > 1) {
      balanceText = summary.pools.map(p => {
        const label = poolLabel(p.poolId, refs, client)
        return `${emoji(p.left)} ${label ? `${label}: ` : ''}<b>${sign(p.left)} зан.</b>`
      }).join('\n') + '\n'
    } else {
      const left = summary.pools[0]?.left || 0
      balanceText = `${emoji(left)} Баланс: <b>${sign(left)} зан.</b>\n`
    }

    await sendMessage(token, chatId,
      `💳 <b>Оплаты и баланс</b>\n\n` +
      balanceText +
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
    await sendMessage(token, chatId, notifySettingsText(settings, studioSettings), notifyMenu(settings || {}))
    return
  }

  if (text === '📝 Онлайн-запись' && bookingUrl) {
    await sendMessage(token, chatId, `📝 <b>Онлайн-запись</b>\n\nПерейдите по ссылке:\n${bookingUrl}`)
    return
  }

  await sendMessage(token, chatId, 'Выберите раздел из меню 👇', mainMenu(bookingUrl))
}

// Подтверждение занятия: callback_data вида «cf:2026-08-20:12:34».
// cf — придём, cd — не сможем; дальше дата, направление, подгруппа.
async function handleConfirm(token, studioId, cbq) {
  const [kind, lessonDate, dirId, groupId] = String(cbq.data).split(':')
  const status = kind === 'cf' ? 'confirmed' : 'declined'

  const link = await getClientByTelegram(studioId, cbq.from.id)
  if (!link?.client_id) {
    await tg(token, 'answerCallbackQuery', {
      callback_query_id: cbq.id, show_alert: true,
      text: 'Не нашли ваш профиль. Напишите /start, чтобы подключиться заново.',
    })
    return
  }

  try {
    await saveConfirmation({
      studioId, clientId: link.client_id, lessonDate,
      directionId: +dirId, groupId: +groupId || 0, status,
    })
  } catch (e) {
    // Сообщаем честно: зелёная галочка на неудаче хуже, чем ошибка
    console.error('confirm save failed:', e.message)
    await tg(token, 'answerCallbackQuery', {
      callback_query_id: cbq.id, show_alert: true,
      text: 'Не получилось сохранить. Попробуйте ещё раз.',
    })
    return
  }

  await tg(token, 'answerCallbackQuery', {
    callback_query_id: cbq.id,
    text: status === 'confirmed' ? '✅ Ждём вас!' : '❌ Спасибо, передали педагогу',
  })

  // Правим только клавиатуру, не текст: в cbq.message.text разметка
  // уже съедена, и переотправка сломала бы жирный шрифт
  await tg(token, 'editMessageReplyMarkup', {
    chat_id: cbq.message.chat.id,
    message_id: cbq.message.message_id,
    ...confirmMenu(lessonDate, dirId, groupId, status),
  })
}

async function handleCallback(token, studioSettings, cbq) {
  const telegramId = cbq.from.id
  const chatId = cbq.message.chat.id
  const data = cbq.data || ''
  const studioId = studioSettings.studios.id

  // Каждая ветка завершается сама. Раньше обработчик после любого
  // нажатия безусловно переписывал сообщение меню настроек — пока
  // callback был один, это не мешало, но кнопка «Придём» превратила
  // бы напоминание о занятии в «Настройки уведомлений»
  if (data.startsWith('cf:') || data.startsWith('cd:')) {
    return handleConfirm(token, studioId, cbq)
  }

  if (data === 'toggle_reminders') {
    const cur = await getClientTelegramSettings(studioId, telegramId)
    const newVal = cur?.notify_before_hours > 0 ? REMINDERS_OFF : REMINDERS_ON
    await updateClientTelegram(studioId, telegramId, { notify_before_hours: newVal })
    await tg(token, 'answerCallbackQuery', { callback_query_id: cbq.id, text: '✅ Сохранено' })

    const settings = await getClientTelegramSettings(studioId, telegramId)
    await tg(token, 'editMessageText', {
      chat_id: chatId,
      message_id: cbq.message.message_id,
      text: notifySettingsText(settings, studioSettings),
      parse_mode: 'HTML',
      ...notifyMenu(settings || {}),
    })
    return
  }

  // Незнакомая кнопка: гасим «часики», чтобы не висели у человека
  await tg(token, 'answerCallbackQuery', { callback_query_id: cbq.id })
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