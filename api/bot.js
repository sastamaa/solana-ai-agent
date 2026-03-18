import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';

// Підключення бази даних та блокчейну
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

// Функція для відправки повідомлень у Telegram
async function sendMessage(chatId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text: text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    
    await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot is running');

    try {
        const update = req.body;

        // --- 1. ОБРОБКА ТЕКСТОВИХ КОМАНД (наприклад /start) ---
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;
            const firstName = update.message.chat.first_name || "Користувач";

            if (text === '/start') {
                let userData = await redis.get(`user_${chatId}`);
                
                // Якщо користувач новий - створюємо гаманець
                if (!userData) {
                    const wallet = Keypair.generate();
                    userData = {
                        chatId: chatId,
                        walletAddress: wallet.publicKey.toString(),
                        privateKey: bs58.encode(wallet.secretKey),
                        isActive: true,
                        // Зменшені суми для старту з $10!
                        settings: { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 } 
                    };
                    await redis.set(`user_${chatId}`, JSON.stringify(userData));
                } else if (typeof userData === 'string') {
                    userData = JSON.parse(userData);
                }

                const welcomeText = `👋 <b>Привіт, ${firstName}!</b>\nЯ твій персональний ШІ-Снайпер на Solana.\n\n💼 <b>Твій торговий гаманець:</b>\n<code>${userData.walletAddress}</code>\n\n⚠️ <i>Поповни його мінімум на 0.05 SOL (≈ $10), щоб почати роботу.</i>`;
                
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "💰 Мій баланс", callback_data: "check_balance" }],
                        [{ text: "⚙️ Налаштування", callback_data: "settings" }],
                        [{ text: "🔑 Експорт приватного ключа", callback_data: "export_key" }]
                    ]
                };

                await sendMessage(chatId, welcomeText, keyboard);
            }
        }

        // --- 2. ОБРОБКА НАТИСКАНЬ НА КНОПКИ ---
        if (update.callback_query) {
            const chatId = update.callback_query.message.chat.id;
            const data = update.callback_query.data;
            
            let userDataStr = await redis.get(`user_${chatId}`);
            let userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;

            if (data === 'check_balance') {
                if (userData && userData.walletAddress) {
                    const balance = await connection.getBalance(new PublicKey(userData.walletAddress));
                    const sol = (balance / 1e9).toFixed(4);
                    await sendMessage(chatId, `💰 <b>Твій баланс:</b>\n<b>${sol} SOL</b>\n\n<i>Для роботи потрібно мінімум 0.05 SOL.</i>`);
                }
            } 
            else if (data === 'settings') {
                if (userData && userData.settings) {
                    const s = userData.settings;
                    const text = `⚙️ <b>Поточні налаштування:</b>\n\n💸 Сума однієї покупки: <b>${s.tradeAmount} SOL</b> (≈ $4)\n📈 Take-Profit: <b>+${s.takeProfit}%</b>\n📉 Stop-Loss: <b>-${s.stopLoss}%</b>\n\n<i>(Зміна налаштувань через меню буде додана в наступних оновленнях)</i>`;
                    await sendMessage(chatId, text);
                }
            }
            else if (data === 'export_key') {
                 if (userData && userData.privateKey) {
                    const text = `🔑 <b>Твій приватний ключ Phantom:</b>\n<code>${userData.privateKey}</code>\n\n🚨 <i>Ніколи і нікому не передавай його! Ти можеш імпортувати його в свій додаток Phantom, щоб контролювати кошти бота.</i>`;
                    await sendMessage(chatId, text);
                }
            }

            // Обов'язкова відповідь Telegram, щоб кнопка не "висіла" у стані завантаження
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: update.callback_query.id })
            });
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error("Bot Error:", error);
        res.status(500).send('Error');
    }
}
