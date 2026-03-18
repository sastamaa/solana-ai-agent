import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

async function sendMessage(chatId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`;
    const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot is running');

    try {
        const update = req.body;

        // --- 1. ОБРОБКА ТЕКСТОВИХ ПОВІДОМЛЕНЬ ---
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text === '/start') {
                await redis.del(`state_${chatId}`); // Очищаємо всі стани
                
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
                        [{ text: "💸 Вивести SOL", callback_data: "withdraw" }],
                        [{ text: "⚙️ Налаштування", callback_data: "settings" }, { text: "🔑 Ключ", callback_data: "export_key" }]
                    ]
                };
                await sendMessage(chatId, welcomeText, keyboard);
            } 
            else {
                // ПЕРЕВІРКА: Чи чекає бот на введення адреси для виведення?
                const state = await redis.get(`state_${chatId}`);
                if (state === 'awaiting_withdraw') {
                    await redis.del(`state_${chatId}`); // Одразу видаляємо стан, щоб уникнути спаму
                    
                    try {
                        const toPublicKey = new PublicKey(text); // Перевіряємо, чи це валідна адреса Solana
                        
                        let userDataStr = await redis.get(`user_${chatId}`);
                        let userData = JSON.parse(userDataStr);
                        const fromWallet = Keypair.fromSecretKey(bs58.decode(userData.privateKey));
                        
                        await sendMessage(chatId, "⏳ Обробка транзакції... Зачекайте.");

                        const balance = await connection.getBalance(fromWallet.publicKey);
                        const feeReserve = 5000000; // Залишаємо 0.005 SOL на комісію
                        
                        if (balance <= feeReserve) {
                            await sendMessage(chatId, "❌ Недостатньо коштів для виведення. На балансі має бути більше 0.005 SOL.");
                            return res.status(200).send('OK');
                        }

                        const transferAmount = balance - feeReserve;
                        
                        const transaction = new Transaction().add(
                            SystemProgram.transfer({
                                fromPubkey: fromWallet.publicKey,
                                toPubkey: toPublicKey,
                                lamports: transferAmount,
                            })
                        );

                        const { blockhash } = await connection.getLatestBlockhash('finalized');
                        transaction.recentBlockhash = blockhash;
                        transaction.feePayer = fromWallet.publicKey;
                        transaction.sign(fromWallet);

                        const txid = await connection.sendRawTransaction(transaction.serialize());
                        const amountUi = (transferAmount / 1e9).toFixed(5);

                        await sendMessage(chatId, `✅ <b>Успішно виведено!</b>\n\n💸 Відправлено: <b>${amountUi} SOL</b>\n📍 На адресу: <code>${toPublicKey.toString()}</code>\n\n🔍 <a href="https://solscan.io/tx/${txid}">Подивитись чек (Solscan)</a>`);
                    } catch (e) {
                        console.error("Withdraw error:", e);
                        await sendMessage(chatId, "❌ <b>Помилка!</b> Ви надіслали невірну адресу гаманця Solana або сталася помилка мережі.\n\nНатисніть /start, щоб спробувати ще раз.");
                    }
                }
            }
        }

        // --- 2. ОБРОБКА НАТИСКАНЬ НА КНОПКИ ---
        if (update.callback_query) {
            const chatId = update.callback_query.message.chat.id;
            const messageId = update.callback_query.message.message_id;
            const data = update.callback_query.data;
            
            let userDataStr = await redis.get(`user_${chatId}`);
            let userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;
            const s = userData.settings || { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 };

            if (data === 'main_menu') {
                await redis.del(`state_${chatId}`); // Скидаємо стани при поверненні в меню
                const text = `🏠 <b>Головне меню</b>\n\n💼 <b>Твій гаманець:</b>\n<code>${userData.walletAddress}</code>`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "💰 Мій баланс", callback_data: "check_balance" }],
                        [{ text: "💸 Вивести SOL", callback_data: "withdraw" }],
                        [{ text: "⚙️ Налаштування", callback_data: "settings" }, { text: "🔑 Ключ", callback_data: "export_key" }]
                    ]
                };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            else if (data === 'check_balance') {
                const balance = await connection.getBalance(new PublicKey(userData.walletAddress));
                const sol = (balance / 1e9).toFixed(4);
                const text = `💰 <b>Твій баланс:</b>\n<b>${sol} SOL</b>`;
                const keyboard = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "main_menu" }]] };
                await editMessage(chatId, messageId, text, keyboard);
            }

            // НОВА КНОПКА: Виведення коштів
            else if (data === 'withdraw') {
                await redis.set(`state_${chatId}`, 'awaiting_withdraw', { ex: 3600 }); // Чекаємо адресу 1 годину
                const text = `💸 <b>Виведення коштів</b>\n\nБудь ласка, надішліть у чат <b>адресу вашого гаманця Solana</b> (наприклад, з Binance, Bybit або Phantom), куди вивести всі вільні SOL.\n\n<i>Для скасування натисніть "Назад" або /start.</i>`;
                const keyboard = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "main_menu" }]] };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            else if (data === 'export_key') {
                const text = `🔑 <b>Приватний ключ Phantom:</b>\n<code>${userData.privateKey}</code>\n\n🚨 <i>Ніколи не передавай його стороннім!</i>`;
                const keyboard = { inline_keyboard: [[{ text: "🔙 Назад", callback_data: "main_menu" }]] };
                await editMessage(chatId, messageId, text, keyboard);
            }
            
            else if (data === 'settings') {
                const text = `⚙️ <b>Налаштування снайпера:</b>`;
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
            
            else if (data === 'edit_trade') {
                const keyboard = { inline_keyboard: [
                    [{ text: "0.02 SOL", callback_data: "set_trade_0.02" }, { text: "0.05 SOL", callback_data: "set_trade_0.05" }],
                    [{ text: "0.1 SOL", callback_data: "set_trade_0.1" }, { text: "0.5 SOL", callback_data: "set_trade_0.5" }],
                    [{ text: "🔙 Назад", callback_data: "settings" }]
                ]};
                await editMessage(chatId, messageId, `💸 <b>Обери суму для однієї покупки:</b>`, keyboard);
            }
            
            else if (data === 'edit_tp') {
                const keyboard = { inline_keyboard: [
                    [{ text: "+10%", callback_data: "set_tp_10" }, { text: "+20%", callback_data: "set_tp_20" }],
                    [{ text: "+50%", callback_data: "set_tp_50" }, { text: "+100%", callback_data: "set_tp_100" }],
                    [{ text: "🔙 Назад", callback_data: "settings" }]
                ]};
                await editMessage(chatId, messageId, `📈 <b>Обери відсоток прибутку (Take-Profit):</b>`, keyboard);
            }
            
            else if (data === 'edit_sl') {
                const keyboard = { inline_keyboard: [
                    [{ text: "-5%", callback_data: "set_sl_5" }, { text: "-10%", callback_data: "set_sl_10" }],
                    [{ text: "-15%", callback_data: "set_sl_15" }, { text: "-25%", callback_data: "set_sl_25" }],
                    [{ text: "🔙 Назад", callback_data: "settings" }]
                ]};
                await editMessage(chatId, messageId, `📉 <b>Обери максимально допустимий мінус (Stop-Loss):</b>`, keyboard);
            }
            
            else if (data.startsWith('set_')) {
                const parts = data.split('_');
                const settingType = parts[1]; 
                const value = parseFloat(parts[2]);
                
                if (settingType === 'trade') userData.settings.tradeAmount = value;
                else if (settingType === 'tp') userData.settings.takeProfit = value;
                else if (settingType === 'sl') userData.settings.stopLoss = value;
                
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
                
                const updatedS = userData.settings;
                const keyboard = { inline_keyboard: [
                    [{ text: `💸 Сума: ${updatedS.tradeAmount} SOL`, callback_data: "edit_trade" }],
                    [{ text: `📈 Take-Profit: +${updatedS.takeProfit}%`, callback_data: "edit_tp" }],
                    [{ text: `📉 Stop-Loss: -${updatedS.stopLoss}%`, callback_data: "edit_sl" }],
                    [{ text: "🔙 В головне меню", callback_data: "main_menu" }]
                ]};
                await editMessage(chatId, messageId, `✅ <b>Збережено!</b>\n\n⚙️ <b>Налаштування:</b>`, keyboard);
            }

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
