import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { Redis } from '@upstash/redis';

export const maxDuration = 60; 

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
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: keyboard })
    });
  } catch (err) { console.error(err); }
}

const t = {
    uk: { rep: "Звіт Агента:", buy: "✅ <b>КУПЛЕНО:</b>", sell: "✅ <b>ПРОДАНО:</b>" },
    en: { rep: "Agent Report:", buy: "✅ <b>BOUGHT:</b>", sell: "✅ <b>SOLD:</b>" },
    el: { rep: "Αναφορά AI:", buy: "✅ <b>ΑΓΟΡΑΣΤΗΚΕ:</b>", sell: "✅ <b>ΠΟΥΛΗΘΗΚΕ:</b>" }
};

const BANNED_SYMBOLS = [
    "SOL","WSOL","USDC","USDT","SOLANA","WRAPPED","BITCOIN","BTC",
    "ETH","ETHEREUM","BNB","WBTC","XRP","ADA","DOGE","SHIB","PEPE"
];

const BANNED_ADDRESSES = [
    "De4ULouuU2cAQkhKuYrsrFtJGRRmcSwQD5esmnAUpump",
];

export default async function handler(req, res) {
  try {
    const groqKey = process.env.GROQ_API_KEY; 
    const jupiterKey = process.env.JUPITER_API_KEY; 
    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    if (!groqKey) throw new Error("Відсутній GROQ_API_KEY!");
    if (!jupiterKey || !redisUrl || !redisToken) throw new Error("Відсутні API ключі!");

    const redis = new Redis({ url: redisUrl, token: redisToken });
    const connection = new Connection(
        process.env.SOLANA_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=15319ab4-3e9a-4c28-98e8-132d733db9b9"
    );
    const solMint = "So11111111111111111111111111111111111111112"; 
    const jupHeaders = { "Content-Type": "application/json", "x-api-key": jupiterKey };

    const userKeys = await redis.keys("user_*");
    if (userKeys.length === 0) return res.status(200).send("Немає користувачів");

    for (const key of userKeys) {
        const chatId = key.replace("user_", "");
        let userLogs = [];
        
        let userDataStr = await redis.get(key);
        if (!userDataStr) continue;
        
        const userData = typeof userDataStr === "string" ? JSON.parse(userDataStr) : userDataStr;
        if (!userData.isActive || !userData.privateKey) continue;
        
        const lang = userData.lang || "uk"; 
        const langDict = t[lang];

        let wallet;
        try { wallet = Keypair.fromSecretKey(bs58.decode(userData.privateKey)); } 
        catch (e) { continue; }
        
        const settings = userData.settings || { tradeAmount: 0.01, takeProfit: 30, stopLoss: 30 };
        let soldSomething = false; 
        let activeTokensCount = 0; 

        try {
            const accounts = await connection.getParsedTokenAccountsByOwner(
                wallet.publicKey, 
                { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
            );
            const balance = await connection.getBalance(wallet.publicKey);
            
            // ЕТАП 1: ПРОДАЖ
            for (const acc of accounts.value) {
                const tokenAmountInfo = acc.account.data.parsed.info.tokenAmount;
                const mintAddress = acc.account.data.parsed.info.mint;
                
                if (tokenAmountInfo.uiAmount > 0 && mintAddress !== solMint) {
                    activeTokensCount++; 
                    const buyPriceStr = await redis.get(`buy_price_${mintAddress}_${chatId}`);
                    if (buyPriceStr) {
                        try {
                            const buyPrice = parseFloat(buyPriceStr);
                            const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
                            const dexData = await dexRes.json();
                            if (dexData.pairs && dexData.pairs.length > 0) {
                                const currentPrice = parseFloat(dexData.pairs[0].priceUsd);
                                const percentChange = ((currentPrice - buyPrice) / buyPrice) * 100;
                                const symbol = dexData.pairs[0].baseToken.symbol;
                                
                                if (percentChange >= settings.takeProfit || percentChange <= -settings.stopLoss) {
                                    const reason = percentChange >= settings.takeProfit 
                                        ? `🎯 Take-Profit (+${percentChange.toFixed(2)}%)` 
                                        : `🛡 Stop-Loss (${percentChange.toFixed(2)}%)`;
                                    
                                    const quoteRes = await fetch(
                                        `https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=300`, 
                                        { headers: jupHeaders }
                                    );
                                    const quoteData = await quoteRes.json();
                                    
                                    if (!quoteData.error) {
                                        const swapRes = await fetch("https://api.jup.ag/swap/v1/swap", { 
                                            method: "POST", headers: jupHeaders, 
                                            body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) 
                                        });
                                        const swapData = await swapRes.json();
                                        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, "base64");
                                        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                                        const { blockhash } = await connection.getLatestBlockhash("finalized");
                                        transaction.message.recentBlockhash = blockhash;
                                        transaction.sign([wallet]);
                                        const txid = await connection.sendRawTransaction(transaction.serialize(), { 
                                            skipPreflight: true, maxRetries: 5 
                                        });
                                        await new Promise(resolve => setTimeout(resolve, 2000));
                                        
                                        await redis.del(`buy_price_${mintAddress}_${chatId}`);
                                        await redis.del(`token_info_${mintAddress}_${chatId}`);
                                        await redis.del(`active_buy_${chatId}`);
                                        
                                        userLogs.push(`${langDict.sell} ${symbol}\nПричина: ${reason}\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                                        soldSomething = true;
                                        activeTokensCount--;
                                    }
                                }
                            }
                        } catch (e) { console.log("Помилка продажу:", e.message); }
                    }
                }
            }

            // ЕТАП 2: ПОКУПКА
            if (!soldSomething && activeTokensCount < 3) {
                const tradeLamports = Math.floor(settings.tradeAmount * 1e9);

                if (balance < tradeLamports + 5000000) {
                    await redis.set(`last_scan_${chatId}`, "⚠️ Недостатньо SOL. Поповніть гаманець.", { ex: 3600 });
                } else {
                    const recentBuy = await redis.get(`active_buy_${chatId}`);
                    if (recentBuy && activeTokensCount === 0) {
                        await redis.del(`active_buy_${chatId}`);
                    } else if (recentBuy) {
                        await redis.set(`last_scan_${chatId}`, "⏳ Нещодавно куплено. Очікуємо підтвердження...", { ex: 300 });
                    } else {
                        try {
                            // ДІАГНОСТИКА: отримуємо пари
// Отримуємо пари з 3 різних джерел і об'єднуємо
const [res1, res2, res3] = await Promise.all([
    fetch("https://api.dexscreener.com/latest/dex/search?q=pump&rankBy=trendingScoreH6&order=desc"),
    fetch("https://api.dexscreener.com/latest/dex/search?q=meme&rankBy=trendingScoreH6&order=desc"),
    fetch("https://api.dexscreener.com/latest/dex/search?q=cat&rankBy=trendingScoreH6&order=desc")
]);
const [d1, d2, d3] = await Promise.all([res1.json(), res2.json(), res3.json()]);

// Об'єднуємо і прибираємо дублікати за адресою
const allPairs = [...(d1.pairs||[]), ...(d2.pairs||[]), ...(d3.pairs||[])];
const seen = new Set();
const pairs = allPairs.filter(p => {
    if (seen.has(p.pairAddress)) return false;
    seen.add(p.pairAddress);
    return true;
});

await redis.set(`last_scan_${chatId}`, `🔧 DexScreener: ${pairs.length} пар з 3 джерел. Фільтруємо...`, { ex: 3600 });

                            let skippedChain = 0, skippedSymbol = 0, skippedAddress = 0;
                            let skippedLiq = 0, skippedPump = 0, foundCandidate = false;
                            
                            for (const pair of pairs) {
                                if (pair.chainId !== "solana") { skippedChain++; continue; }
                                
                                const sym = pair.baseToken.symbol.toUpperCase();
                                const tokenAddress = pair.baseToken.address;
                                
                                if (BANNED_SYMBOLS.some(banned => sym.includes(banned))) { skippedSymbol++; continue; }
                                if (BANNED_ADDRESSES.includes(tokenAddress)) { skippedAddress++; continue; }
                                if (tokenAddress === solMint) continue;
                                
                                const liq = pair.liquidity?.usd || 0;
                                const vol = pair.volume?.h24 || 0;
                                const fdv = pair.fdv || 0; 
                                const priceChange24h = pair.priceChange?.h24 || 0;
                                
                                if (liq < 10000 || vol < 20000 || fdv < 50000) { skippedLiq++; continue; }
                                if (priceChange24h > 150) { skippedPump++; continue; }
                                
                                const isIgnored = await redis.get(`ignored_token_${tokenAddress}`);
                                if (isIgnored) continue;

                                // Знайшли кандидата — йдемо до Groq
                                foundCandidate = true;
                                await redis.set(`last_scan_${chatId}`, 
                                    `🔎 Аналізую: <b>${sym}</b>\nЛік: $${Math.round(liq)} | Об'єм: $${Math.round(vol)}\n📊 Відфільтровано: інші мережі=${skippedChain}, символи=${skippedSymbol}, ліквідність=${skippedLiq}, памп=${skippedPump}`, 
                                    { ex: 3600 }
                                );

                                const prompt = `You are a professional crypto analyst. Analyze this Solana token and respond ONLY in this exact format:

DECISION: BUY or WAIT
SCORE: X/10
ANALYSIS:
• Liquidity: [assessment]
• Volume/MCap ratio: [calculate vol/fdv ratio and assess]
• Price momentum: [assessment]
• Risk level: [Low/Medium/High]
REASON: [1 sentence in Ukrainian explaining the decision]

Token data:
- Symbol: ${sym}
- Liquidity: $${Math.round(liq)}
- Volume 24h: $${Math.round(vol)}
- Market Cap: $${Math.round(fdv)}
- Vol/MCap ratio: ${(vol/fdv*100).toFixed(1)}%
- Price change 24h: ${priceChange24h}%

Rules: BUY only if score >= 7, liquidity > $15k, vol/mcap > 5%, no extreme pumps.`;

                                const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                                    method: "POST",
                                    headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
                                    body: JSON.stringify({ 
model: "llama-3.1-8b-instant",
                                      messages: [{ role: "user", content: prompt }], 
                                        temperature: 0.1 
                                    })
                                });
                                const groqData = await groqRes.json();

                                if (!groqRes.ok || groqData.error) {
                                    const errMsg = groqData?.error?.message || "Невідома помилка";
                                    await redis.set(`last_scan_${chatId}`, `⚠️ Помилка Groq: ${errMsg}`, { ex: 3600 });
                                    break;
                                }
                                if (!groqData.choices || !groqData.choices[0]) break;

                                const aiDecision = groqData.choices[0].message.content.trim();

                                if (aiDecision.toUpperCase().startsWith("BUY")) {
                                    const quoteRes = await fetch(
                                        `https://api.jup.ag/swap/v1/quote?inputMint=${solMint}&outputMint=${tokenAddress}&amount=${tradeLamports}&slippageBps=150`, 
                                        { headers: jupHeaders }
                                    );
                                    const quoteData = await quoteRes.json();
                                    
                                    if (quoteData.error) {
                                        await redis.set(`last_scan_${chatId}`, `❌ Jupiter не зміг купити ${sym}`, { ex: 3600 });
                                        break;
                                    }
                                    
                                    const swapRes = await fetch("https://api.jup.ag/swap/v1/swap", { 
                                        method: "POST", headers: jupHeaders, 
                                        body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) 
                                    });
                                    const swapData = await swapRes.json();
                                    
                                    if (!swapData.swapTransaction) {
                                        await redis.set(`last_scan_${chatId}`, `❌ Транзакція не створена для ${sym}`, { ex: 3600 });
                                        break;
                                    }
                                    
                                    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, "base64");
                                    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                                    const { blockhash } = await connection.getLatestBlockhash("finalized");
                                    transaction.message.recentBlockhash = blockhash;
                                    transaction.sign([wallet]);
                                    
                                    const txid = await connection.sendRawTransaction(transaction.serialize(), { 
                                        skipPreflight: true, maxRetries: 5 
                                    });
                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                    
                                    const priceToSave = (pair.priceUsd || "0.000001").toString();
                                    await redis.set(`buy_price_${tokenAddress}_${chatId}`, priceToSave);
                                    await redis.set(`token_info_${tokenAddress}_${chatId}`, JSON.stringify({
                                        symbol: sym, buyPrice: priceToSave, buyTime: Date.now(), txid: txid
                                    }), { ex: 86400 });
                                    await redis.set(`active_buy_${chatId}`, tokenAddress, { ex: 300 });
                                    await redis.set(`last_scan_${chatId}`, `✅ Куплено: <b>${sym}</b>! ШІ очікує прибутку.`, { ex: 3600 });
                                    userLogs.push(`${langDict.buy} ${sym}\n🎯 <b>ШІ:</b> ${aiDecision}\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                                    break;
                                    
                               } else {
    await redis.set(`ignored_token_${tokenAddress}`, "true", { ex: 7200 });
    
    // Парсимо структурований аналіз
    const scoreMatch = aiDecision.match(/SCORE:\s*(\d+)/i);
    const reasonMatch = aiDecision.match(/REASON:\s*(.+)/i);
    const analysisMatch = aiDecision.match(/ANALYSIS:([\s\S]+?)REASON/i);
    
    const score = scoreMatch ? scoreMatch[1] : "?";
    const reason = reasonMatch ? reasonMatch[1].trim() : aiDecision;
    const analysis = analysisMatch ? analysisMatch[1].trim() : "";
    
    const scanText = `🔎 <b>Відхилено: ${sym}</b>\n` +
        `📊 <b>Оцінка ШІ: ${score}/10</b>\n` +
        (analysis ? `${analysis}\n` : "") +
        `🧠 <i>${reason}</i>`;
    
    await redis.set(`last_scan_${chatId}`, scanText, { ex: 3600 });
    break;
}
                            }

                            // Якщо жодного кандидата не знайдено
                            if (!foundCandidate) {
                                await redis.set(`last_scan_${chatId}`, 
                                    `🔧 Всі ${pairs.length} монет відфільтровані!\nІнші мережі: ${skippedChain} | Символи: ${skippedSymbol} | Ліквідність: ${skippedLiq} | Памп: ${skippedPump}`, 
                                    { ex: 3600 }
                                );
                            }

                        } catch (apiError) {
                            await redis.set(`last_scan_${chatId}`, `⚠️ Помилка мережі: ${apiError.message}`, { ex: 3600 });
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Помилка циклу:", err.message);
            await redis.set(`last_scan_${chatId}`, `⚠️ Системна помилка: ${err.message}`, { ex: 3600 });
        }

        if (userLogs.length > 0) {
            await sendTelegramMessage(
                chatId, 
                `🤖 <b>${langDict.rep}</b>\n\n` + userLogs.join("\n\n"), 
                botToken
            );
        }
    }
    res.status(200).send("OK");
  } catch (error) { 
    res.status(500).send(error.message); 
  }
}
