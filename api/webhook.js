import crypto from 'crypto';
import OpenAI from 'openai';

const { OPENAI_API_KEY, LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN } = process.env;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function verifyLineSignature(rawBody, signature) {
  if (!LINE_CHANNEL_SECRET || !signature) return false;
  const hmac = crypto.createHmac('sha256', LINE_CHANNEL_SECRET).update(rawBody).digest('base64');
  return hmac === signature;
}

async function lineReply(replyToken, text) {
  const resp = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  if (!resp.ok) console.error('LINE reply error:', resp.status, await resp.text());
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // 先回 200，避免 LINE 判定逾時或把錯誤當 500
    res.status(200).end();

    // 變數不齊直接記錄，不處理
    if (!LINE_CHANNEL_SECRET || !LINE_CHANNEL_ACCESS_TOKEN || !OPENAI_API_KEY) {
      console.error('Missing env:', {
        hasSecret: !!LINE_CHANNEL_SECRET,
        hasToken: !!LINE_CHANNEL_ACCESS_TOKEN,
        hasOpenAI: !!OPENAI_API_KEY
      });
      return;
    }

    // 收原始 body（做簽章驗證）
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', c => chunks.push(c));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const rawBody = Buffer.concat(chunks);
    const signature = req.headers['x-line-signature'];
    if (!verifyLineSignature(rawBody, signature)) {
      console.warn('Invalid or missing LINE signature');
      return;
    }

    const body = JSON.parse(rawBody.toString('utf8'));
    for (const event of (body.events || [])) {
      if (event.type === 'message' && event.message?.type === 'text') {
        const userText = (event.message.text || '').trim();
        let aiText = '（暫時無法回覆）';
        try {
          const resp = await openai.responses.create({
            model: 'gpt-4o-mini',
            instructions: '你是用繁體中文回覆的貼心助理。',
            input: userText
          });
          aiText = (resp.output_text || '').slice(0, 1900);
        } catch (e) {
          console.error('OpenAI error:', e);
          aiText = '我這邊忙線一下，等等再試。';
        }
        await lineReply(event.replyToken, aiText);
      }
    }
  } catch (e) {
    console.error('Webhook handler fatal:', e); // 只記 log，不丟 500
  }
}
