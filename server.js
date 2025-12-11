// server.js - RECEIVER HOTMART -> LIBERA BASE44
// NÃO altere se não souber o que faz. Substitua as VARS no Render.

const express = require('express');
const fetch = require('node-fetch'); // v2
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HOTMART_TOKEN = process.env.HOTMART_API_TOKEN || ''; // opcional: para confirmar compra via API
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';   // segredo que você define no Hotmart (opcional)
const BASE44_API_URL = process.env.BASE44_API_URL || '';   // ex: https://app.base44.com/api/hotmart/unlock
const BASE44_API_KEY = process.env.BASE44_API_KEY || '';   // token para autenticar a chamada ao BASE44

// Em produção, SUBSTITUA o "processedSet" por uma tabela no banco (idempotência persistente)
const processedSet = new Set();

async function confirmPurchaseWithHotmart(purchaseId) {
  if (!HOTMART_TOKEN) return null;
  const url = `https://api.hotmart.com/payments/v1/sales/${purchaseId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${HOTMART_TOKEN}` }});
  if (!res.ok) throw new Error('Hotmart API error: ' + res.status);
  return res.json();
}

async function callBase44Unlock(email, purchaseId) {
  if (!BASE44_API_URL) {
    console.warn('BASE44_API_URL não configurado - pulando unlock');
    return { ok: false, message: 'no base44 url' };
  }
  const body = { action: 'grant_access', email, hotmart_purchase_id: purchaseId };
  const headers = { 'Content-Type': 'application/json' };
  if (BASE44_API_KEY) headers['x-api-key'] = BASE44_API_KEY;
  const res = await fetch(BASE44_API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const txt = await res.text();
  return { ok: res.ok, status: res.status, body: txt };
}

app.post('/hotmart/webhook', async (req, res) => {
  try {
    const payload = req.body || {};
    // Ajuste destes caminhos conforme o payload que a Hotmart enviar:
    const purchaseId = payload?.purchase?.id || payload?.data?.purchase?.id || payload?.transaction_id || payload?.purchase_id;
    const email = payload?.buyer?.email || payload?.data?.buyer?.email || payload?.email;
    const eventId = payload?.event?.id || purchaseId || JSON.stringify(payload).slice(0,200);

    if (!purchaseId || !email) {
      console.warn('Payload sem campos necessários', { purchaseId, email });
      return res.status(400).send('missing fields');
    }

    // Validação básica de segredo: Hotmart pode enviar header x-hotmart-signature ou x-auth-token etc.
    const signature = (req.headers['x-hotmart-signature'] || req.headers['x-auth-token'] || '').toString();
    if (WEBHOOK_SECRET && signature && signature !== WEBHOOK_SECRET) {
      console.warn('Assinatura inválida', signature);
      return res.status(401).send('invalid signature');
    }

    // Idempotência (em memória): evita processar duas vezes
    if (processedSet.has(eventId)) {
      console.log('Evento já processado', eventId);
      return res.status(200).send('already processed');
    }

    // (Opcional) confirmar com Hotmart via API
    let statusFromHotmart = payload?.status || payload?.purchase?.status || 'UNKNOWN';
    try {
      const info = await confirmPurchaseWithHotmart(purchaseId);
      if (info && info.status) statusFromHotmart = info.status;
    } catch (err) {
      console.warn('Não foi possível confirmar via API Hotmart:', err.message);
      // aqui decidimos confiar no payload; em ambiente mais rigoroso, reter e responder 500
    }

    // Checar status
    if (!['APPROVED', 'PAID', 'ACTIVE'].includes(String(statusFromHotmart).toUpperCase())) {
      processedSet.add(eventId);
      console.log('Pagamento não aprovado, status:', statusFromHotmart);
      return res.status(200).send('not approved');
    }

    // marcaremos como processado ANTES de agendar para evitar duplicações
    processedSet.add(eventId);

    // Agendar liberação 5 minutos (300000 ms)
    setTimeout(async () => {
      try {
        console.log('Tentando liberar para', email);
        const result = await callBase44Unlock(email, purchaseId);
        console.log('Resultado unlock:', result);
      } catch (err) {
        console.error('Erro ao chamar BASE44:', err);
        // em produção: re-tentar com fila
      }
    }, 5 * 60 * 1000);

    return res.status(200).send('received');
  } catch (err) {
    console.error('Erro no webhook:', err);
    return res.status(500).send('server error');
  }
});

app.get('/', (req, res) => res.send('Hotmart webhook receiver OK'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
