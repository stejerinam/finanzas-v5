export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, filename, accountType, model } = req.body;
  if (!text || text.trim().length < 50)
    return res.status(400).json({ error: 'Text too short or empty' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const MODELS = {
    sonnet: 'claude-sonnet-4-6',
    haiku:  'claude-haiku-4-5-20251001',
  };
  const selectedModel = MODELS[model] || MODELS.sonnet;

  const accountTypeLabel = {
    credit: 'credit card',
    debit: 'debit card',
    savings: 'savings account',
    checking: 'checking account',
  }[accountType] || 'bank account';

  const systemPrompt = `You are a bank statement parser. Your ONLY job is to extract transactions as structured data. Do NOT categorize, interpret, or summarize anything. Output valid JSON only — no markdown, no explanation.`;

  const userPrompt = `This is a <account_type>${accountTypeLabel}</account_type> statement.

Extract every transaction from this statement.

<field_definitions>
- date: transaction date in YYYY-MM-DD format
- description: merchant name, counterparty, or transaction label. Remove raw account numbers and hashes but keep all meaningful text.
- amount: always a positive number. Direction handles the sign.
- direction: "credit" = money IN, "debit" = money OUT
- type: transaction mechanism. Use "Installment Plan" (exactly, in English) for any installment/MSI/cuotas entry — see rule 6. For all other transactions use the mechanism as written in the statement (e.g. "Compra", "Transferencia", "Purchase", "ATM Withdrawal").
- reference: short human-written note describing payment purpose. Banks call this: Concepto, Glosa, Memo, Narration, Payment Reference, Details, Remarks. null if not present.
- merchantHint: if a separate column exists for merchant name or location (e.g. Lugar, Establecimiento, Merchant, Payee) that differs from description, extract it here. null otherwise.
- counterpartyName: name of the person or business on the other side of the transaction if visible. null if not present.
- counterpartyAccount: account number, IBAN, CLABE, or routing ID of the counterparty if visible. null if not present.
</field_definitions>

<rules>
1. Amounts always positive — use direction for credit/debit.
2. Currency consistency — use the primary account currency throughout. Never mix currencies.
3. For Excel/CSV: map columns to fields by meaning regardless of language.
4. Only extract rows that are actual money movements. Skip: balance-only rows, section headers, dividers, zero-amount accrual rows, summary/subtotal rows.
5. CRITICAL — statements often have multiple columns: transaction amount, running balance, others. Only read the debit/credit/transaction amount column. Never use the running balance as the transaction amount.
6. INSTALLMENT PLANS — this is critical: many Latin American credit card statements (especially Mexican, Colombian, Argentine) have a dedicated section listing active installment plans (MSI = Meses Sin Intereses, cuotas, diferidos, meses con intereses). These appear as rows like:
   - "Amazon Prime 3/12 MSI $499" or "Liverpool 6/18 $1,500" or "Cuota 5 de 12 $800"
   These MUST be extracted as individual transactions with type exactly "Installment Plan". Do not skip them. Do not merge them. The amount is the monthly payment amount, not the total.
7. If a statement contains multiple account sections, extract transactions from all of them.
8. Works for any language, any country, any bank format.
</rules>

<statement>
${text.slice(0, 100000)}
</statement>`;

  async function callWithRetry(payload, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (data.error?.type === 'overloaded_error') {
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
          continue;
        }
        return res.status(503).json({ error: 'Anthropic API is temporarily overloaded — please try again in a few seconds' });
      }
      return data;
    }
  }

  try {
    const data = await callWithRetry({
      model: selectedModel,
      max_tokens: 32000,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    if (data.error) return res.status(502).json({ error: data.error.message });

    const raw = data.content?.[0]?.text || '';
    let jsonStr = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    // Find start — could be object { or array [
    const firstObj = jsonStr.indexOf('{');
    const firstArr = jsonStr.indexOf('[');
    let firstToken = -1;
    if (firstObj !== -1 && firstArr !== -1) firstToken = Math.min(firstObj, firstArr);
    else if (firstObj !== -1) firstToken = firstObj;
    else if (firstArr !== -1) firstToken = firstArr;
    if (firstToken > 0) jsonStr = jsonStr.slice(firstToken);

    // Find end
    const lastObj = jsonStr.lastIndexOf('}');
    const lastArr = jsonStr.lastIndexOf(']');
    const lastToken = Math.max(lastObj, lastArr);
    if (lastToken !== -1 && lastToken < jsonStr.length - 1) jsonStr = jsonStr.slice(0, lastToken + 1);

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return res.status(500).json({ error: 'Could not parse AI response as JSON', raw: raw.slice(0, 300) });
    }

    // Normalize: if AI returned bare array, wrap it
    if (Array.isArray(parsed)) {
      parsed = { transactions: parsed };
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
