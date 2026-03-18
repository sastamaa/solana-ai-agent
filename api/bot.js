import { Keypair, Connection, PublicKey, Transaction, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { Redis } from '@upstash/redis';
import fetch from 'node-fetch';

const OWNER_WALLET = new PublicKey("A9KVi2nKqbSbCbHJEfaYayJtHwCT5T5G29EhQQPNKPcn"); 
const FEE_PERCENT = 0.03; 
const BOT_USERNAME = process.env.BOT_USERNAME || "moneymakersol_bot"; 

const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=15319ab4-3e9a-4c28-98e8-132d733db9b9');


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

// Функція для екстреного продажу (Panic Sell)
async function panicSellAll(chatId, privateKey, langDict) {
    try {
        const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
        const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
        const solMint = "So11111111111111111111111111111111111111112";
        const jupHeaders = { 'Content-Type': 'application/json', 'x-api-key': process.env.JUPITER_API_KEY };
        let soldCount = 0;

        for (const acc of accounts.value) {
            const amountInfo = acc.account.data.parsed.info.tokenAmount;
            const mint = acc.account.data.parsed.info.mint;
            if (amountInfo.uiAmount > 0 && mint !== solMint) {
                try {
                    const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${solMint}&amount=${amountInfo.amount}&slippageBps=300`, { headers: jupHeaders });
                    const quoteData = await quoteRes.json();
                    
                    const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: jupHeaders, body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) });
                    const swapData = await swapRes.json();
                    
                    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                    transaction.sign([wallet]);
                    await connection.sendRawTransaction(transaction.serialize());
                    await redis.del(`buy_price_${mint}_${chatId}`);
                    soldCount++;
                } catch (e) {}
            }
        }
        return soldCount;
    } catch (error) { return 0; }
}

const t = {
    uk: {
        welcome: (w, usd) => `👋 <b>Радий вітати вас! Я — ваш особистий ШІ-помічник для трейдингу.</b>\n\n💡 <b>Для кого я створений?</b>\nНавіть якщо ви ніколи не торгували криптовалютою, вам не потрібно хвилюватися. Моя мета — робити все за вас. Я цілодобово аналізую ринок Solana, знаходжу перспективні монети, купую їх на низах і продаю, коли вони приносять прибуток.\n\n💼 <b>Ваш безпечний гаманець:</b>\n<code>${w}</code>\n\n🚀 <b>Як почати заробляти?</b>\nПоповніть цей гаманець мінімум на <b>0.05 SOL (~$${usd})</b>. Як тільки кошти надійдуть, я почну торгувати!`,
        port_head: "📊 <b>Ваш Портфель та Баланс:</b>\n\n",
        with_prompt: "💸 <b>Безпечне виведення коштів</b>\n\nБудь ласка, надішліть мені повідомленням <b>адресу вашого гаманця Solana</b> (з Phantom чи Binance).\n\n<i>ℹ️ Зверніть увагу: за користування алгоритмами стягується комісія 3%.</i>",
        err_with: "❌ <b>Помилка!</b> Недостатньо коштів або невірна адреса.",
        succ_with: (u, f, to, tx) => `✅ <b>Успішно виведено!</b>\n\n💸 Вам: <b>${u} SOL</b>\n💎 Комісія ШІ (3%): <b>${f} SOL</b>\n📍 На: <code>${to}</code>\n🔍 <a href="https://solscan.io/tx/${tx}">Чек</a>`,
        ref_msg: (l) => `🎁 <b>Бонуси: Запроси друга!</b>\n\n🔗 <b>Ваше посилання:</b>\n<code>${l}</code>\n\nЯк тільки друг почне торгувати, <b>ваша комісія на вивід назавжди знизиться з 3% до 2%</b>!`,
        set_main: (s, usd) => `⚙️ <b>Налаштування ШІ</b>\n\n💸 <b>Сума покупки:</b> ${s.tradeAmount} SOL (~$${usd})\n📈 <b>Прибуток:</b> +${s.takeProfit}%\n📉 <b>Захист:</b> -${s.stopLoss}%`,
        panic_conf: "✅ <b>Екстрений продаж запущено.</b> Всі монети будуть конвертовані в SOL протягом хвилини.",
        panic_err: "⚠️ Не знайдено монет для продажу.",
        btns: { port: "📊 Мій Портфель", with: "💸 Вивести", set: "⚙️ Налаштування", ref: "🎁 Бонуси", lang: "🌐 Мова", back: "🔙 Назад", menu: "🔙 Меню", panic: "🚨 Екстрений Продаж" }
    },
    en: {
        welcome: (w, usd) => `👋 <b>Welcome! I am your AI Trading Assistant.</b>\n\n💼 <b>Your secure wallet:</b>\n<code>${w}</code>\n\n🚀 <b>How to start?</b>\nDeposit at least <b>0.05 SOL (~$${usd})</b>. I will automatically start scanning for trades!`,
        port_head: "📊 <b>Your Portfolio & Balance:</b>\n\n",
        with_prompt: "💸 <b>Withdraw Funds</b>\n\nPlease send me your <b>Solana wallet address</b>.\n\n<i>ℹ️ Note: A 3% system fee is applied.</i>",
        err_with: "❌ <b>Error!</b> Insufficient funds or invalid address.",
        succ_with: (u, f, to, tx) => `✅ <b>Successfully withdrawn!</b>\n💸 To you: <b>${u} SOL</b>\n💎 AI fee: <b>${f} SOL</b>\n🔍 <a href="https://solscan.io/tx/${tx}">Receipt</a>`,
        ref_msg: (l) => `🎁 <b>Referrals</b>\n🔗 <b>Link:</b>\n<code>${l}</code>\nInvite friends to reduce your fee to 2%!`,
        set_main: (s, usd) => `⚙️ <b>Settings</b>\n💸 <b>Trade Amount:</b> ${s.tradeAmount} SOL (~$${usd})\n📈 <b>Take-Profit:</b> +${s.takeProfit}%\n📉 <b>Stop-Loss:</b> -${s.stopLoss}%`,
        panic_conf: "✅ <b>Panic Sell initiated.</b> All tokens will be sold to SOL.",
        panic_err: "⚠️ No tokens found to sell.",
        btns: { port: "📊 Portfolio", with: "💸 Withdraw", set: "⚙️ Settings", ref: "🎁 Bonuses", lang: "🌐 Language", back: "🔙 Back", menu: "🔙 Menu", panic: "🚨 Panic Sell" }
    },
    el: {
        welcome: (w, usd) => `👋 <b>Καλώς ήρθατε! Είμαι ο AI Βοηθός Συναλλαγών σας.</b>\n\n💼 <b>Το πορτοφόλι σας:</b>\n<code>${w}</code>\n\n🚀 <b>Πώς να ξεκινήσετε;</b>\nΚαταθέστε <b>0.05 SOL (~$${usd})</b>.`,
        port_head: "📊 <b>Χαρτοφυλάκιο & Υπόλοιπο:</b>\n\n",
        with_prompt: "💸 <b>Ανάληψη</b>\nΣτείλτε μου τη διεύθυνση Solana σας.\n<i>ℹ️ Υπάρχει χρέωση 3%.</i>",
        err_with: "❌ Σφάλμα!",
        succ_with: (u, f, to, tx) => `✅ <b>Επιτυχής ανάληψη!</b>\n💸 Σε εσάς: <b>${u} SOL</b>`,
        ref_msg: (l) => `🎁 <b>Μπόνους</b>\nΟ σύνδεσμός σας:\n<code>${l}</code>`,
        set_main: (s, usd) => `⚙️ <b>Ρυθμίσεις</b>\n💸 <b>Ποσό:</b> ${s.tradeAmount} SOL\n📈 <b>TP:</b> +${s.takeProfit}%\n📉 <b>SL:</b> -${s.stopLoss}%`,
        panic_conf: "✅ <b>Επείγουσα Πώληση ξεκίνησε.</b>",
        panic_err: "⚠️ Δεν βρέθηκαν νομίσματα.",
        btns: { port: "📊 Χαρτοφυλάκιο", with: "💸 Ανάληψη", set: "⚙️ Ρυθμίσεις", ref: "🎁 Μπόνους", lang: "🌐 Γλώσσα", back: "🔙 Πίσω", menu: "🔙 Μενού", panic: "🚨 Επείγουσα Πώληση" }
    }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    try {
        const update = req.body;

        const getMainMenuKeyboard = (l) => ({
            inline_keyboard: [
                [{ text: t[l].btns.port, callback_data: "portfolio" }, { text: t[l].btns.ref, callback_data: "referral" }],
                [{ text: t[l].btns.set, callback_data: "settings" }, { text: t[l].btns.with, callback_data: "withdraw" }]
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
                        
                        if (userData.invitedBy) {
                            let inviterStr = await redis.get(`user_${userData.invitedBy}`);
                            if (inviterStr) {
                                let inviterData = typeof inviterStr === 'string' ? JSON.parse(inviterStr) : inviterStr;
                                inviterData.refCount = (inviterData.refCount || 0) + 1;
                                await redis.set(`user_${userData.invitedBy}`, JSON.stringify(inviterData));
                            }
                        }
                    } else { userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr; }

                    if (!userData.lang) { await sendMessage(chatId, "🌐 <b>Choose your language:</b>", langKeyboard); } 
                    else {
                        const solPrice = await getSolPrice();
                        await sendMessage(chatId, t[userData.lang].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(userData.lang));
                    }
                } catch (e) {}
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
                        let currentFeePercent = FEE_PERCENT;
                        if (userData.refCount && userData.refCount >= 1) currentFeePercent = 0.02; 
                        if (userData.invitedBy && (!userData.refCount || userData.refCount === 0)) currentFeePercent = 0.025; 

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
                               else if (data === 'portfolio') {
                    await editMessage(chatId, messageId, "⏳ <i>Аналізую блокчейн...</i>", { inline_keyboard: [] });
                    const solPrice = await getSolPrice();
                    const balance = await connection.getBalance(new PublicKey(userData.walletAddress));
                    const solUi = (balance / 1e9).toFixed(4);
                    const usdBal = (solUi * solPrice).toFixed(2);

                    let portfolioText = t[l].port_head;
                    portfolioText += `💰 <b>Баланс:</b> ${solUi} SOL (~$${usdBal})\n`;
                    portfolioText += `🟢 <b>ШІ-Агент:</b> Активний\n\n`;
                    portfolioText += `🪙 <b>Куплені токени:</b>\n`;
                    
                    let hasTokens = false;
                    try {
                        const accounts = await connection.getParsedTokenAccountsByOwner(new PublicKey(userData.walletAddress), { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
                        const solMint = "So11111111111111111111111111111111111111112";
                        
                        for (const acc of accounts.value) {
                            const amountInfo = acc.account.data.parsed.info.tokenAmount;
                            const mint = acc.account.data.parsed.info.mint;
                            
                            // Показуємо ВСІ токени, окрім основної Solana, якщо їх кількість більше 0
                            if (amountInfo.uiAmount > 0 && mint !== solMint) {
                                hasTokens = true;
                                const buyPriceStr = await redis.get(`buy_price_${mint}_${chatId}`);
                                let pnlInfo = "<i>Аналіз ціни...</i>";
                                let tokenName = `${mint.substring(0, 4)}...${mint.slice(-4)}`; // За замовчуванням показуємо адресу
                                
                                try {
                                    const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                                    const dexData = await dexRes.json();
                                    if (dexData.pairs && dexData.pairs.length > 0) {
                                        tokenName = dexData.pairs[0].baseToken.name || dexData.pairs[0].baseToken.symbol;
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
                                    }
                                } catch (e) {
                                    // Якщо не вдалося завантажити ціну, залишаємо адресу замість імені
                                }
                                
                                portfolioText += `🔸 <b>${tokenName}:</b> ${amountInfo.uiAmount} шт.\n   └ PnL: ${pnlInfo}\n`;
                            }
                        }
                    } catch (e) {
                        portfolioText += `⚠️ Помилка зчитування гаманця.\n`;
                    }
                    
                    if (!hasTokens) portfolioText += `<i>Немає куплених токенів. ШІ шукає позицію.</i>\n`;

                    const portKeyboard = { inline_keyboard: [
                        hasTokens ? [{ text: t[l].btns.panic, callback_data: "panic_sell" }] : [],
                        [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                    ]};
                    await editMessage(chatId, messageId, portfolioText, portKeyboard);
                }

                else if (data === 'panic_sell') {
                    await editMessage(chatId, messageId, "⏳ <i>Selling all tokens...</i>", { inline_keyboard: [] });
                    const soldCount = await panicSellAll(chatId, userData.privateKey, t[l]);
                    const msg = soldCount > 0 ? t[l].panic_conf : t[l].panic_err;
                    await editMessage(chatId, messageId, msg, { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
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
                    const solPrice = await getSolPrice();
                    const keyboard = { inline_keyboard: [
                        [{ text: `💸 ${userData.settings.tradeAmount} SOL`, callback_data: "edit_trade" }, { text: `📈 TP: +${userData.settings.takeProfit}%`, callback_data: "edit_tp" }],
                        [{ text: t[l].btns.lang, callback_data: "choose_lang" }, { text: `📉 SL: -${userData.settings.stopLoss}%`, callback_data: "edit_sl" }],
                        [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                    ]};
                    await editMessage(chatId, messageId, t[l].set_main(userData.settings, (userData.settings.tradeAmount * solPrice).toFixed(2)), keyboard);
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
                    
                    const solPrice = await getSolPrice();
                    const keyboard = { inline_keyboard: [
                        [{ text: `💸 ${userData.settings.tradeAmount} SOL`, callback_data: "edit_trade" }, { text: `📈 TP: +${userData.settings.takeProfit}%`, callback_data: "edit_tp" }],
                        [{ text: t[l].btns.lang, callback_data: "choose_lang" }, { text: `📉 SL: -${userData.settings.stopLoss}%`, callback_data: "edit_sl" }],
                        [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                    ]};
                    await editMessage(chatId, messageId, "✅\n\n" + t[l].set_main(userData.settings, (userData.settings.tradeAmount * solPrice).toFixed(2)), keyboard);
                }
            } catch (err) {}
            return res.status(200).send('OK');
        }
        return res.status(200).send('OK');
    } catch (error) { return res.status(200).send('OK'); }
}
