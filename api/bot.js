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
    try {
        const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await res.json();
        return data.result?.message_id;
    } catch(e) { return null; }
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
    const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) body.reply_markup = replyMarkup;
    try { await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch(e) {}
}

// ✅ Закріплене повідомлення — оновлює існуюче або створює нове
async function updatePinnedMenu(chatId, text, replyMarkup) {
    const pinnedMsgId = await redis.get(`pinned_msg_${chatId}`);
    if (pinnedMsgId) {
        try {
            await editMessage(chatId, parseInt(pinnedMsgId), text, replyMarkup);
            return parseInt(pinnedMsgId);
        } catch(e) {}
    }
    // Якщо немає — створюємо нове і закріплюємо
    const msgId = await sendMessage(chatId, text, replyMarkup);
    if (msgId) {
        await redis.set(`pinned_msg_${chatId}`, msgId.toString());
        try {
            await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/pinChatMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, message_id: msgId, disable_notification: true })
            });
        } catch(e) {}
    }
    return msgId;
}

async function panicSellAll(chatId, privateKey) {
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
                    if (quoteData.error || !quoteData.outAmount) continue;
                    const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: jupHeaders, body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) });
                    const swapData = await swapRes.json();
                    if (!swapData.swapTransaction) continue;
                    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                    transaction.sign([wallet]);
                    await connection.sendRawTransaction(transaction.serialize());
                    await redis.del(`buy_price_${mint}_${chatId}`);
                    await redis.del(`max_price_${mint}_${chatId}`);
                    soldCount++;
                } catch (e) {}
            }
        }
        return soldCount;
    } catch (error) { return 0; }
}

