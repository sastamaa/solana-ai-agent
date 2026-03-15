import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export default async function handler(req, res) {
  try {
    // 1. Підключаємо гаманець
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    
    // 2. Беремо дані з ринку (наприклад, токен BONK)
    const dexResponse = await fetch('https://api.dexscreener.com/latest/dex/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    const dexData = await dexResponse.json();
    const token = dexData.pairs[0];
    
    const price = parseFloat(token.priceUsd);
    const priceChange24h = token.priceChange.h24;
    const volume24h = token.volume.h24;

    // 3. Звертаємося до БЕЗКОШТОВНОГО Gemini API
    const geminiKey = process.env.GEMINI_API_KEY;
    const prompt = `Ти професійний крипто-трейдер на Solana. Проаналізуй цей токен:
Назва: ${token.baseToken.symbol}
Ціна: $${price}
Зміна за 24г: ${priceChange24h}%
Об'єм торгів: $${volume24h}
Дай коротку відповідь: одне слово "BUY" або "WAIT", і одне речення пояснення. Формат: "РІШЕННЯ: пояснення"`;

    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const geminiData = await geminiResponse.json();
    
    let aiDecision = "Помилка ШІ";
    if (geminiData.candidates && geminiData.candidates.length > 0) {
        aiDecision = geminiData.candidates[0].content.parts[0].text.trim();
    } else {
        console.error("Gemini error:", geminiData);
    }

    // 4. Виводимо результат (зміни grok_analysis на ai_analysis)
    res.status(200).json({
      agent_status: "🧠 ШІ Gemini Активний",
      wallet: wallet.publicKey.toString(),
      market_data: {
        token: token.baseToken.symbol,
        price_usd: `$${price}`,
        change_24h: `${priceChange24h}%`,
        volume_24h: `$${volume24h}`
      },
      ai_analysis: aiDecision
    });

  } catch (error) {
    console.error("Помилка агента:", error);
    res.status(500).json({ error: error.message });
  }
}
