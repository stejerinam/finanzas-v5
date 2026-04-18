import { supabase, supabaseAnon } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const { session, contentHash } = req.body;

  const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(session.access_token);
  if (authError || !user)
    return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('statements')
    .select('id, bank, period_start, period_end')
    .eq('user_id', user.id)
    .eq('content_hash', contentHash)
    .single();

  if (error && error.code !== 'PGRST116') {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    isDuplicate: !!data,
    existingStatement: data || null,
  });
}
