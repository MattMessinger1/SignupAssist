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

    const { credential_id } = await req.json();

    if (!credential_id) {
      throw new Error('Missing credential_id');
    }

    // Get encryption key
    const encKey = Deno.env.get('CRED_ENC_KEY');
    if (!encKey) {
      throw new Error('Encryption key not configured');
    }

    // Decode base64 key to bytes
    const keyBytes = Uint8Array.from(atob(encKey), c => c.charCodeAt(0));

    // Decrypt function using AES-GCM
    async function decrypt(ciphertext: string): Promise<string> {
      const data = JSON.parse(ciphertext);
      const iv = new Uint8Array(data.iv);
      const ct = new Uint8Array(data.ct);
      
      const key = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      );

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ct
      );

      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    }

    // Get encrypted credential (only if owned by user) - bypass RLS with service role
    const { data, error } = await supabaseClient
      .from('account_credentials')
      .select('id, user_id, alias, provider_slug, email_enc, password_enc, cvv_enc')
      .eq('id', credential_id)
      .eq('user_id', user.id)
      .single();

    if (error) {
      console.error('Database error:', error);
      throw new Error('Failed to fetch credential or credential not found');
    }

    // Decrypt the fields
    const email = await decrypt(data.email_enc);
    const password = await decrypt(data.password_enc);
    const cvv = data.cvv_enc ? await decrypt(data.cvv_enc) : null;

    console.log('Credential decrypted successfully for server use:', credential_id);

    return new Response(JSON.stringify({ 
      success: true,
      data: {
        alias: data.alias,
        email,
        password,
        cvv
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in cred-get function:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});