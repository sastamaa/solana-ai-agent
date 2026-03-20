import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { Redis } from '@upstash/redis';

export const maxDuration = 60; 

// --- ФУНКЦІЯ ВІДПРАВКИ ПОВІДОМЛЕНЬ В TELEGRAM З КНОПКАМИ ---
async function sendTelegramMessage(chatId, text, botToken) {
  if (!botToken || !chatId) return; 
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: "📊 Мій Портфель", callback_data: "portfolio" }, { text: "⚙️ Налаштування", callback_data: "settings" }]
    ]
  };

  try {
    await fetch(url, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          chat_id: chatId, 
          text: text, 
          parse_mode: 'HTML', 
          disable_web_page_preview: true,
          reply_markup: keyboard
      })
    });
  } catch (err) { console.error("Помилка відправки Telegram:", err); }
}

// --- СЛОВНИК ПЕРЕКЛАДІВ ---
const t = {
    uk: { rep: "🤖 <b>Звіт Агента:</b>", wal: "💼 <b>Гаманець:</b>", buy: "✅ <b>КУПЛЕНО:</b>", sell: "✅ <b>ПРОДАНО:</b>" },
    en: { rep: "🤖 <b>Agent Report:</b>", wal: "💼 <b>Wallet:</b>", buy: "✅ <b>BOUGHT:</b>", sell: "✅ <b>SOLD:</b>" },
    el: { rep: "🤖 <b>Αναφορά AI:</b>", wal: "💼 <b>Πορτοφόλι:</b>", buy: "✅ <b>ΑΓΟΡΑΣΤΗΚΕ:</b>", sell: "✅ <b>ΠΟΥΛΗΘΗΚΕ:</b>" }
};

