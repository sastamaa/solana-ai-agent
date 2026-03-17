import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  // Перевіряємо, чи це запит від Telegram (має бути POST)
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  try {
    const redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const body = req.body;
    
    // Перевіряємо, чи є текст у повідомленні
    if (body.message && body.message.text) {
      const chatId = body.message.chat.id;
      const text = body.message.text;
      const userName = body.message.from.first_name || 'Трейдер';

      // КОМАНДА: /start
      if (text === '/start') {
        const userKey = `user_${chatId}`;
        let userData = await redis.get(userKey);

        // Якщо клієнт новий, генеруємо йому унікальний гаманець
        if (!userData) {
          const newWallet = Keypair.generate();
          const publicKey = newWallet.publicKey.toString();
          const privateKey = bs58.encode(newWallet.secretKey);
          
          userData = {
            walletAddress: publicKey,
            privateKey: privateKey,
            settings: { tradeAmount: 0.05, takeProfit: 35, stopLoss: 15 },
            isActive: true
          };
          
          // Зберігаємо клієнта в базу даних
          await redis.set(userKey, JSON.stringify(userData));
          
          // Додаємо його ID в загальний список користувачів
          let allUsers = await redis.get('all_users_list') || [];
          if (!allUsers.includes(chatId)) {
             allUsers.push(chatId);
             await redis.set('all_users_list', allUsers);
          }
        } else if (typeof userData === 'string') {
           userData = JSON.parse(userData);
        }

        // Надсилаємо вітальне повідомлення з меню
        const welcomeText = `👋 Привіт, ${userName}!\nЯ твій персональний ШІ-снайпер на Solana.\n\n` +
                            `💼 <b>Твій торговий гаманець:</b>\n<code>${userData.walletAddress}</code>\n\n` +
                            `⚠️ <i>Поповни його мінімум на 0.1 SOL, щоб бот почав працювати. Це безпечний гаманець, до якого маєш доступ лише ти і бот.</i>`;
        
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: welcomeText,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '💰 Мій Баланс', callback_data: 'check_balance' }],
                [{ text: '⚙️ Налаштування', callback_data: 'settings' }, { text: '📈 Статистика', callback_data: 'stats' }],
                [{ text: '🔑 Вивести кошти (Withdraw)', callback_data: 'withdraw' }]
              ]
            }
          })
        });
      }
    }
    
    // Обробка натискань на кнопки (Callback Queries)
    if (body.callback_query) {
      const chatId = body.callback_query.message.chat.id;
      const data = body.callback_query.data;
      
      let replyText = "Ця функція ще в розробці 🛠";
      
      if (data === 'check_balance') {
          replyText = "🔍 Перевіряю баланс блокчейну... (Функція додається)";
      } else if (data === 'settings') {
          replyText = "⚙️ Налаштування бота:\nТейк-профіт: 35%\nСтоп-лос: 15%\nСума угоди: 0.05 SOL";
      }

      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: replyText })
      });
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error("Bot Error:", error);
    return res.status(500).send('Error');
  }
}