const t = {
    uk: {
        welcome: (w, usd) => `👋 <b>Радий вітати! Я — ваш ШІ-помічник для трейдингу.</b>\n\n💼 <b>Ваш гаманець:</b>\n<code>${w}</code>\n\n🚀 <b>Як почати?</b>\nПоповніть на <b>0.05 SOL (~$${usd})</b> і я почну торгувати!`,
        port_head: "📊 <b>Ваш Портфель та Баланс:</b>\n\n",
        with_prompt: "💸 <b>Виведення коштів</b>\n\nНадішліть <b>адресу гаманця Solana</b>.\n\n<i>ℹ️ Комісія сервісу: 3%.</i>",
        err_with: "❌ <b>Помилка!</b> Недостатньо коштів або невірна адреса.",
        succ_with: (u, f, to, tx) => `✅ <b>Виведено!</b>\n\n💸 Вам: <b>${u} SOL</b>\n💎 Комісія (3%): <b>${f} SOL</b>\n📍 На: <code>${to}</code>\n🔍 <a href="https://solscan.io/tx/${tx}">Чек</a>`,
        ref_msg: (l) => `🎁 <b>Бонуси: Запроси друга!</b>\n\n🔗 <b>Ваше посилання:</b>\n<code>${l}</code>\n\nДруг починає торгувати → ваша комісія знижується з 3% до 2%!`,
        set_main: (s, usd) => `⚙️ <b>Налаштування ШІ</b>\n\n💸 <b>Сума покупки:</b> ${s.tradeAmount} SOL (~$${usd})\n📈 <b>Take-Profit:</b> +${s.takeProfit}%\n📉 <b>Stop-Loss:</b> -${s.stopLoss}%`,
        panic_confirm: "⚠️ <b>УВАГА! Екстрений Продаж</b>\n\nВи впевнені? Всі токени будуть продані негайно за ринковою ціною.\n\n<i>Це може призвести до збитків якщо монети зараз в мінусі!</i>",
        panic_conf: "✅ <b>Екстрений продаж виконано.</b> Всі монети конвертовано в SOL.",
        panic_err: "⚠️ Монет для продажу не знайдено.",
        btns: { port: "📊 Мій Портфель", with: "💸 Вивести", set: "⚙️ Налаштування", ref: "🎁 Бонуси", lang: "🌐 Мова", back: "🔙 Назад", menu: "🔙 Меню", panic: "🚨 Екстрений Продаж", panic_yes: "✅ ТАК, ПРОДАТИ ВСЕ", panic_no: "❌ Скасувати" }
    },
    en: {
        welcome: (w, usd) => `👋 <b>Welcome! I am your AI Trading Assistant.</b>\n\n💼 <b>Your wallet:</b>\n<code>${w}</code>\n\n🚀 Deposit <b>0.05 SOL (~$${usd})</b> to start!`,
        port_head: "📊 <b>Your Portfolio & Balance:</b>\n\n",
        with_prompt: "💸 <b>Withdraw Funds</b>\n\nSend your <b>Solana wallet address</b>.\n\n<i>ℹ️ 3% service fee applies.</i>",
        err_with: "❌ <b>Error!</b> Insufficient funds or invalid address.",
        succ_with: (u, f, to, tx) => `✅ <b>Withdrawn!</b>\n💸 To you: <b>${u} SOL</b>\n💎 Fee: <b>${f} SOL</b>\n🔍 <a href="https://solscan.io/tx/${tx}">Receipt</a>`,
        ref_msg: (l) => `🎁 <b>Referrals</b>\n🔗 <b>Link:</b>\n<code>${l}</code>\nInvite friends to reduce your fee to 2%!`,
        set_main: (s, usd) => `⚙️ <b>Settings</b>\n💸 <b>Trade Amount:</b> ${s.tradeAmount} SOL (~$${usd})\n📈 <b>Take-Profit:</b> +${s.takeProfit}%\n📉 <b>Stop-Loss:</b> -${s.stopLoss}%`,
        panic_confirm: "⚠️ <b>CONFIRM: Panic Sell</b>\n\nAre you sure? All tokens will be sold immediately at market price.\n\n<i>This may result in losses if tokens are currently negative!</i>",
        panic_conf: "✅ <b>Panic Sell completed.</b> All tokens converted to SOL.",
        panic_err: "⚠️ No tokens found to sell.",
        btns: { port: "📊 Portfolio", with: "💸 Withdraw", set: "⚙️ Settings", ref: "🎁 Bonuses", lang: "🌐 Language", back: "🔙 Back", menu: "🔙 Menu", panic: "🚨 Panic Sell", panic_yes: "✅ YES, SELL ALL", panic_no: "❌ Cancel" }
    },
    el: {
        welcome: (w, usd) => `👋 <b>Καλώς ήρθατε! Είμαι ο AI Βοηθός σας.</b>\n\n💼 <b>Πορτοφόλι:</b>\n<code>${w}</code>\n\n🚀 Καταθέστε <b>0.05 SOL (~$${usd})</b> για να ξεκινήσετε!`,
        port_head: "📊 <b>Χαρτοφυλάκιο & Υπόλοιπο:</b>\n\n",
        with_prompt: "💸 <b>Ανάληψη</b>\nΣτείλτε τη διεύθυνση Solana σας.\n<i>ℹ️ Χρέωση 3%.</i>",
        err_with: "❌ Σφάλμα! Ανεπαρκή κεφάλαια.",
        succ_with: (u, f, to, tx) => `✅ <b>Επιτυχής ανάληψη!</b>\n💸 Σε εσάς: <b>${u} SOL</b>\n🔍 <a href="https://solscan.io/tx/${tx}">Receipt</a>`,
        ref_msg: (l) => `🎁 <b>Μπόνους</b>\nΟ σύνδεσμός σας:\n<code>${l}</code>`,
        set_main: (s, usd) => `⚙️ <b>Ρυθμίσεις</b>\n💸 <b>Ποσό:</b> ${s.tradeAmount} SOL\n📈 <b>TP:</b> +${s.takeProfit}%\n📉 <b>SL:</b> -${s.stopLoss}%`,
        panic_confirm: "⚠️ <b>Επείγουσα Πώληση;</b>\n\nΕίστε σίγουροι; Όλα τα tokens θα πουληθούν!",
        panic_conf: "✅ <b>Επείγουσα Πώληση ολοκληρώθηκε.</b>",
        panic_err: "⚠️ Δεν βρέθηκαν tokens.",
        btns: { port: "📊 Χαρτοφυλάκιο", with: "💸 Ανάληψη", set: "⚙️ Ρυθμίσεις", ref: "🎁 Μπόνους", lang: "🌐 Γλώσσα", back: "🔙 Πίσω", menu: "🔙 Μενού", panic: "🚨 Επείγουσα Πώληση", panic_yes: "✅ ΝΑΙ, ΠΟΥΛΗΣΗ ΟΛΩΝ", panic_no: "❌ Άκυρο" }
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

        const langKeyboard = { inline_keyboard: [
            [{ text: "🇺🇦 Українська", callback_data: "lang_uk" }],
            [{ text: "🇬🇧 English", callback_data: "lang_en" }],
            [{ text: "🇬🇷 Ελληνικά", callback_data: "lang_el" }]
        ]};

        // ============ ЗВИЧАЙНІ ПОВІДОМЛЕННЯ ============
        if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text.startsWith('/start')) {
                fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, action: 'typing' })
                }).catch(() => {});

                try {
                    await redis.del(`state_${chatId}`);
                    const refCode = text.split(' ')[1]; 
                    
                    let userDataStr = await redis.get(`user_${chatId}`);
                    let userData;
                    
                    if (!userDataStr) {
                        const wallet = Keypair.generate();
                        userData = {
                            chatId,
                            walletAddress: wallet.publicKey.toString(),
                            privateKey: bs58.encode(wallet.secretKey),
                            isActive: true,
                            // ✅ Оновлені дефолтні налаштування
                            settings: { tradeAmount: 0.005, takeProfit: 15, stopLoss: 10 },
                            lang: null,
                            refCount: 0,
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
                    } else {
                        userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;
                    }

                    if (!userData.lang) {
                        await sendMessage(chatId, "🌐 <b>Choose your language:</b>", langKeyboard);
                    } else {
                        const solPrice = await getSolPrice();
                        // ✅ Головне меню — закріплене повідомлення
                        await updatePinnedMenu(chatId, t[userData.lang].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(userData.lang));
                    }
                } catch (e) {}
                return res.status(200).send('OK');
            } else {
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
                        transaction.recentBlockhash = blockhash;
                        transaction.feePayer = fromWallet.publicKey;
                        transaction.sign(fromWallet);

                        const txid = await connection.sendRawTransaction(transaction.serialize());
                        await sendMessage(chatId, t[l].succ_with((userLamports / 1e9).toFixed(5), (ownerFeeLamports / 1e9).toFixed(5), text, txid));
                    } catch (e) { await sendMessage(chatId, t[l].err_with); }
                    return res.status(200).send('OK');
                }
            }
        }

        // ============ CALLBACK КНОПКИ ============
        if (update.callback_query) {
            const chatId = update.callback_query.message.chat.id;
            const messageId = update.callback_query.message.message_id;
            const data = update.callback_query.data;
            
            try {
                await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ callback_query_id: update.callback_query.id })
                });
            } catch(e) {}
            
            let dbData = await redis.get(`user_${chatId}`);
            let userData = typeof dbData === 'string' ? JSON.parse(dbData) : dbData;

            if (data.startsWith('lang_')) {
                userData.lang = data.replace('lang_', '');
                await redis.set(`user_${chatId}`, JSON.stringify(userData));
                const solPrice = await getSolPrice();
                // ✅ Після вибору мови — закріплюємо головне меню
                await updatePinnedMenu(chatId, t[userData.lang].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(userData.lang));
                return res.status(200).send('OK');
            }

            if (!userData.lang) return res.status(200).send('OK');
            const l = userData.lang;

            // ✅ Отримуємо ID закріпленого повідомлення
            const pinnedMsgId = await redis.get(`pinned_msg_${chatId}`);
            const targetMsgId = pinnedMsgId ? parseInt(pinnedMsgId) : messageId;

            try {
                if (data === 'main_menu') {
                    await redis.del(`state_${chatId}`);
                    const solPrice = await getSolPrice();
                    await editMessage(targetMsgId ? targetMsgId : messageId, chatId, t[l].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(l));
                    // Якщо натиснули з іншого повідомлення — редагуємо закріплене
                    if (messageId !== targetMsgId) {
                        await editMessage(chatId, targetMsgId, t[l].welcome(userData.walletAddress, (0.05 * solPrice).toFixed(2)), getMainMenuKeyboard(l));
                    }
                }

                else if (data === 'portfolio') {
                    await editMessage(chatId, targetMsgId, "⏳ <i>Аналізую блокчейн...</i>", { inline_keyboard: [] });
                    const solPrice = await getSolPrice();
                    const balance = await connection.getBalance(new PublicKey(userData.walletAddress));
                    const solUi = (balance / 1e9).toFixed(4);
                    const usdBal = (solUi * solPrice).toFixed(2);

                    let portfolioText = t[l].port_head;
                    portfolioText += `💰 <b>Баланс:</b> ${solUi} SOL (~$${usdBal})\n`;
                    portfolioText += `🟢 <b>ШІ-Агент:</b> Активний\n\n`;
                    
                    const lastScan = await redis.get(`last_scan_${chatId}`);
                    portfolioText += `👀 <b>Активність ШІ:</b>\n${lastScan || '<i>Шукає нові монети на ринку...</i>'}\n\n`;
                    portfolioText += `🪙 <b>Куплені токени:</b>\n`;
                    
                    let hasTokens = false;
                    try {
                        const accounts = await connection.getParsedTokenAccountsByOwner(
                            new PublicKey(userData.walletAddress),
                            { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
                        );
                        const solMint = "So11111111111111111111111111111111111111112";
                        
                        for (const acc of accounts.value) {
                            const amountInfo = acc.account.data.parsed.info.tokenAmount;
                            const mint = acc.account.data.parsed.info.mint;
                            
                            if (amountInfo.uiAmount > 0 && mint !== solMint) {
                                hasTokens = true;
                                const buyPriceStr = await redis.get(`buy_price_${mint}_${chatId}`);
                                const tokenInfoStr = await redis.get(`token_info_${mint}_${chatId}`);
                                const tokenInfo = tokenInfoStr ? (typeof tokenInfoStr === 'string' ? JSON.parse(tokenInfoStr) : tokenInfoStr) : null;
                                let pnlInfo = "<i>Аналіз ціни...</i>";
                                let tokenName = tokenInfo?.symbol || `${mint.substring(0, 4)}...${mint.slice(-4)}`;

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
                                        } else { pnlInfo = `~$${totalUsd}`; }
                                    }
                                } catch (e) {}
                                
                                portfolioText += `🔸 <b>${tokenName}:</b> ${amountInfo.uiAmount} шт.\n   └ PnL: ${pnlInfo}\n`;
                            }
                        }
                    } catch (e) { portfolioText += `⚠️ Помилка зчитування гаманця.\n`; }
                    
                    if (!hasTokens) portfolioText += `<i>Немає куплених токенів. ШІ шукає позицію.</i>\n`;

                    const portKeyboard = { inline_keyboard: [
                        ...(hasTokens ? [[{ text: t[l].btns.panic, callback_data: "panic_sell" }]] : []),
                        [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                    ]};
                    await editMessage(chatId, targetMsgId, portfolioText, portKeyboard);
                }

                // ✅ КРОК 1: Підтвердження екстреного продажу
                else if (data === 'panic_sell') {
                    const confirmKeyboard = { inline_keyboard: [
                        [{ text: t[l].btns.panic_yes, callback_data: "panic_sell_confirmed" }],
                        [{ text: t[l].btns.panic_no, callback_data: "portfolio" }]
                    ]};
                    await editMessage(chatId, targetMsgId, t[l].panic_confirm, confirmKeyboard);
                }

                // ✅ КРОК 2: Виконання після підтвердження
                else if (data === 'panic_sell_confirmed') {
                    await editMessage(chatId, targetMsgId, "⏳ <i>Продаю всі монети...</i>", { inline_keyboard: [] });
                    const soldCount = await panicSellAll(chatId, userData.privateKey);
                    const msg = soldCount > 0 ? t[l].panic_conf : t[l].panic_err;
                    await editMessage(chatId, targetMsgId, msg, { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
                }

                else if (data === 'withdraw') {
                    await redis.set(`state_${chatId}`, 'awaiting_withdraw', { ex: 3600 });
                    await editMessage(chatId, targetMsgId, t[l].with_prompt, { inline_keyboard: [[{ text: t[l].btns.back, callback_data: "main_menu" }]] });
                }

                else if (data === 'referral') {
                    const link = `https://t.me/${BOT_USERNAME}?start=ref_${chatId}`;
                    await editMessage(chatId, targetMsgId, t[l].ref_msg(link), { inline_keyboard: [[{ text: t[l].btns.menu, callback_data: "main_menu" }]] });
                }

                else if (data === 'settings') {
                    const solPrice = await getSolPrice();
                    // ✅ Додано кнопки TP: 15% та SL: 10%
                    const keyboard = { inline_keyboard: [
                        [{ text: `💸 ${userData.settings.tradeAmount} SOL`, callback_data: "edit_trade" }, { text: `📈 TP: +${userData.settings.takeProfit}%`, callback_data: "edit_tp" }],
                        [{ text: t[l].btns.lang, callback_data: "choose_lang" }, { text: `📉 SL: -${userData.settings.stopLoss}%`, callback_data: "edit_sl" }],
                        [{ text: t[l].btns.menu, callback_data: "main_menu" }]
                    ]};
                    await editMessage(chatId, targetMsgId, t[l].set_main(userData.settings, (userData.settings.tradeAmount * solPrice).toFixed(2)), keyboard);
                }

                else if (data === 'choose_lang') {
                    await editMessage(chatId, targetMsgId, "🌐 <b>Choose your language:</b>", langKeyboard);
                }

                else if (data === 'edit_trade') {
                    const keyboard = { inline_keyboard: [
                        [{ text: "0.005 SOL", callback_data: "set_trade_0.005" }, { text: "0.01 SOL", callback_data: "set_trade_0.01" }],
                        [{ text: "0.02 SOL", callback_data: "set_trade_0.02" }, { text: "0.05 SOL", callback_data: "set_trade_0.05" }],
                        [{ text: "0.1 SOL", callback_data: "set_trade_0.1" }, { text: "0.5 SOL", callback_data: "set_trade_0.5" }],
                        [{ text: t[l].btns.back, callback_data: "settings" }]
                    ]};
                    await editMessage(chatId, targetMsgId, "💸 <b>Оберіть суму для однієї покупки:</b>", keyboard);
                }

                // ✅ Take-Profit з новими значеннями 10/15/20/30/50%
                else if (data === 'edit_tp') {
                    const keyboard = { inline_keyboard: [
                        [{ text: "+10%", callback_data: "set_tp_10" }, { text: "+15% ⭐", callback_data: "set_tp_15" }],
                        [{ text: "+20%", callback_data: "set_tp_20" }, { text: "+30%", callback_data: "set_tp_30" }],
                        [{ text: "+50%", callback_data: "set_tp_50" }, { text: "+100%", callback_data: "set_tp_100" }],
                        [{ text: t[l].btns.back, callback_data: "settings" }]
                    ]};
                    await editMessage(chatId, targetMsgId, "📈 <b>Оберіть Take-Profit:</b>\n\n⭐ = рекомендовано для скальпінгу", keyboard);
                }

                // ✅ Stop-Loss з новими значеннями 5/10/15/25%
                else if (data === 'edit_sl') {
                    const keyboard = { inline_keyboard: [
                        [{ text: "-5%", callback_data: "set_sl_5" }, { text: "-10% ⭐", callback_data: "set_sl_10" }],
                        [{ text: "-15%", callback_data: "set_sl_15" }, { text: "-25%", callback_data: "set_sl_25" }],
                        [{ text: t[l].btns.back, callback_data: "settings" }]
                    ]};
                    await editMessage(chatId, targetMsgId, "📉 <b>Оберіть Stop-Loss:</b>\n\n⭐ = рекомендовано для скальпінгу", keyboard);
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
                    await editMessage(chatId, targetMsgId, "✅ Збережено!\n\n" + t[l].set_main(userData.settings, (userData.settings.tradeAmount * solPrice).toFixed(2)), keyboard);
                }

            } catch (err) { console.error(err); }
            return res.status(200).send('OK');
        }

        return res.status(200).send('OK');
    } catch (error) { return res.status(200).send('OK'); }
}
