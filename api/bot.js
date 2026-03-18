import { Keypair, Connection, PublicKey, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';
import fetch from 'node-fetch';

const OWNER_WALLET = new PublicKey("A9KVi2nKqbSbCbHJEfaYayJtHwCT5T5G29EhQQPNKPcn"); 
const FEE_PERCENT = 0.03; 
const BOT_USERNAME = process.env.BOT_USERNAME || "moneymakersol_bot"; 

const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

async function getSolPrice() {
    try {
        const res = await fetch('https://api.jup.ag/price/v2?ids=SOL', { signal: AbortSignal.timeout(1500) });
        const data = await res.json();
        return parseFloat(data.data.SOL.price);
    } catch(e) { return 180; } 
}

async function sendMessage(chatId, text, replyMarkup = null) {
    const body = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try { await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch(e) {}
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
    const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try { await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch(e) {}
}

const t = {
    uk: {
        welcome: (w, usd) => `👋 <b>Радий вітати вас! Я — ваш особистий ШІ-помічник для трейдингу.</b>\n\n💡 <b>Для кого я створений?</b>\nНавіть якщо ви ніколи не торгували криптовалютою, вам не потрібно хвилюватися. Моя мета — робити все за вас. Я цілодобово аналізую ринок Solana, знаходжу перспективні монети, купую їх на низах і продаю, коли вони приносять прибуток.\n\n💼 <b>Ваш особистий безпечний гаманець:</b>\n<code>${w}</code>\n\n🚀 <b>Як почати заробляти?</b>\nВам достатньо просто поповнити цей гаманець мінімум на <b>0.05 SOL (~$${usd})</b> з будь-якої біржі (Binance, Bybit) або гаманця Phantom. Як тільки кошти надійдуть, я автоматично почну сканувати ринок і здійснювати перші угоди для вас!`,
        bal: (sol, usd) => `💰 <b>Ваш поточний баланс:</b>\n<b>${sol} SOL</b> (~$${usd})\n\n<i>ℹ️ Порада: Завжди залишайте хоча б 0.01 SOL на балансі. Це потрібно для оплати мізерних комісій мережі Solana під час покупок і продажів.</i>`,
        with_prompt: "💸 <b>Безпечне виведення коштів</b>\n\nВи можете забрати свої гроші у будь-який момент. Будь ласка, надішліть мені повідомленням <b>адресу вашого зовнішнього гаманця Solana</b> (наприклад, з Phantom чи Binance).\n\n<i>ℹ️ Зверніть увагу: за користування моїми алгоритмами при виведенні стягується системна комісія 3%.</i>",
        err_with: "❌ <b>Ой, сталася помилка!</b> Можливо, у вас недостатньо коштів на балансі, або ви надіслали невірну адресу гаманця. Будь ласка, перевірте і спробуйте ще раз.",
        succ_with: (u, f, to, tx) => `✅ <b>Кошти успішно виведено!</b>\n\n💸 Відправлено на ваш гаманець: <b>${u} SOL</b>\n💎 Комісія ШІ (3%): <b>${f} SOL</b>\n📍 Адреса отримання: <code>${to}</code>\n\n🔍 Ви можете перевірити чек транзакції у блокчейні: <a href="https://solscan.io/tx/${tx}">Натисніть тут</a>`,
        ref_msg: (l) => `🎁 <b>Бонусна програма: Запроси друга!</b>\n\nВам подобається, як я працюю? Розкажіть про мене друзям і отримайте вигоду!\n\n🔗 <b>Ваше унікальне посилання:</b>\n<code>${l}</code>\n\n<b>Що ви отримаєте?</b>\nЯк тільки ваш друг перейде за посиланням і почне торгувати, <b>ваша комісія на вивід назавжди знизиться з 3% до 2%</b>! А ваш друг отримає вітальну знижку на комісію 2.5% замість 3%.`,
        set_main: (s, usd) => `⚙️ <b>Налаштування вашого ШІ-Снайпера</b>\n\nТут ви повністю контролюєте, як саме я маю працювати з вашими грошима:\n\n💸 <b>Сума однієї покупки:</b> ${s.tradeAmount} SOL (~$${usd})\n<i>(Яку суму я витрачатиму на покупку кожної нової монети)</i>\n\n📈 <b>Прибуток (Take-Profit):</b> +${s.takeProfit}%\n<i>(Як тільки монета виросте на цей відсоток, я одразу її продам, щоб зафіксувати ваш плюс)</i>\n\n📉 <b>Захист (Stop-Loss):</b> -${s.stopLoss}%\n<i>(Якщо монета раптом почне падати на цей відсоток, я швидко продам її, щоб ви не втратили більше)</i>`,
        btns: { status: "📊 Мій Портфель", bal: "💰 Баланс", with: "💸 Вивести", set: "⚙️ Налаштування", ref: "🎁 Бонуси", lang: "🌐 Мова", back: "🔙 Назад", menu: "🔙 В головне меню" }
    },
    en: {
        welcome: (w, usd) => `👋 <b>Welcome! I am your AI Trading Assistant.</b>\n\n💡 <b>How does it work?</b>\nYou don't need any trading experience. I analyze the Solana market 24/7, buy promising new coins at the bottom, and sell them when they pump to make you profit.\n\n💼 <b>Your secure wallet:</b>\n<code>${w}</code>\n\n🚀 <b>How to start?</b>\nSimply deposit at least <b>0.05 SOL (~$${usd})</b> to this address. Once funds arrive, I will automatically start scanning for the best trades!`,
        bal: (sol, usd) => `💰 <b>Your Balance:</b>\n<b>${sol} SOL</b> (~$${usd})\n\n<i>ℹ️ Tip: Always keep at least 0.01 SOL on balance to cover tiny network fees.</i>`,
        with_prompt: "💸 <b>Withdraw Funds</b>\n\nPlease send me your <b>Solana wallet address</b>.\n\n<i>ℹ️ Note: A 3% system fee is applied on withdrawals for using the AI algorithms.</i>",
        err_with: "❌ <b>Error!</b> Insufficient funds or invalid address provided.",
        succ_with: (u, f, to, tx) => `✅ <b>Successfully withdrawn!</b>\n\n💸 Sent to you: <b>${u} SOL</b>\n💎 AI fee (3%): <b>${f} SOL</b>\n📍 To: <code>${to}</code>\n\n🔍 <a href="https://solscan.io/tx/${tx}">View Receipt</a>`,
        ref_msg: (l) => `🎁 <b>Referral Bonus Program</b>\n\nInvite friends and get rewarded!\n\n🔗 <b>Your unique link:</b>\n<code>${l}</code>\n\n<b>What do you get?</b>\nWhen a friend starts trading, <b>your withdrawal fee will drop permanently from 3% to 2%</b>! Your friend will also get a discounted 2.5% fee.`,
        set_main: (s, usd) => `⚙️ <b>AI Sniper Settings</b>\n\n💸 <b>Trade Amount:</b> ${s.tradeAmount} SOL (~$${usd})\n📈 <b>Take-Profit:</b> +${s.takeProfit}%\n📉 <b>Stop-Loss:</b> -${s.stopLoss}%`,
        btns: { status: "📊 My Portfolio", bal: "💰 Balance", with: "💸 Withdraw", set: "⚙️ Settings", ref: "🎁 Bonuses", lang: "🌐 Language", back: "🔙 Back", menu: "🔙 Main Menu" }
    },
    el: {
        welcome: (w, usd) => `👋 <b>Καλώς ήρθατε! Είμαι ο AI Βοηθός Συναλλαγών σας.</b>\n\nΑναλύω την αγορά του Solana 24/7 και κάνω συναλλαγές για εσάς.\n\n💼 <b>Το πορτοφόλι σας:</b>\n<code>${w}</code>\n\n🚀 <b>Πώς να ξεκινήσετε;</b>\nΚαταθέστε τουλάχιστον <b>0.05 SOL (~$${usd})</b> σε αυτή τη διεύθυνση για να ξεκινήσω.`,
        bal: (sol, usd) => `💰 <b>Υπόλοιπο:</b>\n<b>${sol} SOL</b> (~$${usd})`,
        with_prompt: "💸 <b>Ανάληψη</b>\n\nΣτείλτε μου τη διεύθυνση Solana σας.\n<i>ℹ️ Υπάρχει χρέωση 3% στις αναλήψεις.</i>",
        err_with: "❌ Σφάλμα! Ανεπαρκές υπόλοιπο ή μη έγκυρη διεύθυνση.",
        succ_with: (u, f, to, tx) => `✅ <b>Επιτυχής ανάληψη!</b>\n💸 Σε εσάς: <b>${u} SOL</b>\n💎 Τέλος: <b>${f} SOL</b>`,
        ref_msg: (l) => `🎁 <b>Μπόνους Πρόσκλησης</b>\nΟ σύνδεσμός σας:\n<code>${l}</code>\nΠροσκαλέστε φίλους για να μειώσετε τα τέλη σας στο 2%!`,
        set_main: (s, usd) => `⚙️ <b>Ρυθμίσεις</b>\n💸 <b>Ποσό:</b> ${s.tradeAmount} SOL (~$${usd})\n📈 <b>Take-Profit:</b> +${s.takeProfit}%\n📉 <b>Stop-Loss:</b> -${s.stopLoss}%`,
        btns: { status: "📊 Χαρτοφυλάκιο", bal: "💰 Υπόλοιπο", with: "💸 Ανάληψη", set: "⚙️ Ρυθμίσεις", ref: "🎁 Μπόνους", lang: "🌐 Γλώσσα", back: "🔙 Πίσω", menu: "🔙 Μενού" }
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
                [{ text: t[l].btns.set, callback_data: "settings" }]
            ]
        });

        const langKeyboard = { inline_keyboard: [[{ text: "🇺🇦 Українська", callback_data: "lang_uk" }], [{ text: "🇬🇧 English", callback_data: "lang_en" }], [{ text: "🇬🇷 Ελληνικά", callback_data: "lang_el" }]]};

        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text.startsWith('/start')) {
                fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, action: 'typing' })
                }).catch(() => {});

                try {
                    await redis.del(`state_${chatId}`);
                    const refCode = text.split(' ')[1]; 
                    
                    let userDataStr = await redis.get(`user_${chatId}`);
                    let userData;
                    
                    if (!userDataStr) {
                        const wallet = Keypair.generate();
                        userData = {
                            chatId, walletAddress: wallet.publicKey.toString(), privateKey: bs58.encode(wallet.secretKey), isActive: true,
                            settings: { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 }, lang: null, refCount: 0,
                            invitedBy: refCode ? refCode.replace('ref_', '') : null
                        };
                        await redis.set(`user_${chatId}`, JSON.stringify(userData));
                        
                        // Якщо хтось запросив - додаємо йому +1 реферала
                        if (userData.invitedBy) {
                            let inviterStr = await redis.get(`user_${userData.invitedBy}`);
                            if (inviterStr) {
                                let inviterData = typeof inviterStr === 'string' ? JSON.parse(inviterStr) : inviterStr;
                                inviterData.refCount = (inviterData.refCount || 0) + 1;
                                await redis.set(`user_${userData.invitedBy}`, JSON.stringify(inviterData));
                            }
                        }
                    } else { userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr; }

                    if (!userData.lang) {
                        await sendMessage(chatId, "🌐 <b>Оберіть мову / Choose your language:</b>", langKeyboard);
                    } else {
                        const solPrice = await getSolPrice();
                        await sendMessage(chatId, t[userData.lang].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(userData.lang));
                    }
                } catch (e) { await sendMessage(chatId, "⚠️ System error."); }
                
                return res.status(200).send('OK');
            } 
            else {
                const state = await redis.get(`state_${chatId}`);
                if (state === 'awaiting_withdraw') {
                    await redis.del(`state_${chatId}`);
                    let userDataStr = await redis.get(`user_${chatId}`);
                    let userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;
                    const l = userData.lang || 'uk';
                    
                    try {
                        const toPublicKey = new PublicKey(text);
                        const fromWallet = Keypair.fromSecretKey(bs58.decode(userData.privateKey));
                        await sendMessage(chatId, "⏳...");

                        const balance = await connection.getBalance(fromWallet.publicKey);
                        if (balance <= 5000000) throw new Error("No funds");

                        const totalAvailable = balance - 5000000;
                        
                        // ЛОГІКА ЗНИЖКИ НА КОМІСІЮ
                        let currentFeePercent = FEE_PERCENT; // 3%
                        if (userData.refCount && userData.refCount >= 1) currentFeePercent = 0.02; // Якщо є реферали - 2%
                        if (userData.invitedBy && (!userData.refCount || userData.refCount === 0)) currentFeePercent = 0.025; // Якщо прийшов від друга - 2.5%

                        const ownerFeeLamports = Math.floor(totalAvailable * currentFeePercent);
                        const userLamports = totalAvailable - ownerFeeLamports;

                        const transaction = new Transaction();
                        transaction.add(SystemProgram.transfer({ fromPubkey: fromWallet.publicKey, toPubkey: toPublicKey, lamports: userLamports }));
                        if (ownerFeeLamports > 0) transaction.add(SystemProgram.transfer({ fromPubkey: fromWallet.publicKey, toPubkey: OWNER_WALLET, lamports: ownerFeeLamports }));

                        const { blockhash } = await connection.getLatestBlockhash('finalized');
                        transaction.recentBlockhash = blockhash; transaction.feePayer = fromWallet.publicKey; transaction.sign(fromWallet);

                        const txid = await connection.sendRawTransaction(transaction.serialize());
                        await sendMessage(chatId, t[l].succ_with((userLamports / 1e9).toFixed(5), (ownerFeeLamports / 1e9).toFixed(5), text, txid));
                    } catch (e) { await sendMessage(chatId, t[l].err_with); }
                    return res.status(200).send('OK');
                }
            }
        }

        if (update.callback_query) {
            const chatId = update.callback_query.message.chat.id;
            const messageId = update.callback_query.message.message_id;
            const data = update.callback_query.data;
            
            try { await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: update.callback_query.id }) }); } catch(e) {}
            
            let dbData = await redis.get(`user_${chatId}`);
            let userData = typeof dbData === 'string' ? JSON.parse(dbData) : dbData;

            if (data.startsWith('lang_')) {
                userData.lang = data.replace('lang_', '');
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
                const solPrice = await getSolPrice();
                await editMessage(chatId, messageId, t[userData.lang].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(userData.lang));
                return res.status(200).send('OK');
            }
            if(!userData.lang) return res.status(200).send('OK');
            
            const l = userData.lang;

            try {
                if (data === 'main_menu') {
                    await redis.del(`state_${chatId}`);
                    await editMessage(chatId, messageId, t[l].welcome(userData.walletAddress, (0.05 * 180).toFixed(2)), getMainMenuKeyboard(l));
                }
                else if (data === 'check_status') {
                    await editMessage(chatId, messageId, "⏳ <i>Аналізую ваш портфель у блокчейні...</i>", { inline_keyboard: [] });
                    
                    const solPrice = await getSolPrice();
                    let portfolioText = l === 'uk' ? "📊 <b>Детальний статус вашого портфеля:</b>\n\n🟢 <b>ШІ:</b> АКТИВНИЙ (Сканує ринок)\n" : (l === 'en' ? "📊 <b>Portfolio Status:</b>\n\n🟢 <b>AI:</b> ACTIVE\n" : "📊 <b>Κατάσταση Χαρτοφυλακίου:</b>\n\n🟢 <b>AI:</b> ΕΝΕΡΓΟ\n");
                    
                    try {
                        const walletPubKey = new PublicKey(userData.walletAddress);
                        const accounts = await connection.getParsedTokenAccountsByOwner(walletPubKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
                        const solMint = "So11111111111111111111111111111111111111112";
                        
                        let hasTokens = false;
                        for (const acc of accounts.value) {
                            const amountInfo = acc.account.data.parsed.info.tokenAmount;
                            const mint = acc.account.data.parsed.info.mint;
                            
                            if (amountInfo.uiAmount > 0 && mint !== solMint) {
                                hasTokens = true;
                                // Читаємо ціну покупки з Upstash, щоб показати PNL
                                const buyPriceStr = await redis.get(`buy_price_${mint}_${chatId}`);
                                let pnlInfo = "";
                                
                                try {
                                    // Отримуємо поточну ціну монети
                                    const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                                    const dexData = await dexRes.json();
                                    if (dexData.pairs && dexData.pairs.length > 0) {
                                        const symbol = dexData.pairs[0].baseToken.symbol;
                                        const currentPrice = parseFloat(dexData.pairs[0].priceUsd);
                                        const totalUsd = (amountInfo.uiAmount * currentPrice).toFixed(2);
                                        
                                        if (buyPriceStr) {
                                            const buyPrice = parseFloat(buyPriceStr);
                                            const percentChange = ((currentPrice - buyPrice) / buyPrice) * 100;
                                            const emoji = percentChange >= 0 ? "🟩" : "🟥";
                                            const sign = percentChange >= 0 ? "+" : "";
                                            pnlInfo = `${emoji} ${sign}${percentChange.toFixed(2)}% | ~$${totalUsd}`;
                                        } else {
                                            pnlInfo = `~$${totalUsd}`;
                                        }
                                        portfolioText += `\n🪙 <b>${symbol}:</b> ${amountInfo.uiAmount} шт.\n   └ ${pnlInfo}`;
                                    }
                                } catch (e) {
                                    portfolioText += `\n🪙 Token: ${amountInfo.uiAmount} шт.`;
                                }
                            }
                        }
                        if (!hasTokens) {
                            portfolioText += l === 'uk' ? "\n\n<i>Наразі всі монети продані, ШІ чекає нових токенів для покупки.</i>" : "\n\n<i>Waiting for new tokens to buy.</i>";
                        }
                    } catch (e) {
                        portfolioText += "\n⚠️ Не вдалося завантажити токени.";
                    }

                    await editMessage(chatId, messageId, portfolioText, { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
                }
                else if (data === 'check_balance') {
                    await editMessage(chatId, messageId, "⏳...", { inline_keyboard: [] });
                    const balance = await connection.getBalance(new PublicKey(userData.walletAddress));
                    const solPrice = await getSolPrice();
                    await editMessage(chatId, messageId, t[l].bal((balance / 1e9).toFixed(4), ((balance / 1e9) * solPrice).toFixed(2)), { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
                }
                else if (data === 'withdraw') {
                    await redis.set(`state_${chatId}`, 'awaiting_withdraw', { ex: 3600 });
                    await editMessage(chatId, messageId, t[l].with_prompt, { inline_keyboard: [[{ text: t[l].btns.back, callback_data: "main_menu" }]] });
                }
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
                    await editMessage(chatId, messageId, t[l].set_main(userData.settings, "..."), keyboard);
                }
                else if (data === 'choose_lang') {
                    await editMessage(chatId, messageId, "🌐 <b>Choose your language:</b>", langKeyboard);
                }
                else if (data === 'edit_trade') {
                    const keyboard = { inline_keyboard: [[{ text: `0.02 SOL`, callback_data: "set_trade_0.02" }, { text: `0.05 SOL`, callback_data: "set_trade_0.05" }], [{ text: `0.1 SOL`, callback_data: "set_trade_0.1" }, { text: `0.5 SOL`, callback_data: "set_trade_0.5" }], [{ text: t[l].btns.back, callback_data: "settings" }]]};
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
                    
                    const keyboard = { inline_keyboard: [
                        [{ text: `💸 ${userData.settings.tradeAmount} SOL`, callback_data: "edit_trade" }, { text: `📈 TP: +${userData.settings.takeProfit}%`, callback_data: "edit_tp" }],
                        [{ text: t[l].btns.lang, callback_data: "choose_lang" }, { text: `📉 SL: -${userData.settings.stopLoss}%`, callback_data: "edit_sl" }],
                        [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                    ]};
                    await editMessage(chatId, messageId, "✅\n\n" + t[l].set_main(userData.settings, "..."), keyboard);
                }
            } catch (err) {}
            return res.status(200).send('OK');
        }
        return res.status(200).send('OK');
    } catch (error) { return res.status(200).send('OK'); }
}
