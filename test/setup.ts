// As rotas do Stripe importam o cliente do Supabase na carga; nos testes ele nunca é chamado.
process.env['SUPABASE_URL'] = 'http://localhost:1';
process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'chave-falsa-de-teste';
