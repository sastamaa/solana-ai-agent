import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export default async function handler(req, res) {
  try {
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    const groqKey = process.env.GROQ_API_KEY;
    if (!privateKey || !groqKey) throw new Error("Ключі не налаштовані");
    
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    const connection = new Connection('https://api.mainnet-beta.solana.com');
    const solMint = "So11111111111111111111111111111111111111112";

    let logs = { wallet: wallet.publicKey.toString(), actions: [] };

    // ==========================================
    // СТАДІЯ 1: МЕНЕДЖЕР ПОРТФЕЛЯ (ПРОДАЖ)
    // ==========================================
    logs.actions.push("Сканую гаманець на наявність токенів...");
    
    // Отримуємо всі токени з гаманця
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new (require('@solana/web3.js').PublicKey)("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    });

    let hasTokensToSell = false;

    // Перевіряємо кожен токен
    for (const acc of accounts.value) {
      const tokenAmountInfo = acc.account.data.parsed.info.tokenAmount;
      const mintAddress = acc.account.data.parsed.info.mint;
      
      // Якщо баланс в доларовому еквіваленті хоч трохи значний (ігноруємо SOL і порожні)
      if (tokenAmountInfo.uiAmount > 0 && mintAddress !== solMint) {
        hasTokensToSell = true;
        
        // Дізнаємось ринкову ціну токена
        const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
        const dexData = await dexRes.json();
        
        if (dexData.pairs && dexData.pairs.length > 0) {
            const pair = dexData.pairs[0];
            const change24h = pair.priceChange.h24;
            
            // ЛОГІКА ПРОДАЖУ: Якщо ціна виросла на >15% АБО впала на >10%
            if (change24h >= 15 || change24h <= -10) {
                logs.actions.push(`Вирішено ПРОДАТИ ${pair.baseToken.symbol}. Зміна ціни: ${change24h}%`);
                
                try {
                    // Отримуємо котирування на продаж ВСЬОГО балансу цього токена
                    const quoteRes = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${solMint}&amount=${tokenAmountInfo.amount}&slippageBps=300`);
                    const quoteData = await quoteRes.json();

                    const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() })
                    });
                    const { swapTransaction } = await swapRes.json();

                    const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
                    transaction.sign([wallet]);
                    const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
                    
                    logs.actions.push(`✅ Успішно продано! TX: https://solscan.io/tx/${txid}`);
                    return res.status(200).json(logs); // Завершуємо роботу після успішного продажу
                } catch (err) {
                    logs.actions.push(`❌ Помилка продажу: ${err.message}`);
                }
            } else {
                logs.actions.push(`Токен ${pair.baseToken.symbol} тримаємо (HOLD). Зміна: ${change24h}%`);
            }
        }
      }
    }

    // Якщо ми маємо токени, але їх не треба продавати - ми не купуємо нові, щоб не витратити всі SOL
    if (hasTokensToSell) {
        logs.actions.push("В гаманці є активи, нові покупки призупинено до моменту фіксації прибутку.");
        return res.status(200).json(logs);
    }

    // ==========================================
    // СТАДІЯ 2: СНАЙПЕР (КУПІВЛЯ 0.05 SOL)
    // ==========================================
    logs.actions.push("Гаманець чистий. Починаю пошук нових токенів...");
    
    const searchRes = await fetch('https://api.dexscreener.com/latest/dex/search?q=solana');
    const searchData = await searchRes.json();
    const activePairs = searchData.pairs.filter(p => p.chainId === 'solana' && p.volume && p.volume.h24 > 50000 && p.liquidity && p.liquidity.usd > 10000);
    
    if (activePairs.length === 0) return res.status(200).json({ status: "WAIT", logs });

    const targetToken = activePairs[Math.floor(Math.random() * Math.min(5, activePairs.length))];
    const prompt = `Ти трейдер на Solana. Токен: ${targetToken.baseToken.symbol}. Ціна: $${targetToken.priceUsd}. Зміна: ${targetToken.priceChange.h24}%. Об'єм: $${targetToken.volume.h24}. Напиши "BUY", якщо бачиш потенціал росту. Інакше "WAIT". Формат: "РІШЕННЯ: пояснення"`;

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }] })
    });
    
    const groqData = await groqResponse.json();
    const aiDecision = groqData.choices[0].message.content;
    logs.actions.push(`ШІ Аналіз: ${aiDecision}`);

    if (aiDecision.includes("BUY")) {
        try {
            // КУПУЄМО НА 0.01 SOL (це 10000000 lamports)
            const quoteRes = await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${solMint}&outputMint=${targetToken.baseToken.address}&amount=10000000&slippageBps=300`);
            const quoteData = await quoteRes.json();

            const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString() })
            });
            const { swapTransaction } = await swapRes.json();

            const transaction = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
            transaction.sign([wallet]);
            const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
            
            logs.actions.push(`✅ Успішно КУПЛЕНО ${targetToken.baseToken.symbol} на 0.05 SOL! TX: https://solscan.io/tx/${txid}`);
        } catch (err) {
            logs.actions.push(`❌ Помилка покупки: ${err.message}`);
        }
    }

    res.status(200).json(logs);

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
