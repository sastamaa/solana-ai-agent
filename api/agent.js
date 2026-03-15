import { Connection, Keypair } from '@solana/web3.js';
import { createJupiterApiClient } from '@jup-ag/api';
import bs58 from 'bs58';

export default async function handler(req, res) {
  try {
    // 1. Підключення до мережі Solana та Jupiter
    const connection = new Connection('https://api.mainnet-beta.solana.com');
    const jupiter = createJupiterApiClient();

    // 2. БЕЗПЕЧНЕ отримання гаманця з Vercel Environment Variables
    const privateKey = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("Private key not found in Vercel settings!");
    }
    // Phantom видає ключ у форматі base58, тому його треба розкодувати
    const wallet = Keypair.fromSecretKey(bs58.decode(privateKey));

    console.log(`Bot Wallet Address: ${wallet.publicKey.toString()}`);

    // === ТУТ БУДЕ ЛОГІКА ШІ ТА ТОРГІВЛІ ===
    // Цей блок поки що закоментовано, щоб бот не купив щось випадково при першому запуску
    /*
    const quoteResponse = await jupiter.quoteGet({
      inputMint: "So11111111111111111111111111111111111111112", // SOL
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      amount: 10000000, // 0.01 SOL (в lamports)
      slippageBps: 50, // 0.5%
    });

    const { swapTransaction } = await jupiter.exchange({
      quoteResponse,
      userPublicKey: wallet.publicKey,
    });

    // Виконання транзакції
    const txid = await connection.sendTransaction(swapTransaction, [wallet]);
    console.log(`Auto-trade TX: https://solscan.io/tx/${txid}`);
    */
    // ======================================

    // Відповідь сервера, щоб ти бачила, що бот працює
    res.status(200).json({ 
      status: 'Агент працює!', 
      walletAddress: wallet.publicKey.toString() 
    });

  } catch (error) {
    console.error("Помилка агента:", error);
    res.status(500).json({ error: error.message });
  }
}
