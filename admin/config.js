/**
 * admin/config.js — PUBLIC values only: the Supabase project URL and the
 * anon/public key. Both are safe to ship in client-side code — Row Level
 * Security on app_config (see backend_and_admin.md) is what actually gates
 * read/write access, not secrecy of this key. The SERVICE ROLE key must
 * NEVER appear in this file or anywhere else under /admin/ — that one lives
 * only in the git-ignored api/config.php, used server-side.
 *
 * Get the anon key from: Supabase dashboard > Project Settings > API >
 * "anon" / "public" key (NOT the "service_role" key).
 */
window.RiteAdminConfig = {
  SUPABASE_URL: "https://zrhramlifwikaufqprfx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpyaHJhbWxpZndpa2F1ZnFwcmZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4ODU4MjksImV4cCI6MjA5ODQ2MTgyOX0.wYpaSgZa-SNYONGnVjxKbqg-hV-ZueZe9syDLo0cp_A"
};