// --- ГОЛОВНА ЛОГІКА БОТА ---
export default async function handler(req, res) {
  try {
    const groqKey = process.env.GROQ_API_KEY; 
    const jupiterKey = process.env.JUPITER_API_KEY; 
    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    if (!groqKey) throw new Error("Відсутній ключ GROQ_API_KEY!");
    if (!jupiterKey || !redisUrl || !redisToken) throw new Error("Відсутні інші API ключі!");

    const redis = new Redis({ url: redisUrl, token: redisToken });
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=15319ab4-3e9a-4c28-98e8-132d733db9b9');
    const solMint = "So11111111111111111111111111111111111111112"; 
    const jupHeaders = { 'Content-Type': 'application/json', 'x-api-key': jupiterKey };

    // Отримуємо всіх користувачів з Redis
    const userKeys = await redis.keys('user_*');
    if (userKeys.length === 0) return res.status(200).send("Немає користувачів");

    for (const key of userKeys) {
        const chatId = key.replace('user_', '');
        let userLogs = [];
        
        let userDataStr = await redis.get(key);
        if (!userDataStr) continue;
        
        const userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;
        if (!userData.isActive || !userData.privateKey) continue;
        
        const lang = userData.lang || 'uk'; 
        const langDict = t[lang];

        let wallet;
        try { 
            wallet = Keypair.fromSecretKey(bs58.decode(userData.privateKey)); 
        } catch (e) { continue; }
        
        const settings = userData.settings || { tradeAmount: 0.01, takeProfit: 30, stopLoss: 30 };
        
        let soldSomething = false; 
        let activeTokensCount = 0; 

        // Отримуємо баланс та токени
        const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
        const balance = await connection.getBalance(wallet.publicKey);
        
        // --- ЕТАП 1: ПЕРЕВІРКА КУПЛЕНИХ ТОКЕНІВ (ПРОДАЖ) ---
        for (const acc of accounts.value) {
            const tokenAmountInfo = acc.account.data.parsed.info.tokenAmount;
            const mintAddress = acc.account.data.parsed.info.mint;
            
            if (tokenAmountInfo.uiAmount > 0 && mintAddress !== solMint) {
                activeTokensCount++; 
                
                const buyPriceStr = await redis.get(`buy_price_${mintAddress}_${chatId}`);
                if (buyPriceStr) {
                    const buyPrice = parseFloat(buyPriceStr);
                    try {
                        const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
                        const dexData = await dexRes.json();
                        
                        if (dexData.pairs && dexData.pairs.length > 0) {
                            const currentPrice = parseFloat(dexData.pairs[0].priceUsd);
                            const percentChange = ((currentPrice - buyPrice) / buyPrice) * 100;
                            const symbol = dexData.pairs[0].baseToken.symbol;
                            
                            // Продаємо, якщо досягли TP або SL
                            if (percentChange >= settings.takeProfit || percentChange <= -settings.stopLoss) {
                                const reason = percentChange >= settings.takeProfit ? `🎯 Take-Profit (+${percentChange.toFixed(2)}%)` : `🛡 Stop-Loss (${percentChange.toFixed(2)}%)`;
                                
                                const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=300`, { headers: jupHeaders });
                                const quoteData = await quoteRes.json();
                                
                                if (!quoteData.error) {
                                    const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: jupHeaders, body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) });
                                    const swapData = await swapRes.json();
                                    
                                    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                                    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                                    transaction.sign([wallet]);
                                    const txid = await connection.sendRawTransaction(transaction.serialize());
                                    
                                    await redis.del(`buy_price_${mintAddress}_${chatId}`);
                                    userLogs.push(`${langDict.sell} ${symbol}\nПричина: ${reason}\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                                    soldSomething = true;
                                    activeTokensCount--; 
                                }
                            }
                        }
                    } catch (e) { console.log(`Помилка перевірки ціни для ${mintAddress}`); }
                }
            }
        }

        // --- ЕТАП 2: ПОШУК ТА ПОКУПКА НОВОЇ МОНЕТИ (ЯКЩО Є ГРОШІ) ---
        if (!soldSomething && activeTokensCount < 3) {
            const tradeLamports = Math.floor(settings.tradeAmount * 1e9);

            // Залишаємо мінімум 0.005 SOL на комісії
            if (balance >= tradeLamports + 5000000) {
                
                try {
                    // Шукаємо серед топ-пар Solana
                    const trendRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
                    const trendData = await trendRes.json();
                    const pairs = trendData.pairs || [];
                    
                    for (const pair of pairs) {
                        if (pair.chainId !== 'solana') continue;
                        const symbol = pair.baseToken.symbol.toUpperCase();
                        if (symbol === 'SOL' || symbol === 'WSOL' || symbol === 'USDC' || symbol === 'USDT') continue;

                        const tokenAddress = pair.baseToken.address;
                        if (tokenAddress === solMint) continue;

                        const liq = pair.liquidity?.usd || 0;
                        const vol = pair.volume?.h24 || 0;
                        const fdv = pair.fdv || 0; 
                        const priceChange24h = pair.priceChange?.h24 || 0;
                      
                        // Жорсткі фільтри для стабільності
                        if (liq < 10000 || vol < 20000 || fdv < 50000) continue; 
                        if (priceChange24h > 150) continue; 
                        
                        // Перевіряємо, чи ми не відхилили цю монету раніше
                        const isIgnored = await redis.get(`ignored_token_${tokenAddress}`);
                        if (isIgnored) continue; 

                        await redis.set(`last_scan_${chatId}`, `🔎 Аналізую: <b>${symbol}</b>\nЛіквідність: $${Math.round(liq)}\nОб'єм: $${Math.round(vol)}`, { ex: 3600 });

                        const prompt = `You are an expert crypto trader. Analyze this Solana token and answer exactly with 'BUY' or 'WAIT', followed by a new line and a 1-2 sentence explanation in Ukrainian.
Token: ${symbol}
Liquidity: $${Math.round(liq)}
Volume 24h: $${Math.round(vol)}
Market Cap: $${Math.round(fdv)}
Change 24h: ${priceChange24h}%
Rule: Prefer stable growth. Ignore high-risk pump and dumps.`;

                        // Звертаємося до Groq (Mixtral)
                        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${groqKey}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
model: "llama-3.3-70b-versatile",
                              messages: [
                                    { role: "system", content: "You are a conservative AI trader." },
                                    { role: "user", content: prompt }
                                ],
                                temperature: 0.1
                            })
                        });
                        
                        const groqData = await groqRes.json();
                        
                        // ОБРОБКА ПОМИЛОК GROQ
                        if (!groqRes.ok || groqData.error) {
                            const errMsg = groqData.error?.message || groqRes.statusText || "Невідома помилка API";
                            await redis.set(`last_scan_${chatId}`, `⚠️ <b>Помилка Groq API:</b>\n${errMsg}`, { ex: 3600 });
                            break; // Припиняємо пошук на цей запуск
                        }
                        
                        if (!groqData.choices || !groqData.choices[0]) break;
                        
                        const aiDecision = groqData.choices[0].message.content.trim();

                        if (aiDecision.includes("BUY")) {
                            const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${solMint}&outputMint=${tokenAddress}&amount=${tradeLamports}&slippageBps=150`, { headers: jupHeaders });
                            const quoteData = await quoteRes.json();

                            if (!quoteData.error) {
                                const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: jupHeaders, body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) });
                                const swapData = await swapRes.json();
                                
                                const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                                const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                                transaction.sign([wallet]);
                                const txid = await connection.sendRawTransaction(transaction.serialize());
                                
                                await redis.set(`buy_price_${tokenAddress}_${chatId}`, pair.priceUsd);
                                await redis.set(`last_scan_${chatId}`, `✅ <b>Куплено:</b> ${symbol}!\nШІ очікує прибутку.`, { ex: 3600 });
                                
                                userLogs.push(`${langDict.buy} ${symbol}\n🎯 <b>ШІ:</b> ${aiDecision}\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                                break; // Купили 1 монету - завершуємо роботу
                            } else {
                                await redis.set(`last_scan_${chatId}`, `❌ <b>Помилка Jupiter:</b>\nНе зміг купити ${symbol} через проковзування.`, { ex: 3600 });
                                break;
                            }
                        } else {
                            // Відхилили - забуваємо про неї на 2 години
                            await redis.set(`ignored_token_${tokenAddress}`, 'true', { ex: 7200 });
                            let shortThought = aiDecision.replace('WAIT', '').trim();
                            await redis.set(`last_scan_${chatId}`, `🔎 Відхилено: <b>${symbol}</b>\n🧠 <b>Причина:</b> <i>${shortThought}</i>`, { ex: 3600 });
                            break; // Завершуємо роботу до наступних 5 хвилин
                        }
                    }
                } catch (apiError) {
                    await redis.set(`last_scan_${chatId}`, `⚠️ <b>Помилка мережі:</b>\n${apiError.message}`, { ex: 3600 });
                }
            } else if (balance < tradeLamports + 5000000 && activeTokensCount === 0) {
                 await redis.set(`last_scan_${chatId}`, `⚠️ <b>Недостатньо SOL</b>\nБаланс менший за суму покупки + комісію. Поповніть гаманець.`, { ex: 3600 });
            }
        }

        // Відправляємо звіт в Telegram, якщо були дії (покупка/продаж)
        if (userLogs.length > 0) {
            const reportText = `${langDict.rep}\n${langDict.wal} <code>${userData.walletAddress.substring(0, 4)}...${userData.walletAddress.slice(-4)}</code>\n\n` + userLogs.join('\n\n');
            await sendTelegramMessage(chatId, reportText, botToken);
        }
    }
    
    res.status(200).send('Виконано успішно');
  } catch (error) { 
    res.status(500).send(error.message); 
  }
}
