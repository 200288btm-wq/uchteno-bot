// Запускать: node setup-webhooks.js
// Регистрирует вебхуки для всех ботов в системе

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dmvqiuminxrtcaylfcwg.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_KEY
const BOT_SERVICE_URL = process.env.BOT_SERVICE_URL // например https://panda-bot-xxx.amvera.io

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function setupWebhooks() {
  const { data: settings } = await supabase
    .from('studio_settings')
    .select('bot_token, bot_username, studios(name)')
    .not('bot_token', 'is', null)

  if (!settings?.length) {
    console.log('No bots configured')
    return
  }

  for (const s of settings) {
    const token = s.bot_token
    const webhookUrl = `${BOT_SERVICE_URL}/webhook/${token}`

    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    })
    const result = await res.json()
    console.log(`${s.studios?.name}: ${result.ok ? '✅ webhook set' : '❌ ' + result.description}`)
  }
}

setupWebhooks()
