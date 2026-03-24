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

const BANNED_SYMBOLS = ["SOL","WSOL","USDC","USDT","WBTC","PEPE","SHIB","FLOKI","DOGE"];
const BANNED_SUBSTRINGS = ["SOLANA","WRAPPED","BITCOIN","ETHEREUM","OFFICIAL","VERIFIED","REAL","LEGIT","SAFE","ELON","TRUMP"];
const BANNED_ADDRESSES = ["De4ULouuU2cAQkhKuYrsrFtJGRRmcSwQD5esmnAUpump"];

const TAKE_PROFIT = 15;
const STOP_LOSS = 10;
const TRAILING_DROP = 8;
const TRAILING_MIN = 8;
const MAX_HOLD_HOURS = 4;

// ✅ Актуальний курс SOL з кількох джерел
async function getSolPrice() {
    try {
        const res = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
            { signal: AbortSignal.timeout(3000) }
        );
        const data = await res.json();
        if (data?.solana?.usd) return parseFloat(data.solana.usd);
    } catch(e) {}
    // Запасне джерело — Jupiter
    try {
        const res = await fetch(
            'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112',
            { signal: AbortSignal.timeout(3000) }
        );
        const data = await res.json();
        const price = data?.data?.['So11111111111111111111111111111111111111112']?.price;
        if (price) return parseFloat(price);
    } catch(e) {}
    return 130; // Fallback
}

