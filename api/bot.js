import { Keypair, Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

// Функція для відправки НОВОГО повідомлення
async function sendMessage(chatId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text: text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Функція для РЕДАГУВАННЯ існуючого повідомлення (щоб кнопки оновлювалися в одному повідомленні)
async function editMessage(chatId, messageId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`;
    const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot is running');

    try {
        const update = req.body;

        // --- ОБРОБКА ТЕКСТОВИХ КОМАНД (/start) ---
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text;

            if (text === '/start') {
                let userDataStr = await redis.get(`user_${chatId}`);
                let userData;
                
                if (!userDataStr) {
                    const wallet = Keypair.generate();
                    userData = {
                        chatId: chatId, walletAddress: wallet.publicKey.toString(),
                        privateKey: bs58.encode(wallet.secretKey), isActive: true,
                        settings: { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 }
                    };
                    await redis.set(`user_${chatId}`, JSON.stringify(userData));
                } else {
                    userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;
                }

                const welcomeText = `👋 <b>Головне меню</b>\n\n💼 <b>Твій торговий гаманець:</b>\n<code>${userData.walletAddress}</code>\n\n⚠️ <i>Поповни його мінімум на 0.05 SOL, щоб почати роботу.</i>`;
                
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "💰 Мій баланс", callback_data: "check_balance" }],
                        [{ text: "⚙️ Налаштування", callback_data: "settings" }],
                        [{ text: "🔑 Експорт ключа", callback_data: "export_key" }]
                    ]
                };

                await sendMessage(chatId, welcomeText, keyboard);
            }
        }

        // --- ОБРОБКА НАТИСКАНЬ НА КНОПКИ ---
        if (update.callback_query) {
            const chatId = update.callback_query.message.chat.id;
            const messageId = update.callback_query.message.message_id;
            const data = update.callback_query.data;
            
            let userDataStr = await redis.get(`user_${chatId}`);
            let userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;
            
            // Захист: якщо налаштувань ще немає (у старих юзерів), створюємо їх
            if (!userData.settings) {
                userData.settings = { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 };
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
            }
            const s = userData.settings;

            // 1. КНОПКА: Назад в Головне меню
            if (data === 'main_menu') {
                const text = `🏠 <b>Головне меню</b>\n\n💼 <b>Твій гаманець:</b>\n<code>${userData.walletAddress}</code>`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "💰 Мій баланс", callback_data: "check_balance" }],
                        [{ text: "⚙️ Налаштування", callback_data: "settings" }],
                        [{ text: "🔑 Експорт ключа", callback_data: "export_key" }]
                    ]
                };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            // 2. КНОПКА: Баланс
            else if (data === 'check_balance') {
                const balance = await connection.getBalance(new PublicKey(userData.walletAddress));
                const sol = (balance / 1e9).toFixed(4);
                const text = `💰 <b>Твій баланс:</b>\n<b>${sol} SOL</b>`;
                const keyboard = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "main_menu" }]] };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            // 3. КНОПКА: Експорт ключа
            else if (data === 'export_key') {
                const text = `🔑 <b>Твій приватний ключ Phantom:</b>\n<code>${userData.privateKey}</code>\n\n🚨 <i>Ніколи не передавай його стороннім!</i>`;
                const keyboard = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "main_menu" }]] };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            // 4. КНОПКА: ГОЛОВНІ НАЛАШТУВАННЯ
            else if (data === 'settings') {
                const text = `⚙️ <b>Налаштування снайпера:</b>\nОбери параметр, який хочеш змінити:`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: `💸 Сума покупки: ${s.tradeAmount} SOL`, callback_data: "edit_trade" }],
                        [{ text: `📈 Take-Profit: +${s.takeProfit}%`, callback_data: "edit_tp" }],
                        [{ text: `📉 Stop-Loss: -${s.stopLoss}%`, callback_data: "edit_sl" }],
                        [{ text: "🔙 В головне меню", callback_data: "main_menu" }]
                    ]
                };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            // 5. ПІДМЕНЮ: Зміна суми покупки
            else if (data === 'edit_trade') {
                const text = `💸 <b>Обери суму для однієї покупки:</b>\n<i>Поточна: ${s.tradeAmount} SOL</i>`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "0.02 SOL (~$4)", callback_data: "set_trade_0.02" }, { text: "0.05 SOL (~$10)", callback_data: "set_trade_0.05" }],
                        [{ text: "0.1 SOL (~$20)", callback_data: "set_trade_0.1" }, { text: "0.5 SOL (~$100)", callback_data: "set_trade_0.5" }],
                        [{ text: "🔙 Назад", callback_data: "settings" }]
                    ]
                };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            // 6. ПІДМЕНЮ: Зміна Take-Profit
            else if (data === 'edit_tp') {
                const text = `📈 <b>Обери відсоток прибутку (Take-Profit):</b>\n<i>Поточний: +${s.takeProfit}%</i>`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "+10%", callback_data: "set_tp_10" }, { text: "+20%", callback_data: "set_tp_20" }],
                        [{ text: "+50%", callback_data: "set_tp_50" }, { text: "+100%", callback_data: "set_tp_100" }],
                        [{ text: "🔙 Назад", callback_data: "settings" }]
                    ]
                };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            // 7. ПІДМЕНЮ: Зміна Stop-Loss
            else if (data === 'edit_sl') {
                const text = `📉 <b>Обери максимально допустимий мінус (Stop-Loss):</b>\n<i>Поточний: -${s.stopLoss}%</i>`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "-5%", callback_data: "set_sl_5" }, { text: "-10%", callback_data: "set_sl_10" }],
                        [{ text: "-15%", callback_data: "set_sl_15" }, { text: "-25%", callback_data: "set_sl_25" }],
                        [{ text: "🔙 Назад", callback_data: "settings" }]
                    ]
                };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            // 8. ЗБЕРЕЖЕННЯ ОБРАНОГО ВАРІАНТУ
            else if (data.startsWith('set_')) {
                const parts = data.split('_'); // 'set', 'trade', '0.02'
                const settingType = parts[1]; 
                const value = parseFloat(parts[2]);
                
                if (settingType === 'trade') userData.settings.tradeAmount = value;
                else if (settingType === 'tp') userData.settings.takeProfit = value;
                else if (settingType === 'sl') userData.settings.stopLoss = value;
                
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
                
                // Повертаємось у меню налаштувань і показуємо оновлені дані
                const updatedS = userData.settings;
                const text = `✅ <b>Успішно збережено!</b>\n\n⚙️ <b>Налаштування снайпера:</b>`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: `💸 Сума покупки: ${updatedS.tradeAmount} SOL`, callback_data: "edit_trade" }],
                        [{ text: `📈 Take-Profit: +${updatedS.takeProfit}%`, callback_data: "edit_tp" }],
                        [{ text: `📉 Stop-Loss: -${updatedS.stopLoss}%`, callback_data: "edit_sl" }],
                        [{ text: "🔙 В головне меню", callback_data: "main_menu" }]
                    ]
                };
                await editMessage(chatId, messageId, text, keyboard);
            }

            // Відповідь для Telegram, щоб кнопка не "висіла" натиснутою
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
