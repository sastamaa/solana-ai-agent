import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export default async function handler(req, res) {
  try {
    // 1. Підключаємо гаманець
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));
    
    // 2. Агент дивиться на ринок (Беремо дані з Dexscreener для токена BONK)
    // Це реальні дані прямо зараз!
    const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    const data = await response.json();
    const token = data.pairs[0];
    
    // 3. Логіка агента (Поки що проста: якщо об'єм торгів великий і ціна падає - купуємо дно)
    const price = parseFloat(token.priceUsd);
    const priceChange24h = token.priceChange.h24;
    const volume24h = token.volume.h24;
    
    let decision = "WAIT (ЧЕКАТИ)";
    let reason = "Ринок нестабільний, краще почекати.";

    // Просте правило для тесту:
    if (priceChange24h < 0 && volume24h > 1000000) {
      decision = "BUY (КУПУВАТИ)";
      reason = `Ціна впала на ${priceChange24h}%, але люди багато торгують ($${volume24h}). Час купувати на низах!`;
    } else if (priceChange24h > 10) {
      decision = "SELL (ПРОДАВАТИ)";
      reason = `Ціна виросла на ${priceChange24h}%, фіксуємо прибуток!`;
    }

    // 4. Агент видає звіт тобі на екран
    res.status(200).json({
      agent_status: "🟢 Активний",
      wallet: wallet.publicKey.toString(),
      market_data: {
        token: token.baseToken.symbol,
        price_usd: `$${price}`,
        change_24h: `${priceChange24h}%`,
        volume_24h: `$${volume24h}`
      },
      agent_thought_process: {
        decision: decision,
        reason: reason
      },
      action_taken: "Поки що тільки аналіз (Торгівля вимкнена для безпеки)"
    });

  } catch (error) {
    console.error("Помилка агента:", error);
    res.status(500).json({ error: error.message });
  }
}