// ✅ Honeypot перевірка через RugCheck
async function checkHoneypot(tokenAddress) {
    try {
        const res = await fetch(
            `https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`,
            { signal: AbortSignal.timeout(3000) }
        );
        if (!res.ok) return false;
        const data = await res.json();
        const risks = data?.risks || [];
        const score = data?.score || 0;
        const dangerous = risks.some(r =>
            r.name?.toLowerCase().includes('honeypot') ||
            r.name?.toLowerCase().includes('freeze') ||
            r.name?.toLowerCase().includes('mint authority') ||
            r.name?.toLowerCase().includes('copycat') ||
            r.level === 'danger'
        );
        return dangerous || score > 500;
    } catch(e) { return false; }
}

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

    // ✅ Отримуємо актуальний курс SOL один раз для всіх користувачів
    const solPriceUsd = await getSolPrice();

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
        
        const settings = userData.settings || { 
            tradeAmount: 0.005, 
            takeProfit: TAKE_PROFIT, 
            stopLoss: STOP_LOSS 
        };
        settings.takeProfit = settings.takeProfit || TAKE_PROFIT;
        settings.stopLoss = settings.stopLoss || STOP_LOSS;

        let soldSomething = false; 
        let activeTokensCount = 0; 

        try {
            const accounts = await connection.getParsedTokenAccountsByOwner(
                wallet.publicKey, 
                { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
            );
            const balance = await connection.getBalance(wallet.publicKey);
            
            // ============ ЕТАП 1: ПРОДАЖ ============
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

                                // Трейлінг-стоп
                                const maxPriceStr = await redis.get(`max_price_${mintAddress}_${chatId}`);
                                let maxPrice = maxPriceStr ? parseFloat(maxPriceStr) : buyPrice;
                                if (currentPrice > maxPrice) {
                                    maxPrice = currentPrice;
                                    await redis.set(`max_price_${mintAddress}_${chatId}`, maxPrice.toString(), { ex: 86400 });
                                }
                                const percentFromMax = ((currentPrice - maxPrice) / maxPrice) * 100;
                                const trailingActive = maxPrice >= buyPrice * (1 + TRAILING_MIN / 100);
                                const trailingTriggered = trailingActive && percentFromMax <= -TRAILING_DROP;

                                // Час утримання
                                const tokenInfoStr = await redis.get(`token_info_${mintAddress}_${chatId}`);
                                const tokenInfo = tokenInfoStr ? JSON.parse(tokenInfoStr) : null;
                                const buyTime = tokenInfo?.buyTime || Date.now();
                                const heldHours = (Date.now() - buyTime) / (1000 * 60 * 60);

                                let reason = null;
                                if (percentChange >= settings.takeProfit) {
                                    reason = `🎯 Take-Profit (+${percentChange.toFixed(2)}%)`;
                                } else if (percentChange <= -settings.stopLoss) {
                                    reason = `🛡 Stop-Loss (${percentChange.toFixed(2)}%)`;
                                } else if (trailingTriggered) {
                                    reason = `📉 Trailing Stop (пік: +${((maxPrice-buyPrice)/buyPrice*100).toFixed(1)}%, впало: ${percentFromMax.toFixed(1)}%)`;
                                } else if (heldHours >= MAX_HOLD_HOURS && percentChange >= 0) {
                                    reason = `⏰ Час вийшов +${percentChange.toFixed(2)}% — фіксуємо прибуток`;
                                } else if (heldHours >= MAX_HOLD_HOURS + 2 && percentChange < 0) {
                                    reason = `⏰ Час вийшов (${heldHours.toFixed(1)}г) — мінімізуємо збиток ${percentChange.toFixed(2)}%`;
                                }
                                
                                if (reason) {
                                    const quoteRes = await fetch(
                                        `https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=300`, 
                                        { headers: jupHeaders }
                                    );
                                    const quoteData = await quoteRes.json();
                                    
                                    if (!quoteData.error && quoteData.outAmount) {
                                        const swapRes = await fetch("https://api.jup.ag/swap/v1/swap", { 
                                            method: "POST", headers: jupHeaders, 
                                            body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() }) 
                                        });
                                        const swapData = await swapRes.json();
                                        if (!swapData.swapTransaction) continue;
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
                                        await redis.del(`max_price_${mintAddress}_${chatId}`);
                                        await redis.del(`active_buy_${chatId}`);
                                        // ✅ SOL отримано з актуальним курсом
                                        const solReceived = (parseInt(quoteData.outAmount) / 1e9).toFixed(4);
                                        const usdReceived = (parseFloat(solReceived) * solPriceUsd).toFixed(2);
                                        await redis.set(`last_scan_${chatId}`, 
                                            `✅ <b>Продано: ${symbol}</b>\nПричина: ${reason}\n💰 Отримано: ${solReceived} SOL (~$${usdReceived})`, 
                                            { ex: 3600 }
                                        );
                                        userLogs.push(`${langDict.sell} ${symbol}\nПричина: ${reason}\n💰 Отримано: ${solReceived} SOL (~$${usdReceived})\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                                        soldSomething = true;
                                        activeTokensCount--;
                                    } else {
                                        await redis.set(`last_scan_${chatId}`, 
                                            `⚠️ <b>${symbol}</b> не можна продати (honeypot/no liquidity).`, 
                                            { ex: 3600 }
                                        );
                                    }
                                }
                            }
                        } catch (e) { console.log("Помилка продажу:", e.message); }
                    }
                }
            }

            // ============ ЕТАП 2: ПОКУПКА ============
            if (!soldSomething && activeTokensCount < 3) {
                const tradeLamports = Math.floor(settings.tradeAmount * 1e9);

                if (balance < tradeLamports + 5000000) {
                    const balSol = (balance / 1e9).toFixed(4);
                    const balUsd = (parseFloat(balSol) * solPriceUsd).toFixed(2);
                    await redis.set(`last_scan_${chatId}`, `⚠️ Недостатньо SOL. Баланс: ${balSol} SOL (~$${balUsd}). Поповніть гаманець.`, { ex: 3600 });
                } else {
                    const recentBuy = await redis.get(`active_buy_${chatId}`);
                    if (recentBuy && activeTokensCount === 0) {
                        await redis.del(`active_buy_${chatId}`);
                    } else if (recentBuy) {
                        await redis.set(`last_scan_${chatId}`, "⏳ Нещодавно куплено. Очікуємо підтвердження...", { ex: 300 });
                    } else {
                        try {
                            const [res1, res2, res3, res4, res5, res6] = await Promise.all([
                                fetch("https://api.dexscreener.com/latest/dex/search?q=dog&rankBy=trendingScoreH6&order=desc"),
                                fetch("https://api.dexscreener.com/latest/dex/search?q=inu&rankBy=trendingScoreH6&order=desc"),
                                fetch("https://api.dexscreener.com/latest/dex/search?q=moon&rankBy=trendingScoreH6&order=desc"),
                                fetch("https://api.dexscreener.com/latest/dex/search?q=bonk&rankBy=trendingScoreH6&order=desc"),
                                fetch("https://api.dexscreener.com/latest/dex/search?q=cat&rankBy=trendingScoreH6&order=desc"),
                                fetch("https://api.dexscreener.com/latest/dex/search?q=frog&rankBy=trendingScoreH6&order=desc")
                            ]);
                            const [d1, d2, d3, d4, d5, d6] = await Promise.all([
                                res1.json(), res2.json(), res3.json(), res4.json(), res5.json(), res6.json()
                            ]);
                            const allPairs = [
                                ...(d1.pairs||[]), ...(d2.pairs||[]), ...(d3.pairs||[]),
                                ...(d4.pairs||[]), ...(d5.pairs||[]), ...(d6.pairs||[])
                            ];
                            const seen = new Set();
                            const pairs = allPairs.filter(p => {
                                if (!p.pairAddress || seen.has(p.pairAddress)) return false;
                                seen.add(p.pairAddress);
                                return true;
                            });

                            let skippedChain = 0, skippedSymbol = 0, skippedLiq = 0;
                            let skippedPump = 0, skippedIgnored = 0, skippedAge = 0;
                            let skippedNoRoute = 0, skippedHoneypot = 0, foundCandidate = false;
                            
                            for (const pair of pairs) {
                                if (pair.chainId !== "solana") { skippedChain++; continue; }
                                
                                const sym = pair.baseToken.symbol.toUpperCase();
                                const tokenAddress = pair.baseToken.address;
                                
                                if (BANNED_SYMBOLS.includes(sym)) { skippedSymbol++; continue; }
                                if (BANNED_SUBSTRINGS.some(sub => sym.includes(sub))) { skippedSymbol++; continue; }
                                if (BANNED_ADDRESSES.includes(tokenAddress)) continue;
                                if (tokenAddress === solMint) continue;
                                
                                const liq = pair.liquidity?.usd || 0;
                                const vol = pair.volume?.h24 || 0;
                                const fdv = pair.fdv || 0; 
                                const priceChange24h = pair.priceChange?.h24 || 0;

                                // ✅ Вік знижено до 6 годин
                                const pairCreatedAt = pair.pairCreatedAt || 0;
                                const ageHours = (Date.now() - pairCreatedAt) / (1000 * 60 * 60);
                                if (ageHours < 6) { skippedAge++; continue; }
                                
                                if (liq < 5000 || vol < 1000 || fdv < 5000) { skippedLiq++; continue; }
                                if (priceChange24h > 200 || priceChange24h < -30) { skippedPump++; continue; }
                                
                                const isIgnored = await redis.get(`ignored_token_${tokenAddress}`);
                                if (isIgnored) { skippedIgnored++; continue; }

                                // Jupiter перевірка маршруту
                                try {
                                    const testQuote = await fetch(
                                        `https://api.jup.ag/swap/v1/quote?inputMint=${tokenAddress}&outputMint=${solMint}&amount=1000000&slippageBps=300`,
                                        { headers: jupHeaders }
                                    );
                                    const testData = await testQuote.json();
                                    if (testData.error || !testData.outAmount) { 
                                        skippedNoRoute++; 
                                        continue;
                                    }
                                } catch(e) { skippedNoRoute++; continue; }

                                // Honeypot перевірка
                                const isHoneypot = await checkHoneypot(tokenAddress);
                                if (isHoneypot) {
                                    skippedHoneypot++;
                                    await redis.set(`ignored_token_${tokenAddress}`, "honeypot", { ex: 86400 });
                                    continue;
                                }

                                foundCandidate = true;
                                // ✅ Показуємо актуальний курс SOL в повідомленні
                                const tradeUsd = (settings.tradeAmount * solPriceUsd).toFixed(2);
                                await redis.set(`last_scan_${chatId}`, 
                                    `🔎 Аналізую: <b>${sym}</b>\nЛік: $${Math.round(liq).toLocaleString()} | Об'єм: $${Math.round(vol).toLocaleString()}\nVol/MCap: ${(vol/fdv*100).toFixed(1)}% | Зміна: ${priceChange24h}%\n💰 SOL: $${solPriceUsd.toFixed(2)}`, 
                                    { ex: 3600 }
                                );

                                const prompt = `You are an aggressive crypto scalper. Analyze this Solana token for a SHORT-TERM trade (1-4 hours) and respond ONLY in this exact format:

DECISION: BUY or WAIT
SCORE: X/10
ANALYSIS:
• Liquidity: [assessment]
• Volume/MCap ratio: [assess]
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

Strategy: SHORT-TERM scalping. BUY if score >= 6.
Prefer tokens with: positive momentum, high volume, liquidity $10k+.
Vol/MCap 5%+ is GREAT. 10%+ is EXCELLENT.
$50k+ liquidity is GOOD. $500k+ is EXCELLENT.
Avoid: price change below -30% or above +200% in 24h.`;

                                const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                                    method: "POST",
                                    headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
                                    body: JSON.stringify({ 
                                        model: "llama-3.3-70b-versatile",
                                        messages: [{ role: "user", content: prompt }], 
                                        temperature: 0.2
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
                                const scoreMatch = aiDecision.match(/SCORE:\s*(\d+)/i);
                                const reasonMatch = aiDecision.match(/REASON:\s*(.+)/i);
                                const analysisMatch = aiDecision.match(/ANALYSIS:([\s\S]+?)REASON/i);
                                const score = scoreMatch ? scoreMatch[1] : "?";
                                const reason = reasonMatch ? reasonMatch[1].trim() : "";
                                const analysis = analysisMatch ? analysisMatch[1].trim() : "";

                                if (aiDecision.toUpperCase().includes("DECISION: BUY")) {
                                    const quoteRes = await fetch(
                                        `https://api.jup.ag/swap/v1/quote?inputMint=${solMint}&outputMint=${tokenAddress}&amount=${tradeLamports}&slippageBps=200`, 
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
                                    await redis.set(`max_price_${tokenAddress}_${chatId}`, priceToSave, { ex: 86400 });
                                    await redis.set(`token_info_${tokenAddress}_${chatId}`, JSON.stringify({
                                        symbol: sym, buyPrice: priceToSave, buyTime: Date.now(), txid
                                    }), { ex: 86400 });
                                    await redis.set(`active_buy_${chatId}`, tokenAddress, { ex: 300 });
                                    await redis.set(`last_scan_${chatId}`, 
                                        `✅ <b>Куплено: ${sym}</b>\n💰 Витрачено: ${settings.tradeAmount} SOL (~$${tradeUsd})\n📊 Оцінка: ${score}/10\n🧠 <i>${reason}</i>\n⏰ Авто-продаж через ${MAX_HOLD_HOURS}г`, 
                                        { ex: 3600 }
                                    );
                                    userLogs.push(`${langDict.buy} ${sym}\n💰 Витрачено: ${settings.tradeAmount} SOL (~$${tradeUsd})\n📊 Оцінка: ${score}/10\n🧠 <i>${reason}</i>\n🔍 <a href="https://solscan.io/tx/${txid}">Tx</a>`);
                                    break;
                                    
                                } else {
                                    await redis.set(`ignored_token_${tokenAddress}`, "true", { ex: 1800 });
                                    const scanText = `🔎 <b>Відхилено: ${sym}</b>\n` +
                                        `📊 <b>Оцінка ШІ: ${score}/10</b>\n` +
                                        (analysis ? `${analysis}\n` : "") +
                                        `🧠 <i>${reason}</i>`;
                                    await redis.set(`last_scan_${chatId}`, scanText, { ex: 3600 });
                                    continue;
                                }
                            }

                            if (!foundCandidate) {
                                await redis.set(`last_scan_${chatId}`, 
                                    `🔧 Всі ${pairs.length} монет відфільтровані!\nІнші мережі: ${skippedChain} | Символи: ${skippedSymbol} | Вік: ${skippedAge} | Ліквідність: ${skippedLiq} | Памп/Дамп: ${skippedPump} | Без маршруту: ${skippedNoRoute} | Honeypot: ${skippedHoneypot} | В ЧС: ${skippedIgnored}\n💰 Курс SOL: $${solPriceUsd.toFixed(2)}`, 
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
