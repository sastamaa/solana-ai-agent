import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';

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
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
    const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
}

// --- СЛОВНИК ТЕКСТІВ (3 МОВИ) ---
const t = {
    uk: {
        welcome: (w, usd) => `👋 <b>Привіт! Я — твій автоматичний крипто-трейдер на базі штучного інтелекту.</b>\n\n🤖 <b>Що я роблю?</b>\nЯ працюю 24/7. Я сам знаходжу нові перспективні монети на Solana, купую їх і автоматично продаю, коли вони виростають у ціні. <i>Тобі взагалі не потрібно нічого робити вручну!</i>\n\n💼 <b>Твій особистий торговий гаманець:</b>\n<code>${w}</code>\n\n⚠️ <b>Як почати?</b>\nПросто перекажи на цю адресу мінімум <b>0.05 SOL (~$${usd})</b>. Ти можеш зробити це з гаманця Phantom або з будь-якої біржі (Binance, WhiteBIT). Як тільки гроші надійдуть, я почну роботу!`,
        status_msg: "📊 <b>Статус: АКТИВНИЙ 🟢</b>\n\nБот підключений до мережі та кожні 5 хвилин сканує нові монети на біржі.\n\n<i>Наразі ШІ відхиляє ризиковані токени та чекає на ідеальну точку входу. Як тільки він знайде безпечну монету з потенціалом росту — він автоматично купить її та надішле вам звіт! Бот не спамить пустими повідомленнями, він пише лише тоді, коли купує або продає.</i>",
        bal: (sol, usd) => `💰 <b>Твій баланс:</b>\n<b>${sol} SOL</b> (~$${usd})\n\n<i>(Для роботи бота завжди потрібно залишати хоча б 0.01 SOL для оплати комісій мережі)</i>`,
        with_prompt: "💸 <b>Виведення коштів</b>\n\nБудь ласка, надішли мені в чат <b>адресу твого гаманця Solana</b>, куди ти хочеш вивести гроші.\n\n<i>Я відправлю всі вільні кошти, залишивши лише мізерні ~0.005 SOL для оплати самої транзакції.</i>",
        err_with: "❌ <b>Помилка!</b> Можливо, на балансі недостатньо коштів або ти надіслав невірну адресу.",
        succ_with: (amount, usd, to, tx) => `✅ <b>Успішно виведено!</b>\n\n💸 Відправлено: <b>${amount} SOL</b> (~$${usd})\n📍 На адресу: <code>${to}</code>\n\n🔍 <a href="https://solscan.io/tx/${tx}">Подивитись чек</a>`,
        set_main: (s, usd) => `⚙️ <b>Налаштування ШІ-Снайпера:</b>\n\n💡 <i>Тут ти керуєш тим, як бот торгує:</i>\n\n💸 <b>Сума покупки:</b> ${s.tradeAmount} SOL (~$${usd})\n<i>— Скільки грошей бот витрачає на купівлю однієї монети.</i>\n\n📈 <b>Take-Profit (Прибуток):</b> +${s.takeProfit}%\n<i>— При якому плюсі бот продає монету (наприклад, якщо монета виросла на ${s.takeProfit}%, я продаю і фіксую твій дохід).</i>\n\n📉 <b>Stop-Loss (Захист):</b> -${s.stopLoss}%\n<i>— Захист від обвалу: при якому мінусі бот продає монету, щоб ти не втратив всі гроші.</i>`,
        btns: { status: "📊 Статус бота", bal: "💰 Мій баланс", with: "💸 Вивести", set: "⚙️ Налаштування", key: "🔑 Ключ", lang: "🌐 Змінити мову", back: "🔙 Назад", menu: "🔙 Меню", saved: "✅ Збережено!" }
    },
    en: {
        welcome: (w, usd) => `👋 <b>Hello! I am your AI-powered Crypto Trading Bot.</b>\n\n🤖 <b>What do I do?</b>\nI work 24/7. I find new promising coins on Solana, buy them, and automatically sell them when the price goes up. <i>You don't need to do anything manually!</i>\n\n💼 <b>Your personal trading wallet:</b>\n<code>${w}</code>\n\n⚠️ <b>How to start?</b>\nSimply send at least <b>0.05 SOL (~$${usd})</b> to this address. You can send from Phantom or any exchange (Binance, Bybit). Once funds arrive, I start trading!`,
        status_msg: "📊 <b>Status: ACTIVE 🟢</b>\n\nThe bot is connected to the network and scans new coins every 5 minutes. \n\n<i>Currently, the AI is rejecting risky tokens and waiting for the perfect entry point. As soon as it finds a safe coin with growth potential, it will automatically buy it and send you a report! The bot stays quiet and only messages you when an actual trade happens.</i>",
        bal: (sol, usd) => `💰 <b>Your Balance:</b>\n<b>${sol} SOL</b> (~$${usd})\n\n<i>(Keep at least 0.01 SOL on balance to cover network fees)</i>`,
        with_prompt: "💸 <b>Withdraw Funds</b>\n\nPlease send me your <b>Solana wallet address</b> where you want to receive your money.\n\n<i>I will send all available funds, leaving only ~0.005 SOL to pay for the transaction fee.</i>",
        err_with: "❌ <b>Error!</b> Insufficient funds or invalid address provided.",
        succ_with: (amount, usd, to, tx) => `✅ <b>Successfully withdrawn!</b>\n\n💸 Sent: <b>${amount} SOL</b> (~$${usd})\n📍 To: <code>${to}</code>\n\n🔍 <a href="https://solscan.io/tx/${tx}">View receipt</a>`,
        set_main: (s, usd) => `⚙️ <b>AI Sniper Settings:</b>\n\n💡 <i>Here you control how the bot trades:</i>\n\n💸 <b>Trade Amount:</b> ${s.tradeAmount} SOL (~$${usd})\n<i>— How much money the bot spends on buying one coin.</i>\n\n📈 <b>Take-Profit:</b> +${s.takeProfit}%\n<i>— When the coin grows by this percentage, the bot sells to secure your profit.</i>\n\n📉 <b>Stop-Loss:</b> -${s.stopLoss}%\n<i>— Protection: if the coin drops by this percentage, the bot sells to prevent bigger losses.</i>`,
        btns: { status: "📊 Bot Status", bal: "💰 My Balance", with: "💸 Withdraw", set: "⚙️ Settings", key: "🔑 Export Key", lang: "🌐 Change Language", back: "🔙 Back", menu: "🔙 Menu", saved: "✅ Saved!" }
    },
    el: {
        welcome: (w, usd) => `👋 <b>Γεια σας! Είμαι το AI Crypto Trading Bot σας.</b>\n\n🤖 <b>Τι κάνω;</b>\nΔουλεύω 24/7. Βρίσκω νέα υποσχόμενα νομίσματα στο Solana, τα αγοράζω και τα πουλάω αυτόματα όταν η τιμή ανεβαίνει. <i>Δεν χρειάζεται να κάνετε τίποτα χειροκίνητα!</i>\n\n💼 <b>Το προσωπικό σας πορτοφόλι συναλλαγών:</b>\n<code>${w}</code>\n\n⚠️ <b>Πώς να ξεκινήσετε;</b>\nΑπλά στείλτε τουλάχιστον <b>0.05 SOL (~$${usd})</b> σε αυτήν τη διεύθυνση. Μπορείτε να στείλετε από το Phantom ή από οποιοδήποτε ανταλλακτήριο (Binance, Bybit). Μόλις φτάσουν τα χρήματα, ξεκινάω τις συναλλαγές!`,
        status_msg: "📊 <b>Κατάσταση: ΕΝΕΡΓΟ 🟢</b>\n\nΤο bot είναι συνδεδεμένο στο δίκτυο και σαρώνει νέα νομίσματα κάθε 5 λεπτά.\n\n<i>Προς το παρόν, η AI απορρίπτει ριψοκίνδυνα tokens και περιμένει το τέλειο σημείο εισόδου. Μόλις βρει ένα ασφαλές νόμισμα με δυναμική ανάπτυξης, θα το αγοράσει αυτόματα και θα σας στείλει αναφορά!</i>",
        bal: (sol, usd) => `💰 <b>Το Υπόλοιπό σας:</b>\n<b>${sol} SOL</b> (~$${usd})\n\n<i>(Κρατήστε τουλάχιστον 0.01 SOL στο υπόλοιπο για τα τέλη δικτύου)</i>`,
        with_prompt: "💸 <b>Ανάληψη Χρημάτων</b>\n\nΠαρακαλώ στείλτε μου τη <b>διεύθυνση του πορτοφολιού σας Solana</b> όπου θέλετε να λάβετε τα χρήματά σας.\n\n<i>Θα στείλω όλα τα διαθέσιμα χρήματα, αφήνοντας μόνο ~0.005 SOL για τα τέλη συναλλαγής.</i>",
        err_with: "❌ <b>Σφάλμα!</b> Ανεπαρκές υπόλοιπο ή μη έγκυρη διεύθυνση.",
        succ_with: (amount, usd, to, tx) => `✅ <b>Η ανάληψη ήταν επιτυχής!</b>\n\n💸 Στάλθηκαν: <b>${amount} SOL</b> (~$${usd})\n📍 Προς: <code>${to}</code>\n\n🔍 <a href="https://solscan.io/tx/${tx}">Προβολή απόδειξης</a>`,
        set_main: (s, usd) => `⚙️ <b>Ρυθμίσεις AI Sniper:</b>\n\n💡 <i>Εδώ ελέγχετε πώς κάνει συναλλαγές το bot:</i>\n\n💸 <b>Ποσό Συναλλαγής:</b> ${s.tradeAmount} SOL (~$${usd})\n<i>— Πόσα χρήματα ξοδεύει το bot για την αγορά ενός νομίσματος.</i>\n\n📈 <b>Take-Profit (Κέρδος):</b> +${s.takeProfit}%\n<i>— Όταν το νόμισμα αυξηθεί κατά αυτό το ποσοστό, το bot πουλάει για να εξασφαλίσει το κέρδος σας.</i>\n\n📉 <b>Stop-Loss (Προστασία):</b> -${s.stopLoss}%\n<i>— Αν το νόμισμα πέσει κατά αυτό το ποσοστό, το bot πουλάει για να αποτρέψει μεγαλύτερες απώλειες.</i>`,
        btns: { status: "📊 Κατάσταση", bal: "💰 Υπόλοιπο", with: "💸 Ανάληψη", set: "⚙️ Ρυθμίσεις", key: "🔑 Κλειδί", lang: "🌐 Αλλαγή Γλώσσας", back: "🔙 Πίσω", menu: "🔙 Μενού", saved: "✅ Αποθηκεύτηκε!" }
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('Bot is running');

    try {
        const update = req.body;
        const solPrice = await getSolPrice();

        // Функція для створення клавіαтури головного меню
        const getMainMenuKeyboard = (l) => ({
            inline_keyboard: [
                [{ text: t[l].btns.status, callback_data: "check_status" }],
                [{ text: t[l].btns.bal, callback_data: "check_balance" }, { text: t[l].btns.with, callback_data: "withdraw" }],
                [{ text: t[l].btns.set, callback_data: "settings" }, { text: t[l].btns.key, callback_data: "export_key" }]
            ]
        });

        // Меню вибору мови
        const langKeyboard = { inline_keyboard: [
            [{ text: "🇺🇦 Українська", callback_data: "lang_uk" }],
            [{ text: "🇬🇧 English", callback_data: "lang_en" }],
            [{ text: "🇬🇷 Ελληνικά", callback_data: "lang_el" }]
        ]};

        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text === '/start') {
                await redis.del(`state_${chatId}`);
                let dbData = await redis.get(`user_${chatId}`);
                let userData;
                
                if (!dbData) {
                    const wallet = Keypair.generate();
                    userData = {
                        chatId, walletAddress: wallet.publicKey.toString(),
                        privateKey: bs58.encode(wallet.secretKey), isActive: true,
                        settings: { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 }, lang: null
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
                        const feeReserve = 5000000; 
                        if (balance <= feeReserve) throw new Error("No funds");

                        const transferAmount = balance - feeReserve;
                        const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromWallet.publicKey, toPubkey: toPublicKey, lamports: transferAmount }));
                        const { blockhash } = await connection.getLatestBlockhash('finalized');
                        transaction.recentBlockhash = blockhash; transaction.feePayer = fromWallet.publicKey; transaction.sign(fromWallet);

                        const txid = await connection.sendRawTransaction(transaction.serialize());
                        const amountUi = (transferAmount / 1e9).toFixed(5);
                        const usdAmount = (amountUi * solPrice).toFixed(2);

                        await sendMessage(chatId, t[l].succ_with(amountUi, usdAmount, text, txid));
                    } catch (e) {
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

            // ОБΡΟБКА ЗМІНИ МОВИ
            if (data.startsWith('lang_')) {
                userData.lang = data.replace('lang_', ''); // 'uk', 'en' або 'el'
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
                
                const l = userData.lang;
                const usdEst = (0.05 * solPrice).toFixed(2);
                await editMessage(chatId, messageId, t[l].welcome(userData.walletAddress, usdEst), getMainMenuKeyboard(l));
            }
            
            // Якщо мова ще не обрана, не продовжуємо
            if(!userData.lang) return res.status(200).send('OK');

            const l = userData.lang;
            const s = userData.settings;

            if (data === 'main_menu') {
                await redis.del(`state_${chatId}`);
                const usdEst = (0.05 * solPrice).toFixed(2);
                await editMessage(chatId, messageId, t[l].welcome(userData.walletAddress, usdEst), getMainMenuKeyboard(l));
            }
            
            else if (data === 'check_status') {
                await editMessage(chatId, messageId, t[l].status_msg, { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            }

            else if (data === 'check_balance') {
                const balance = await connection.getBalance(new PublicKey(userData.walletAddress));
                const sol = (balance / 1e9).toFixed(4);
                const usd = (sol * solPrice).toFixed(2);
                await editMessage(chatId, messageId, t[l].bal(sol, usd), { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            }

            else if (data === 'withdraw') {
                await redis.set(`state_${chatId}`, 'awaiting_withdraw', { ex: 3600 });
                await editMessage(chatId, messageId, t[l].with_prompt, { inline_keyboard: [[{ text: t[l].btns.back, callback_data: "main_menu" }]] });
            }
            
            else if (data === 'export_key') {
                let keyText = `🔑 <b>Key:</b>\n<code>${userData.privateKey}</code>`;
                if(l === 'uk') keyText = `🔑 <b>Приватний ключ:</b>\n<code>${userData.privateKey}</code>\n🚨 <i>Нікому його не показуй!</i>`;
                if(l === 'en') keyText = `🔑 <b>Private Key:</b>\n<code>${userData.privateKey}</code>\n🚨 <i>Do not share this!</i>`;
                if(l === 'el') keyText = `🔑 <b>Ιδιωτικό Κλειδί:</b>\n<code>${userData.privateKey}</code>\n🚨 <i>Μην το μοιράζεστε με κανέναν!</i>`;
                
                await editMessage(chatId, messageId, keyText, { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
            }
            
            else if (data === 'settings') {
                const usd = (s.tradeAmount * solPrice).toFixed(2);
                const keyboard = { inline_keyboard: [
                    [{ text: `💸 ${s.tradeAmount} SOL (~$${usd})`, callback_data: "edit_trade" }],
                    [{ text: `📈 Take-Profit: +${s.takeProfit}%`, callback_data: "edit_tp" }, { text: `📉 Stop-Loss: -${s.stopLoss}%`, callback_data: "edit_sl" }],
                    [{ text: t[l].btns.lang, callback_data: "choose_lang" }], // ΚΝΟΠКА ЗМІНИ ΜΟΒИ
                    [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                ]};
                await editMessage(chatId, messageId, t[l].set_main(s, usd), keyboard);
            }

            // ВІДКРИТТЯ МЕНЮ МОВИ З НАЛАШТУВАНЬ
            else if (data === 'choose_lang') {
                await editMessage(chatId, messageId, "🌐 <b>Choose your language:</b>", langKeyboard);
            }
            
            else if (data === 'edit_trade') {
                const keyboard = { inline_keyboard: [
                    [{ text: `0.02 SOL (~$${(0.02*solPrice).toFixed(2)})`, callback_data: "set_trade_0.02" }, { text: `0.05 SOL (~$${(0.05*solPrice).toFixed(2)})`, callback_data: "set_trade_0.05" }],
                    [{ text: `0.1 SOL (~$${(0.1*solPrice).toFixed(2)})`, callback_data: "set_trade_0.1" }, { text: `0.5 SOL (~$${(0.5*solPrice).toFixed(2)})`, callback_data: "set_trade_0.5" }],
                    [{ text: t[l].btns.back, callback_data: "settings" }]
                ]};
                let msg = "💸 <b>Обери суму для купівлі:</b>";
                if(l === 'en') msg = "💸 <b>Select trade amount:</b>";
                if(l === 'el') msg = "💸 <b>Επιλέξτε ποσό συναλλαγής:</b>";
                await editMessage(chatId, messageId, msg, keyboard);
            }
            
            else if (data === 'edit_tp') {
                const keyboard = { inline_keyboard: [
                    [{ text: "+10%", callback_data: "set_tp_10" }, { text: "+20%", callback_data: "set_tp_20" }],
                    [{ text: "+50%", callback_data: "set_tp_50" }, { text: "+100%", callback_data: "set_tp_100" }],
                    [{ text: t[l].btns.back, callback_data: "settings" }]
                ]};
                let msg = "📈 <b>Обери відсоток прибутку:</b>";
                if(l === 'en') msg = "📈 <b>Select Take-Profit:</b>";
                if(l === 'el') msg = "📈 <b>Επιλέξτε Take-Profit:</b>";
                await editMessage(chatId, messageId, msg, keyboard);
            }
            
            else if (data === 'edit_sl') {
                const keyboard = { inline_keyboard: [
                    [{ text: "-5%", callback_data: "set_sl_5" }, { text: "-10%", callback_data: "set_sl_10" }],
                    [{ text: "-15%", callback_data: "set_sl_15" }, { text: "-25%", callback_data: "set_sl_25" }],
                    [{ text: t[l].btns.back, callback_data: "settings" }]
                ]};
                let msg = "📉 <b>Обери захист (Stop-Loss):</b>";
                if(l === 'en') msg = "📉 <b>Select Stop-Loss:</b>";
                if(l === 'el') msg = "📉 <b>Επιλέξτε Stop-Loss:</b>";
                await editMessage(chatId, messageId, msg, keyboard);
            }
            
            else if (data.startsWith('set_')) {
                const parts = data.split('_');
                const val = parseFloat(parts[2]);
                if (parts[1] === 'trade') userData.settings.tradeAmount = val;
                else if (parts[1] === 'tp') userData.settings.takeProfit = val;
                else if (parts[1] === 'sl') userData.settings.stopLoss = val;
                
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
                
                const usd = (userData.settings.tradeAmount * solPrice).toFixed(2);
                const keyboard = { inline_keyboard: [
                    [{ text: `💸 ${userData.settings.tradeAmount} SOL (~$${usd})`, callback_data: "edit_trade" }],
                    [{ text: `📈 Take-Profit: +${userData.settings.takeProfit}%`, callback_data: "edit_tp" }, { text: `📉 Stop-Loss: -${userData.settings.stopLoss}%`, callback_data: "edit_sl" }],
                    [{ text: t[l].btns.lang, callback_data: "choose_lang" }],
                    [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                ]};
                await editMessage(chatId, messageId, `<b>${t[l].btns.saved}</b>\n\n` + t[l].set_main(userData.settings, usd), keyboard);
            }

            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: update.callback_query.id })
            });
        }
        res.status(200).send('OK');
    } catch (error) { res.status(500).send('Error'); }
}
