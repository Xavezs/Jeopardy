// discord-bot/supabaseClient.js
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

console.log("Debug - Supabase URL found:", supabaseUrl ? "Yes (" + supabaseUrl + ")" : "NO");
console.log("Debug - Supabase Key found:", supabaseKey ? "Yes" : "NO");

if (!supabaseUrl || !supabaseKey) {
  console.error("Error: Missing Supabase URL or Key in .env file!");
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;