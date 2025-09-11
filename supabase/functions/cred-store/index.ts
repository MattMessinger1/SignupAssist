import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SB_URL') ?? '',
      Deno.env.get('SB_SERVICE_ROLE_KEY') ?? ''
    );

    // Get user from JWT
    const authHeader = req.headers.get('Authorization')?.replace('Bearer ', '');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(authHeader);
    if (authError || !user) {
      throw new Error('Invalid authentication');
    }

    const { provider_slug, alias, email, password, cvv } = await req.json();

    if (!provider_slug || !alias || !email || !password) {
      throw new Error('Missing required fields');
    }

    // Get encryption key
    const encKey = Deno.env.get('CRED_ENC_KEY');
    if (!encKey) {
      throw new Error('Encryption key not configured');
    }

    // Decode base64 key to bytes
    const keyBytes = Uint8Array.from(atob(encKey), c => c.charCodeAt(0));

    // Encrypt function using AES-GCM
    async function encrypt(plaintext: string): Promise<string> {
      const encoder = new TextEncoder();
      const data = encoder.encode(plaintext);
      
      const key = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
      );

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        data
      );

      const result = {
        iv: Array.from(iv),
        ct: Array.from(new Uint8Array(encrypted))
      };

      return JSON.stringify(result);
    }

    // Encrypt the sensitive fields
    const emailEnc = await encrypt(email);
    const passwordEnc = await encrypt(password);
    const cvvEnc = cvv ? await encrypt(cvv) : null;

    // Insert credential
    const { data, error } = await supabaseClient
      .from('account_credentials')
      .insert({
        user_id: user.id,
        provider_slug,
        alias,
        email_enc: emailEnc,
        password_enc: passwordEnc,
        cvv_enc: cvvEnc
      })
      .select('id, alias, provider_slug')
      .single();

    if (error) {
      console.error('Database error:', error);
      throw new Error('Failed to store credential');
    }

    console.log('Credential stored successfully:', data.id);

    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in cred-store function:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});