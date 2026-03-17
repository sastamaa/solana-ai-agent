import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';
import fetch from 'node-fetch';

// СЛОВНИК ПЕРЕКЛАДІВ
const i18n = {
  en: {
    choose_lang: "🇬🇧 Please choose your language:",
    welcome: (name, wallet) => `👋 Hello, ${name}!\nI am your personal AI Sniper on Solana.\n\n💼 <b>Your trading wallet:</b>\n<code>${wallet}</code>\n\n⚠️ <i>Deposit at least 0.1 SOL to start.</i>`,
    btn_balance: "💰 My Balance",
    btn_settings: "⚙️ Settings",
    reply_dev: "🛠 This feature is under development",
    reply_settings: "⚙️ Settings:\nTake-Profit: 35%\nStop-Loss: 15%\nTrade Amount: 0.05 SOL"
  },
  uk: {
    choose_lang: "🇺🇦 Будь ласка, оберіть мову:",
    welcome: (name, wallet) => `👋 Привіт, ${name}!\nЯ твій персональний ШІ-снайпер на Solana.\n\n💼 <b>Твій торговий гаманець:</b>\n<code>${wallet}</code>\n\n⚠️ <i>Поповни його мінімум на 0.1 SOL для старту.</i>`,
    btn_balance: "💰 Мій Баланс",
    btn_settings: "⚙️ Налаштування",
    reply_dev: "🛠 Ця функція ще в розробці",
    reply_settings: "⚙️ Налаштування:\nТейк-профіт: 35%\nСтоп-лос: 15%\nСума угоди: 0.05 SOL"
  },
  el: {
    choose_lang: "🇬🇷 Παρακαλώ επιλέξτε τη γλώσσα σας:",
    welcome: (name, wallet) => `👋 Γεια σου, ${name}!\nΕίμαι ο προσωπικός σου AI Sniper στο Solana.\n\n💼 <b>Το πορτοφόλι σου:</b>\n<code>${wallet}</code>\n\n⚠️ <i>Κατέθεσε τουλάχιστον 0.1 SOL για να ξεκινήσεις.</i>`,
    btn_balance: "💰 Το Υπόλοιπό μου",
    btn_settings: "⚙️ Ρυθμίσεις",
    reply_dev: "🛠 Αυτή η λειτουργία είναι υπό ανάπτυξη",
    reply_settings: "⚙️ Ρυθμίσεις:\nTake-Profit: 35%\nStop-Loss: 15%\nΠοσό: 0.05 SOL"
  }
};

export default async function handler(req, res) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (req.method === 'GET') {
      const host = req.headers.host;
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const webhookUrl = `${protocol}://${host}/api/bot`;
      const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${webhookUrl}`);
      const data = await response.json();
      return res.status(200).json({ message: "Webhook setup", data: data, url: webhookUrl });
  }

  try {
    const redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    
    const body = req.body;
    
    // ФУНКЦІЯ ДЛЯ ВІДПРАВКИ ПОВІДОМЛЕНЬ
    const sendMsg = async (chatId, text, keyboard = null) => {
      const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
      if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    };

    // ОБРОБКА ТЕКСТУ (/start)
    if (body.message && body.message.text) {
      const chatId = body.message.chat.id;
      const text = body.message.text;

      if (text === '/start') {
        const userKey = `user_${chatId}`;
        let userData = await redis.get(userKey);
        
        // Якщо юзера немає в базі - створюємо
        if (!userData) {
          const newWallet = Keypair.generate();
          userData = {
            walletAddress: newWallet.publicKey.toString(),
            privateKey: bs58.encode(newWallet.secretKey),
            settings: { tradeAmount: 0.05, takeProfit: 35, stopLoss: 15 },
            language: null, // Мова ще не обрана
            isActive: true
          };
          await redis.set(userKey, JSON.stringify(userData));
        } else if (typeof userData === 'string') {
           userData = JSON.parse(userData);
        }

        // Якщо мова не обрана, показуємо кнопки вибору мови
        if (!userData.language) {
          const langKeyboard = [
            [{ text: '🇬🇧 English', callback_data: 'lang_en' }],
            [{ text: '🇺🇦 Українська', callback_data: 'lang_uk' }],
            [{ text: '🇬🇷 Ελληνικά', callback_data: 'lang_el' }]
          ];
          await sendMsg(chatId, "Please choose your language / Оберіть мову / Επιλέξτε γλώσσα:", langKeyboard);
          return res.status(200).send('OK');
        }

        // Якщо мова вже є - показуємо головне меню тією мовою
        const lang = userData.language;
        const userName = body.message.from.first_name || '';
        const menuKeyboard = [
          [{ text: i18n[lang].btn_balance, callback_data: 'check_balance' }],
          [{ text: i18n[lang].btn_settings, callback_data: 'settings' }]
        ];
        await sendMsg(chatId, i18n[lang].welcome(userName, userData.walletAddress), menuKeyboard);
      }
    }
    
    // ОБРОБКА НАТИСКАНЬ НА КНОПКИ
    if (body.callback_query) {
      const chatId = body.callback_query.message.chat.id;
      const data = body.callback_query.data;
      
      const userKey = `user_${chatId}`;
      let userData = await redis.get(userKey);
      if (typeof userData === 'string') userData = JSON.parse(userData);
      
      if (!userData) return res.status(200).send('OK');

      // Якщо людина натиснула кнопку вибору мови
      if (data.startsWith('lang_')) {
        const chosenLang = data.split('_')[1]; // Отримуємо 'en', 'uk' або 'el'
        userData.language = chosenLang;
        await redis.set(userKey, JSON.stringify(userData)); // Зберігаємо мову в базу
        
        // Відправляємо головне меню вже обраною мовою
        const userName = body.callback_query.from.first_name || '';
        const menuKeyboard = [
          [{ text: i18n[chosenLang].btn_balance, callback_data: 'check_balance' }],
          [{ text: i18n[chosenLang].btn_settings, callback_data: 'settings' }]
        ];
        
        // Видаляємо повідомлення з вибором мови (щоб було красиво)
        await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: body.callback_query.message.message_id })
        });

        await sendMsg(chatId, i18n[chosenLang].welcome(userName, userData.walletAddress), menuKeyboard);
        return res.status(200).send('OK');
      }

      // Обробка інших кнопок (Баланс, Налаштування)
      const lang = userData.language || 'en';
      let replyText = i18n[lang].reply_dev;
      
      if (data === 'check_balance') replyText = i18n[lang].reply_dev; // Зробимо пізніше
      else if (data === 'settings') replyText = i18n[lang].reply_settings;

      // Спливаюче сповіщення
      await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: body.callback_query.id, text: replyText, show_alert: true })
      });
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error("Помилка:", error);
    return res.status(500).send('Error');
  }
}
