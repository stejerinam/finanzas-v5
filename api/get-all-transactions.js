import { supabase } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { session } = req.body;

  const { data: { user }, error: authError } =
    await supabase.auth.getUser(session.access_token);
  if (authError || !user)
    return res.status(401).json({ error: 'Unauthorized' });

  // Load all statements for account filter
  const { data: statements, error: stmtError } = await supabase
    .from('statements')
    .select('*')
    .eq('user_id', user.id)
    .order('period_start', { ascending: false });

  if (stmtError)
    return res.status(500).json({ error: stmtError.message });

  // Load ALL transactions for this user
  const { data: transactions, error: txnError } = await supabase
    .from('transactions')
    .select('*')
    .eq('user_id', user.id)
    .order('date', { ascending: false });

  if (txnError)
    return res.status(500).json({ error: txnError.message });

  return res.status(200).json({ statements, transactions });
}
