import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'node-fetch';

export const maxDuration = 60;

// ==========================================
// ФУНКЦІЯ: ВІДПРАВКА ЗВІТУ В TELEGRAM
// ==========================================
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; 
  
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true })
  }).catch(err => console.error("Помилка відправки в Telegram:", err));
}

export default async function handler(req, res) {
  let logs = { actions: [] };

  try {
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    const jupiterKey = process.env.JUPITER_API_KEY; // НОВИЙ КЛЮЧ JUPITER
    
    if (!privateKey || !groqKey || !jupiterKey) {
        throw new Error("Не вистачає ключів Solana, Groq або Jupiter у Vercel!");
    }
    
    // Створюємо "перепустку" для Jupiter
    const jupHeaders = {
        'Content-Type': 'application/json',
        'x-api-key': jupiterKey
    };

    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl);
    const solMint = "So11111111111111111111111111111111111111112";

    // ==========================================
    // СТАДІЯ 1: МЕНЕДЖЕР ПОРТФЕЛЯ (ПЕРЕВІРКА І ПРОДАЖ)
    // ==========================================
    logs.actions.push("🔍 <b>Перевірка портфеля:</b>");
    
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    });

    let hasTokensToSell = false;

    for (const acc of accounts.value) {
      const tokenAmountInfo = acc.account.data.parsed.info.tokenAmount;
      const mintAddress = acc.account.data.parsed.info.mint;
      
      if (tokenAmountInfo.uiAmount > 0 && mintAddress !== solMint) {
        hasTokensToSell = true;
        
        const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
        const dexData = await dexRes.json();
        
        if (dexData.pairs && dexData.pairs.length > 0) {
            const pair = dexData.pairs[0];
            const change24h = pair.priceChange.h24;
            
            if (change24h >= 15 || change24h <= -10) {
                logs.actions.push(`🚨 Вирішено <b>ПРОДАТИ</b> ${pair.baseToken.symbol}! Зміна ціни: ${change24h}%`);
                
                try {
                    const quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=1000`, {
                        method: 'GET',
                        headers: jupHeaders // Додаємо ключ сюди
                    });
                    const quoteData = await quoteRes.json();

                    const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
                        method: 'POST',
                        headers: jupHeaders, // Додаємо ключ сюди
                        body: JSON.stringify({ 
                            quoteResponse: quoteData, 
                            userPublicKey: wallet.publicKey.toString(),
                            wrapAndUnwrapSol: true,
                            dynamicComputeUnitLimit: true,
                            prioritizationFeeLamports: "auto",
                            dynamicSlippage: { maxBps: 1000 }
                        })
                    });
                    
                    if (!swapRes.ok) throw new Error("Jupiter не зміг згенерувати транзакцію продажу.");
                    const { swapTransaction } = await swapRes.json();

                    const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
                    transaction.sign([wallet]);
                    
                    const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
                    
                    logs.actions.push(`✅ Успішно продано! \nTX: https://solscan.io/tx/${txid}`);
                    const reportText = `🤖 <b>Звіт Агента:</b>\n\n` + logs.actions.join('\n\n');
                    await sendTelegramMessage(reportText);
                    return res.status(200).json(logs); 

                } catch (err) {
                    logs.actions.push(`❌ Помилка продажу: ${err.message}`);
                }
            } else {
                logs.actions.push(`🟡 Токен ${pair.baseToken.symbol} тримаємо (HOLD). Зміна: ${change24h}%`);
            }
        }
      }
    }

    if (hasTokensToSell) {
        logs.actions.push("\n⏸ В гаманці є активи. Нові покупки призупинено.");
        const reportText = `🤖 <b>Звіт Агента:</b>\n\n` + logs.actions.join('\n');
        await sendTelegramMessage(reportText);
        return res.status(200).json(logs);
    }

    // ==========================================
    // СТАДІЯ 2: СНАЙПЕР (КУПІВЛЯ НОВОГО ТОКЕНА)
    // ==========================================
    logs.actions.push("\n🎯 <b>Режим Снайпера (Гаманець чистий):</b>");
    
    const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=raydium');
    const searchData = await searchRes.json();
    
    const activePairs = searchData.pairs.filter(p => 
        p.chainId === 'solana' && 
        p.volume && p.volume.h24 > 50000 && 
        p.liquidity && p.liquidity.usd > 50000 && 
        p.baseToken.symbol !== 'SOL' && 
        p.baseToken.symbol !== 'WSOL' && 
        p.baseToken.symbol !== 'USDC'
    );
    
    if (activePairs.length === 0) {
        logs.actions.push("Ринок порожній. Нічого безпечного не знайдено.");
        const reportText = `🤖 <b>Звіт Агента:</b>\n\n` + logs.actions.join('\n');
        await sendTelegramMessage(reportText);
        return res.status(200).json(logs);
    }

    const targetToken = activePairs[Math.floor(Math.random() * activePairs.length)];
    const prompt = `Ти трейдер на Solana. Токен: ${targetToken.baseToken.symbol}. Ціна: $${targetToken.priceUsd}. Зміна: ${targetToken.priceChange.h24}%. Об'єм: $${targetToken.volume.h24}. Напиши "BUY", якщо бачиш потенціал росту. Інакше "WAIT". Формат: "РІШЕННЯ: пояснення"`;

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }] })
    });
    
    const groqData = await groqResponse.json();
    const aiDecision = groqData.choices[0].message.content;
    
    logs.actions.push(`Токен: <b>${targetToken.baseToken.symbol}</b>\n🧠 Аналіз ШІ: ${aiDecision}`);

    if (aiDecision.includes("BUY")) {
        try {
            logs.actions.push(`⏳ Створюю транзакцію для ${targetToken.baseToken.symbol}...`);
            
            let quoteRes;
            for (let i = 0; i < 3; i++) {
                try {
                    quoteRes = await fetch(`https://api.jup.ag/swap/v1/quote?inputMint=${solMint}&outputMint=${targetToken.baseToken.address}&amount=20000000&slippageBps=1000`, {
                        method: 'GET',
                        headers: jupHeaders // Додаємо ключ
                    });
                    if (quoteRes.ok) break; 
                } catch (e) {
                    if (i === 2) throw new Error(`Не вдалося з'єднатися з Jupiter: ${e.message}`);
                    await new Promise(res => setTimeout(res, 1000)); 
                }
            }
            
            if (!quoteRes || !quoteRes.ok) {
                const errorText = quoteRes ? await quoteRes.text() : 'Немає відповіді';
                throw new Error(`Jupiter відмовив: ${errorText}`);
            }
            
            const quoteData = await quoteRes.json();
            if (quoteData.error) throw new Error(quoteData.error);

            const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
                method: 'POST',
                headers: jupHeaders, // Додаємо ключ
                body: JSON.stringify({ 
                    quoteResponse: quoteData, 
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: "auto",
                    dynamicSlippage: { maxBps: 1000 }
                })
            });
            
            if (!swapRes.ok) throw new Error("Jupiter не зміг згенерувати Swap-транзакцію.");
            const { swapTransaction } = await swapRes.json();

            logs.actions.push(`⏳ Відправляю в блокчейн...`);
            const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
            transaction.sign([wallet]);
            const rawTransaction = transaction.serialize();
            
            let txid = await connection.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 5 });
            logs.actions.push(`\n✅ <b>ТРАНЗАКЦІЯ ВІДПРАВЛЕНА!</b> Потрачено 0.02 SOL.\nTX: https://solscan.io/tx/${txid}`);
            
        } catch (err) {
             logs.actions.push(`\n❌ Помилка покупки: ${err.message}`);
        }
    }

    const finalReport = `🤖 <b>Звіт Агента:</b>\n\n` + logs.actions.join('\n');
    await sendTelegramMessage(finalReport);

    res.status(200).json(logs);

  } catch (error) {
    await sendTelegramMessage(`⚠️ <b>Критична помилка агента:</b>\n${error.message}`);
    res.status(500).json({ error: error.message });
  }
}
