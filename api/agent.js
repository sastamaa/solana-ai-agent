import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { Redis } from '@upstash/redis';

export const maxDuration = 60; 

async function sendTelegramMessage(chatId, text, botToken) {
  if (!botToken || !chatId) return; 
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
  }).catch(err => console.error("Помилка Telegram:", err));
}

export default async function handler(req, res) {
  let globalLogs = [];

  try {
    const groqKey = process.env.GROQ_API_KEY;
    const jupiterKey = process.env.JUPITER_API_KEY; 
    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    if (!groqKey || !jupiterKey || !redisUrl || !redisToken) throw new Error("Missing API Keys");

    const redis = new Redis({ url: redisUrl, token: redisToken });
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const solMint = "So11111111111111111111111111111111111111112";
    const jupHeaders = { 'Content-Type': 'application/json', 'x-api-key': jupiterKey };

    const userKeys = await redis.keys('user_*');
    const allUsers = userKeys.map(key => key.replace('user_', ''));
    if (allUsers.length === 0) return res.status(200).json({ status: "No users in database" });

    for (const chatId of allUsers) {
        let userLogs = { actions: [] };
        let userDataStr = await redis.get(`user_${chatId}`);
        if (!userDataStr) continue;
        
        const userData = typeof userDataStr === 'string' ? JSON.parse(userDataStr) : userDataStr;
        if (!userData.isActive || !userData.privateKey) continue;

        let wallet;
        try { wallet = Keypair.fromSecretKey(bs58.decode(userData.privateKey)); } 
        catch (e) { continue; }
        
        const settings = userData.settings || { tradeAmount: 0.02, takeProfit: 20, stopLoss: 15 };
        
        userLogs.actions.push(`💼 <b>Гаманець:</b> ${userData.walletAddress.substring(0, 4)}...${userData.walletAddress.slice(-4)}`);
        
        const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
          programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        });

        let tokenCount = 0; 
        let soldSomething = false; 

        // --- БЛОК ПРОДАЖУ (Залишаємо без змін) ---
        for (const acc of accounts.value) {
          const tokenAmountInfo = acc.account.data.parsed.info.tokenAmount;
          const mintAddress = acc.account.data.parsed.info.mint;
          
          if (tokenAmountInfo.uiAmount > 0 && mintAddress !== solMint) {
            tokenCount++; 
            try {
                const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
                const dexData = await dexRes.json();
                
                if (dexData.pairs && dexData.pairs.length > 0) {
                    const pair = dexData.pairs[0];
                    const currentPrice = parseFloat(pair.priceUsd);
                    
                    const buyKey = `buy_price_${mintAddress}_${chatId}`;
                    const maxKey = `max_price_${mintAddress}_${chatId}`;
                    let buyPrice = await redis.get(buyKey);
                    let maxPrice = await redis.get(maxKey);
                    
                    let displayProfit = "Невідомо";
                    let shouldSell = false; let sellReason = "";

                    if (buyPrice) {
                        if (!maxPrice || currentPrice > maxPrice) {
                            await redis.set(maxKey, currentPrice); maxPrice = currentPrice;
                        }
                        const profitPercent = ((currentPrice - buyPrice) / buyPrice) * 100;
                        const dropFromMax = ((maxPrice - currentPrice) / maxPrice) * 100; 
                        displayProfit = `PnL: ${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}%`;

                        if (profitPercent >= settings.takeProfit) { shouldSell = true; sellReason = `Тейк-профіт (+${settings.takeProfit}%)`; } 
                        else if (maxPrice > buyPrice && dropFromMax >= 5) { shouldSell = true; sellReason = "Trailing Stop (-5% від піку)"; } 
                        else if (profitPercent <= -settings.stopLoss) {
                            shouldSell = true; sellReason = `Stop-Loss (-${settings.stopLoss}%)`;
                            await redis.set(`blacklist_${mintAddress}_${chatId}`, "true", { ex: 86400 });
                        }
                    } else {
                        const profitPercent = pair.priceChange.h24;
                        displayProfit = `PnL: ${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}% (За 24г)`;
                        if (profitPercent >= 15 || profitPercent <= -10) { shouldSell = true; sellReason = "Фіксація (без бази)"; }
                    }
                    
                    if (shouldSell) {
                        userLogs.actions.push(`🚨 Вирішено <b>ПРОДАТИ</b> ${pair.baseToken.symbol}! \nПричина: ${sellReason}\n${displayProfit}`);
                        try {
                            const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=1500`, { headers: jupHeaders });
                            const quoteData = await quoteRes.json();
                            if(quoteData.error) throw new Error(quoteData.error);

                            const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
                                method: 'POST', headers: jupHeaders,
                                body: JSON.stringify({ 
                                    quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString(),
                                    wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto"
                                })
                            });
                            const swapData = await swapRes.json();
                            const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
                            transaction.sign([wallet]);
                            const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
                            
                            userLogs.actions.push(`✅ Продано! \nTX: https://solscan.io/tx/${txid}`);
                            await redis.del(buyKey); await redis.del(maxKey);
                            tokenCount--; soldSomething = true;
                        } catch (err) { userLogs.actions.push(`❌ Помилка продажу: ${err.message}`); }
                    } else {
                        userLogs.actions.push(`🟡 ${pair.baseToken.symbol} тримаємо. ${displayProfit}`);
                    }
                }
            } catch (e) {}
          }
        }

        if (soldSomething) {
            await sendTelegramMessage(chatId, `🤖 <b>Звіт:</b>\n\n` + userLogs.actions.join('\n\n'), botToken);
            globalLogs.push({ user: chatId, logs: userLogs });
            continue; 
        }

        const solBalance = await connection.getBalance(wallet.publicKey);
        const solBalanceUi = solBalance / 1e9; 
        let tradeAmountUi = settings.tradeAmount;
        
        // Перевіряємо, чи вистачить грошей на покупку і на комісію
        const canAfford = (solBalanceUi - tradeAmountUi) >= 0.005; 
        
        if (tokenCount >= 3 || !canAfford) {
            // Щоб бот не спамив кожні 5 хвилин про те, що немає грошей, ми не надсилаємо це в Telegram
            console.log(`User ${chatId} - Not enough balance or max tokens reached.`);
            globalLogs.push({ user: chatId, status: "Paused" });
            continue; 
        }

        // --- БЛОК ПОШУКУ ТА ПОКУПКИ (ТЕПЕР БОТ ПЕРЕБИРАЄ ТОКЕНИ) ---
        userLogs.actions.push("\n🎯 <b>Режим Снайпера:</b>");
        const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
        
        try {
            const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
            const searchData = await searchRes.json();
            
            let boughtSomething = false;

            if(searchData && searchData.pairs) {
                // Перебираємо до 5 різних токенів, поки не знайдемо підходящий
                for (const p of searchData.pairs) {
                    if (boughtSomething) break; // Якщо вже купили - зупиняємось

                    // Відфільтровуємо скам і старі монети
                    if (p.chainId === 'solana' && p.volume && p.volume.h24 > 50000 && p.liquidity && p.liquidity.usd > 20000 && 
                        p.baseToken.symbol !== 'SOL' && p.pairCreatedAt && p.pairCreatedAt < twoHoursAgo) {
                        
                        const isBlacklisted = await redis.get(`blacklist_${p.baseToken.address}_${chatId}`);
                        if (isBlacklisted) continue; // Пропускаємо ті, що в чорному списку

                        // Звертаємось до ШІ для перевірки конкретного токена
                        const prompt = `Ти крипто-снайпер. Токен: ${p.baseToken.symbol}. Зміна 24г: ${p.priceChange.h24}%. Об'єм: $${p.volume.h24}. Якщо зміна більше 50% або менше -5% - пиши "WAIT". Напиши "BUY", тільки якщо бачиш потенціал для росту (зміна від -5% до 40%). Відповідай коротко. Формат: "РІШЕННЯ: пояснення"`;

                        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
                            body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }] })
                        });
                        
                        const groqData = await groqResponse.json();
                        if(groqData.choices && groqData.choices.length > 0) {
                            const aiDecision = groqData.choices[0].message.content;
                            
                            // Якщо ШІ каже чекати - записуємо це в лог і ЙДЕМО ДО НАСТУПНОГО ТОКЕНА
                          if (aiDecision.includes("WAIT")) {
    continue; // Просто йдемо далі, нічого не записуючи в лог
                            }

                            // Якщо ШІ каже BUY - купуємо!
                            if (aiDecision.includes("BUY")) {
                                userLogs.actions.push(`🧠 ШІ обрав <b>${p.baseToken.symbol}</b>: ${aiDecision}`);
                                try {
                                    const tradeAmountLamports = Math.floor(tradeAmountUi * 1e9);
                                    const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${solMint}&outputMint=${p.baseToken.address}&amount=${tradeAmountLamports}&slippageBps=1500`, { headers: jupHeaders });
                                    const quoteData = await quoteRes.json();
                                    if(quoteData.error) throw new Error(quoteData.error);

                                    const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
                                        method: 'POST', headers: jupHeaders, 
                                        body: JSON.stringify({ 
                                            quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString(),
                                            wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto"
                                        })
                                    });
                                    
                                    const swapData = await swapRes.json();
                                    const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));
                                    transaction.sign([wallet]);
                                    const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
                                    
                                    const currentPrice = parseFloat(p.priceUsd);
                                    await redis.set(`buy_price_${p.baseToken.address}_${chatId}`, currentPrice);
                                    await redis.set(`max_price_${p.baseToken.address}_${chatId}`, currentPrice);

                                    userLogs.actions.push(`✅ <b>КУПЛЕНО!</b> Потрачено ${tradeAmountUi} SOL. \nTX: https://solscan.io/tx/${txid}`);
                                    boughtSomething = true; // Купили, виходимо з циклу
                                    
                                } catch (err) {
                                     userLogs.actions.push(`❌ Помилка покупки ${p.baseToken.symbol}: ${err.message}`);
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) { console.error("Sniper error", e); }
        
        // Відправляємо звіт в Telegram ТІЛЬКИ якщо бот щось знайшов і прийняв рішення 
        // (щоб не спамити пустими повідомленнями кожні 5 хвилин)
       // Відправляємо звіт ТІЛЬКИ якщо бот щось реально КУПИВ або ПРОДАВ
const hasAction = userLogs.actions.some(msg => msg.includes("КУПЛЕНО") || msg.includes("ПРОДАТИ") || msg.includes("Помилка покупки") || msg.includes("Помилка продажу"));

if (hasAction) {
    await sendTelegramMessage(chatId, `🤖 <b>Звіт Агента:</b>\n\n` + userLogs.actions.join('\n\n'), botToken);
}

        globalLogs.push({ user: chatId, logs: userLogs });
    }

    res.status(200).json({ status: "Trade cycle completed", details: globalLogs });

  } catch (error) {
    console.error("Fatal Agent Error:", error);
    res.status(500).json({ error: error.message });
  }
}
