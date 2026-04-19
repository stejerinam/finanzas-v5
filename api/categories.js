import { supabase, supabaseAnon } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { session, action, categories } = req.body;

  const { data: { user }, error: authError } = await supabaseAnon.auth.getUser(session.access_token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  if (action === 'save') {
    const rows = categories.map(c => ({
      user_id: user.id,
      category_id: c.category_id,
      label: c.label,
      emoji: c.emoji,
      description: c.description,
      examples: c.examples,
      is_active: c.is_active,
      is_custom: c.is_custom,
      sort_order: c.sort_order,
    }));

    const { error } = await supabase
      .from('user_categories')
      .upsert(rows, { onConflict: 'user_id,category_id' });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  // default: get
  const { data: cats, error } = await supabase
    .from('user_categories')
    .select('*')
    .eq('user_id', user.id)
    .order('sort_order', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ categories: cats });
}
