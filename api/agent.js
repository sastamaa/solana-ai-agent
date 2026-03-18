import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { Redis } from '@upstash/redis';

export const maxDuration = 60; 

async function sendTelegramMessage(chatId, text, botToken) {
  if (!botToken || !chatId) return; 
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
  }).catch(err => console.error("Telegram error:", err));
}

export default async function handler(req, res) {
  let globalLogs = [];

  try {
    const groqKey = process.env.GROQ_API_KEY;
    const jupiterKey = process.env.JUPITER_API_KEY; 
    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    
    if (!groqKey || !jupiterKey || !redisUrl || !redisToken) {
        throw new Error("Missing API Keys");
    }

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
        if (!userData.isActive) continue;

        const wallet = Keypair.fromSecretKey(bs58.decode(userData.privateKey));
        const settings = userData.settings || { tradeAmount: 0.02, takeProfit: 15, stopLoss: 10 };
        
        userLogs.actions.push(`💼 <b>Гаманець:</b> ${userData.walletAddress.substring(0, 4)}...${userData.walletAddress.slice(-4)}`);
        userLogs.actions.push("🔍 <b>Перевірка портфеля:</b>");
        
        const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
          programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        });

        let tokenCount = 0; 
        let soldSomething = false; 

        for (const acc of accounts.value) {
          const tokenAmountInfo = acc.account.data.parsed.info.tokenAmount;
          const mintAddress = acc.account.data.parsed.info.mint;
          
          if (tokenAmountInfo.uiAmount > 0 && mintAddress !== solMint) {
            tokenCount++; 
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
                let shouldSell = false;
                let sellReason = "";

                if (buyPrice) {
                    if (!maxPrice || currentPrice > maxPrice) {
                        await redis.set(maxKey, currentPrice);
                        maxPrice = currentPrice;
                    }

                    const profitPercent = ((currentPrice - buyPrice) / buyPrice) * 100;
                    const dropFromMax = ((maxPrice - currentPrice) / maxPrice) * 100; 
                    displayProfit = `PnL: ${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}% | Відкат: -${dropFromMax.toFixed(2)}%`;

                    if (profitPercent >= settings.takeProfit) {
                        shouldSell = true; sellReason = `Тейк-профіт (+${settings.takeProfit}%)`;
                    } else if (maxPrice > buyPrice && dropFromMax >= 5) {
                        shouldSell = true; sellReason = "Trailing Stop (-5% від піку)";
                    } else if (profitPercent <= -settings.stopLoss) {
                        shouldSell = true; sellReason = `Stop-Loss (-${settings.stopLoss}%)`;
                        await redis.set(`blacklist_${mintAddress}_${chatId}`, "true", { ex: 86400 });
                    }
                } else {
                    const profitPercent = pair.priceChange.h24;
                    displayProfit = `PnL: ${profitPercent > 0 ? '+' : ''}${profitPercent.toFixed(2)}% (За 24г)`;
                    if (profitPercent >= 15 || profitPercent <= -10) {
                        shouldSell = true; sellReason = "Фіксація (без бази)";
                    }
                }
                
                if (shouldSell) {
                    userLogs.actions.push(`🚨 Вирішено <b>ПРОДАТИ</b> ${pair.baseToken.symbol}! \nПричина: ${sellReason}\n${displayProfit}`);
                    try {
                        const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=1000`, { headers: jupHeaders });
                        const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
                            method: 'POST', headers: jupHeaders,
                            body: JSON.stringify({ 
                                quoteResponse: await quoteRes.json(), userPublicKey: wallet.publicKey.toString(),
                                wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto"
                            })
                        });
                        const { swapTransaction } = await swapRes.json();
                        const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
                        transaction.sign([wallet]);
                        const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
                        
                        userLogs.actions.push(`✅ Продано! \nTX: https://solscan.io/tx/${txid}`);
                        await redis.del(buyKey); await redis.del(maxKey);
                        tokenCount--; soldSomething = true;
                    } catch (err) {
                        userLogs.actions.push(`❌ Помилка продажу: ${err.message}`);
                    }
                } else {
                    userLogs.actions.push(`🟡 Токен ${pair.baseToken.symbol} тримаємо. \n${displayProfit}`);
                }
            }
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
        const canAfford = (solBalanceUi - tradeAmountUi) >= 0.005;
        
        if (tokenCount >= 3 || !canAfford) {
            userLogs.actions.push(`\n⏸ Нові покупки призупинено. В портфелі: ${tokenCount}/3. \nВільний баланс: ${solBalanceUi.toFixed(3)} SOL.`);
            globalLogs.push({ user: chatId, logs: userLogs });
            continue; 
        }

        userLogs.actions.push("\n🎯 <b>Режим Снайпера (БЕЗПЕЧНИЙ ПОШУК):</b>");
        const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000); 
        
        const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=raydium');
        const searchData = await searchRes.json();
        
        let targetToken = null;

        for (const p of searchData.pairs) {
            if (p.chainId === 'solana' && p.volume && p.volume.h24 > 150000 && p.liquidity && p.liquidity.usd > 50000 && 
                p.baseToken.symbol !== 'SOL' && p.pairCreatedAt && p.pairCreatedAt < twoHoursAgo) {
                
                const isBlacklisted = await redis.get(`blacklist_${p.baseToken.address}_${chatId}`);
                if (!isBlacklisted) {
                    targetToken = p;
                    break;
                }
            }
        }
        
        if (!targetToken) {
            userLogs.actions.push("Безпечних монет не знайдено. Чекаю.");
            continue;
        }

        const prompt = `Ти консервативний крипто-снайпер. Токен: ${targetToken.baseToken.symbol}. Зміна 24г: ${targetToken.priceChange.h24}%. Об'єм: $${targetToken.volume.h24}. Якщо зміна більше 30% або менше 0% - пиши "WAIT". Напиши "BUY", тільки якщо бачиш стабільний ріст від 5% до 25%. Інакше "WAIT". Формат: "РІШЕННЯ: пояснення"`;

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }] })
        });
        
        const aiDecision = (await groqResponse.json()).choices[0].message.content;
        userLogs.actions.push(`Токен: <b>${targetToken.baseToken.symbol}</b>\n🧠 ШІ: ${aiDecision}`);

        if (aiDecision.includes("BUY")) {
            try {
                const tradeAmountLamports = Math.floor(tradeAmountUi * 1e9);
                const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${solMint}&outputMint=${targetToken.baseToken.address}&amount=${tradeAmountLamports}&slippageBps=1000`, { headers: jupHeaders });
                const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
                    method: 'POST', headers: jupHeaders, 
                    body: JSON.stringify({ 
                        quoteResponse: await quoteRes.json(), userPublicKey: wallet.publicKey.toString(),
                        wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto"
                    })
                });
                
                const { swapTransaction } = await swapRes.json();
                const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
                transaction.sign([wallet]);
                const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
                
                const currentPrice = parseFloat(targetToken.priceUsd);
                await redis.set(`buy_price_${targetToken.baseToken.address}_${chatId}`, currentPrice);
                await redis.set(`max_price_${targetToken.baseToken.address}_${chatId}`, currentPrice);

                userLogs.actions.push(`\n✅ <b>КУПЛЕНО!</b> Потрачено ${tradeAmountUi} SOL. \nTX: https://solscan.io/tx/${txid}`);
                
            } catch (err) {
                 userLogs.actions.push(`\n❌ Помилка покупки: ${err.message}`);
            }
        }
        
        await sendTelegramMessage(chatId, `🤖 <b>Звіт Агента:</b>\n\n` + userLogs.actions.join('\n'), botToken);
        globalLogs.push({ user: chatId, logs: userLogs });
    }

    res.status(200).json({ status: "Trade cycle completed", details: globalLogs });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
